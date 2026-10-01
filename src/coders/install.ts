import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { CoderKind } from './types.js';
import type { CodexSettings } from './settings.js';

/** Versions Nexus installs for itself; bump deliberately and rerun the adapter tests. */
export const MANAGED_PACKAGES: Record<CoderKind, { name: string; version: string }> = {
  // 0.155.0-alpha and 0.155.0 fail to build the bubblewrap sandbox when Docker leaves `net:[…]` nsfs mounts in mountinfo (WSL, 2026-09-20); 0.155.1 handles them.
  codex: { name: '@openai/codex', version: '0.155.1' },
  claude: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.273' },
};

/** Environment variable the generated Codex provider reads its key from. */
export const CODEX_KEY_ENV = 'NEXUS_CODEX_API_KEY';
export const CODEX_OFFICIAL_BASE_URL = 'https://api.openai.com/v1';

export interface ManagedLayout {
  /** `npm install` runs here; packages land in `node_modules`. */
  root: string;
  nodeModules: string;
  /** One marker per coder, written only after a complete install; its absence means "not installed" whatever `node_modules` holds. */
  markers: string;
  /** `CODEX_HOME` for managed Codex: its config.toml, auth, trust list, and sessions. */
  codexHome: string;
  /** `CLAUDE_CONFIG_DIR` for Claude Code run by Nexus, whichever SDK copy is used. */
  claudeHome: string;
}

export function managedLayout(root: string): ManagedLayout {
  return { root, nodeModules: join(root, 'node_modules'), markers: join(root, 'installed'), codexHome: join(root, 'codex-home'), claudeHome: join(root, 'claude-home') };
}

export interface HostPlatform { platform: NodeJS.Platform; arch: string; musl: boolean }

let cachedHost: HostPlatform | undefined;

/**
 * musl hosts ship the musl dynamic loader and lack the glibc one. Decided from
 * the filesystem once and cached: `process.report.getReport()` would also tell,
 * but it is synchronous and took 20 s inside the long-running DSH process.
 */
export function hostPlatform(): HostPlatform {
  if (cachedHost) return cachedHost;
  const musl = process.platform === 'linux' && existsSync(`/lib/ld-musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`)
    && !existsSync(process.arch === 'arm64' ? '/lib/ld-linux-aarch64.so.1' : '/lib64/ld-linux-x86-64.so.2');
  cachedHost = { platform: process.platform, arch: process.arch, musl };
  return cachedHost;
}

/**
 * The native package each coder needs on this machine. Both coders declare
 * these as optional dependencies, which npm skips silently when a download
 * fails; Nexus lists the right one explicitly so a missing binary fails the install.
 */
export function platformPackage(coder: CoderKind, host: HostPlatform = hostPlatform()): { name: string; spec: string; binary: string } {
  const { name, version } = MANAGED_PACKAGES[coder];
  const suffix = `${host.platform}-${host.arch}`;
  if (coder === 'codex') {
    return { name: `${name}-${suffix}`, spec: `npm:${name}@${version}-${suffix}`, binary: '' };
  }
  const pkg = `${name}-${suffix}${host.musl ? '-musl' : ''}`;
  return { name: pkg, spec: version, binary: host.platform === 'win32' ? 'claude.exe' : 'claude' };
}

export interface InstallStatus {
  installed: boolean;
  version?: string;
  /** Binary for Codex, SDK entry for Claude Code. */
  path?: string;
  /** Claude Code: the CLI the SDK should drive instead of its built-in binary. */
  executable?: string;
  /** Why an otherwise present install is unusable. */
  problem?: string;
}

export interface CoderDetection { managed: InstallStatus; system: InstallStatus }

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  return access(path, mode).then(async () => (await stat(path)).isFile()).catch(() => false);
}

async function packageVersion(directory: string): Promise<string | undefined> {
  try { return (JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { version?: string }).version; }
  catch { return undefined; }
}

