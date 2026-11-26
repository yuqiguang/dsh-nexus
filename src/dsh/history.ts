import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';

/** DSH 0.2.2 removed controller.inspect; the public read handle preserves the fork cut. */
export async function inspectSession(ctx: Context, sessionId: SessionId, signal?: AbortSignal) {
  const controller = ctx.sessionController as unknown as { inspect?: (id: SessionId, signal?: AbortSignal) => Promise<{ events: readonly SessionEvent[]; inheritedEventCount: number }> };
  if (typeof controller.inspect === 'function') return controller.inspect(sessionId, signal);
  const handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal });
  try {
    return { events: (await handle.read(0, undefined, { signal })).events, inheritedEventCount: handle.inheritedEventCount };
  } finally { await handle.close(); }
}

/** Read the actual log without attaching an agent or synthesizing interrupted-turn repair events. */
export async function storedEvents(ctx: Context, sessionId: SessionId, signal?: AbortSignal): Promise<readonly SessionEvent[]> {
  let handle;
  try { handle = await ctx.sessionPersistence.open(sessionId, 'read', { signal }); }
  catch (error) {
    if (error instanceof SessionPersistenceNotFoundError) return [];
    throw error;
  }
  try { return (await handle.read(0, undefined, { signal })).events; }
  finally { await handle.close(); }
}
