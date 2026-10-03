import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { commandPath } from './command-path.js';
import { redact } from './normalize.js';
import { pythonImports, pythonModuleCommands, type PythonImport } from './python-evidence.js';

const EXTENSIONS = '(?:[cm]?[jt]sx?|py|sh|ps1|html?|json|css|md|mdx|txt|ya?ml|toml|ini|cfg)';
const FILE = new RegExp(`\\.${EXTENSIONS}$`, 'i');
const MAX_FILE = 96 * 1024;
const MAX_TOTAL = 192 * 1024;
const MAX_FILES = 24;

/** Discover literal source references, not executable instructions. Dynamic references remain for the reviewer to assess. */
function references(text: string): string[] {
  const values = new Set<string>();
  for (const match of text.matchAll(/(["'`])([^"'`\r\n]{1,1024})\1/g)) {
    const name = match[2]!.split('::')[0]!;
    if (FILE.test(name) && !/[\x00-\x1f${}]/.test(name)) values.add(name);
  }
  const bare = new RegExp(`(?:^|[\\s=;(])([^\\s"'\x60;&|<>()]+\\.${EXTENSIONS})(?=$|::|[\\s"'\x60;&|<>()])`, 'gim');
  for (const match of text.matchAll(bare)) values.add(match[1]!);
  return [...values];
}

/** A bounded, complete read per source, recursively including literal local inputs such as HTML and imported scripts. */
export async function commandEvidence(command: string, cwd: string, within: (path: string) => Promise<string>): Promise<{ evidence: string[]; complete: boolean }> {
  const evidence: string[] = [];
  const seen = new Set<string>();
  const queue: { path: string; optional?: boolean }[] = [{ path: resolve(cwd, 'package.json'), optional: true }];
  let bytes = 0, complete = true;
  let moduleProbes = 0;
  const probes = new Map<string, boolean>();
  const inProject = (path: string) => { const name = relative(cwd, path); return name !== '..' && !name.startsWith('..' + sep) && !isAbsolute(name); };
  const localFile = async (path: string) => {
    if (probes.has(path)) return probes.get(path)!;
    if (!inProject(path)) { complete = false; return false; }
    if (++moduleProbes > 192) { complete = false; return false; }
    try { const real = await within(path); const exists = (await lstat(real)).isFile(); probes.set(path, exists); return exists; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        evidence.push(`${redact(path)}: Python 模块路径未读取，不能确认审核边界或文件状态`); complete = false;
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
        found = true; queue.push({ path: candidate });
        // Package initializers run before imported submodules.
        for (let parent = dirname(candidate); parent !== root && inProject(parent); parent = dirname(parent)) {
          const init = resolve(parent, '__init__.py');
          if (await localFile(init)) queue.push({ path: init });
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
      queue.push({ path: resolve(base, path), ...(fromSource && /\.(?:md|txt|json|html?|css)$/i.test(path) ? { optional: true } : {}) });
      if (base !== cwd && !isAbsolute(path)) queue.push({ path: resolve(cwd, path), optional: true });
    }
  };
  add(command, cwd);
  const modules = pythonModuleCommands(command);
  for (const module of modules) if (module !== 'pytest') await addModule({ module, names: [] }, cwd, true);
  const pytest = modules.includes('pytest') || /(?:^|[\s/\\])pytest(?:\.exe)?(?:\s|$)/i.test(command);
  if (pytest) {
    const targets = queue.filter(item => /\.py$/i.test(item.path));
    if (!targets.length) { evidence.push('pytest 未显式指定 Python 测试文件，目录或自动发现的测试范围未展开，证据不完整。'); complete = false; }
    for (const file of ['conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) queue.push({ path: resolve(cwd, file), optional: true });
    for (const target of targets) {
      for (let parent = dirname(target.path); inProject(parent); parent = dirname(parent)) {
        queue.push({ path: resolve(parent, 'conftest.py'), optional: true });
        queue.push({ path: resolve(parent, '__init__.py'), optional: true });
        if (parent === cwd) break;
      }
    }
    evidence.push('pytest 可能加载第三方插件或配置中的动态测试路径；本次仅展开可静态定位的项目源码，不把测试命令视为自动授权。');
  }
  let files = 0;
  for (let index = 0; index < queue.length; index++) {
    if (index >= 192) { evidence.push('关联路径超过定位上限，证据不完整。'); complete = false; break; }
    const candidate = queue[index]!;
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    let real: string;
    try { real = await within(candidate.path); }
    catch { evidence.push(`${redact(candidate.path)}: 未读取，超出允许的审核边界`); complete = false; continue; }
    const info = await lstat(real).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) { evidence.push(`${redact(real)}: 不存在`); if (!candidate.optional) complete = false; continue; }
    if (++files > MAX_FILES) { evidence.push('关联文件超过审核数量上限，证据不完整；不得假定未读取的代码安全。'); complete = false; break; }
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
      if (/\.py$/i.test(real)) {
        const parsed = pythonImports(source);
        for (const item of parsed.imports) await addModule(item, dirname(real));
        if (parsed.dynamic) { evidence.push(`${redact(real)}: 存在动态 Python 加载或执行，静态依赖证据不完整`); complete = false; }
      }
      add(source, dirname(real), true);
    } finally { await file.close(); }
  }
  if (moduleProbes > 192) evidence.push('Python 模块定位超过数量上限，未继续探测；证据不完整。');
  evidence.push('以上只收集可识别的文件引用和静态 Python 导入，不证明依赖完整；动态加载、间接执行、环境与网络行为须结合完整命令和代码判断。');
  return { evidence, complete };
}
