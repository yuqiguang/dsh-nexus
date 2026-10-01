import { foldScheduleEvents, type LegacyScheduleRecord, type ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session';

/** Only this module reads the native Schedule plugin's durable events and message framing. */

/** Historical reminders only: DSH 0.2 no longer schedules these events. Used for upgrade diagnostics. */
export function activeLegacyReminders(events: readonly SessionEvent[]): readonly LegacyScheduleRecord[] {
  try { return foldScheduleEvents(events).active; }
  catch { return []; }
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
