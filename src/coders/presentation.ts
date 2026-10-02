import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { CoderStore } from './store.js';
import { CODER_NAMES, isActive, type TaskRecord } from './types.js';
import { taskStatusLabel } from './status.js';

export interface TaskSummary {
  id: string;
  ownerSession: string;
  coderName: string;
  status: TaskRecord['status'];
  statusLabel: string;
  active: boolean;
  description: string;
  updatedAt: number;
  activity?: string;
  pending?: string;
  pendingReason?: string;
  completionNotice?: TaskRecord['completionNotice'];
}

export function taskSummary(task: TaskRecord, activity?: string): TaskSummary {
  return { id: task.id, ownerSession: task.ownerSession, coderName: CODER_NAMES[task.coder], status: task.status,
    statusLabel: taskStatusLabel(task), active: isActive(task), description: task.description.slice(0, 240),
    updatedAt: task.updatedAt, ...(activity ? { activity: activity.slice(0, 240) } : {}),
    ...(task.status === 'waiting-user' && task.pending ? { pending: task.pending.summary.slice(0, 240), ...(task.pending.reason ? { pendingReason: task.pending.reason.slice(0, 500) } : {}) } : {}),
    ...(task.completionNotice ? { completionNotice: task.completionNotice } : {}) };
}

/** Match only durable native job notices. User prose and inherited history cannot place a card. */
export function noticeTask(tasks: readonly TaskRecord[], owner: string, event: SessionEvent): TaskRecord | undefined {
  if (event.type !== 'user/message') return;
  const source = event.data.source as { kind: string; form?: string };
  if (source.kind !== 'tool-jobs' || source.form !== 'notice') return;
  const body = event.data.content.map(part => part.type === 'text' ? part.text : '').join('\n');
  const match = /^background job (\S+) \(coder: (Codex|Claude Code)(?: \[(ct-[0-9a-f]{8})\])?: /.exec(body);
  if (!match) return; // Truncated/unknown formats stay in the dock; never guess identity.
  const candidates = tasks.filter(task => task.ownerSession === owner && task.jobId === match[1] && CODER_NAMES[task.coder] === match[2]);
  const stableId = match[3];
  const matches = candidates.filter(task => !isActive(task) && event.time >= task.createdAt && (stableId
    ? task.id === stableId
    // Pre-upgrade labels lack stable identity. Require a settled task in an unambiguous job lifetime.
    : event.time >= task.updatedAt && !candidates.some(other => other.id !== task.id && other.createdAt >= task.createdAt && other.createdAt <= event.time)));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Read-only native history backfill plus live observation. This stores placement, never a replacement session. */
export function taskNotices(ctx: Context, store: CoderStore) {
  let pending = Promise.resolve();
  const inspected = new Map<string, Promise<void>>();
  const shutdown = new AbortController();
  const record = async (owner: string, event: SessionEvent) => {
    const task = noticeTask(store.list(), owner, event);
    if (task && !task.completionNotice && event.type === 'user/message') {
      await store.linkNotice(task.id, { messageId: event.data.id, seq: event.seq, at: event.time });
    }
  };
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'user/message' || (event.data.source as { kind: string }).kind !== 'tool-jobs') return;
    pending = pending.then(() => shutdown.signal.aborted ? undefined : record(session.id, event)).catch(() => {
      inspected.delete(session.id); // A later read can retry from native history.
    });
  });
  ctx.effect(() => () => { shutdown.abort(); inspected.clear(); });
  return async (owner: string) => {
    if (!inspected.has(owner)) {
      const read = (async () => {
        const history = await ctx.sessionController.inspect(owner as SessionId, shutdown.signal);
        for (const event of history.events.slice(history.inheritedEventCount)) await record(owner, event);
      })();
      inspected.set(owner, read);
      // Bound the cache of inspected session IDs; no history is retained.
      if (inspected.size > 64) inspected.delete(inspected.keys().next().value!);
    }
    try { await inspected.get(owner); } catch { inspected.delete(owner); }
    await pending;
  };
}
