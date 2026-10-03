import type { MemoryView } from '../memory/index.js';

export type MemoryApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<MemoryView>;

export const memoryApi: MemoryApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-memory/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as MemoryView;
};

