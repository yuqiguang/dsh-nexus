import { requireWindowsFirewall } from './windows-firewall.js';
import { taskStatusLabel } from './status.js';
import { windowsSandbox, type WindowsSandboxStatus } from './windows-sandbox.js';
import { access, constants, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ChannelError } from '../channels/types.js';
import { CODEX_KEY_ENV, CoderInstaller, codexConfigToml, detectClaude, detectCodex, ensureClaudeHome, writeCodexHome, type CoderDetection, type DetectOptions,
  type InstallProgress, type InstallStatus, type ManagedLayout, platformPackage, probe } from './install.js';
import { claudeLoginInstructions, type ClaudeLoginInstructions } from './login.js';
import { describeRule } from './habits.js';
import { CoderSettingsStore, coderConcurrency, redact, type CoderSettingsRecord, type CoderSettingsView, type CoderSource, type CoderSecurityMode } from './settings.js';
import type { CoderStore } from './store.js';
import type { CoderKind, HabitRule, TaskRecord } from './types.js';

export interface CoderStatusView {
  windowsSandbox?: WindowsSandboxStatus | 'checking' | 'failed';
  managed: InstallStatus;
  system: InstallStatus;
  /** Which install a task would use right now. */
  active: CoderSource | 'none';
  /** Installation and platform support are separate; also shown before installation. */
  platformProblem?: string;
  /** The preferred source was unavailable and the other one is being used. */
  fallback: boolean;
  ready: boolean;
  problem?: string;
  /** Codex system install: `codex login status` output with keys masked. Managed: derived from the settings. */
  login?: string;
  /** Configuration/login evidence only, not a successful model request. */
  credentialState?: 'configured' | 'missing' | 'unknown';
  lastTask?: { id: string; status: TaskRecord['status']; statusLabel?: string; updatedAt: number; detail?: string };
}

export interface CodersView {
  platform: NodeJS.Platform;
  settings: CoderSettingsView;
  profileRoots: string[];
  effectiveRoots: string[];
  /** Whether these roots restrict the native session workspace. */
  restrictRoots?: boolean;
  managedRoot: string;
  claudeHome: string;
  claudeLogin?: ClaudeLoginInstructions;
  codex: CoderStatusView;
  claude: CoderStatusView;
  install?: InstallProgress;
  rules: { id: string; source: HabitRule['source']; text: string }[];
  recentTasks: { id: string; coder: CoderKind; status: TaskRecord['status']; statusLabel?: string; description: string; updatedAt: number; cwd?: string; ownerSession?: string; objective?: string }[];
}

export type CodexRuntime = { command: string; env: NodeJS.ProcessEnv; source: CoderSource; model?: string };
export type ClaudeRuntime = { sdkPath?: string; executable?: string; env: NodeJS.ProcessEnv; source: CoderSource; model?: string };

/** Everything the supervisor needs at dispatch time; `error` carries a user-facing reason a coder cannot run. */
export interface EffectiveRuntime {
  /** Native dependency-service executables for this dispatch, never loaded from task/model input. */
  runtimeExecutables?: Record<string, string>;
  maxTaskMinutes?: number;
  autoApproveSafe?: boolean;
  securityMode?: CoderSecurityMode;
  allowedNetworkDomains?: string[];
  roots: string[];
  defaultCoder: CoderKind;
  codex: CodexRuntime | { error: string };
  claude: ClaudeRuntime | { error: string };
}

export interface ManagerDeps {
  windowsSandbox?: typeof windowsSandbox;
  store: CoderSettingsStore;
  layout: ManagedLayout;
  /** Profile defaults for embedded hosts; only explicit roots restrict native sessions. */
  profileRoots: string[];
  restrictRoots?: boolean;
  installer: CoderInstaller;
  detect?: DetectOptions;
  /** Test seam for `codex login status`. */
  loginStatus?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | CoderLoginStatus>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const DETECT_TTL_MS = 30_000;
const LOGIN_TTL_MS = 60_000;
const SLOW_MS = 2_000;

/** Do not advertise an installed tool as safe to dispatch before its isolation is supported. */
export function coderPlatformProblem(coder: CoderKind, platform: NodeJS.Platform, securityMode: CoderSecurityMode = 'strict'): string | undefined {
  if (platform !== 'win32' || securityMode === 'standard') return undefined;
  return coder === 'claude'
    ? 'Claude Code 可以安装，但其命令沙箱不支持原生 Windows。严格模式不能派发；可选择标准模式由 DSH 审核命令，或在 WSL2 / Linux 实例使用严格模式。'
    : undefined;
}

/** Time one step; anything slow is logged so a stalled probe shows up in the service log instead of on the page. */
async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try { return await run(); }
  finally {
    const elapsed = Date.now() - started;
    if (elapsed >= SLOW_MS) console.error(`[nexus-coders] slow: ${label} took ${(elapsed / 1000).toFixed(1)}s`);
  }
}

