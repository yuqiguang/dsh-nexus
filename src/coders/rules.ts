import { isIP } from 'node:net';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import type { CoderRequest } from './types.js';
import { commandPath } from './command-path.js';

/**
 * Hard rules are fixed in code. They only deny or escalate, never allow, and no
 * later layer (habit rules, model judgment, learning) may override them.
 */
export type HardVerdict = {
  verdict: 'deny' | 'escalate';
  reason: string;
  /** What was blocked, so repeated attempts at one block group together instead of looking like unrelated rejections. */
  key?: string;
  /** High-impact actions need the owner's explicit decision, never an automatic review. */
  manualOnly?: boolean;
};

/**
 * Registry config. It can carry an `_authToken`, so it is protected like a credential everywhere except inside a task's own
 * directory. A fresh project's `.npmrc` holds `registry` and `store-dir` and no secret, and denying it by name once cost a real
 * task 48 minutes and eight identical rejections over a single `store-dir` line (ct-b5bb174b). The files that actually carry
 * tokens — `~/.npmrc`, `/etc/npmrc` — stay protected, so nothing new becomes readable.
 */
const PACKAGE_CONFIG = /^\.(npmrc|netrc)$/;
const PROTECTED_BASENAMES = [/^\.env(\..+)?$/, /credentials/i, /^id_rsa/, /^id_ed25519/, /^id_ecdsa/, /\.pem$/];
const PROTECTED_DIRS = ['.ssh', '.dsh', '.nexus', '.gnupg', '.aws', '.config/gh'];

export function isEnvironmentFile(path: string): boolean { return /^\.env(?:\..+)?$/i.test(baseName(path)); }
export function isEnvironmentTemplate(path: string): boolean { return /^\.env\.(?:example|sample|template)$/i.test(baseName(path)); }

/** Naming an output is not permission to read/write it. Credential directories still win. */
export function isProjectEnvironment(path: string, cwd: string, standard: boolean): boolean {
  return isAbsolute(path) && isInside(cwd, path) && isEnvironmentFile(path)
    && !isProtectedPath(dirname(path), [cwd], standard);
}

const DENY_COMMANDS: readonly [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)\s+(\/|~\/?|\$HOME\/?)(\s|$|\*)/i, '删除根目录或家目录'],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, '下载脚本直接执行'],
  [/\bmkfs(\.\w+)?\b/, '格式化磁盘'],
  [/\bdd\s+[^|;]*\bof=\/dev\//, '直接写磁盘设备'],
  [/>\s*\/dev\/(sd|nvme|hd)/, '直接写磁盘设备'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, 'fork 炸弹'],
];

const ESCALATE_COMMANDS: readonly [RegExp, string][] = [
  [/\bgit\s+(?:reset\b[^|;&]*--hard|clean\b)/, '丢弃已有工作区改动'],
  [/\b(?:kill|pkill|killall)\s/, '终止进程，需要确认目标'],
  [/\bgit\s+push\b/, 'git push'],
  [/\bgit\s+[^|;&]*--force(-with-lease)?\b/, 'git 强制操作'],
  [/\bgit\s+branch\s+(-D|--delete\s+--force)\b/, '强制删除分支'],
  [/\bgit\s+push\s+[^|;&]*--delete\b/, '删除远程分支'],
  [/\b(npm|pnpm|yarn)\s+publish\b/, '发布包'],
  [/\bdocker\s+push\b/, '推送镜像'],
  [/\bsudo\b/, '提权'],
  [/\bchmod\s+(-R\s+)?[0-7]*777\b/, '开放全部权限'],
  [/\bchown\s+(-R\s+)?root\b/, '改为 root 所有'],
  [/\bssh\s/, '远程登录'],
  [/\bscp\s/, '远程复制'],
  [/\b(npm|pnpm|yarn)\s+(install|add|i)\s+(-g|--global)\b/, '安装全局依赖'],
  [/\b(apt|apt-get|yum|dnf|brew)\s+(install|remove|purge)\b/, '修改系统软件'],
  [/\bsystemctl\s+(start|stop|restart|enable|disable)\b/, '修改系统服务'],
  [/\bcrontab\b/, '修改定时任务'],
];

function normalizeRoot(root: string): string {
  return resolve(root);
}

/** True when `path` equals `root` or lies below it after resolving `..` segments. */
export function isInside(root: string, path: string): boolean {
  const between = relative(normalizeRoot(root), resolve(path));
  return between === '' || (between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between));
}