/** Run a program with a timeout and return its trimmed combined output; never throws. */
export function probe(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolvePromise => {
    let output = '';
    let child;
    try { child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolvePromise({ ok: false, output: (error as Error).message }); return; }
    let settled = false;
    const settle = (result: { ok: boolean; output: string }) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    // On timeout, do not wait for `close`: a grandchild may keep the pipes open long after the child is gone.
    const timer = setTimeout(() => { child.kill('SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); settle({ ok: false, output: `${output}\n[probe timed out after ${timeoutMs} ms]`.trim() }); }, timeoutMs);
    timer.unref();
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4096); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => settle({ ok: false, output: `${output}\n${error.message}`.trim() }));
    child.on('close', code => settle({ ok: code === 0, output: output.trim() }));
  });
}

/** First executable named `name` on PATH, or undefined. */
export async function onPath(name: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | undefined> {
  const windows = platform === 'win32';
  const path = Object.entries(env).find(([key]) => windows ? key.toLowerCase() === 'path' : key === 'PATH')?.[1] ?? '';
  // Windows npm also writes extensionless POSIX scripts; those are not Windows executables.
  const extensions = windows && !/\.(?:exe|com|cmd|bat)$/i.test(name) ? ['.exe', '.com', '.cmd', '.bat'] : [''];
  for (const item of path.split(windows ? ';' : ':')) {
    const directory = item.replace(/^"(.*)"$/, '$1');
    if (!isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      // App Execution Aliases are launch stubs, not a usable unattended interpreter.
      if (windows && /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(name)
        && /(?:^|[\\/])Microsoft[\\/]WindowsApps(?:[\\/]|$)/i.test(candidate)) continue;
      if (await exists(candidate, constants.X_OK)) return candidate;
    }
  }
  return undefined;
}

/** Use the pinned Windows native executable, not npm's shell wrapper. */
export function managedCodexBinary(layout: ManagedLayout, host: HostPlatform = hostPlatform()): string {
  if (host.platform !== 'win32') return join(layout.nodeModules, '.bin', 'codex');
  const target = host.arch === 'x64' ? 'x86_64' : host.arch === 'arm64' ? 'aarch64' : undefined;
  if (!target) throw new Error(`unsupported_codex_arch: ${host.arch}`);
  return join(layout.nodeModules, platformPackage('codex', host).name, 'vendor', `${target}-pc-windows-msvc`, 'bin', 'codex.exe');
}

/** Resolve known npm Codex shims without interpreting a batch file or using a shell. */
async function systemCodexBinary(shim: string, host: HostPlatform): Promise<string | undefined> {
  if (host.platform !== 'win32' || /\.(?:exe|com)$/i.test(shim)) return shim;
  try {
    const fromShim = createRequire(join(dirname(shim), 'nexus-resolve.cjs'));
    const packageRoot = dirname(fromShim.resolve('@openai/codex/package.json'));
    const fromCodex = createRequire(join(packageRoot, 'package.json'));
    const nativeRoot = dirname(fromCodex.resolve(`${platformPackage('codex', host).name}/package.json`));
    const relative = host.arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    const binary = join(nativeRoot, 'vendor', relative, 'bin', 'codex.exe');
    return await exists(binary, constants.X_OK) ? binary : undefined;
  } catch { return undefined; }
}

/** Windows npm.cmd must be run through its Node entry, without cmd.exe quoting. */
export async function npmInvocation(command: string, env: NodeJS.ProcessEnv, platform = process.platform): Promise<{ command: string; args: string[] }> {
  if (platform !== 'win32' || !/^npm(?:\.cmd)?$/i.test(basename(command))) return { command, args: [] };
  const npm = isAbsolute(command) ? command : await onPath('npm', env, platform);
  if (!npm) throw new Error('npm_not_found: 请先安装 Windows Node.js 和 npm，并重新启动桌面端。');
  const cli = join(dirname(npm), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const adjacentNode = join(dirname(npm), 'node.exe');
  const node = await exists(adjacentNode, constants.X_OK) ? adjacentNode : await onPath('node', env, platform);
  if (!node || !await exists(cli)) throw new Error('npm_launcher_missing: 未找到 Windows npm 的 Node 启动文件，请修复 Node.js 安装。');
  return { command: node, args: [cli] };
}

export function parseCodexVersion(output: string): string | undefined {
  return /codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(output)?.[1];
}

/** `claude --version` prints `2.1.258 (Claude Code)`. */
export function parseClaudeVersion(output: string): string | undefined {
  return /^\s*v?(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(output)?.[1];
}

export interface DetectOptions {
  env?: NodeJS.ProcessEnv;
  host?: HostPlatform;
  /** Test seam for `codex --version` and `claude --version`. */
  probe?: typeof probe;
  /** Test seam for the SDK the plugin itself can import. */
  pluginSdk?: () => Promise<{ version: string; path: string } | undefined>;
}

let cachedPluginSdk: Promise<{ version: string; path: string } | undefined> | undefined;

/**
 * The Agent SDK resolvable from the plugin: its entry module and version. The
 * package hides package.json behind exports, so resolve the entry. Resolved
 * once: `import.meta.resolve` is synchronous and goes through the host's module
 * hooks, and the answer cannot change while the process runs.
 */
function pluginSdk(): Promise<{ version: string; path: string } | undefined> {
  return cachedPluginSdk ??= (async () => {
    try {
      const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
      const version = await packageVersion(dirname(entry));
      return version ? { version, path: entry } : undefined;
    } catch { return undefined; }
  })();
}

export interface InstallMarker { coder: CoderKind; version: string; platformPackage: string; at: number }

export async function readMarker(layout: ManagedLayout, coder: CoderKind): Promise<InstallMarker | undefined> {
  try {
    const marker = JSON.parse(await readFile(join(layout.markers, `${coder}.json`), 'utf8')) as InstallMarker;
    return marker?.coder === coder && typeof marker.version === 'string' ? marker : undefined;
  } catch { return undefined; }
}

export async function detectCodex(layout: ManagedLayout, options: DetectOptions = {}): Promise<CoderDetection> {
  const env = options.env ?? process.env;
  const run = options.probe ?? probe;
  const host = options.host ?? hostPlatform();
  const managedBin = managedCodexBinary(layout, host);
  const marker = await readMarker(layout, 'codex');
  let managed: InstallStatus = { installed: false };
  if (marker) {
    managed = marker.platformPackage === platformPackage('codex', host).name && await exists(managedBin, constants.X_OK) ? { installed: true, version: marker.version, path: managedBin }
      : { installed: false, version: marker.version, problem: 'binary_missing' };
  } else if (await packageVersion(join(layout.nodeModules, '@openai', 'codex'))) managed = { installed: false, problem: 'install_incomplete' };
  const systemShim = await onPath('codex', env, host.platform);
  const systemBin = systemShim ? await systemCodexBinary(systemShim, host) : undefined;
  let system: InstallStatus = { installed: false };
  if (systemShim && !systemBin) system = { installed: false, path: systemShim, problem: 'windows_launcher_unsupported' };
  if (systemBin) {
    const result = await run(systemBin, ['--version'], env);
    const version = parseCodexVersion(result.output);
    system = result.ok && version ? { installed: true, version, path: systemBin } : { installed: false, path: systemBin, problem: 'version_check_failed' };
  }
  return { managed, system };
}

export async function detectClaude(layout: ManagedLayout, options: DetectOptions = {}): Promise<CoderDetection> {
  const env = options.env ?? process.env;
  const run = options.probe ?? probe;
  const native = platformPackage('claude', options.host);
  const sdkDirectory = join(layout.nodeModules, '@anthropic-ai', 'claude-agent-sdk');
  const marker = await readMarker(layout, 'claude');
  let managed: InstallStatus = { installed: false };
  if (marker) {
    const binary = join(layout.nodeModules, native.name, native.binary);
    managed = await exists(join(sdkDirectory, 'sdk.mjs')) && await exists(binary, constants.X_OK)
      ? { installed: true, version: marker.version, path: join(sdkDirectory, 'sdk.mjs') }
      : { installed: false, version: marker.version, problem: 'platform_package_missing' };
  } else if (await packageVersion(sdkDirectory)) managed = { installed: false, problem: 'install_incomplete' };
  // "System" Claude Code: the plugin's own SDK drives the `claude` command on PATH, or its built-in binary when that matches this libc.
  const plugin = await (options.pluginSdk ?? pluginSdk)();
  let system: InstallStatus = { installed: false };
  if (plugin) {
    const cli = await onPath('claude', env, (options.host ?? hostPlatform()).platform);
    const executable = cli && !((options.host ?? hostPlatform()).platform === 'win32' && /\.(?:cmd|bat)$/i.test(cli)) ? cli : undefined;
    const result = executable ? await run(executable, ['--version'], env) : undefined;
    const cliVersion = result?.ok ? parseClaudeVersion(result.output) : undefined;
    if (executable && cliVersion) system = { installed: true, version: `claude ${cliVersion}（SDK ${plugin.version}）`, path: plugin.path, executable };
    else if (await exists(join(dirname(plugin.path), '..', '..', native.name, native.binary), constants.X_OK)) system = { installed: true, version: `SDK ${plugin.version} 内置`, path: plugin.path };
    else system = { installed: false, version: `SDK ${plugin.version}`, path: plugin.path, problem: cli && !executable ? 'windows_launcher_unsupported' : cli ? 'version_check_failed' : 'claude_cli_missing' };
  }
  return { managed, system };
}

/**
 * The managed Codex home's config.toml, regenerated from settings. Approval and
 * sandbox defaults provide a supported startup baseline. The adapter requests and
 * verifies untrusted approvals through the app-server API before starting any turn.
 * Codex 0.155 rejects untrusted in config.toml, but still supports it in thread RPCs.
 */
export function codexConfigToml(settings: Pick<CodexSettings, 'model' | 'baseUrl' | 'wireApi' | 'apiKey'>): string {
  const quote = (value: string) => JSON.stringify(value);
  const lines = ['# Generated by Nexus Next from the coder settings; saving the settings overwrites this file.',
    'approval_policy = "on-request"', 'sandbox_mode = "workspace-write"'];
  if (settings.model) lines.push(`model = ${quote(settings.model)}`);
  if (settings.apiKey) {
    lines.push('model_provider = "nexus"', '', '[model_providers.nexus]', 'name = "Nexus"',
      `base_url = ${quote(settings.baseUrl ?? CODEX_OFFICIAL_BASE_URL)}`, `env_key = ${quote(CODEX_KEY_ENV)}`,
      `wire_api = ${quote(settings.wireApi ?? 'responses')}`);
  }
  return lines.join('\n') + '\n';
}

export async function writeCodexHome(layout: ManagedLayout, settings: CodexSettings): Promise<void> {
  await mkdir(layout.codexHome, { recursive: true, mode: 0o700 });
  await writeFile(join(layout.codexHome, 'config.toml'), codexConfigToml(settings), { mode: 0o600 });
}

export async function ensureClaudeHome(layout: ManagedLayout): Promise<void> {
  await mkdir(layout.claudeHome, { recursive: true, mode: 0o700 });
}

export interface InstallProgress {
  coder: CoderKind;
  phase: 'installing' | 'installed' | 'failed';
  startedAt: number;
  finishedAt?: number;
  error?: string;
  /** Tail of npm's output, for the page. */
  log: string;
}

export type NpmRunner = (args: string[], cwd: string, onOutput: (chunk: string) => void, signal: AbortSignal) => Promise<{ code: number | null; error?: string }>;

/**
 * Runs npm in its own process group so a timeout can end the whole tree:
 * SIGTERM first, SIGKILL after the grace period. npm traps SIGTERM and may
 * keep downloading otherwise.
 */
export function createNpmRunner(command = 'npm', killGraceMs = 5_000): NpmRunner {
  return async (args, cwd, onOutput, signal) => {
    let invocation: Awaited<ReturnType<typeof npmInvocation>>;
    try { invocation = await npmInvocation(command, process.env); }
    catch (error) { return { code: null, error: (error as Error).message }; }
    if (signal.aborted) return { code: null, error: 'install_timeout' };
    return new Promise<{ code: number | null; error?: string }>(resolvePromise => {
      let child;
      try {
        child = spawn(invocation.command, [...invocation.args, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true,
          env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: 'false' } });
      } catch (error) { resolvePromise({ code: null, error: (error as Error).message }); return; }
      const group = (signalName: NodeJS.Signals) => {
        if (process.platform === 'win32' && child.pid && child.exitCode === null) {
          const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
          if (systemRoot) {
            const killer = spawn(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { child.kill(signalName); } catch { /* already gone */ } });
            return;
          }
        }
        try { process.platform === 'win32' || !child.pid ? child.kill(signalName) : process.kill(-child.pid, signalName); } catch { /* already gone */ }
      };
      let killer: NodeJS.Timeout | undefined;
      const abort = () => { group('SIGTERM'); killer = setTimeout(() => group('SIGKILL'), killGraceMs); killer.unref(); };
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => onOutput(chunk.toString()));
      child.stderr.on('data', chunk => onOutput(chunk.toString()));
      const finish = (result: { code: number | null; error?: string }) => {
        signal.removeEventListener('abort', abort);
        if (killer) clearTimeout(killer);
        resolvePromise(signal.aborted ? { ...result, error: result.error ?? 'install_timeout' } : result);
      };
      child.on('error', error => finish({ code: null, error: error.message }));
      child.on('close', code => finish({ code }));
    });
  };
}