function maskKeys(text: string): string {
  return text.replace(/\b(sk-|key-|token-)?[A-Za-z0-9_*-]{20,}\b/g, match => `${match.slice(0, 4)}…`).trim();
}

export interface CoderLoginStatus { text: string; state: 'configured' | 'missing' | 'unknown' }

async function codexLoginStatus(command: string, env: NodeJS.ProcessEnv): Promise<CoderLoginStatus> {
  const result = await probe(command, ['login', 'status'], env);
  return { text: maskKeys(result.output.split('\n').find(Boolean) ?? (result.ok ? '已登录' : '无法读取登录状态')), state: result.ok ? 'configured' : 'unknown' };
}

/** Coder settings, installs, and the runtime the supervisor uses; the settings page talks to this through the RPC routes. */
export class CodersManager {
  private sandbox?: { key: string; at: number; status: WindowsSandboxStatus | 'failed'; problem?: string };
  private checkingSandbox?: Promise<void>;
  private settingUpSandbox = false;

  private async checkWindowsSandbox(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    await mkdir(env.LOCALAPPDATA!, { recursive: true });
    const key = `${command}:${env.CODEX_HOME ?? ''}`;
    if (!this.sandbox || this.sandbox.key !== key || this.now() - this.sandbox.at > DETECT_TTL_MS) {
      this.checkingSandbox ??= (async () => {
        try {
          const status = await (this.deps.windowsSandbox ?? windowsSandbox)({ command, env }, this.deps.layout.root);
          this.sandbox = { key, at: this.now(), status };
        } catch (error) { this.sandbox = { key, at: this.now(), status: 'failed', problem: (error as Error).message }; }
      })().finally(() => { this.checkingSandbox = undefined; });
      await this.checkingSandbox;
    }
    return this.sandbox?.key !== key ? 'Windows 沙箱配置已改变，请重试。'
      : this.sandbox.status === 'ready' ? undefined : this.sandbox.status === 'firewallDisabled'
        ? 'Windows 防火墙未全部启用，无法保证 Codex 离线沙箱的网络限制。请在 Windows 安全中心启用防火墙后重试。'
        : this.sandbox.problem ?? 'Windows 增强沙箱尚未配置或需要更新，请点击“配置 Windows 沙箱”；系统可能请求管理员确认。';
  }
  private settings?: CoderSettingsRecord;
  private readonly concurrencyListeners = new Set<(limit: number) => void>();
  private detection?: { at: number; codex: CoderDetection; claude: CoderDetection };
  private detecting?: Promise<{ codex: CoderDetection; claude: CoderDetection }>;
  private login?: { at: number; key: string; value: CoderLoginStatus };
  private loggingIn?: Promise<CoderLoginStatus>;
  private tasks?: CoderStore;
  /** config.toml content last written to the managed Codex home; rewritten only when the settings change it. */
  private codexToml?: string;
  private claudeHomeReady = false;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(private readonly deps: ManagerDeps) {
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? Date.now;
  }

  /** The task store is created after the manager; the supervisor attaches it so the page can list rules and tasks. */
  attach(store: CoderStore): void { this.tasks = store; }

  /** Last loaded settings, for synchronous readers such as the prompt section. */
  current(): CoderSettingsRecord | undefined { return this.settings; }

  onConcurrencyChange(listener: (limit: number) => void): () => void {
    this.concurrencyListeners.add(listener);
    return () => { this.concurrencyListeners.delete(listener); };
  }

