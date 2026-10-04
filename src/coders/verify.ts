import { spawnTaskProcess, stopTaskProcess, taskProcessArgv, taskProcessCleaned } from './process.js';
import { canonical } from './permissions.js';
import { execFile, spawn } from 'node:child_process';
import { readdir, stat, lstat, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isInside } from './rules.js';
import { createOutputDecoder, pythonUtf8Output } from './decode.js';
import type { TaskRecord } from './types.js';

const run = promisify(execFile);

export class SnapshotError extends Error {}

export interface VerifyResult {
  preflightCheck?: { command: string; ok: boolean; executed: boolean; output: string };
  changedFiles: string[];
  commits?: string[];
  outsideRoots: string[];
  verifyOk?: boolean;
  verifyOutput?: string;
  verifyExecuted?: boolean;
  verifyChecks?: { command: string; ok: boolean; executed: boolean; output: string }[];
}

/**
 * The work tree as it was when a task was dispatched. Taken again when the task ends, the difference is what the task changed; a
 * leftover from an earlier task or the user's own uncommitted edits are not. In a git work tree (`git`) it is HEAD and every dirty
 * or untracked file; git cannot see into a directory it ignores or one outside any repository, so there (`walk`) it is every file
 * under the task directory.
 */
export interface WorkTreeSnapshot {
  kind: 'git' | 'walk';
  head: string;
  /** Absolute path → `<status> <mode> <sha256>`, or `<status> gone` for a deleted file; `walk` has no status. */
  files: Map<string, string>;
}

const VERIFY_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_LIMIT = 8 * 1024;
const GIT_BUFFER = 4 * 1024 * 1024;

