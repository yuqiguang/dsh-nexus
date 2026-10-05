import { parse } from 'acorn';
import { builtinModules } from 'node:module';

/** Observations for the evidence collector, never a shell evaluator or an authorization parser. */
export type SourceLanguage = 'python' | 'javascript' | 'shell' | 'powershell';
export interface ExecutionObservation {
  sources: { path: string; language?: SourceLanguage }[];
  inline: { code: string; language: SourceLanguage }[];
  packages: { manager: string; script: string }[];
  manifests: string[];
  gaps: string[];
  /** null means discovery could not be narrowed to literal targets. */
  pytest: (string[] | null)[];
}
type Word = { value: string; literal: boolean };

/** Only split enough syntax to locate evidence. Unsupported quoting/expansion is retained as a gap. */
function words(source: string, powershell: boolean): { words: Word[]; uncertain: boolean } {
  const result: Word[] = [];
  let value = '', quote = '', started = false, literal = true, uncertain = false;
  const flush = () => { if (started) result.push({ value, literal }); value = ''; started = false; literal = true; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!, next = source[i + 1];
    if (!quote && !started && char === '#') { while (i < source.length && source[i] !== '\n') i++; flush(); result.push({ value: ';', literal: true }); continue; }
    if (!quote && char === '\n') { flush(); result.push({ value: ';', literal: true }); continue; }
    if (!quote && /[\s;&|()<>]/.test(char)) { flush(); if (!/\s/.test(char)) result.push({ value: char, literal: true }); continue; }
    started = true;
    if (char === quote) {
      if (powershell && next === quote) { value += char; i++; } else quote = '';
      continue;
    }
    if (!quote && (char === '"' || char === "'")) { quote = char; continue; }
    if (char === '\\' && (!quote || quote === '"') && next && /["'\\\s$`]/.test(next)) {
      // PowerShell does not use backslash escapes, but native command displays may contain escaped double quotes.
      if (powershell && next !== '"') value += char;
      else { value += next; i++; }
      continue;
    }
    if (powershell && char === '`' && quote !== "'" && next) { value += next; i++; uncertain = true; continue; }
    if (quote !== "'" && /[$`]/.test(char)) literal = false;
    value += char;
  }
  flush();
  return { words: result, uncertain: uncertain || !!quote };
}

const programName = (value: string) => value.replace(/\\/g, '/').split('/').at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '');
const separator = (value: string) => /^[;&|()<>]$/.test(value);

function pytestTargets(args: Word[]): string[] | null | undefined {
  const targets: string[] = [];
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.literal || /[$`*?{}]/.test(arg.value)) return undefined;
    if (!operands && arg.value === '--') { operands = true; continue; }
    if (!operands && ['-k', '-m', '--maxfail', '--tb', '--color', '--durations'].includes(arg.value)) {
      if (!args[++i]?.literal) return undefined;
      continue;
    }
    if (!operands && (/^-[qvxs]+$/.test(arg.value) || ['--disable-warnings', '--collect-only'].includes(arg.value)
      || /^--(?:maxfail|tb|color|durations)=/.test(arg.value))) continue;
    if (!operands && arg.value.startsWith('-')) return undefined;
    const path = arg.value.split('::')[0]!;
    if (!path || path.startsWith('@')) return undefined;
    targets.push(path);
  }
  return targets.length ? targets : null;
}

export function executionObservations(command: string, language: 'shell' | 'powershell' = 'shell', depth = 0): ExecutionObservation {
  const out: ExecutionObservation = { sources: [], inline: [], packages: [], manifests: [], gaps: [], pytest: [] };
  if (depth > 4 || command.length > 96 * 1024) { out.gaps.push('嵌套命令或代码超过静态解析上限'); return out; }
  const parsed = words(command, language === 'powershell'), tokens = parsed.words;
  if (parsed.uncertain) out.gaps.push('命令引号或转义未完整解析，须核对原始命令');
  let directoryChanged = false;
  const addPytest = (args: Word[]) => {
    const targets = parsed.uncertain || directoryChanged ? undefined : pytestTargets(args);
    out.pytest.push(targets ?? null);
    if (targets === undefined) out.gaps.push('pytest 参数或目标未完整解析，项目扫描不能证明实际测试发现范围完整');
  };
  const addSource = (word: Word | undefined, language?: SourceLanguage) => {
    if (!word || !word.literal || /[$`*?{}]/.test(word.value)) { out.gaps.push('执行路径包含动态表达式，未静态展开'); return; }
    out.sources.push({ path: word.value, language });
  };
  const merge = (other: ExecutionObservation) => {
    if (directoryChanged && other.pytest.length) {
      other.pytest = [null];
      other.gaps.push('命令改变工作目录，不能按原目录推断 pytest 的实际目标');
    }
    for (const key of ['sources', 'inline', 'packages', 'manifests', 'gaps', 'pytest'] as const) (out[key] as unknown[]).push(...other[key]);
  };
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i]!, name = programName(word.value);
    // Search executable positions and nested wrappers. Strings inside arguments are not recursively treated as commands.
    if (i && !separator(tokens[i - 1]!.value) && !/^(?:&|command|exec|env|sudo)$/.test(tokens[i - 1]!.value)
      && !/^[\w:$]+=.*/.test(tokens[i - 1]!.value)) continue;
    if (['cd', 'chdir', 'pushd', 'popd', 'set-location', 'sl', 'push-location', 'pop-location'].includes(name)) directoryChanged = true;
    const args: Word[] = [];
    for (let j = i + 1; j < tokens.length && !separator(tokens[j]!.value); j++) args.push(tokens[j]!);
    const python = /^python(?:\d+(?:\.\d+)*)?$/.test(name);
    const js = /^(?:node|nodejs|bun|deno)$/.test(name);
    const shell = /^(?:ba|da|z|k)?sh$/.test(name);
    const ps = /^(?:powershell|pwsh)$/.test(name);
    if (python || js || shell || ps) {
      const sourceLanguage: SourceLanguage = python ? 'python' : js ? 'javascript' : ps ? 'powershell' : 'shell';
      for (let a = 0; a < args.length; a++) {
        const arg = args[a]!.value, lower = arg.toLowerCase();
        if ((python || shell) && /^-[a-z]*c$/i.test(arg) || js && ['-e', '--eval', '-p', '--print'].includes(lower) || ps && ['-command', '-c'].includes(lower)) {
          const inline = args[a + 1];
          if (inline) {
            // PowerShell also accepts unquoted -Command followed by the remaining command line.
            const code = ps ? args.slice(a + 1).map(item => item.value).join(' ') : inline.value;
            out.inline.push({ code, language: sourceLanguage });
            if (!inline.literal) out.gaps.push('内联代码含宿主 shell 展开，提取内容仅为静态线索');
            if (shell || ps) merge(executionObservations(code, ps ? 'powershell' : 'shell', depth + 1));
          } else out.gaps.push('内联代码参数缺失');
          break;
        }
        if (js && ['-r', '--require', '--import', '--loader', '--experimental-loader'].includes(lower)) { addSource(args[++a], 'javascript'); continue; }
        if (js && ['--test', 'test'].includes(lower)) out.gaps.push('运行时测试发现和测试配置未完整展开');
        if (ps && ['-encodedcommand', '-enc', '-encodedarguments'].includes(lower)) { out.gaps.push('编码后的 PowerShell 命令未展开'); break; }
        if (python && ['-m', '-x', '-w'].includes(lower)) {
          if (lower === '-m') {
            if (args[a + 1]?.value === 'pytest') addPytest(args.slice(a + 2));
            break;
          }
          a++; continue;
        }
        if (ps && ['-executionpolicy', '-inputformat', '-outputformat', '-workingdirectory', '-windowstyle'].includes(lower)) {
          if (lower === '-workingdirectory') directoryChanged = true;
          a++; continue;
        }
        if (ps && ['-file', '-f'].includes(lower)) { addSource(args[a + 1], sourceLanguage); break; }
        if (arg.startsWith('-') || js && ['run', 'test'].includes(lower)) continue;
        addSource(args[a], sourceLanguage); break;
      }
    } else if (name === 'pytest') {
      addPytest(args);
    } else if (name === 'using' && args[0]?.value.toLowerCase() === 'module') {
      addSource(args[1], 'powershell');
    } else if (['source', '.', 'import-module'].includes(name)) {
      addSource(args.find(arg => !arg.value.startsWith('-')), name === 'import-module' || language === 'powershell' ? 'powershell' : 'shell');
    } else if (/\.(?:sh|ps1|psm1)$/i.test(word.value)) {
      addSource(word, /\.ps(?:1|m1)$/i.test(word.value) ? 'powershell' : 'shell');
    } else if (['npm', 'pnpm', 'yarn'].includes(name)) {
      const action = args[0]?.value;
      const script = ['run', 'run-script'].includes(action ?? '') ? args[1] : args[0];
      if (script?.literal && (['run', 'run-script', 'test', 'start', 'stop', 'restart'].includes(action ?? '')
        || name === 'yarn' && action && !['install', 'add', 'remove', 'dlx', 'exec', 'up', 'set', 'config'].includes(action))) out.packages.push({ manager: name, script: script.value });
      else { out.manifests.push('package.json'); out.gaps.push('包管理器安装、工作区或其他命令未完整展开执行链'); }
      if (args.some(arg => /^(?:--prefix|--cwd|--dir|-C|--workspace|-w|--filter|--recursive|-r)(?:=|$)/.test(arg.value))) out.gaps.push('包管理器修改目录或选择工作区，当前清单不足以证明实际执行入口');
    } else if (['cargo', 'go', 'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet', 'make', 'cmake'].includes(name)) {
      out.manifests.push(...({ cargo: ['Cargo.toml', 'build.rs', '.cargo/config.toml'], go: ['go.mod', 'go.work'], mvn: ['pom.xml'], mvnw: ['pom.xml'], gradle: ['build.gradle', 'settings.gradle'], gradlew: ['build.gradle', 'settings.gradle'], dotnet: ['global.json', 'Directory.Build.props', 'Directory.Build.targets'], make: ['Makefile'], cmake: ['CMakeLists.txt'] }[name] ?? []));
      out.gaps.push('构建工具的插件、生成器及依赖代码尚未完整解析，清单仅为入口证据');
    } else if (['cd', 'set-location', 'pushd'].includes(name)) out.gaps.push('命令改变工作目录，后续相对路径须结合原始命令核对');
    else if (['eval', 'invoke-expression', 'iex'].includes(name)) out.gaps.push('命令包含动态求值，不能证明执行代码完整');
  }
  return out;
}

export interface JavaScriptObservation { modules: string[]; dynamic: boolean }
/** Parse JS syntax so commented-out imports and string examples are not dependencies. TS falls back conservatively. */
export function javascriptObservations(source: string, moduleSpans?: { start: number; end: number }[]): JavaScriptObservation {
  const modules = new Set<string>();
  let dynamic = false;
  const builtins = new Set(builtinModules.flatMap(name => [name, 'node:' + name]));
  const module = (node: any) => {
    if (node?.type === 'Literal' && typeof node.value === 'string') {
      moduleSpans?.push({ start: node.start, end: node.end });
      if (!builtins.has(node.value)) modules.add(node.value);
    } else dynamic = true;
  };
  try {
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true });
    const queue: any[] = [tree];
    for (let i = 0; i < queue.length; i++) {
      if (i >= 30_000) { dynamic = true; break; }
      const node = queue[i];
      if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source) module(node.source);
      if (node.type === 'ImportExpression') module(node.source);
      if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') module(node.arguments[0]);
      if (node.type === 'CallExpression' && (['eval', 'Function'].includes(node.callee?.name) || ['runInNewContext', 'runInThisContext', 'compileFunction', 'exec', 'execSync', 'spawn', 'spawnSync'].includes(node.callee?.property?.name))) dynamic = true;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) queue.push(...value.filter(item => item && typeof item === 'object' && typeof item.type === 'string'));
        else if (value && typeof value === 'object' && 'type' in value) queue.push(value);
      }
    }
  } catch {
    dynamic = true;
    for (const match of source.matchAll(/(?:\bfrom\s*|\b(?:require|import)\s*\(\s*)['"]([^'"\r\n]+)['"]/g)) if (!builtins.has(match[1]!)) modules.add(match[1]!);
  }
  return { modules: [...modules], dynamic };
}

/** The generic literal collector must not reinterpret module-relative imports as cwd-relative data paths. */
export function javascriptDataReferences(source: string): string {
  const spans: { start: number; end: number }[] = [];
  javascriptObservations(source, spans);
  for (const span of spans.sort((a, b) => b.start - a.start)) source = source.slice(0, span.start) + ' '.repeat(span.end - span.start) + source.slice(span.end);
  return source;
}
