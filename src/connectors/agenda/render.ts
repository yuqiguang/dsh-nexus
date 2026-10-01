import { addDays, addMonths, formatClock, formatDateTime, formatDay, sameDay } from './time.js';

/** How an event recurs from its first `start` on: every day, the same weekday, or the same day of the month (months without that day are skipped). */
export type Repeat = 'daily' | 'weekly' | 'monthly';
export const REPEATS: readonly Repeat[] = ['daily', 'weekly', 'monthly'];
const REPEAT_LABEL: Record<Repeat, string> = { daily: '每天', weekly: '每周', monthly: '每月' };

/** One calendar entry. `end === start` is a point in time (a wake-up call, a pill): it takes no span and clashes with nothing. */
export interface AgendaEvent {
  id: string;
  title: string;
  /** Epoch millis of the (first) occurrence. */
  start: number;
  end: number;
  location?: string;
  note?: string;
  repeat?: Repeat;
  /** Minutes before the start at which to remind: 0 at the start itself, negative never; absent means the connector's default. */
  remindMinutes?: number;
  /** The occurrence start that was last reminded, so a restart never repeats or backfills a reminder. */
  remindedFor?: number;
  createdAt: number;
}

export interface Todo {
  id: string;
  title: string;
  /** Epoch millis; with `dueAllDay` it is the day's local midnight and the time of day is not meaningful. */
  due?: number;
  dueAllDay?: boolean;
  note?: string;
  /** When it was marked done; absent while open. */
  doneAt?: number;
  remindedFor?: number;
  createdAt: number;
}

/** One concrete occurrence of an event, for listing and reminding. */
export interface Occurrence { event: AgendaEvent; start: number; end: number }

/** About ten years of each kind of repeat, so a runaway range cannot loop for ever. */
const LIMIT: Record<Repeat, number> = { daily: 3660, weekly: 520, monthly: 120 };
/** An upper bound on one step, so the first step worth looking at can be skipped to without missing one (a DST day has 25 hours). */
const STEP_MS: Record<Repeat, number> = { daily: 25 * 3_600_000, weekly: 7 * 25 * 3_600_000, monthly: 31 * 25 * 3_600_000 };

/** Whether a span overlaps `[from, to)`; a point counts when it falls inside. */
function overlaps(start: number, end: number, from: number, to: number): boolean {
  return start < to && (end > start ? end > from : start >= from);
}

/** The occurrences of `event` that overlap `[from, to)`, in time order. */
export function occurrences(event: AgendaEvent, from: number, to: number, timeZone: string): Occurrence[] {
  const duration = event.end - event.start;
  const repeat = event.repeat;
  if (!repeat) return overlaps(event.start, event.end, from, to) ? [{ event, start: event.start, end: event.end }] : [];
  const result: Occurrence[] = [];
  // Steps are counted on the calendar so a zone with DST keeps the wall-clock time.
  for (let step = Math.max(0, Math.floor((from - event.end) / STEP_MS[repeat]) - 1); step < LIMIT[repeat]; step++) {
    const start = repeat === 'monthly' ? addMonths(event.start, step, timeZone) : addDays(event.start, (repeat === 'weekly' ? 7 : 1) * step, timeZone);
    if (start === undefined) continue;
    if (start >= to) break;
    if (overlaps(start, start + duration, from, to)) result.push({ event, start, end: start + duration });
  }
  return result;
}

/** Every occurrence of every event in `[from, to)`, soonest first. */
export function agendaBetween(events: readonly AgendaEvent[], from: number, to: number, timeZone: string): Occurrence[] {
  return events.flatMap(event => occurrences(event, from, to, timeZone)).sort((a, b) => a.start - b.start || a.event.createdAt - b.event.createdAt);
}

/** Occurrences of other events that overlap the candidate span; a point in time takes no span, so it clashes with nothing. */
export function conflicts(events: readonly AgendaEvent[], start: number, end: number, timeZone: string, exceptId?: string): Occurrence[] {
  if (end <= start) return [];
  return agendaBetween(events.filter(event => event.id !== exceptId && event.end > event.start), start, end, timeZone);
}

function span(item: Occurrence, timeZone: string): string {
  if (item.end === item.start) return formatDateTime(item.start, timeZone);
  return sameDay(item.start, item.end, timeZone) ? `${formatDateTime(item.start, timeZone)}–${formatClock(item.end, timeZone)}` : `${formatDateTime(item.start, timeZone)}–${formatDateTime(item.end, timeZone)}`;
}

/** `[ev-1a2b] 9/22（周二）15:00–16:00 和张老师开会 @ 会议室（每周）｜备注`. */
export function renderOccurrence(item: Occurrence, timeZone: string): string {
  const { event } = item;
  return `[${event.id}] ${span(item, timeZone)} ${event.title}${event.location ? ` @ ${event.location}` : ''}${event.repeat ? `（${REPEAT_LABEL[event.repeat]}）` : ''}${event.note ? `｜${event.note}` : ''}`;
}

/** A day-grouped list for the model; empty ranges say so. */
export function renderAgenda(items: readonly Occurrence[], from: number, to: number, timeZone: string): string {
  if (!items.length) return `${formatDay(from, timeZone)} 到 ${formatDay(to - 1, timeZone)} 没有日程。`;
  const lines: string[] = [];
  let day = '';
  for (const item of items) {
    const label = formatDay(item.start, timeZone);
    if (label !== day) { day = label; lines.push(`${label}：`); }
    lines.push(renderOccurrence(item, timeZone));
  }
  return lines.join('\n');
}

export function renderTodo(todo: Todo, timeZone: string): string {
  const due = todo.due === undefined ? '' : todo.dueAllDay ? `，${formatDay(todo.due, timeZone)} 前` : `，${formatDateTime(todo.due, timeZone)} 前`;
  return `[${todo.id}] ${todo.doneAt ? '✓ ' : ''}${todo.title}${due}${todo.note ? `｜${todo.note}` : ''}`;
}

/** Open todos first by due (undated last), then done ones if asked. */
export function sortTodos(todos: readonly Todo[]): Todo[] {
  return [...todos].sort((a, b) => Number(!!a.doneAt) - Number(!!b.doneAt) || (a.due ?? Infinity) - (b.due ?? Infinity) || a.createdAt - b.createdAt);
}

export function renderTodos(todos: readonly Todo[], timeZone: string): string {
  return todos.length ? todos.map(todo => renderTodo(todo, timeZone)).join('\n') : '没有待办。';
}

/** The push sent before an event: what, when, where. */
export function eventReminderText(item: Occurrence, now: number, timeZone: string): string {
  const minutes = Math.round((item.start - now) / 60_000);
  const lead = minutes <= 0 ? '现在' : `${minutes} 分钟后`;
  return `日程提醒：${lead}（${formatDateTime(item.start, timeZone)}）${item.event.title}${item.event.location ? `，地点 ${item.event.location}` : ''}${item.event.note ? `。${item.event.note}` : '。'}`;
}

export function todoReminderText(todo: Todo, timeZone: string): string {
  return todo.dueAllDay ? `待办提醒：「${todo.title}」今天到期。` : `待办提醒：「${todo.title}」${formatDateTime(todo.due!, timeZone)} 到期。`;
}
