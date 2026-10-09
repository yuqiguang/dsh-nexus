import { lstat, readFile, realpath, stat, readdir } from 'node:fs/promises';
import { dirname, resolve, sep, isAbsolute, join, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { isInside, isProtectedPath } from './rules.js';
import { onPath } from './install.js';
import { canonical } from './permissions.js';
import { redact } from './normalize.js';

/** A deliberately small direct argv grammar. Shell wrappers, substitutions and compound installs stay manual. */
function installWords(command: string): string[] | undefined {
  const direct = command.trim().replace(/^&\s+(?=["'])/, '');
  if (direct.length > 12_000 || /[\x00-\x1f;&|<>`$()]/.test(direct)
    || !/^(?:[^\s'"]+|'[^']*'|"[^"]*")(?:\s+(?:[^\s'"]+|'[^']*'|"[^"]*"))*$/.test(direct)) return;
  return direct.match(/[^\s'"]+|'[^']*'|"[^"]*"/g)!.map(word => /^["']/.test(word) ? word.slice(1, -1) : word);
}

const stamp = (info: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;

/** Public source identity only; never retain credentials, query strings or authenticated URLs. */
function indexSource(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
      || !/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) || /\.(?:local|internal|lan|home|test|localhost)$/i.test(url.hostname)) return;
    return url.href;
  } catch { return; }
}

/** Read only bounded pip configuration, never execute Python/pip to discover its environment. Unknown settings fail closed. */
async function pipConfiguration(env: NodeJS.ProcessEnv, venv?: string): Promise<string[] | undefined> {
  const get = (key: string) => Object.entries(env).find(([name]) => process.platform === 'win32' ? name.toLowerCase() === key.toLowerCase() : name === key)?.[1];
  const evidence: string[] = [], sources = new Set<string>();
  const setting = (key: string, value: string): boolean => {
    key = key.toLowerCase().replace(/_/g, '-');
    if (['index-url', 'extra-index-url'].includes(key)) {
      const urls = value.trim().split(/\s+/).map(indexSource);
      if (urls.some(url => !url)) return false;
      for (const url of urls) sources.add(url!);
      return true;
    }
    return ['disable-pip-version-check', 'no-color', 'progress-bar', 'timeout', 'retries'].includes(key) && /^[\w.-]+$/.test(value);
  };
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^PYTHON(?:HOME|PATH|USERBASE|STARTUP)$/i.test(key)) return;
    if (/^PIP_/i.test(key) && !setting(key.slice(4), value)) return;
  }
  const user = get('HOME') ?? get('USERPROFILE') ?? homedir();
  const configs = process.platform === 'win32'
    ? [join(get('PROGRAMDATA') ?? 'C:\\ProgramData', 'pip', 'pip.ini'), join(user, 'pip', 'pip.ini'), join(get('APPDATA') ?? join(user, 'AppData', 'Roaming'), 'pip', 'pip.ini')]
    : [...(get('XDG_CONFIG_DIRS') ?? '/etc/xdg').split(':').map(path => join(path, 'pip', 'pip.conf')), '/etc/pip.conf', join(user, '.pip', 'pip.conf'), join(get('XDG_CONFIG_HOME') ?? join(user, '.config'), 'pip', 'pip.conf')];
  if (configs.some(path => !isAbsolute(path)) || configs.length > 20) return;
  if (venv) configs.push(join(venv, process.platform === 'win32' ? 'pip.ini' : 'pip.conf'));
  for (const path of new Set(configs)) {
    const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!info) { evidence.push(`${redact(path)}: 无 pip 配置`); continue; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192 || await realpath(path) !== resolve(path)) return;
    const text = await readFile(path, 'utf8');
    if (stamp(await lstat(path)) !== stamp(info)) return;
    let section = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || /^[#;]/.test(line)) continue;
      if (/^\[[\w-]+\]$/.test(line)) { section = line.slice(1, -1); if (section === 'DEFAULT') return; continue; }
      const pair = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
      if (!pair || !section) return;
      if (['global', 'install'].includes(section) && !setting(pair[1]!, pair[2]!)) return;
    }
    evidence.push(`${redact(path)}: pip 配置身份 ${stamp(info)}；SHA256 ${createHash('sha256').update(text).digest('hex')}；未发现安装目标、加载或信任覆盖；配置正文不输出`);
  }
  evidence.push(`安装源候选：${[...sources].join('、') || '默认 https://pypi.org/simple/'}；包下载和构建钩子仍须审核。`);
  return evidence;
}

/** Include existing descendants in the identity and reject link redirects before an installer can overwrite them. */
async function targetEvidence(path: string, root: string): Promise<string | undefined> {
  const realRoot = await realpath(root), real = await canonical(path);
  if (!isInside(root, path) || resolve(path) === resolve(root) || !isInside(realRoot, real)
    || real !== resolve(realRoot, relative(root, path)) || isProtectedPath(real, [realRoot], true)) return;
  const pending = [path], hash = createHash('sha256');
  let count = 0;
  while (pending.length) {
    if (++count > 4096) return;
    const entry = pending.shift()!;
    const info = await lstat(entry).catch(error => { if (error.code === 'ENOENT' && entry === path) return undefined; throw error; });
    if (!info) { hash.update(`new:${await canonical(entry)}`); continue; }
    if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile()) || info.isFile() && info.nlink > 1 || entry === path && !info.isDirectory()) return;
    hash.update(`${relative(path, entry)}:${stamp(info)}:${info.mode}\n`);
    if (info.isDirectory()) {
      const names = await readdir(entry);
      if (count + pending.length + names.length > 4096) return;
      pending.push(...names.sort().map(name => join(entry, name)));
    }
  }
  return `${real}；目录树身份 ${hash.digest('hex')}（${count} 个路径，无链接重定向）`;
}

/** Evidence for routing a project pip request to review, never an execution grant.
 * The reviewer still sees the entire shell expression, requested permissions and startup effects. */
export async function projectPipEvidence(command: string, cwd: string, env?: NodeJS.ProcessEnv, projectRoot = cwd): Promise<string[] | undefined> {
  if (!/\bpip\s+install\b/i.test(command) || !isAbsolute(cwd) || !isInside(projectRoot, cwd)) return;
  const words = installWords(command);
  if (!words || words[1] !== '-m' || words[2] !== 'pip' || words[3] !== 'install') return;
  const word = words[0]!;
  let target: string | undefined, cache: string | undefined, noCache = false, packages = 0;
  for (let i = 4; i < words.length; i++) {
    const arg = words[i]!;
    const option = /^(--target|--cache-dir)(?:=(.*))?$/.exec(arg);
    if (option || arg === '-t') {
      const value = option?.[2] ?? words[++i];
      if (!value || value.startsWith('-')) return;
      if (option?.[1] === '--cache-dir') { if (cache || noCache) return; cache = resolve(cwd, value); }
      else { if (target) return; target = resolve(cwd, value); }
    } else if (arg === '--no-cache-dir') { if (cache || noCache) return; noCache = true; }
    else if (['--upgrade', '--no-deps', '--disable-pip-version-check', '--no-input', '-q', '--quiet'].includes(arg)) continue;
    else if (/^[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9_,.-]+\])?(?:(?:==|~=)[a-z0-9.*+_-]+)?$/i.test(arg) && !/\.(?:whl|zip|tar\.gz)$/i.test(arg)) packages++;
    else return;
  }
  if (!packages) return;
  const virtual = /[\\/]+(?:bin[\\/]+python(?:3(?:\.\d+)?)?|Scripts[\\/]+python\.exe)$/i.test(word);
  if (!virtual && !target || target && !cache && !noCache) return;
  try {
    let executable = resolve(cwd, word);
    if (!/[\\/]/.test(word)) {
      if (!env || !/^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(word)) return;
      const path = Object.entries(env).find(([key]) => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH')?.[1];
      if (!path || path.split(process.platform === 'win32' ? ';' : ':').some(part => !isAbsolute(part.replace(/^"(.*)"$/, '$1')))) return;
      const found = await onPath(word, env);
      if (!found || process.platform === 'win32' && !/\.exe$/i.test(found)) return;
      executable = found;
      if (process.platform === 'win32') for (const suffix of ['', '.exe', '.com', '.cmd', '.bat', '.ps1']) {
        if (await lstat(resolve(cwd, word.replace(/\.exe$/i, '') + suffix)).then(() => true, () => false)) return;
      }
    } else if (!virtual && !/[\\/]python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(word)) return;
    const venv = dirname(dirname(executable));
    const configEvidence = await pipConfiguration(env ?? {}, virtual ? venv : undefined);
    if (!configEvidence) return;
    const binary = await realpath(executable), binaryInfo = await stat(binary);
    if (!binaryInfo.isFile()) return;
    if (target) {
      const destination = await targetEvidence(target, projectRoot);
      const cacheState = cache ? await targetEvidence(cache, projectRoot) : undefined;
      if (!destination || cache && !cacheState) return;
      return [`项目目录依赖安装候选：工作目录 ${cwd}；解释器 ${executable} -> ${binary}；身份 ${stamp(binaryInfo)}；--target ${destination}；${cacheState ? `缓存 ${cacheState}` : '禁用下载缓存'}。仅进入审核，不授权整条命令；核对解释器启动钩子、pip 模块来源及安装脚本。`, ...configEvidence];
    }
    const realRoot = await realpath(cwd), realVenv = await realpath(venv);
    if (!isInside(cwd, venv) || venv === resolve(cwd) || !isInside(realRoot, realVenv)
      || isProtectedPath(realVenv, [realRoot], true)) return;
    const config = resolve(venv, 'pyvenv.cfg');
    const info = await lstat(config);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) return;
    const text = await readFile(config, 'utf8');
    const settings = text.split(/\r?\n/).filter(line => /^include-system-site-packages\s*=/i.test(line));
    if (!/^home\s*=\s*\S.+$/mi.test(text) || settings.length !== 1 || !/^include-system-site-packages\s*=\s*false\s*$/i.test(settings[0]!)) return;
    // Site directories must not redirect installation outside the virtual environment.
    for (const name of ['Lib', 'lib', 'lib64']) {
      const path = resolve(venv, name);
      try { if (!isInside(realVenv, await realpath(path))) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    }
    const sites = [resolve(venv, 'Lib', 'site-packages')];
    for (const name of ['lib', 'lib64']) {
      const entries = await readdir(resolve(venv, name)).catch(() => []);
      for (const entry of entries.filter(value => /^python[0-9.]+$/.test(value))) sites.push(resolve(venv, name, entry, 'site-packages'));
    }
    for (const site of sites) {
      try { if (!isInside(realVenv, await realpath(site))) return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    }
    const identity = `${binaryInfo.dev}:${binaryInfo.ino}:${binaryInfo.size}:${binaryInfo.mtimeMs}:${binaryInfo.ctimeMs}`;
    if (cache && !await targetEvidence(cache, projectRoot)) return;
    return [`项目虚拟环境候选：${realVenv}${sep}；显式解释器 ${executable} -> ${binary}；身份 ${identity}；pyvenv.cfg SHA256 ${createHash('sha256').update(text).digest('hex')}。include-system-site-packages=false。仅允许进入审核，不证明整条命令安全；核对 shell、环境赋值、pip 配置、安装来源及安装钩子，无法确认实际安装目标时转人工。`, ...configEvidence];
  } catch { return; }
}
