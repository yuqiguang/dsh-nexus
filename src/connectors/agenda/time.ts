import { formatLocal, zoned } from '../../assistant/clock.js';

/** Wall-clock handling for the agenda: the model speaks local `YYYY-MM-DD HH:mm`, storage keeps epoch millis. */

const DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const DAY_MS = 24 * 60 * 60_000;

interface Parts { y: number; m: number; d: number; h: number; mi: number; weekday: number }

function parts(at: number, timeZone: string): Parts {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(at);
  const get = (type: string) => formatted.find(part => part.type === type)?.value ?? '';
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), h: Number(get('hour')), mi: Number(get('minute')),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')) };
}

function validDate(y: number, m: number, d: number): boolean {
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** A local date-time (`2026-09-22 15:00`) as epoch millis; `undefined` for anything else. */
export function parseDateTime(text: unknown, timeZone: string): number | undefined {
  if (typeof text !== 'string') return undefined;
  const match = DATE_TIME.exec(text.trim());
  if (!match) return undefined;
  const [y, m, d, h, mi] = match.slice(1).map(Number) as [number, number, number, number, number];
  if (!validDate(y, m, d) || h > 23 || mi > 59) return undefined;
  return zoned(y, m, d, h, mi, timeZone);
}

/** A local date (`2026-09-22`) as the epoch millis of its midnight; `undefined` for anything else. */
export function parseDate(text: unknown, timeZone: string): number | undefined {
  if (typeof text !== 'string') return undefined;
  const match = DATE.exec(text.trim());
  if (!match) return undefined;
  const [y, m, d] = match.slice(1).map(Number) as [number, number, number];
  return validDate(y, m, d) ? zoned(y, m, d, 0, 0, timeZone) : undefined;
}

/** Local midnight of the day containing `at`. */
export function startOfDay(at: number, timeZone: string): number {
  const { y, m, d } = parts(at, timeZone);
  return zoned(y, m, d, 0, 0, timeZone);
}

/** Local midnight `days` days after the day containing `at` (DST-safe: computed from the calendar, not by adding hours). */
export function addDays(at: number, days: number, timeZone: string): number {
  const { y, m, d, h, mi } = parts(at, timeZone);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return zoned(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), h, mi, timeZone);
}

/**
 * The same day of the month and wall-clock time `months` months after `at`; `undefined` when that month has
 * no such day (the 31st in a 30-day month), which a monthly repeat skips rather than moving.
 */
export function addMonths(at: number, months: number, timeZone: string): number | undefined {
  const { y, m, d, h, mi } = parts(at, timeZone);
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const [year, month] = [first.getUTCFullYear(), first.getUTCMonth() + 1];
  return validDate(year, month, d) ? zoned(year, month, d, h, mi, timeZone) : undefined;
}

export function localDateOf(at: number, timeZone: string): string {
  const { y, m, d } = parts(at, timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** `9/22（周二）15:00`. */
export function formatDateTime(at: number, timeZone: string): string {
  const { m, d, h, mi, weekday } = parts(at, timeZone);
  return `${m}/${d}（周${WEEKDAYS[weekday]}）${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** `9/22（周二）`. */
export function formatDay(at: number, timeZone: string): string {
  const { m, d, weekday } = parts(at, timeZone);
  return `${m}/${d}（周${WEEKDAYS[weekday]}）`;
}

/** `15:00`. */
export function formatClock(at: number, timeZone: string): string {
  const { h, mi } = parts(at, timeZone);
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** What the model needs to resolve "明天下午三点": the full local date, weekday and time. */
export function describeNow(now: number, timeZone: string): string {
  const { y, m, d, weekday } = parts(now, timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}（周${WEEKDAYS[weekday]}）${formatLocal(now, timeZone).replace(/^\S+ /, '')}`;
}

export function sameDay(a: number, b: number, timeZone: string): boolean {
  return localDateOf(a, timeZone) === localDateOf(b, timeZone);
}

export { DAY_MS };
