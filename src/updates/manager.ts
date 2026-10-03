import type { Records } from '../channels/records.js';
import { ChannelError } from '../channels/types.js';
import { CHECK_INTERVAL, newerVersion, validVersion, type UpdatePackage } from './package.js';

export interface UpdateInstaller {
  installed(): Promise<string | undefined>;
  install(pkg: UpdatePackage, signal: AbortSignal): Promise<'restart-required'>;
}
interface Transaction { from: string; fromCommit: string; to: string; toCommit: string; phase: 'installing' | 'rolling-back' | 'restart-required'; rollback?: boolean }
interface SavedUpdates {
  revision: number; autoCheck: boolean; autoInstall: boolean; lastCheckAt?: number; nextCheckAt?: number;
  lastError?: string; failedVersion?: string; transaction?: Transaction; rollbackVersion?: string; rollbackCommit?: string; outcome?: 'updated' | 'rolled-back' | 'interrupted';
}
export interface UpdatesView {
  supported: boolean; currentVersion: string; installedVersion?: string; dshVersion: string;
  revision: number; autoCheck: boolean; autoInstall: boolean; lastCheckAt?: number;
  phase: 'idle' | 'checking' | 'available' | 'waiting' | 'preparing' | 'installing' | 'rolling-back' | 'restart-required' | 'failed';
  latest?: { version: string; compatible: boolean; dshVersion: string; releaseUrl: string };
  error?: string; outcome?: SavedUpdates['outcome']; rollbackVersion?: string;
}
export interface UpdatesDeps {
  records: Records; currentVersion: string; currentCommit?: string; dshVersion: string;
  packages: { latest(signal: AbortSignal): Promise<string>; get(version: string, signal: AbortSignal): Promise<UpdatePackage>; verify(pkg: UpdatePackage): Promise<void> };
  installer(): UpdateInstaller | undefined;
  isIdle(quiet: boolean): Promise<boolean>;
  now?: () => number;
}
function saved(value: unknown): SavedUpdates {
  const input = value as Partial<SavedUpdates> | undefined;
  if (!input || typeof input.autoCheck !== 'boolean' || typeof input.autoInstall !== 'boolean' || !Number.isSafeInteger(input.revision)) return { revision: 0, autoCheck: true, autoInstall: false };
  const transaction = input.transaction;
  const commit = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const validTransaction = transaction && validVersion(transaction.from) && validVersion(transaction.to)
    && commit(transaction.fromCommit) && commit(transaction.toCommit) && ['installing', 'rolling-back', 'restart-required'].includes(transaction.phase);
  return { ...input, transaction: validTransaction ? transaction : undefined,
    autoCheck: input.autoCheck, autoInstall: input.autoCheck && input.autoInstall, revision: input.revision!,
    nextCheckAt: typeof input.nextCheckAt === 'number' && Number.isFinite(input.nextCheckAt) ? input.nextCheckAt : undefined };
}
const errorCode = (error: unknown) => error instanceof ChannelError ? error.code : 'update_failed';

/** The UI requests work; timers never grant installation permission. All installs
 * use immutable versioned artifacts and the Host's package manager. */
