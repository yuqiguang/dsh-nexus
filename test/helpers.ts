import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Records } from '../src/channels/records.js';

export class MemoryRecords implements Records {
  readonly values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async read(key: string): Promise<unknown> { return structuredClone(this.values.get(key)); }
  async modify(key: string, update: (value: unknown) => Promise<unknown>): Promise<unknown> {
    const task = this.tail.catch(() => {}).then(async () => {
      const value = await update(await this.read(key));
      if (value !== undefined) this.values.set(key, structuredClone(value));
      return this.read(key);
    });
    this.tail = task;
    return task;
  }
}

export async function until(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, description);
    await delay(2);
  }
}

export function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
