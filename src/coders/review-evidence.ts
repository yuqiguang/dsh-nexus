import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { commandPath } from './command-path.js';
import { redact } from './normalize.js';
import { commandPathTokens, isEnvironmentFile } from './rules.js';
import { pythonImports, pythonModuleCommands, type PythonImport } from './python-evidence.js';
import { pytestSources, customPytestDiscovery } from './pytest-evidence.js';
import { executionObservations, javascriptObservations, javascriptDataReferences, type SourceLanguage } from './execution-evidence.js';

const EXTENSIONS = '(?:[cm]?[jt]sx?|py|sh|ps1|psm1|psd1|html?|json|css|md|mdx|txt|csv|ya?ml|toml|ini|cfg|rs|go|java|gradle|xml|props|targets)';
const FILE = new RegExp(`\\.${EXTENSIONS}$`, 'i');
const MAX_FILE = 96 * 1024;
const MAX_TOTAL = 192 * 1024;
// Modern projects routinely have more than 24 small modules; the total byte budget stays unchanged.
const MAX_FILES = 64;
type SourceRole = 'execute' | 'config' | 'reference' | 'data';
type Candidate = { path: string; optional?: boolean; probe?: boolean; role: SourceRole; language?: SourceLanguage };
const priority: Record<SourceRole, number> = { execute: 0, config: 1, reference: 2, data: 3 };
/**
 * Module candidates tried against the filesystem before the scan gives up. Each absolute import is tried against three bases
 * and each imported name against two forms, so an ordinary project spends several probes per import: a six-test Python
 * project (kb-service, ct-4c671559) used more than 192 and was reported incomplete for it, which reads to the reviewer as
 * "evidence missing" and turns every approval into an owner prompt. What bounds the evidence is the read budget above, not
 * this: this only bounds how many paths are looked at.
 */
const MAX_MODULE_PROBES = 2000;