export class UpdatesManager {
  private record: SavedUpdates = saved(undefined);
  private phase: UpdatesView['phase'] = 'idle';
  private target?: UpdatePackage;
  private installedVersion?: string;
  private work?: Promise<void>;
  private control?: AbortController;
  private requested?: string;
  private automatic = false;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  constructor(private readonly deps: UpdatesDeps) { this.now = deps.now ?? Date.now; }
  private async persist(patch: Partial<SavedUpdates>) {
    this.record = saved(await this.deps.records.modify('settings', async current => ({ ...saved(current), ...patch })));
  }
  async load() {
    this.record = saved(await this.deps.records.read('settings'));
    const transaction = this.record.transaction;
    if (transaction) {
      if (transaction.to === this.deps.currentVersion && transaction.toCommit === this.deps.currentCommit && transaction.phase !== 'rolling-back') {
        await this.persist({ transaction: undefined, outcome: transaction.rollback ? 'rolled-back' : 'updated', lastError: undefined, failedVersion: transaction.rollback ? transaction.from : undefined });
      } else if (transaction.phase === 'restart-required' && transaction.from === this.deps.currentVersion && transaction.fromCommit === this.deps.currentCommit) this.phase = 'restart-required';
      else { this.phase = 'failed'; await this.persist({ outcome: 'interrupted', lastError: 'update_interrupted', failedVersion: transaction.to }); }
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 30_000).unref();
  }
  async close() {
    this.closed = true; if (this.timer) clearInterval(this.timer);
    this.control?.abort('disposed'); await this.work;
  }
  activity() { if (this.phase === 'preparing' || this.phase === 'installing') this.control?.abort('activity'); }
  get busy() { return !!this.record.transaction || this.phase === 'preparing' || this.phase === 'installing' || this.phase === 'rolling-back' || this.phase === 'restart-required'; }
  async view(): Promise<UpdatesView> {
    const installer = this.deps.installer();
    if (installer && !this.work) this.installedVersion = await installer.installed().catch(() => this.installedVersion);
    return { supported: !!installer, currentVersion: this.deps.currentVersion, installedVersion: this.installedVersion,
      dshVersion: this.deps.dshVersion, revision: this.record.revision, autoCheck: this.record.autoCheck, autoInstall: this.record.autoInstall,
      phase: this.phase, lastCheckAt: this.record.lastCheckAt, error: this.record.lastError, outcome: this.record.outcome,
      ...(this.target ? { latest: { version: this.target.version, compatible: this.target.compatible, dshVersion: this.target.dshVersion, releaseUrl: this.target.releaseUrl } } : {}),
      ...(validVersion(this.record.rollbackVersion) && (this.record.rollbackVersion !== this.deps.currentVersion || this.record.transaction || this.record.lastError === 'update_rollback_failed') ? { rollbackVersion: this.record.rollbackVersion } : {}) };
  }
  private launch(action: (signal: AbortSignal) => Promise<void>) {
    if (this.closed || this.work) return;
    const control = this.control = new AbortController();
    this.work = Promise.resolve().then(() => action(control.signal)).catch(async error => {
      if (control.signal.aborted && !this.record.transaction) {
        this.phase = control.signal.reason === 'activity' ? 'waiting' : this.target ? 'available' : 'idle';
        if (control.signal.reason !== 'activity') this.requested = undefined;
        return;
      }
      const installing = this.phase === 'preparing' || this.phase === 'installing' || this.phase === 'rolling-back';
      this.phase = 'failed'; this.requested = undefined;
      await this.persist({ lastError: errorCode(error), ...(installing && this.target ? { failedVersion: this.target.version } : {}) });
    }).finally(() => { this.work = undefined; this.control = undefined; });
  }
  async settle() { await this.work; }
  async handle(method: string, payload: unknown = {}): Promise<UpdatesView> {
    if (method === 'status') return this.view();
    if (this.closed || !this.deps.installer()) throw new ChannelError('update_unavailable');
    const input = payload as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChannelError('invalid_configuration');
    if (method === 'save') {
      if (typeof input.autoCheck !== 'boolean' || typeof input.autoInstall !== 'boolean') throw new ChannelError('invalid_configuration');
      this.record = saved(await this.deps.records.modify('settings', async current => {
        const before = saved(current);
        if (input.revision !== before.revision) throw new ChannelError('configuration_changed');
        return { ...before, revision: before.revision + 1, autoCheck: input.autoCheck, autoInstall: input.autoCheck && input.autoInstall };
      }));
      if (!this.record.autoInstall && this.automatic) { this.requested = undefined; this.control?.abort('disabled'); }
      if (!this.record.autoCheck && this.phase === 'checking') this.control?.abort();
      if (!this.work && this.phase === 'waiting' && !this.requested && !this.record.autoInstall) this.phase = this.target ? 'available' : 'idle';
    } else if (method === 'check') {
      if (this.record.transaction) throw new ChannelError(this.phase === 'restart-required' ? 'update_restart_required' : 'update_interrupted');
      if (!this.work) { this.phase = 'checking'; this.launch(signal => this.check(signal)); }
    } else if (method === 'install') {
      if (this.busy || this.work) throw new ChannelError('update_busy');
      if (!this.target || !this.target.compatible || input.version !== this.target.version) throw new ChannelError('update_candidate_changed');
      this.requested = this.target.version; this.automatic = false; this.phase = 'waiting';
      await this.tick();
    } else if (method === 'cancel') {
      if (!['waiting', 'preparing', 'installing'].includes(this.phase)) throw new ChannelError('update_busy');
      this.requested = undefined;
      await this.persist({ failedVersion: this.target?.version });
      this.control?.abort('user');
      if (!this.work) this.phase = this.target ? 'available' : 'idle';
    } else if (method === 'rollback') {
      if (this.work || !validVersion(this.record.rollbackVersion) || input.version !== this.record.rollbackVersion) throw new ChannelError('update_rollback_unavailable');
      if (!await this.deps.isIdle(false)) throw new ChannelError('update_tasks_running');
      this.phase = 'preparing'; this.automatic = false;
      this.launch(async signal => {
        const pkg = await this.deps.packages.get(this.record.rollbackVersion!, signal);
        if (pkg.commit !== this.record.rollbackCommit || !pkg.compatible) throw new ChannelError('update_rollback_unavailable');
        if (pkg.version === this.deps.currentVersion) {
          await this.deps.packages.verify(pkg);
          if (signal.aborted || !await this.deps.isIdle(false)) throw new ChannelError('update_tasks_running');
          const installer = this.deps.installer();
          if (!installer || await installer.installed() === undefined) throw new ChannelError('update_unavailable');
          this.phase = 'rolling-back';
          try {
            await installer.install(pkg, signal);
            if (await installer.installed() !== pkg.version) throw new Error();
          } catch { throw new ChannelError('update_rollback_failed'); }
          this.installedVersion = pkg.version; this.phase = 'idle';
          await this.persist({ transaction: undefined, outcome: 'rolled-back', lastError: undefined }); return;
        }
        await this.perform(pkg, signal, false);
      });
    } else throw new ChannelError('unknown_action');
    return this.view();
  }
  async tick() {
    if (this.closed || this.work || !this.deps.installer() || this.record.transaction) return;
    if (this.target?.compatible && (this.requested === this.target.version || (this.record.autoInstall && this.record.failedVersion !== this.target.version))) {
      const target = this.target, automatic = this.requested !== target.version;
      const idle = await this.deps.isIdle(automatic);
      // Settings, another request, or disposal may change while the idle check awaits I/O.
      if (this.closed || this.work || this.record.transaction || target !== this.target
        || (this.requested !== target.version && (!this.record.autoInstall || this.record.failedVersion === target.version))) return;
      this.automatic = automatic;
      if (idle) {
        this.phase = 'preparing'; this.launch(signal => this.perform(target, signal, automatic));
      } else this.phase = 'waiting';
    } else if (this.record.autoCheck && this.now() >= (this.record.nextCheckAt ?? 0)) {
      this.phase = 'checking'; this.launch(signal => this.check(signal));
    }
  }
  private async check(signal: AbortSignal) {
    await this.persist({ lastCheckAt: this.now(), nextCheckAt: this.now() + 30 * 60 * 1000, lastError: undefined });
    const version = await this.deps.packages.latest(signal);
    this.target = newerVersion(version, this.deps.currentVersion) ? await this.deps.packages.get(version, signal) : undefined;
    if (signal.aborted) throw new ChannelError('update_cancelled');
    this.phase = this.target ? 'available' : 'idle';
    await this.persist({ nextCheckAt: this.now() + CHECK_INTERVAL, lastError: this.target && !this.target.compatible ? 'update_incompatible' : undefined });
  }
  private async perform(target: UpdatePackage, signal: AbortSignal, automatic: boolean) {
    const installer = this.deps.installer();
    if (!installer) throw new ChannelError('update_unavailable');
    // Before touching the installed package, obtain and validate its exact release.
    const previous = await this.deps.packages.get(this.deps.currentVersion, signal).catch(() => { throw new ChannelError('update_rollback_unavailable'); });
    if (!previous.compatible || previous.commit !== this.deps.currentCommit) throw new ChannelError('update_rollback_unavailable');
    await this.deps.packages.verify(previous); await this.deps.packages.verify(target);
    if (signal.aborted || (automatic && !this.record.autoInstall) || !await this.deps.isIdle(automatic)) {
      this.phase = this.requested || (this.record.autoInstall && this.record.failedVersion !== target.version) ? 'waiting' : 'available'; return;
    }
    const installed = await installer.installed();
    if (installed !== this.deps.currentVersion) throw new ChannelError('update_installed_changed');
    const transaction: Transaction = { from: previous.version, fromCommit: previous.commit, to: target.version, toCommit: target.commit, phase: 'installing', rollback: newerVersion(previous.version, target.version) };
    await this.persist({ transaction, rollbackVersion: previous.version, rollbackCommit: previous.commit, lastError: undefined, outcome: undefined });
    this.phase = 'installing';
    try {
      await installer.install(target, AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]));
      this.installedVersion = await installer.installed();
      if (this.installedVersion !== target.version) throw new ChannelError('update_install_failed');
      this.phase = 'restart-required'; this.requested = undefined;
      await this.persist({ transaction: { ...transaction, phase: 'restart-required' }, failedVersion: undefined });
    } catch (error) {
      if (this.closed || !this.deps.installer()) {
        this.phase = 'failed'; this.requested = undefined;
        await this.persist({ lastError: 'update_interrupted', failedVersion: target.version }); return;
      }
      // A removed bundle belongs to the user. Never restore an explicit uninstall.
      if (await installer.installed() === undefined) {
        this.phase = 'failed'; this.requested = undefined;
        await this.persist({ transaction: undefined, failedVersion: target.version, lastError: 'update_unavailable' }); return;
      }
      this.phase = 'rolling-back';
      await this.persist({ transaction: { ...transaction, phase: 'rolling-back' } });
      try {
        await this.deps.packages.verify(previous);
        await installer.install(previous, AbortSignal.timeout(120_000));
        this.installedVersion = await installer.installed();
        if (this.installedVersion !== previous.version) throw new Error();
        const interrupted = signal.reason === 'activity';
        this.phase = interrupted ? 'waiting' : 'failed';
        if (!interrupted) this.requested = undefined;
        await this.persist({ transaction: undefined, failedVersion: interrupted ? undefined : target.version, lastError: interrupted ? undefined : errorCode(error), outcome: 'rolled-back' });
      } catch {
        this.phase = 'failed'; this.requested = undefined;
        await this.persist({ failedVersion: target.version, lastError: 'update_rollback_failed' });
      }
    }
  }
}
