import { isInside } from './rules.js';
type Scope = string | readonly string[];
const roots = (scope?: Scope): readonly string[] => typeof scope === 'string' ? [scope] : scope ?? [];
const overlaps = (a?: Scope, b?: Scope) => roots(a).some(left => roots(b).some(right => isInside(left, right) || isInside(right, left)));
/** FIFO execution slots; jobs, ownership, cancellation and notifications remain with DSH. */
export class CoderQueue {
  private running = 0;
  private closed = false;
  private waiting: { enter: () => void; scope?: Scope }[] = [];
  private scopes = new Map<symbol, Scope>();

  constructor(private concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid coder concurrency');
  }

  /** Lowering the limit never cancels a lease; raising it admits eligible waiting jobs immediately. */
  setConcurrency(concurrency: number): void {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid coder concurrency');
    this.concurrency = concurrency;
    this.drain();
  }

  /** Direct tools must return a conflict instead of blocking the session that may need to answer a coder. */
  tryAcquire(scope: Scope): (() => void) | undefined {
    if (this.closed || this.running >= this.concurrency || [...this.scopes.values()].some(active => overlaps(active, scope))
      || this.waiting.some(entry => overlaps(entry.scope, scope))) return;
    return this.lease(scope);
  }

  private lease(scope?: Scope): () => void {
    this.running++;
    const lease = Symbol();
    if (scope) this.scopes.set(lease, scope);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.scopes.delete(lease);
      this.drain();
    };
  }

  acquire(signal: AbortSignal, scope?: Scope): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting = this.waiting.filter(entry => entry.enter !== enter);
        signal.removeEventListener('abort', abort);
        reject(new Error('coder_queue_cancelled'));
      };
      const enter = () => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted || this.closed) { abort(); return; }
        resolve(this.lease(scope));
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
      const index = this.waiting.findIndex(entry => ![...this.scopes.values()].some(scope => overlaps(scope, entry.scope)));
      if (index < 0) return;
      this.waiting.splice(index, 1)[0]!.enter();
    }
  }
}
