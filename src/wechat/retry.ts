import { setTimeout as delay } from 'node:timers/promises';
import { ChannelError } from '../channels/types.js';

export type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;
export const wait: Wait = async (milliseconds, signal) => { await delay(milliseconds, undefined, { signal }); };
export function backoff(failures: number): number { return Math.min(60_000, 1000 * 2 ** Math.min(Math.max(0, failures - 1), 6)); }
export function retryable(error: unknown): boolean {
  return error instanceof ChannelError && ['connection_failed', 'connection_timeout', 'rate_limited', 'server_unavailable'].includes(error.code);
}