const INSTALL_TIMEOUT_MS = 15 * 60_000;
const LOG_LIMIT = 4096;

/** Installs one coder's pinned package into the managed root; one install at a time, progress readable by the page. */
export class CoderInstaller {
  private current?: InstallProgress;
  private running?: Promise<void>;

  constructor(private readonly layout: ManagedLayout, private readonly npm: NpmRunner = createNpmRunner(),
    private readonly afterInstall: (coder: CoderKind) => Promise<void> = async () => {}, private readonly now: () => number = Date.now,
    private readonly host: HostPlatform = hostPlatform(), private readonly timeoutMs = INSTALL_TIMEOUT_MS) {}

  progress(): InstallProgress | undefined { return this.current ? { ...this.current } : undefined; }

  /** The coder whose install is running right now, if any. */
  installing(): CoderKind | undefined { return this.current?.phase === 'installing' ? this.current.coder : undefined; }

  /** Starts an install; rejects when one is already running. The returned promise settles when npm finishes. */
  start(coder: CoderKind): Promise<void> {
    if (this.current?.phase === 'installing') throw new Error('install_in_progress');
    this.current = { coder, phase: 'installing', startedAt: this.now(), log: '' };
    this.running = this.run(coder).catch(error => {
      if (this.current) Object.assign(this.current, { phase: 'failed', finishedAt: this.now(), error: (error as Error)?.message ?? String(error) });
    });
    return this.running;
  }