  private updateSettings(settings: CoderSettingsRecord): void {
    const previous = coderConcurrency(this.settings?.maxConcurrent);
    this.settings = settings;
    const next = coderConcurrency(settings.maxConcurrent);
    if (next !== previous) for (const listener of this.concurrencyListeners) listener(next);
  }

  async load(): Promise<CoderSettingsRecord> {
    const settings = await this.deps.store.read();
    this.updateSettings(settings);
    return settings;
  }

  /**
   * Install detection spawns `codex --version` and `claude --version`. A request
   * gets the cached result at once and only the first request ever waits; a
   * stale cache is refreshed in the background, one refresh at a time.
   */
  private async detected(force = false): Promise<{ codex: CoderDetection; claude: CoderDetection }> {
    const fresh = this.detection && this.now() - this.detection.at < DETECT_TTL_MS;
    if (this.detection && (fresh && !force)) return this.detection;
    const refresh = this.detecting ??= (async () => {
      await Promise.resolve();
      const options = { env: this.env, ...this.deps.detect };
      try {
        const [codex, claude] = await Promise.all([
          timed('detect codex', () => detectCodex(this.deps.layout, options)),
          timed('detect claude', () => detectClaude(this.deps.layout, options)),
        ]);
        this.detection = { at: this.now(), codex, claude };
        return this.detection;
      } finally { this.detecting = undefined; }
    })();
    if (this.detection && !force) { void refresh.catch(() => {}); return this.detection; }
    return refresh;
  }

  private async ensureCodexHome(settings: CoderSettingsRecord): Promise<void> {
    const toml = codexConfigToml(settings.codex);
    if (this.codexToml === toml) return;
    await writeCodexHome(this.deps.layout, settings.codex);
    this.codexToml = toml;
  }

  private async ensureClaudeHome(): Promise<void> {
    if (this.claudeHomeReady) return;
    await ensureClaudeHome(this.deps.layout);
    this.claudeHomeReady = true;
  }

  private effectiveRoots(settings: CoderSettingsRecord): string[] {
    return settings.roots?.length ? settings.roots : this.deps.profileRoots;
  }

  /** A source counts only when its install is complete and no install of that coder is running right now. */
  private pick(coder: CoderKind, preferred: CoderSource, detection: CoderDetection): { active: CoderSource | 'none'; fallback: boolean } {
    const usable = (source: CoderSource) => detection[source].installed && !(source === 'managed' && this.deps.installer.installing() !== undefined);
    if (usable(preferred)) return { active: preferred, fallback: false };
    const other: CoderSource = preferred === 'managed' ? 'system' : 'managed';
    return usable(other) ? { active: other, fallback: true } : { active: 'none', fallback: false };
  }

