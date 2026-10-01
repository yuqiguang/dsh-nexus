/** Wall-clock arithmetic in the assistant's time zone; no DST assumptions beyond Intl's. */

function parts(now: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number } {
  const formatted = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(formatted.find(part => part.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute') };
}

/** Minutes since local midnight. */
export function localMinutes(now: number, timeZone: string): number {
  const { h, mi } = parts(now, timeZone);
  return h * 60 + mi;
}

export function clockMinutes(clock: string): number {
  const [h, m] = clock.split(':').map(Number);
  return h! * 60 + m!;
}

/** Epoch millis of the local wall-clock `y-m-d h:mi` in `timeZone`, found by correcting a UTC guess with the zone's offset at that instant. */
export function zoned(y: number, m: number, d: number, h: number, mi: number, timeZone: string): number {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let round = 0; round < 2; round++) {
    const seen = parts(guess, timeZone);
    const seenUtc = Date.UTC(seen.y, seen.m - 1, seen.d, seen.h, seen.mi);
    guess += Date.UTC(y, m - 1, d, h, mi) - seenUtc;
  }
  return guess;
}

/** The next instant strictly after `now` at which the local clock reads `clock`. */
export function nextOccurrence(now: number, clock: string, timeZone: string): number {
  const [h, mi] = clock.split(':').map(Number);
  const today = parts(now, timeZone);
  const candidate = zoned(today.y, today.m, today.d, h!, mi!, timeZone);
  if (candidate > now) return candidate;
  const tomorrow = parts(now + 24 * 60 * 60_000, timeZone);
  return zoned(tomorrow.y, tomorrow.m, tomorrow.d, h!, mi!, timeZone);
}

/** `true` between start and end (a window that crosses midnight is allowed). */
export function inWindow(now: number, start: string, end: string, timeZone: string): boolean {
  const minute = localMinutes(now, timeZone);
  const from = clockMinutes(start);
  const to = clockMinutes(end);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** Local calendar date `YYYY-MM-DD`, for once-a-day bookkeeping. */
export function localDate(now: number, timeZone: string): string {
  const { y, m, d } = parts(now, timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function formatLocal(now: number, timeZone: string): string {
  return new Date(now).toLocaleString('zh-CN', { timeZone, hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
