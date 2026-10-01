import type { Context } from '@deepseek-ai/cordis';
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';

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
