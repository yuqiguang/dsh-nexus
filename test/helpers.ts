import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

function runs(command: string, args: string[]): boolean {
  try { execFileSync(command, args, { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

/**
 * `process.platform === 'linux'` is not the same claim as "this machine can isolate a process".
 * A kernel can be built or configured to refuse unprivileged user namespaces (`unshare --user`),
 * which is the guard the coder process tests actually need.
 */
export function hasUserNamespaces(): boolean {
  return process.platform === 'linux' && runs('unshare', ['--user', '--map-root-user', 'true']);
}

/**
 * The confined local check additionally shells out to `bwrap` and to `ip link set lo up` inside a
 * private network namespace — see src/coders/local-check.ts. Neither is guaranteed: bubblewrap is
 * absent from the GitHub Actions runner images and from slim container images, so gating these
 * tests on the platform alone reports a capability the machine does not have and they fail instead
 * of saying why. Gate on the real thing and let the skip reason name what is missing.
 *
 * This is a guard on the *test*, not on the feature: the code still refuses to run a confined
 * check without full enforcement rather than degrading, and CI installs bubblewrap so the
 * coverage is not lost there.
 */
export function missingLocalCheckDependency(): string | undefined {
  if (process.platform !== 'linux') return `needs Linux, this is ${process.platform}`;
  if (!runs('bwrap', ['--version'])) return 'bubblewrap (bwrap) is not installed';
  if (!runs('ip', ['-V'])) return 'iproute2 (ip) is not installed';
  if (!hasUserNamespaces()) return 'unprivileged user namespaces are disabled';
  return undefined;
}
