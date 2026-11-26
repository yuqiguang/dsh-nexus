import type { LegacyScheduleRecord, ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import type { SessionId } from '@deepseek-ai/dsh-session';

/** A session-bound view across the old Session scheduler and new Host scheduler. */
export type ScheduleCatalogEntry = ScheduleRecord & {
  sessionId: SessionId; status: 'active' | 'inactive' | 'paused' | 'ended'; lastDelivery?: unknown;
  target?: { kind: string; sessionId?: SessionId }; updatedAt?: string;
};
export type ScheduleTimingChange =
  | { kind: 'at'; at: string } | { kind: 'every'; every_seconds: number }
  | { kind: 'daily'; daily: { time: string; time_zone: string } }
  | { kind: 'weekly'; weekly: { time: string; time_zone: string; weekdays: number[] } }
  | { kind: 'cron'; cron: { expression: string; time_zone: string } };

/** Only fixed destination tasks belong to a channel; involved editors are not owners. */
export async function scheduleCatalog(service: { catalog(): Promise<unknown[]> } | undefined): Promise<ScheduleCatalogEntry[]> {
  const entries = await service?.catalog() ?? [];
  return entries.flatMap(value => {
    const entry = value as ScheduleCatalogEntry;
    const sessionId = entry.target ? entry.target.kind === 'session' ? entry.target.sessionId : undefined : entry.sessionId;
    return sessionId ? [{ ...entry, sessionId }] : [];
  });
}
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session';

/** Only this module reads the native Schedule plugin's durable events and message framing. */

/** One frozen version-1 `schedule/change` payload, read without trusting any of its fields. */
interface RawScheduleChange {
  readonly version?: unknown;
  readonly operation?: unknown;
  readonly id?: unknown;
  readonly schedule?: unknown;
}

/**
 * Replay the version-1 `schedule/change` events an older Session log still carries.
 *
 * DSH 0.2.2 removed the native `foldScheduleEvents` helper together with the Session-local
 * reminder runtime, so Nexus folds the frozen events itself instead of importing it. Neither
 * side executes these records any more: the fold only powers the "old reminders were not
 * migrated" diagnostic, so an unreadable change is skipped rather than failing the whole log.
 */
export function activeLegacyReminders(events: readonly SessionEvent[]): readonly LegacyScheduleRecord[] {
  const active = new Map<string, LegacyScheduleRecord>();
  for (const event of events) {
    if (event.type !== 'schedule/change') continue;
    const change = event.data as unknown as RawScheduleChange;
    if (change === null || typeof change !== 'object' || change.version !== 1) continue;
    if (change.operation === 'create') {
      const record = change.schedule as Partial<LegacyScheduleRecord> | undefined;
      if (record === null || typeof record !== 'object') continue;
      if (typeof record.id !== 'string' || typeof record.kind !== 'string') continue;
      active.set(record.id, record as LegacyScheduleRecord);
      continue;
    }
    if (typeof change.id !== 'string') continue;
    if (change.operation === 'delete') { active.delete(change.id); continue; }
    // A dispatch retires a one-shot record and advances a fixed-rate one; only the latter survives.
    const current = active.get(change.id);
    if (change.operation === 'dispatch' && current !== undefined && current.kind !== 'every') active.delete(change.id);
  }
  return [...active.values()];
}

const zone = 'Asia/Shanghai';

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { timeZone: zone, hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** One line per reminder for the channel status reply. */
export function describeReminders(records: readonly (ScheduleRecord | LegacyScheduleRecord)[]): string[] {
  return records.map(record => {
    const recurring = record.kind === 'every' ? `每 ${Math.round(record.everySeconds / 60)} 分钟`
      : record.kind === 'daily' ? `每天 ${record.time}（${record.timeZone}）`
      : record.kind === 'weekly' ? `每周 ${record.weekdays.join('、')} ${record.time}（${record.timeZone}）`
      : record.kind === 'cron' ? `${record.expression}（${record.timeZone}）` : undefined;
    const rule = recurring ? `${recurring}，下次 ${when(record.scheduledAt)}` : when(record.scheduledAt);
    return `- ${record.id} ${rule}：${record.prompt.length > 60 ? `${record.prompt.slice(0, 60)}…` : record.prompt}`;
  });
}

/** Whether a user-role message was produced by a plugin (reminder, job notice) rather than typed by the user. */
export function pluginInitiated(message: UserMessage): boolean {
  return message.source.kind !== 'user';
}

/** The model says this when a monitoring reminder found nothing worth pushing. */
export const QUIET_REPLY = '静默';

export function isQuietReply(text: string): boolean {
  return text.trim().replace(/^[\[【(（]|[\]】)）]$/g, '').replace(/[。.!！]+$/, '').trim() === QUIET_REPLY;
}