  private codexEnv(settings: CoderSettingsRecord, source: CoderSource): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = source === 'system' ? { ...this.env }
      : { ...this.env, CODEX_HOME: this.deps.layout.codexHome, ...(settings.codex.apiKey ? { [CODEX_KEY_ENV]: settings.codex.apiKey } : {}) };
    // Keep the unattended runtime's caches separate from interactive Codex Desktop.
    // Its sandbox setup recursively refreshes the LOCALAPPDATA Codex runtime tree.
    if ((this.deps.detect?.host?.platform ?? process.platform) === 'win32') env.LOCALAPPDATA = join(this.deps.layout.root, 'codex-local-app-data');
    return env;
  }

  private claudeEnv(settings: CoderSettingsRecord): NodeJS.ProcessEnv {
    const { claude } = settings;
    return { ...this.env, CLAUDE_CONFIG_DIR: this.deps.layout.claudeHome,
      ...(claude.baseUrl ? { ANTHROPIC_BASE_URL: claude.baseUrl } : {}),
      ...(claude.token ? (claude.authHeader === 'api-key' ? { ANTHROPIC_API_KEY: claude.token } : { ANTHROPIC_AUTH_TOKEN: claude.token }) : {}),
      ...(claude.model ? { ANTHROPIC_MODEL: claude.model } : {}) };
  }

  private claudeLogin(detection: CoderDetection, source: CoderSource | 'none'): ClaudeLoginInstructions | undefined {
    if (source === 'none') return undefined;
    const install = detection[source];
    if (!install.installed || !install.path) return undefined;
    const native = platformPackage('claude', this.deps.detect?.host);
    const executable = install.executable ?? join(dirname(install.path), '..', '..', native.name, native.binary);
    return claudeLoginInstructions(this.deps.detect?.host?.platform ?? process.platform, this.deps.layout.claudeHome, executable);
  }

  /** Resolve what a task would run with right now. Never throws; unusable coders carry an error message. */
  async runtime(mode?: CoderSecurityMode): Promise<EffectiveRuntime> {
    const settings = this.settings ?? await this.load();
    const securityMode = mode ?? settings.securityMode ?? 'standard';
    const detection = await this.detected();
    const roots = this.effectiveRoots(settings);
    const platform = this.deps.detect?.host?.platform ?? process.platform;
    const codexPlatformProblem = coderPlatformProblem('codex', platform, securityMode);
    const claudePlatformProblem = coderPlatformProblem('claude', platform, securityMode);
    const codexPick = this.pick('codex', settings.codex.source, detection.codex);
    let codex: EffectiveRuntime['codex'];
    if (codexPick.active === 'none') codex = { error: this.deps.installer.installing() ? '托管安装正在进行，请等它完成。' : 'Codex 尚未安装。请在设置页的“编码工具”里安装，或在本机安装 codex 命令。' };
    else if (codexPlatformProblem) codex = { error: codexPlatformProblem };
    else {
      if (codexPick.active === 'managed') await this.ensureCodexHome(settings);
      codex = { command: detection.codex[codexPick.active].path!, env: this.codexEnv(settings, codexPick.active), source: codexPick.active,
        ...(settings.codex.model && codexPick.active === 'system' ? { model: settings.codex.model } : {}) };
      const sandboxProblem = platform === 'win32' ? this.settingUpSandbox ? 'Windows 沙箱正在配置，请稍候。' : await this.checkWindowsSandbox(codex.command, codex.env) : undefined;
      const firewallProblem = platform === 'win32' && securityMode === 'strict' && !sandboxProblem ? await requireWindowsFirewall().then(() => undefined, () => '严格模式需要有效的 Windows 防火墙网络隔离；请配置防火墙，或为新任务选择标准模式。') : undefined;
      if (firewallProblem) codex = { error: firewallProblem };
      else if (sandboxProblem) codex = { error: sandboxProblem };
      else if (codexPick.active === 'managed' && !settings.codex.apiKey) codex = { error: '托管的 Codex 还没有 API key。请在设置页填写，或把 Codex 来源改为系统安装。' };
    }
    const claudePick = this.pick('claude', settings.claude.source, detection.claude);
    let claude: EffectiveRuntime['claude'];
    if (claudePick.active === 'none') claude = { error: this.deps.installer.installing() ? '托管安装正在进行，请等它完成。'
      : 'Claude Code 不可用：既没有完成的托管安装，插件自带的 SDK 也没有可用的 claude 命令或匹配本机的二进制。请在设置页的“编码工具”里安装。' };
    else if (claudePlatformProblem) claude = { error: claudePlatformProblem };
    else {
      await this.ensureClaudeHome();
      const oauth = await access(join(this.deps.layout.claudeHome, '.credentials.json'), constants.R_OK).then(() => true, () => false);
      if (!settings.claude.token && !oauth) {
        const login = this.claudeLogin(detection.claude, claudePick.active);
        claude = { error: `Claude Code 还没有凭据。请在设置页填写兼容端点和 token${login ? `，或在 DSH 所在电脑的 ${login.shell} 中执行：\n${login.command}` : '。'}` };
      }
      else claude = { ...(claudePick.active === 'managed' ? { sdkPath: detection.claude.managed.path! } : {}),
        ...(claudePick.active === 'system' && detection.claude.system.executable ? { executable: detection.claude.system.executable } : {}),
        env: this.claudeEnv(settings), source: claudePick.active, ...(settings.claude.model ? { model: settings.claude.model } : {}) };
    }
    return { securityMode, roots, defaultCoder: settings.defaultCoder, maxTaskMinutes: settings.maxTaskMinutes ?? 60, autoApproveSafe: settings.autoApproveSafe ?? true, allowedNetworkDomains: settings.allowedNetworkDomains, codex, claude };
  }

  private lastTask(coder: CoderKind): CoderStatusView['lastTask'] {
    const task = this.tasks?.list().find(item => item.coder === coder);
    return task ? { id: task.id, status: task.status, statusLabel: taskStatusLabel(task), updatedAt: task.updatedAt, ...(task.result?.detail ? { detail: task.result.detail } : {}) } : undefined;
  }

  private async codexLogin(settings: CoderSettingsRecord, active: CoderSource | 'none', detection: CoderDetection): Promise<CoderLoginStatus | undefined> {
    if (active === 'managed') return { text: settings.codex.apiKey ? `使用设置里的 API key${settings.codex.baseUrl ? `，端点 ${settings.codex.baseUrl}` : '，官方端点'}` : '未配置 API key', state: settings.codex.apiKey ? 'configured' : 'missing' };
    if (active === 'none' && settings.codex.source === 'managed' && !settings.codex.apiKey) return undefined;
    if (active !== 'system' || !detection.system.path) return undefined;
    const key = `${detection.system.path}:${detection.system.version}`;
    const cached = this.login?.key === key ? this.login : undefined;
    if (cached && this.now() - cached.at < LOGIN_TTL_MS) return cached.value;
    const refresh = this.loggingIn ??= (async () => {
      await Promise.resolve();
      try {
        const result = await timed('codex login status', () => (this.deps.loginStatus ?? codexLoginStatus)(detection.system.path!, this.env));
        const value: CoderLoginStatus = typeof result === 'string' ? { text: maskKeys(result), state: 'unknown' } : { ...result, text: maskKeys(result.text) };
        this.login = { at: this.now(), key, value };
        return value;
      } finally { this.loggingIn = undefined; }
    })();
    if (cached) { void refresh.catch(() => {}); return cached.value; }
    return refresh;
  }

  async view(): Promise<CodersView> {
    const settings = this.settings ?? await this.load();
    const detection = await this.detected();
    const runtime = await timed('resolve runtime', () => this.runtime());
    const codexPick = this.pick('codex', settings.codex.source, detection.codex);
    const claudePick = this.pick('claude', settings.claude.source, detection.claude);
    const status = (kind: CoderKind, pick: ReturnType<CodersManager['pick']>, detected: CoderDetection, resolved: EffectiveRuntime['codex' | 'claude']): CoderStatusView => ({
      managed: detected.managed, system: detected.system, active: pick.active, fallback: pick.fallback,
      ...(coderPlatformProblem(kind, this.deps.detect?.host?.platform ?? process.platform, settings.securityMode ?? 'standard') ? { platformProblem: coderPlatformProblem(kind, this.deps.detect?.host?.platform ?? process.platform, settings.securityMode ?? 'standard') } : {}),
      ready: !('error' in resolved), ...('error' in resolved ? { problem: resolved.error } : {}),
      ...(this.lastTask(kind) ? { lastTask: this.lastTask(kind) } : {}),
    });
    const codex = status('codex', codexPick, detection.codex, runtime.codex);
    if ((this.deps.detect?.host?.platform ?? process.platform) === 'win32' && codexPick.active !== 'none') codex.windowsSandbox = this.settingUpSandbox ? 'checking' : this.sandbox?.status ?? 'failed';
    const login = await this.codexLogin(settings, codexPick.active, detection.codex);
    if (login) { codex.login = login.text; codex.credentialState = login.state; }
    const claude = status('claude', claudePick, detection.claude, runtime.claude);
    const claudeOauth = await access(join(this.deps.layout.claudeHome, '.credentials.json'), constants.R_OK).then(() => true, () => false);
    claude.credentialState = settings.claude.token || claudeOauth ? 'configured' : 'missing';
    claude.login = settings.claude.token ? `使用设置里的 token${settings.claude.baseUrl ? `，端点 ${settings.claude.baseUrl}` : '，官方端点'}`
      : claudeOauth ? 'OAuth 登录（Nexus 专用配置目录）' : '未配置凭据';
    const progress = this.deps.installer.progress();
    return {
      platform: this.deps.detect?.host?.platform ?? process.platform,
      settings: redact(settings), profileRoots: [...this.deps.profileRoots], effectiveRoots: runtime.roots,
      restrictRoots: !!settings.roots?.length || this.deps.restrictRoots === true,
      managedRoot: this.deps.layout.root, claudeHome: this.deps.layout.claudeHome, codex, claude,
      claudeLogin: this.claudeLogin(detection.claude, claudePick.active),
      ...(progress ? { install: progress } : {}),
      rules: (this.tasks?.rules() ?? []).map(rule => ({ id: rule.id, source: rule.source, text: describeRule(rule) })),
      recentTasks: (this.tasks?.list() ?? []).slice(0, 10).map(task => ({ id: task.id, coder: task.coder, status: task.status, statusLabel: taskStatusLabel(task),
        cwd: task.cwd, ownerSession: task.ownerSession, ...(task.brief ? { objective: task.brief.objective } : {}),
        description: task.description.length > 120 ? `${task.description.slice(0, 120)}…` : task.description, updatedAt: task.updatedAt })),
    };
  }

  async handle(method: string, payload: unknown): Promise<CodersView> {
    if (method === 'list') return timed('coders list', () => this.view());
    if (method === 'refresh') {
      await this.load();
      await this.loggingIn?.catch(() => {});
      this.login = undefined;
      await this.detected(true);
      return this.view();
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    if (method === 'save') {
      const saved = await this.deps.store.save(input.revision as number, input.config as Record<string, unknown>);
      this.updateSettings(saved);
      if (this.detection?.codex.managed.installed) await this.ensureCodexHome(saved);
      this.login = undefined;
    } else if (method === 'clear-secret') {
      const coder = input.coder;
      if (coder !== 'codex' && coder !== 'claude') throw new ChannelError('invalid_configuration');
      this.settings = await this.deps.store.clearSecret(input.revision as number, coder);
      this.login = undefined;
    } else if (method === 'install') {
      const coder = input.coder;
      if (coder !== 'codex' && coder !== 'claude') throw new ChannelError('invalid_configuration');
      if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 0) throw new ChannelError('invalid_revision');
      const settings = await this.load();
      if (input.revision !== settings.revision) throw new ChannelError('configuration_changed');
      if (this.tasks?.active().length || this.settingUpSandbox) throw new ChannelError('install_tasks_active');
      if (this.deps.installer.installing()) throw new ChannelError('install_in_progress');
      void this.deps.installer.start(coder, settings[coder].managedVersion);
      void this.deps.installer.whenDone().then(() => { this.detection = undefined; });
    } else if (method === 'windows-sandbox/setup') {
      if ((this.deps.detect?.host?.platform ?? process.platform) !== 'win32' || this.deps.installer.installing() || this.settingUpSandbox || this.tasks?.active().length) throw new ChannelError('sandbox_setup_unavailable');
      const settings = this.settings ?? await this.load();
      const detected = await this.detected();
      const pick = this.pick('codex', settings.codex.source, detected.codex);
      if (pick.active === 'none') throw new ChannelError('sandbox_setup_unavailable');
      if (pick.active === 'managed') await this.ensureCodexHome(settings);
      const command = detected.codex[pick.active].path!;
      const env = this.codexEnv(settings, pick.active);
      await mkdir(env.LOCALAPPDATA!, { recursive: true });
      this.settingUpSandbox = true;
      try {
        await this.checkingSandbox;
        const status = await (this.deps.windowsSandbox ?? windowsSandbox)({ command, env }, this.deps.layout.root, true);
        this.sandbox = { key: `${command}:${env.CODEX_HOME ?? ''}`, at: this.now(), status };
      } catch (error) {
        this.sandbox = { key: `${command}:${env.CODEX_HOME ?? ''}`, at: this.now(), status: 'failed', problem: (error as Error).message };
      } finally { this.settingUpSandbox = false; }
    } else if (method === 'rules/remove') {
      if (typeof input.id !== 'string' || !this.tasks) throw new ChannelError('invalid_configuration');
      if (!(await this.tasks.removeRule(input.id))) throw new ChannelError('rule_not_found');
    } else throw new ChannelError('unknown_action');
    return this.view();
  }

  /** After a managed install lands: regenerate the Codex home so the first task finds its config. */
  async afterInstall(coder: CoderKind): Promise<void> {
    this.detection = undefined;
    const settings = this.settings ?? await this.load();
    if (coder === 'codex') { this.codexToml = undefined; await this.ensureCodexHome(settings); }
    else await this.ensureClaudeHome();
  }
}