/** Discover literal source references, not executable instructions. Dynamic references remain for the reviewer to assess. */
function references(text: string): string[] {
  const values = new Set<string>();
  for (const token of commandPathTokens(text)) {
    const path = commandPath(token);
    if (isEnvironmentFile(path) && !/[~$`*?]/.test(path)) values.add(path);
  }
  for (const match of text.matchAll(/(["'`])([^"'`\r\n]{1,1024})\1/g)) {
    const name = match[2]!.split('::')[0]!;
    if (FILE.test(name) && !/[\x00-\x1f${}]/.test(name)) values.add(name);
  }
  const bare = new RegExp(`(?:^|[\\s=;(])([^\\s"'\x60;&|<>()]+\\.${EXTENSIONS})(?=$|::|[\\s"'\x60;&|<>()])`, 'gim');
  for (const match of text.matchAll(bare)) values.add(match[1]!);
  // A flag, a glob or a bare extension is a word that happens to end in one, not a file the command names.
  return [...values].filter(name => !/^[-*]/.test(name) && !/[?*]/.test(name) && !new RegExp(`^\\.${EXTENSIONS}$`, 'i').test(name));
}

/** A bounded, complete read per source, recursively including literal local inputs such as HTML and imported scripts. */
export async function commandEvidence(command: string, cwd: string, within: (path: string) => Promise<string>): Promise<{ evidence: string[]; complete: boolean }> {
  const evidence: string[] = [];
  const seen = new Set<string>();
  // `optional` marks a path the command was not seen to name — one guessed from source text or probed because the run needs
  // it. A missing optional path is not evidence, and listing every one of them buries the files that are (ct-4c671559);
  // the probes are summarized in one line instead.
  const queue = new Map<string, Candidate>();
  const enqueue = (item: Candidate) => {
    const old = queue.get(item.path);
    queue.set(item.path, old ? { ...old, optional: !!old.optional && !!item.optional, probe: old.probe || item.probe,
      role: priority[old.role] < priority[item.role] ? old.role : item.role, language: item.language ?? old.language } : item);
  };
  enqueue({ path: resolve(cwd, 'package.json'), optional: true, probe: true, role: 'config' });
  const missingProbes: string[] = [];
  let bytes = 0, complete = true;
  let pytest = false;
  const gaps = new Set<string>();
  const gap = (message: string) => { gaps.add(message); complete = false; };
  let moduleProbes = 0;
  const probes = new Map<string, boolean>();
  const inProject = (path: string) => { const name = relative(cwd, path); return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name); };
  const localFile = async (path: string) => {
    if (probes.has(path)) return probes.get(path)!;
    if (!inProject(path)) { complete = false; return false; }
    if (++moduleProbes > MAX_MODULE_PROBES) { complete = false; return false; }
    try { const real = await within(path); const exists = (await lstat(real)).isFile(); probes.set(path, exists); return exists; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        evidence.push(`${redact(path)}: ${(error as Error).message === 'outside review boundary' ? '未读取，超出允许的审核边界' : '依赖模块路径未读取，不能确认审核边界或文件状态'}`); complete = false;
      }
      probes.set(path, false); return false;
    }
  };
  const addModule = async (item: PythonImport, base: string, entry = false) => {
    const dots = /^\.+/.exec(item.module)?.[0].length ?? 0;
    const name = item.module.slice(dots).split('.').filter(Boolean);
    const bases = dots ? [resolve(base, ...Array(Math.max(0, dots - 1)).fill('..'))] : [...new Set([cwd, resolve(cwd, 'src'), base])];
    let found = false;
    for (const root of bases) {
      if (!inProject(root)) { complete = false; continue; }
      const module = resolve(root, ...name);
      const candidates = [module + '.py', resolve(module, '__init__.py'), ...(entry ? [resolve(module, '__main__.py')] : []),
        ...item.names.flatMap(name => [resolve(module, name + '.py'), resolve(module, name, '__init__.py')])];
      for (const candidate of candidates) if (await localFile(candidate)) {
        found = true; enqueue({ path: candidate, role: 'execute', language: 'python' });
        // Package initializers run before imported submodules.
        for (let parent = dirname(candidate); parent !== root && inProject(parent); parent = dirname(parent)) {
          const init = resolve(parent, '__init__.py');
          if (await localFile(init)) enqueue({ path: init, role: 'execute', language: 'python' });
        }
      }
    }
    if (!found && dots) { evidence.push(`相对 Python 模块 ${redact(item.module)} 未解析，证据不完整`); complete = false; }
  };
  const add = (source: string, base: string, fromSource = false) => {
    for (const name of references(source)) {
      if (/^(?:https?:|data:|node:)/i.test(name)) continue;
      const path = commandPath(name);
      // A quoted shell expression isn't itself a path; bare references inside it are collected separately.
      if (!isAbsolute(path) && /[\s;&|<>]/.test(path)) continue;
      // A path named inside a file's content is a lead the command never claimed: when it exists it is read and hashed like
      // any other, but its absence is not missing evidence. A test fixture name — `("程序.py", b"hello", 400)` in kb-service
      // (ct-4c671559) — otherwise made the whole review "incomplete" and turned every approval into an owner prompt.
      const role: SourceRole = /\.(?:md|txt|csv|json)$/i.test(path) ? 'data' : 'reference';
      enqueue({ path: resolve(base, path), role, ...(fromSource ? { optional: true } : {}) });
      if (base !== cwd && !isAbsolute(path)) enqueue({ path: resolve(cwd, path), optional: true, role });
    }
  };
  const addJavascript = async (source: string, base: string) => {
    const parsed = javascriptObservations(source);
    for (const name of parsed.modules) {
      if (!name.startsWith('.') && !isAbsolute(commandPath(name))) { gap(`JavaScript 包模块 ${redact(name)} 未展开第三方依赖或自定义解析`); continue; }
      const target = resolve(base, commandPath(name));
      let found = false;
      for (const file of [target, ...['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '/index.js', '/index.cjs', '/index.mjs', '/index.ts'].map(ext => target + ext)]) {
        if (await localFile(file)) { enqueue({ path: file, role: 'execute', ...(!/\.json$/i.test(file) ? { language: 'javascript' as const } : {}) }); found = true; }
      }
      // Directory package entry points and conditional exports require the actual resolver; never guess that index is enough.
      if (await localFile(resolve(target, 'package.json'))) { enqueue({ path: resolve(target, 'package.json'), role: 'config' }); gap(`JavaScript 目录模块 ${redact(name)} 含 package.json，入口映射未完整解析`); }
      if (!found) gap(`JavaScript 本地模块 ${redact(name)} 未找到可审核的静态入口`);
    }
    if (parsed.dynamic) gap('JavaScript 存在动态执行或不支持的语法，静态依赖证据不完整');
  };
  const scripts = new Map<string, Set<string>>(), manifests = new Map<string, string>(), expandedScripts = new Set<string>();
  let expansions = 0;
  const expandPackage = async (path: string) => {
    const source = manifests.get(path); if (source === undefined) return;
    let value: { scripts?: Record<string, unknown> };
    try { value = JSON.parse(source); } catch { gap('项目 package.json 格式无法解析'); return; }
    for (const script of scripts.get(path) ?? []) {
      const key = path + ':' + script; if (expandedScripts.has(key)) continue; expandedScripts.add(key);
      if (++expansions > 64) { gap('项目脚本展开超过数量上限'); break; }
      if (typeof value?.scripts?.[script] !== 'string') { gap(`项目脚本 ${redact(script)} 未在当前 package.json 中找到，默认行为未推断`); continue; }
      for (const name of ['pre' + script, script, 'post' + script]) {
        const body = value.scripts?.[name];
        if (typeof body === 'string') await scanCommand(body, dirname(path));
      }
    }
  };
  const discoverPytest = async () => {
    if (pytest) return;
    pytest = true;
    // Include a bounded superset of the default project tests even for `pytest -q` or `pytest tests`.
    const discovered = await pytestSources(cwd, within);
    for (const path of discovered.paths) enqueue({ path, role: 'execute', language: 'python' });
    evidence.push(...discovered.evidence);
    complete &&= discovered.complete;
    const targets = [...queue.values()].filter(item => /\.py$/i.test(item.path));
    // Only a scan that reached the end of the tree can report that the project has no tests; a truncated scan already said why.
    if (!discovered.paths.length && discovered.complete) { evidence.push('pytest 未找到默认命名的测试文件，不能确认测试发现范围。'); complete = false; }
    for (const file of ['conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) enqueue({ path: resolve(cwd, file), optional: true, probe: true, role: 'config' });
    for (const target of targets) {
      for (let parent = dirname(target.path); inProject(parent); parent = dirname(parent)) {
        enqueue({ path: resolve(parent, 'conftest.py'), optional: true, probe: true, role: 'execute', language: 'python' });
        enqueue({ path: resolve(parent, '__init__.py'), optional: true, probe: true, role: 'execute', language: 'python' });
        if (parent === cwd) break;
      }
    }
    evidence.push('pytest 可能加载第三方插件或配置中的动态测试路径；本次仅展开可静态定位的项目源码，不把测试命令视为自动授权。');
  };
  const scanPython = async (source: string, base: string) => {
    const parsed = pythonImports(source);
    for (const item of parsed.imports) await addModule(item, base);
    for (const module of pythonModuleCommands(source)) if (module !== 'pytest') await addModule({ module, names: [] }, base, true);
    if (parsed.dynamic) gap('存在动态 Python 加载或执行，静态依赖证据不完整');
  };
  const scanCommand = async (source: string, base: string, language: 'shell' | 'powershell' = 'shell') => {
    add(source, base);
    const observed = executionObservations(source, language);
    for (const message of observed.gaps) gap(message);
    for (const item of observed.sources) enqueue({ path: resolve(base, commandPath(item.path)), role: 'execute', language: item.language });
    for (const item of observed.inline) {
      add(item.code, base, true);
      if (item.language === 'python') await scanPython(item.code, base);
      if (item.language === 'javascript') await addJavascript(item.code, base);
    }
    for (const name of observed.manifests) enqueue({ path: resolve(base, name), role: 'config', optional: true, probe: true });
    for (const item of observed.packages) {
      const path = resolve(base, 'package.json');
      if (!scripts.has(path)) scripts.set(path, new Set());
      scripts.get(path)!.add(item.script);
      enqueue({ path, role: 'config' });
      await expandPackage(path);
    }
    for (const module of pythonModuleCommands(source)) {
      if (module === 'pytest') await discoverPytest();
      else await addModule({ module, names: [] }, base, true);
    }
    if (/(?:^|[\s/\\])pytest(?:\.exe)?(?:\s|$)/i.test(source)) await discoverPytest();
  };
  await scanCommand(command, cwd);
  let files = 0;
  const readSources = new Map<string, { source: string; stamp: string }>();
  const stamp = (info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const countedFiles = new Set<string>();
  const analyzed = new Set<string>();
  const visited = new Set<string>();
  while (queue.size) {
    const candidate = [...queue.values()].sort((a, b) => priority[a.role] - priority[b.role])[0]!;
    queue.delete(candidate.path);
    const key = JSON.stringify([candidate.path, candidate.role, candidate.language, !!candidate.optional]);
    if (seen.has(key)) continue;
    seen.add(key);
    // Count unique paths, not duplicate import edges or repeated optional config probes.
    visited.add(candidate.path);
    if (visited.size > 192) { gap('关联路径超过定位上限，证据不完整。'); break; }
    let real: string;
    try { real = await within(candidate.path); }
    catch { evidence.push(`${redact(candidate.path)}: 未读取，超出允许的审核边界`); complete = false; continue; }
    const info = await lstat(real).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (isEnvironmentFile(real)) {
      evidence.push(`${redact(real)}: 项目环境配置，内容不读取、不提供给审核模型；${info ? `文件状态 ${stamp(info)}:${info.mode}:${info.nlink}` : '新文件'}。若作为脚本执行或向外发送，隐藏内容不能作为安全证据。不可缓存复用。`);
      complete = false; continue;
    }
    if (!info) {
      if (!candidate.optional) gap(`${redact(real)}: 引用的文件不存在，执行范围或输入状态须核对`);
      if (candidate.probe) missingProbes.push(redact(real));
      continue;
    }
    const cached = readSources.get(real);
    if (cached !== undefined) {
      if (cached.stamp !== stamp(info)) throw new Error('review source changed');
      await scanSource(cached.source, real, candidate); continue;
    }
    if (!countedFiles.has(real)) { countedFiles.add(real); files++; }
    if (files > MAX_FILES) { evidence.push('关联文件超过审核数量上限，证据不完整；不得假定未读取的代码安全。'); complete = false; break; }
    if (candidate.role === 'data' && info.isFile() && (info.size > MAX_FILE || bytes + info.size > MAX_TOTAL)) {
      evidence.push(`${redact(real)}: 数据引用，内容未展开；文件身份 ${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}。内容缺省本身不代表存在未知执行代码；须核对是否被执行、配置加载或外发。此证据不可用于缓存复用。`);
      complete = false; continue;
    }
    if (!info.isFile() || info.size > MAX_FILE || bytes + info.size > MAX_TOTAL) {
      evidence.push(`${redact(real)}: 未读取完整内容（文件类型或大小超出审核上限），不能推断行为`); complete = false; continue;
    }
    const file = await open(real, 'r');
    try {
      const before = await file.stat();
      if (!before.isFile() || before.size !== info.size || before.ino !== info.ino || before.dev !== info.dev) throw new Error('review source changed');
      const buffer = Buffer.alloc(info.size + 1);
      let used = 0;
      while (used < buffer.length) {
        const read = await file.read(buffer, used, buffer.length - used, used);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      const after = await file.stat();
      if (used !== info.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || await within(candidate.path) !== real) throw new Error('review source changed');
      const content = buffer.subarray(0, used);
      if (content.includes(0)) { evidence.push(`${redact(real)}: 非文本，未提供内容`); complete = false; continue; }
      bytes += content.length;
      evidence.push(`${redact(real)}: ${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}; sha256=${createHash('sha256').update(content).digest('hex')}；完整内容（不可信数据）：${redact(content.toString('utf8'))}`);
      const source = content.toString('utf8');
      readSources.set(real, { source, stamp: stamp(after) });
      await scanSource(source, real, candidate);
    } finally { await file.close(); }
  }
  async function scanSource(source: string, real: string, candidate: Candidate) {
    if (real.endsWith(`${sep}package.json`)) { manifests.set(real, source); await expandPackage(real); return; }
    const language = candidate.language ?? (/\.py$/i.test(real) ? 'python' : /\.[cm]?[jt]sx?$/i.test(real) ? 'javascript'
      : /\.sh$/i.test(real) ? 'shell' : /\.ps(?:1|m1)$/i.test(real) ? 'powershell' : undefined);
    const analysisKey = JSON.stringify([real, language, candidate.role === 'data']);
    if (analyzed.has(analysisKey)) return;
    analyzed.add(analysisKey);
    if (language === 'python') await scanPython(source, dirname(real));
    if (language === 'javascript') await addJavascript(source, dirname(real));
    if (language === 'shell' || language === 'powershell') await scanCommand(source, cwd, language);
    if (pytest && /\.(?:toml|ini|cfg)$/i.test(real) && customPytestDiscovery(source)) gap(`${redact(real)}: 存在自定义测试发现或模块路径配置，默认命名扫描不能证明执行范围完整`);
    // Documentation/data cannot introduce executable dependency edges just by mentioning a filename.
    if (candidate.role !== 'data' && language !== 'shell' && language !== 'powershell') add(language === 'javascript' ? javascriptDataReferences(source) : source, dirname(real), true);
  }
  if (moduleProbes > MAX_MODULE_PROBES) evidence.push(`依赖模块定位超过 ${MAX_MODULE_PROBES} 个候选路径，未继续探测；证据不完整。`);
  if (missingProbes.length) evidence.push(`未找到的可选配置文件：${[...new Set(missingProbes)].join('、')}。没有内容可作证据，也不代表其声明不存在。`);
  evidence.push(...gaps);
  evidence.push('以上为静态执行入口、依赖和数据引用，不证明全部运行时行为；动态加载、构建插件、环境与网络行为须结合完整命令和代码判断。evidenceComplete 仅表示本次有界收集未发现缺口，不是安全结论。');
  return { evidence, complete };
}