/** Windows paths keep backslashes; quotes delimit argv without introducing a shell. */
export function windowsVerifyWords(command: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = ''; else word += char; started = true; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { if (/[&|;<>`$\r\n]/.test(char)) throw new Error('验证只接受单条命令，不支持 shell 运算符。'); word += char; started = true; }
  }
  if (quote) throw new Error('验证命令的引号未闭合。');
  if (started) words.push(word);
  if (words.length && !words[0]) throw new Error('验证程序不能为空。');
  return words;
}
/** Files a `walk` snapshot fingerprints at most; directories that are never a task's own output are skipped. */
const WALK_LIMIT = 50_000;
/**
 * Dependency and build caches. They are never a task's deliverable, and one real task put a 61 MB pnpm content-addressable
 * store in its project directory, which made a 34-file change report as 679 files because the store's blobs were counted
 * (ct-b5bb174b). `.gitignore` cannot help here: a directory with no repository is walked rather than read through `git status`.
 */
const WALK_SKIP = new Set(['.git', 'node_modules', '.pnpm-store', '.pnpm', '.yarn', '.turbo', '.cache', '.gradle', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.npm-cache']);

/** Dirty and untracked paths from `git status --porcelain -z`, absolute and with their two-letter status; `-z` keeps non-ASCII names literal. */
export async function workspaceScope(cwd: string, signal?: AbortSignal): Promise<string> {
  return run('git', ['rev-parse', '--show-toplevel'], { cwd, signal, timeout: 10_000 }).then(result => resolve(result.stdout.trim()), () => { signal?.throwIfAborted(); return resolve(cwd); });
}

async function dirtyFiles(cwd: string, signal?: AbortSignal): Promise<{ top: string; files: [string, string][] } | undefined> {
  let top: string;
  try { top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd, signal, timeout: 10_000 })).stdout.trim(); }
  catch { signal?.throwIfAborted(); return undefined; }
  let stdout: string;
  try { stdout = (await run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd, signal, maxBuffer: GIT_BUFFER, timeout: 30_000 })).stdout; }
  catch { throw new SnapshotError('无法完整读取 Git 改动清单，未将部分扫描当作验证结果。'); }
  const fields = stdout.split('\0'), files: [string, string][] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    files.push([resolve(top, field.slice(3)), status]);
    if (status.includes('R') || status.includes('C')) index++;
  }
  return { top, files };
}

async function fingerprint(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return 'gone';
  if (info.isSymbolicLink()) return `link ${await readlink(path)}`;
  if (!info.isFile()) return `kind ${info.mode}`;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  const after = await stat(path);
  if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new SnapshotError('扫描期间文件发生变化，请停止其他写入后重新验证。');
  return `${info.mode} ${hash.digest('hex')}`;
}

/** Every file under `root` with its content hash, breadth first, up to {@link WALK_LIMIT}. */
async function walkFiles(root: string, signal?: AbortSignal, limit = WALK_LIMIT): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [resolve(root)];
  while (queue.length) {
    signal?.throwIfAborted();
    const directory = queue.shift()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const browserProfile = !WALK_SKIP.has(entry.name) && await stat(join(path, 'Local State')).then(item => item.isFile(), () => false)
          && await stat(join(path, 'Default')).then(item => item.isDirectory(), () => false);
        if (!WALK_SKIP.has(entry.name) && !browserProfile) queue.push(path);
      }
      else if (entry.isFile() || entry.isSymbolicLink()) {
        if (files.size >= limit) throw new SnapshotError(`工作区扫描超过 ${limit} 个文件，无法完整核验；请缩小任务目录或使用 Git 管理。`);
        files.set(path, await fingerprint(path, signal));
      }
    }
  }
  return files;
}

/** True when git ignores the directory itself, so `git status` says nothing about the files in it. */
async function ignoredByGit(cwd: string, signal?: AbortSignal): Promise<boolean> {
  return run('git', ['check-ignore', '-q', resolve(cwd)], { cwd, signal }).then(() => true, () => false);
}

/** The current work tree: from git when git can see the directory, else by walking it. */
export async function snapshotWorkTree(cwd: string, signal?: AbortSignal, maxFiles = WALK_LIMIT): Promise<WorkTreeSnapshot> {
  signal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120_000)]);
  const dirty = await dirtyFiles(cwd, signal);
  if (!dirty || await ignoredByGit(cwd, signal)) return { kind: 'walk', head: '', files: await walkFiles(cwd, signal, maxFiles) };
  const head = await run('git', ['rev-parse', 'HEAD'], { cwd, signal }).then(result => result.stdout.trim(), () => '');
  const files = new Map<string, string>();
  for (const [path, status] of dirty.files) {
    if (files.size >= maxFiles) throw new SnapshotError(`Git 改动超过 ${maxFiles} 个文件，无法完整核验。`);
    const info = await fingerprint(path, signal);
    files.set(path, `${status} ${info}`);
  }
  return { kind: 'git', head, files };
}

/**
 * Files the task changed, absolute. Without a baseline every dirty file counts, as `git status` lists it; a walked directory has
 * no notion of dirty, so nothing does. With one, a file counts when it is dirty now and was clean or different at dispatch, or when
 * it is in a commit the task made; in a walked directory, when it is new, different, or gone.
 */
export async function changedFiles(cwd: string, baseline?: WorkTreeSnapshot, signal?: AbortSignal): Promise<string[]> {
  const now = await snapshotWorkTree(cwd, signal);
  if (!baseline) return now.kind === 'git' ? [...now.files.keys()] : [];
  if (now.kind !== baseline.kind) {
    if (baseline.kind === 'walk') {
      const files = await walkFiles(cwd, signal);
      return [...new Set([...files.keys(), ...baseline.files.keys()])].filter(path => files.get(path) !== baseline.files.get(path)).sort();
    }
    throw new SnapshotError('Git 工作区结构发生变化，无法可靠比较改动。');
  }
  const changed = new Set([...now.files].filter(([path, fingerprint]) => baseline.files.get(path) !== fingerprint).map(([path]) => path));
  for (const path of baseline.files.keys()) if (!now.files.has(path)) changed.add(path);
  if (now.kind === 'walk') {
    return [...changed].sort();
  }
  if (baseline.head && now.head && baseline.head !== now.head) {
    const top = (await run('git', ['rev-parse', '--show-toplevel'], { cwd, signal })).stdout.trim();
    const committed = await run('git', ['diff', '--name-only', '-z', baseline.head, now.head], { cwd, signal, maxBuffer: GIT_BUFFER })
      .then(result => result.stdout.split('\0').filter(Boolean));
    for (const path of committed) changed.add(resolve(top, path));
  }
  return [...changed].sort();
}

/** Run the user's verify command without a shell: the first word is the program, the rest are arguments. */
export async function runVerifyCommand(command: string, cwd: string, signal?: AbortSignal, confine?: (argv: string[], command: string) => Promise<string[]>, extraEnv?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string; executed?: boolean }> {
  if (!await stat(cwd).then(info => info.isDirectory(), () => false)) return { ok: false, executed: false, output: `验证未执行：验证目录不存在或不可访问：${cwd}。verify_cwd 相对于任务 cwd；项目根目录请填写 .，不要重复项目目录名。` };
  let words: string[];
  try { words = process.platform === 'win32' ? windowsVerifyWords(command) : command.trim().split(/\s+/); }
  catch (error) { return { ok: false, executed: false, output: (error as Error).message }; }
  const [program, ...args] = words;
  if (!program) return Promise.resolve({ ok: true, output: '' });
  let argv = [program, ...args];
  try { if (confine) argv = await confine(argv, command); signal?.throwIfAborted(); }
  catch (error) { return { ok: false, executed: false, output: `验证未执行：${(error as Error).message}` }; }
  return new Promise(resolvePromise => {
    let output = '';
    let settled = false;
    let timedOut = false;
    let streamFailed = false;
    argv = taskProcessArgv(argv);
    const env = Object.fromEntries(Object.entries({ ...process.env, ...pythonUtf8Output(), ...extraEnv }).filter(([key]) => !/TOKEN|SECRET|PASSWORD|KEY|AUTH|^DSH_/i.test(key)
      && !(process.platform === 'win32' && /PROXY/i.test(key))));
    const child = process.platform === 'win32' ? spawnTaskProcess(argv[0]!, argv.slice(1), cwd, env)
      : spawn(argv[0]!, argv.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal, detached: true, env });
    if (process.platform === 'win32') child.stdin?.end();
    const kill = () => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else stopTaskProcess(child as import('node:child_process').ChildProcessWithoutNullStreams); } catch { /* already stopped */ } };
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    // Node's own `timeout` option leaks its timer when the program does not exist; keep the timer here and unref it.
    const timer = setTimeout(() => { timedOut = true; output += '\n[verify timed out]'; kill(); }, VERIFY_TIMEOUT_MS);
    timer.unref();
    const settle = (result: { ok: boolean; output: string; executed?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      kill();
      resolvePromise(result);
    };
    const decoder = createOutputDecoder();
    const collect = (chunk: Buffer) => { output = (output + decoder.push(chunk)).slice(-OUTPUT_LIMIT); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const brokenPipe = () => { streamFailed = true; output += '\n验证进程输出连接中断。'; kill(); };
    child.stdout.on('error', brokenPipe);
    child.stderr.on('error', brokenPipe);
    child.on('error', error => { output += decoder.flush(); settle({ ok: false, executed: !!child.pid, output: `${output}\n${child.pid ? '验证进程错误' : '验证未执行：进程启动失败'}：${error.message}`.trim() }); });
    child.on('close', (code, signalName) => { output += decoder.flush(); settle({ ok: code === 0 && !timedOut && !streamFailed && !signal?.aborted && taskProcessCleaned(child),
      output: !taskProcessCleaned(child) ? `${output}\n无法确认 Windows 验证进程已完全清理。` : code === 0 ? output : `${output}\n[exit ${code ?? signalName ?? 'unknown'}]`.trim() }); });
  });
}

/** The supervisor's own check after the coder reports completion; never trusts the coder's summary. */
export async function verifyTask(task: Pick<TaskRecord, 'cwd' | 'verify' | 'verifyCommands' | 'verifyCwd'>, roots: readonly string[], baseline?: WorkTreeSnapshot, signal?: AbortSignal, confine?: (argv: string[], command: string) => Promise<string[]>, extraEnv?: NodeJS.ProcessEnv, onCheck?: (check: NonNullable<VerifyResult['verifyChecks']>[number]) => void): Promise<VerifyResult> {
  const result: VerifyResult = { changedFiles: [], outsideRoots: [] };
  if (task.verify) {
    const directory = await canonical(task.verifyCwd ?? task.cwd);
    if (!isInside(await canonical(task.cwd), directory)) throw new SnapshotError('验证目录必须位于任务目录内，不能通过符号链接越界。');
    const checks: NonNullable<VerifyResult['verifyChecks']> = [];
    for (const command of [task.verify, ...(task.verifyCommands ?? [])]) {
      if (checks.some(check => !check.ok) || signal?.aborted) {
        checks.push({ command, ok: false, executed: false, output: '未执行：前项未通过或任务已取消。' });
        continue;
      }
      const problem = await verifyPreflight(command, directory);
      const verify = problem ? { ok: false, executed: false, output: problem } : await runVerifyCommand(command, directory, signal, confine, extraEnv);
      checks.push({ command, ok: verify.ok, executed: verify.executed !== false, output: verify.output });
      // Preserve preflight evidence even if cancellation interrupts the following filesystem audit.
      onCheck?.(checks.at(-1)!);
    }
    result.verifyChecks = checks;
    result.verifyOk = checks.every(check => check.ok);
    result.verifyExecuted = checks.some(check => check.executed);
    result.verifyOutput = checks.length === 1 ? checks[0]!.output : checks.map(check => `验证 ${check.command}：${!check.executed ? '未执行' : check.ok ? '通过' : '失败'}\n${check.output}`).join('\n');
  }
  const files = await changedFiles(task.cwd, baseline, signal);
  result.changedFiles = files; result.outsideRoots = files.filter(file => !roots.some(root => isInside(root, file)));
  if (baseline?.head) {
    const commits = await run('git', ['rev-list', '--max-count=50', `${baseline.head}..HEAD`], { cwd: task.cwd, signal }).then(result => result.stdout.trim().split('\n').filter(hash => /^[a-f0-9]{40,64}$/.test(hash)), () => []);
    if (commits.length) result.commits = commits;
  }
  return result;
}

/** Inspect a package-manager invocation without guessing a project from task prose. */
export async function verifyPreflight(command: string, cwd: string): Promise<string | undefined> {
  const args = process.platform === 'win32' ? windowsVerifyWords(command) : command.trim().split(/\s+/);
  if (!['npm', 'pnpm', 'yarn'].includes(args[0]!) || !args.some(word => ['run', 'test', 'build'].includes(word))) return;
  let directory = cwd;
  for (let i = 1; i < args.length; i++) {
    if (['--prefix', '--dir', '-C', '--cwd'].includes(args[i]!)) directory = resolve(cwd, args[++i] ?? '.');
    else if (/^--(?:prefix|dir|cwd)=/.test(args[i]!)) directory = resolve(cwd, args[i]!.slice(args[i]!.indexOf('=') + 1));
  }
  if (await stat(join(directory, 'package.json')).then(info => info.isFile(), () => false)) return;
  const candidates: string[] = [];
  for (const entry of (await readdir(cwd, { withFileTypes: true }).catch(() => [])).slice(0,100)) {
    if (entry.isDirectory() && !WALK_SKIP.has(entry.name) && await stat(join(cwd, entry.name, 'package.json')).then(info => info.isFile(), () => false)) candidates.push(entry.name);
  }
  return `验证未执行：${directory} 没有 package.json。请将 cwd 设为实际项目目录，或用 verify_cwd 明确绑定子目录${candidates.length ? `（发现：${candidates.slice(0,5).join('、')}）` : ''}；不会自动猜测目录。`;
}
