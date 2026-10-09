export const RETRY_PROGRESS_LIMITS = { warnAfterMs: 5 * 60_000, stopAfterMs: 10 * 60_000, intervalMs: 60_000 };
export type RetryProgressEvent = { level: 'waiting' | 'warning' | 'stop'; waitedMs: number };

/** Account only observed retry waits since the last successful operation. Native retries and adapter resumes share this guard. */
export class RetryProgressGuard {
  private elapsed = 0;
  private since = Date.now();
  private waiting = false;
  private suspended = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  warned = false;
  stopped = false;
  private readonly limits: typeof RETRY_PROGRESS_LIMITS;
  constructor(private readonly notice: (event: RetryProgressEvent) => void, limits: Partial<typeof RETRY_PROGRESS_LIMITS> = {}) {
    this.limits = { ...RETRY_PROGRESS_LIMITS, ...limits };
    if (!(this.limits.warnAfterMs > 0 && this.limits.stopAfterMs > this.limits.warnAfterMs && this.limits.intervalMs > 0)) throw new Error('invalid retry progress limits');
  }
  private account() {
    const now = Date.now();
    if (this.waiting && !this.suspended && !this.closed) this.elapsed += Math.max(0, now - this.since);
    this.since = now;
  }
  get waitedMs(): number { this.account(); return this.elapsed; }
  setWaiting(waiting: boolean) { if (this.closed) return; this.account(); this.waiting = waiting; this.arm(); }
  /** Status text, model deltas, new session IDs and retry counters are not successful operations. */
  progress() { if (this.closed) return; this.account(); this.elapsed = 0; this.warned = false; this.arm(); }
  pause(): () => void {
    if (this.closed) return () => {};
    this.account(); this.suspended++; this.arm();
    let resumed = false;
    return () => { if (resumed) return; resumed = true; this.account(); this.suspended--; this.arm(); };
  }
  private arm() {
    clearTimeout(this.timer);
    if (this.closed || !this.waiting || this.suspended) return;
    const deadline = this.warned ? this.limits.stopAfterMs : this.limits.warnAfterMs;
    this.timer = setTimeout(() => {
      this.account();
      const level = this.elapsed >= this.limits.stopAfterMs ? 'stop' : this.elapsed >= this.limits.warnAfterMs ? 'warning' : 'waiting';
      if (level === 'warning') this.warned = true;
      if (level === 'stop') { this.stopped = true; this.close(); }
      this.notice({ level, waitedMs: this.elapsed });
      this.arm();
    }, Math.max(0, Math.min(this.limits.intervalMs, deadline - this.elapsed)));
    this.timer.unref?.();
  }
  close() { this.account(); this.closed = true; clearTimeout(this.timer); }
}
