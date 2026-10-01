/** Runtime budget excludes bounded waits for the user. Nested waits cannot restart the clock early. */
export class ActiveBudget {
  private remaining: number;
  private started = Date.now();
  private paused = 0;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(duration: number, private readonly expire: () => void) { this.remaining = duration; this.arm(); }
  private arm() {
    this.started = Date.now();
    this.timer = setTimeout(() => { this.closed = true; this.expire(); }, Math.max(0, this.remaining));
    this.timer.unref();
  }
  pause(): () => void {
    if (this.closed) return () => {};
    if (this.paused++ === 0) { clearTimeout(this.timer); this.remaining -= Date.now() - this.started; }
    let resumed = false;
    return () => { if (resumed || this.closed) return; resumed = true; if (--this.paused === 0) this.arm(); };
  }
  close(): void { this.closed = true; clearTimeout(this.timer); }
}
