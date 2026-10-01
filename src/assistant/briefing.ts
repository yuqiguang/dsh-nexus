import type { Context } from '@deepseek-ai/cordis';
import type { ScheduleRecord } from '@deepseek-ai/dsh-schedule';
import type { ChannelNotifier } from '../channels/notify.js';
import { identity } from '../channels/protocol.js';
import { describeReminders } from '../dsh/schedule.js';
import type { Occurrence, Todo } from '../connectors/agenda/render.js';
import { renderOccurrence, renderTodo } from '../connectors/agenda/render.js';
import { formatLocal, localDate, nextOccurrence } from './clock.js';
import type { AssistantSettingsRecord } from './settings.js';

/** The assistant's own calendar and todo list, when the connector is on. */
export type AgendaSource = (now: number, days: number) => { occurrences: Occurrence[]; todos: Todo[] } | undefined;

/** The day's schedule and open todos, then the reminders and monitors the assistant itself holds. */
export function briefingText(now: number, timeZone: string, reminders: readonly ScheduleRecord[], agenda?: ReturnType<AgendaSource>): string {
  const dayEnd = nextOccurrence(now, '00:00', timeZone);
  const today = reminders.filter(record => record.kind !== 'every' && Date.parse(record.scheduledAt) < dayEnd);
  const later = reminders.filter(record => record.kind !== 'every' && Date.parse(record.scheduledAt) >= dayEnd);
  const monitors = reminders.filter(record => record.kind === 'every');
  const lines = [`早上好，${formatLocal(now, timeZone).replace(/ .*$/, '')} 的简报：`];
  if (agenda) {
    const events = agenda.occurrences.filter(item => item.start < dayEnd && item.end > now - 60_000);
    lines.push(events.length ? `今天的日程（${events.length}）：` : '今天没有日程。', ...events.map(item => renderOccurrence(item, timeZone)));
    const due = agenda.todos.filter(todo => todo.due !== undefined && todo.due < dayEnd);
    const rest = agenda.todos.filter(todo => !due.includes(todo));
    if (due.length) lines.push(`今天到期或已过期的待办（${due.length}）：`, ...due.map(todo => renderTodo(todo, timeZone)));
    if (rest.length) lines.push(`其他待办（${rest.length}）：`, ...rest.slice(0, 10).map(todo => renderTodo(todo, timeZone)), ...(rest.length > 10 ? [`…还有 ${rest.length - 10} 条`] : []));
  }
  lines.push(today.length ? `今天的提醒（${today.length}）：` : '今天没有待触发的提醒。', ...describeReminders(today));
  if (later.length) lines.push(`之后的提醒（${later.length}）：`, ...describeReminders(later));
  if (monitors.length) lines.push(`进行中的监控（${monitors.length}）：`, ...describeReminders(monitors));
  return lines.join('\n');
}

export interface BriefingDeps {
  ctx: Pick<Context, 'schedule'> & Partial<Pick<Context, 'get'>>;
  sameChat?(first: string, second: string): boolean;
  notifier: ChannelNotifier;
  /** Sessions bound to a chat that a briefing should reach. */
  sessions(): string[];
  now?: () => number;
  onError?: (message: string) => void;
}

/** Sends one briefing per local day at the configured time; a restart after the time does not resend. */
export class DailyBriefing {
  private settings: AssistantSettingsRecord;
  private timer?: NodeJS.Timeout;
  private sentOn?: string;
  private agenda?: AgendaSource;
  private readonly now: () => number;

  constructor(private readonly deps: BriefingDeps, settings: AssistantSettingsRecord) {
    this.settings = settings;
    this.now = deps.now ?? Date.now;
    this.arm();
  }

  update(settings: AssistantSettingsRecord): void { this.settings = settings; this.arm(); }

  attachAgenda(source: AgendaSource): void { this.agenda = source; }

  nextAt(): number | undefined {
    const { briefingTime, timeZone } = this.settings;
    return briefingTime ? nextOccurrence(this.now(), briefingTime, timeZone) : undefined;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const at = this.nextAt();
    if (at === undefined) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.send().finally(() => this.arm()); }, Math.min(at - this.now(), 2 ** 31 - 1));
    this.timer.unref();
  }

  async send(force = false): Promise<number> {
    const today = localDate(this.now(), this.settings.timeZone);
    if (!force && this.sentOn === today) return 0;
    this.sentOn = today;
    let sent = 0;
    for (const sessionId of this.deps.sessions()) {
      try {
        const schedule = typeof this.deps.ctx.get === 'function' ? this.deps.ctx.get('schedule') as Context['schedule'] | undefined : this.deps.ctx.schedule;
        const reminders = (await schedule?.catalog() ?? []).filter(record => record.status === 'active'
          && (this.deps.sameChat?.(sessionId, record.sessionId) ?? sessionId === record.sessionId));
        const text = briefingText(this.now(), this.settings.timeZone, reminders, this.agenda?.(this.now(), 1));
        if (await this.deps.notifier.notify(sessionId, text, identity('briefing', sessionId, today))) sent++;
      } catch (error) { this.deps.onError?.(`briefing for ${sessionId} failed: ${(error as Error)?.message ?? error}`); }
    }
    return sent;
  }

  close(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