  whenDone(): Promise<void> { return this.running ?? Promise.resolve(); }

  private async run(coder: CoderKind): Promise<void> {
    const pkg = MANAGED_PACKAGES[coder];
    const native = platformPackage(coder, this.host);
    await mkdir(this.layout.root, { recursive: true, mode: 0o700 });
    await mkdir(this.layout.markers, { recursive: true, mode: 0o700 });
    // A reinstall is "not installed" until it completes; nothing may pick up a half-written binary.
    await rm(join(this.layout.markers, `${coder}.json`), { force: true });
    const manifestPath = join(this.layout.root, 'package.json');
    let manifest: { name: string; private: true; dependencies: Record<string, string> } = { name: 'nexus-coders', private: true, dependencies: {} };
    try { manifest = { ...manifest, ...JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<typeof manifest> }; } catch { /* first install */ }
    manifest.dependencies = { ...manifest.dependencies, [pkg.name]: pkg.version, [native.name]: native.spec };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('install_timeout')), this.timeoutMs);
    timer.unref();
    const progress = this.current!;
    const result = await this.npm(['install', '--no-audit', '--no-fund', '--loglevel=error', '--omit=dev', '--omit=optional'], this.layout.root,
      chunk => { progress.log = (progress.log + chunk).slice(-LOG_LIMIT); }, controller.signal);
    clearTimeout(timer);
    if (result.code !== 0) throw new Error(result.error ?? (controller.signal.aborted ? 'install_timeout' : `npm exited with ${result.code}`));
    const binary = coder === 'codex' ? managedCodexBinary(this.layout, this.host) : join(this.layout.nodeModules, native.name, native.binary);
    if (!await exists(binary, constants.X_OK)) throw new Error(`platform_package_missing: ${native.name}`);
    const marker: InstallMarker = { coder, version: pkg.version, platformPackage: native.name, at: this.now() };
    await writeFile(join(this.layout.markers, `${coder}.json`), JSON.stringify(marker, null, 2) + '\n', { mode: 0o600 });
    await this.afterInstall(coder);
    Object.assign(progress, { phase: 'installed', finishedAt: this.now() });
  }
}