function insideAny(roots: readonly string[], path: string): boolean {
  return roots.some(root => isInside(root, path));
}

/** The last segment, so `~/.npmrc` and `<task>/.npmrc` are recognised as the same block rather than two unrelated ones. */
function baseName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() ?? path;
}

/** Only Nexus's dedicated workspace, inside this task's existing boundary. Never arbitrary DSH data. */
export function isDshWorkspacePath(path: string, roots: readonly string[] = []): boolean {
  return isAbsolute(path) && isInside(dshHomePath('nexus-workspace'), path) && insideAny(roots, path);
}

/**
 * Credential-looking file names and directories that a coder must never read or write. Purely lexical: no cwd lookup, and no
 * content is read to tell a token from a setting. Given the task roots, a package-manager config inside one of them is the
 * task's own file rather than the user's credentials; see {@link PACKAGE_CONFIG}.
 */
export function isProtectedPath(path: string, roots?: readonly string[], standard = false): boolean {
  const expanded = commandPath(path).replace(/^~(?=\/|$)/, homedir()).replace(/^\$HOME(?=\/|$)/, homedir());
  // Callers canonicalize file targets first. Keep checking all nested sensitive names;
  // stripping this exact prefix must not exempt workspace/.ssh or a symlink into credentials.
  const scoped = standard && isDshWorkspacePath(expanded, roots) ? relative(dshHomePath('nexus-workspace'), resolve(expanded)) : expanded;
  const segments = scoped.split(/[\\/]+/).filter(segment => segment && segment !== '.').map(part => process.platform === 'win32' ? part.toLowerCase() : part);
  const name = segments[segments.length - 1] ?? '';
  // Only a path that names its own directory can be placed. A bare `cat .npmrc` in a command runs wherever that command's own
  // cwd is — which this function cannot see and must not guess at — so it keeps the protected answer rather than being placed
  // against a working directory that has nothing to do with where the command will actually run.
  const placed = roots !== undefined && isAbsolute(expanded) && insideAny(roots, resolve(expanded));
  if (name === '.npmrc' && placed) return false;
  if (resolve(expanded) === '/etc/npmrc') return true;
  if (PROTECTED_BASENAMES.some(pattern => pattern.test(name))) return true;
  if (PACKAGE_CONFIG.test(name)) return true;
  for (const dir of PROTECTED_DIRS) {
    const parts = dir.split('/');
    for (let index = 0; index + parts.length <= segments.length; index++) {
      if (parts.every((part, offset) => segments[index + offset] === part)) return true;
    }
  }
  const home = homedir().split(sep).filter(Boolean);
  const underHome = home.every((part, index) => segments[index] === part) && segments.length === home.length + 1;
  return underHome && ['.bashrc', '.profile', '.zshrc', '.bash_profile'].includes(name);
}

/** Path-shaped words in a shell command, with quoting removed. A quoted argument that itself looks like a command line is
 * split again, so `bash -c "cat .env"` yields the inner path too. Used for credential matching and template exemptions. */
