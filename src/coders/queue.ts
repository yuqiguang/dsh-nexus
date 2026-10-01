import { isInside } from './rules.js';
/** FIFO execution slots; jobs, ownership, cancellation and notifications remain with DSH. */
export class CoderQueue {
  private running = 0;
  private closed = false;
  private waiting: { enter: () => void; scope?: string }[] = [];
  private scopes = new Map<symbol, string>();

  constructor(private concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid coder concurrency');
  }

  /** Lowering the limit never cancels a lease; raising it admits eligible waiting jobs immediately. */
  setConcurrency(concurrency: number): void {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid coder concurrency');
    this.concurrency = concurrency;
    this.drain();
  }

  acquire(signal: AbortSignal, scope?: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter(entry => entry.enter !== enter);
        signal.removeEventListener('abort', abort);
        reject(new Error('coder_queue_cancelled'));
      };
      const enter = () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted || this.closed) { abort(); return; }
        this.running++;
        const lease = Symbol();
        if (scope) this.scopes.set(lease, scope);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.running--;
          this.scopes.delete(lease);
          this.drain();
        });
      };
      if (signal.aborted || this.closed) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.waiting.push({ enter, scope });
      this.drain();
    });
  }

  close(): void {
    this.closed = true;
    for (const entry of this.waiting.splice(0)) entry.enter();
  }

  private drain(): void {
    while (!this.closed && this.running < this.concurrency && this.waiting.length) {
      const index = this.waiting.findIndex(entry => !entry.scope || ![...this.scopes.values()].some(scope => isInside(scope, entry.scope!) || isInside(entry.scope!, scope)));
      if (index < 0) return;
      this.waiting.splice(index, 1)[0]!.enter();
    }
  }
}