export function commandPathTokens(command: string, roots: readonly string[] = []): string[] {
  const split = (text: string, depth = 0): string[] => (text.match(/"[^"]*"|'[^']*'|[^\s'"`;|&<>()]+/g) ?? []).flatMap(token => {
    if (!/^['"]/.test(token)) return [token];
    const value = commandPath(token.slice(1, -1));
    if (!/\s/.test(value) || depth >= 4) return [value];
    const nested = split(value, depth + 1).filter(part => !(isDshWorkspacePath(value, roots)
      && isAbsolute(part) && value.startsWith(part + ' ')));
    return isAbsolute(value) ? [value, ...nested] : nested;
  });
  return split(command);
}

/** `exempt` is consulted per token and only ever skips that one mention: the remaining tokens still decide, so
 * `cp .env.example .env` is denied on `.env` even when the template itself is a verified placeholder file. */
function mentionsProtectedPath(command: string, roots: readonly string[], standard: boolean, exempt?: (token: string) => boolean): string | undefined {
  for (const token of commandPathTokens(command, roots)) {
    if (/[\/.~]/.test(token) && isProtectedPath(token, roots, standard) && !exempt?.(token)) return token;
  }
  return undefined;
}

/** Only native read-only research tools qualify; never commands or generic network grants.
 * URL parsing excludes explicit local targets. DNS/redirect enforcement remains with native WebFetch.
 */
export function isPublicWebRequest(request: CoderRequest): boolean {
  if (request.kind !== 'network' || request.paths.length) return false;
  if (request.tool === 'WebSearch') return typeof request.raw.query === 'string' && request.raw.query.trim().length > 0;
  if (request.tool !== 'WebFetch' || typeof request.raw.url !== 'string') return false;
  try {
    const url = new URL(request.raw.url);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port
      && host.includes('.') && !isIP(host) && !host.includes(':')
      && !['localhost', 'local', 'internal', 'lan', 'home', 'test', 'invalid'].some(suffix => host === suffix || host.endsWith(`.${suffix}`));
  } catch { return false; }
}

/**
 * First decision layer. Returns `undefined` when no hard rule applies, which
 * never means "allow": the caller continues with the next layer.
 * `safeTemplates` holds paths already verified against their own content as placeholder-only project templates: they exempt a
 * file operation on that exact file, and a command that merely names that exact file, from the credential rule.
 */
export function hardRule(request: CoderRequest, roots: readonly string[], webResearch = false, standard = false,
  cwd = roots[0] ?? '', safeTemplates: readonly string[] = [], projectPip = false): HardVerdict | undefined {
  if (request.tool === 'codex.permissions') return { verdict: 'deny', reason: '无人值守任务不授予整个回合额外权限，请按具体命令或文件操作申请', key: 'turn-permissions' };
  const scopedWrite = request.kind === 'file-write' && ['Write', 'Edit', 'codex.fileChange'].includes(request.tool) && !request.raw.grantRoot && !request.raw.additionalPermissions;
  const environment = request.paths.filter(path => isProjectEnvironment(path, cwd, standard));
  const safeTemplate = (path: string) => environment.includes(path) && isEnvironmentTemplate(path) && safeTemplates.includes(path);
  const protectedPath = request.paths.find(path => isProtectedPath(path, roots, standard) && !safeTemplate(path)
    && !(standard && scopedWrite && environment.includes(path)));
  if (protectedPath) return { verdict: 'deny', reason: `涉及凭据或密钥文件：${protectedPath}`, key: `credential:${baseName(protectedPath)}` };
  if (environment.some(path => !safeTemplate(path))) return { verdict: 'escalate', manualOnly: true,
    reason: '本次写入项目环境配置文件，可能包含凭据；需你确认，仅授权所列文件的这次修改，内容不在审批消息中展示' };
  const outside = request.paths.find(path => !insideAny(roots, path));
  if (outside && (request.kind === 'file-write' || request.kind === 'file-read' || request.kind === 'other')) {
    return { verdict: 'escalate', reason: `路径在任务根目录之外：${outside}` };
  }
  if (request.kind === 'command') {
    if (!standard && request.tool === 'Bash' && (request.raw.dangerouslyDisableSandbox === true || outside)) return { verdict: 'deny', reason: 'Claude 命令不能临时解除沙箱限制。目录外文件请改用文件工具申请审批；缺少联网域名请在设置中授权后新建任务。', key: 'claude-sandbox-boundary' };
    const mentioned = mentionsProtectedPath(request.detail, roots, standard, token => {
      if (!safeTemplates.length) return false;
      const resolved = resolve(cwd, commandPath(token));
      return insideAny(roots, resolved) && safeTemplates.includes(resolved);
    });
    if (mentioned) return { verdict: 'deny', reason: `命令涉及凭据或密钥文件：${mentioned}`, key: `credential:${baseName(mentioned)}` };
    for (const [pattern, reason] of DENY_COMMANDS) if (pattern.test(request.detail)) return { verdict: 'deny', reason, key: `command:${reason}` };
    for (const [pattern, reason] of ESCALATE_COMMANDS) if (pattern.test(request.detail)) return { verdict: 'escalate', reason, manualOnly: true };
    if (/\bpip(?:3)?\s+install\b/i.test(request.detail)) return { verdict: 'escalate',
      reason: standard && projectPip ? '项目虚拟环境依赖安装，需审核本次命令和安装来源' : 'Python 依赖安装目标尚未核验，需要你确认', manualOnly: !(standard && projectPip) };
    if (outside) return { verdict: 'escalate', reason: `命令访问任务根目录之外的路径：${outside}` };
    return undefined;
  }
  if (request.kind === 'network' && !(webResearch && isPublicWebRequest(request))) return { verdict: 'escalate', reason: '网络请求' };
  return undefined;
}
