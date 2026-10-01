import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { REMIND_MINUTES } from '../settings.js';
import { REPEATS, agendaBetween, conflicts, sortTodos, type AgendaEvent, type Occurrence, type Repeat, type Todo } from './render.js';
import { addDays, parseDate, parseDateTime, startOfDay } from './time.js';

export const agendaDomain = defineDomain({
  name: 'nexus_agenda',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    events: domainTable<string, AgendaEvent>(z.object({ id: z.string(), title: z.string(), start: z.number(), end: z.number(), location: z.string().optional(), note: z.string().optional(),
      repeat: z.enum(['daily', 'weekly', 'monthly']).optional(), remindMinutes: z.number().optional(), remindedFor: z.number().optional(), createdAt: z.number() })),
    todos: domainTable<string, Todo>(z.object({ id: z.string(), title: z.string(), due: z.number().optional(), dueAllDay: z.boolean().optional(), note: z.string().optional(),
      doneAt: z.number().optional(), remindedFor: z.number().optional(), createdAt: z.number() })),
  },
});
export type AgendaDomain = Domain<typeof agendaDomain>;
export interface AgendaDomainOpener { open(spec: typeof agendaDomain): Promise<AgendaDomain> }

const MAX_EVENTS = 2000;
const MAX_TODOS = 1000;
const MAX_TITLE = 120;
const MAX_TEXT = 500;
const MAX_EVENT_HOURS = 24 * 14;
const MAX_LIST_DAYS = 92;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** The repeat the model asked for; anything else (none, empty, unknown) is no repeat. */
function repeatInput(value: unknown): Repeat | undefined {
  return REPEATS.includes(value as Repeat) ? value as Repeat : undefined;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  return clean(value, max) || undefined;
}

/** Core-owned data and owner management remain available without the optional runtime. */
export class AgendaData {
  private constructor(private readonly domain: AgendaDomain, private readonly zone: () => string, private readonly now: () => number) {}
  static async open(opener: AgendaDomainOpener, timeZone: () => string, now = Date.now): Promise<AgendaData> {
    return new AgendaData(await opener.open(agendaDomain), timeZone, now);
  }
  private get events() { return this.domain.table('events'); }
  private get todos() { return this.domain.table('todos'); }
  listEvents(): AgendaEvent[] { return [...this.events.entries()].map(([, event]) => event); }
  listTodos(): Todo[] { return sortTodos([...this.todos.entries()].map(([, todo]) => todo)); }
  eventCurrent(event: AgendaEvent): boolean { return isDeepStrictEqual(this.events.get(event.id), event); }
  todoCurrent(todo: Todo): boolean { return isDeepStrictEqual(this.todos.get(todo.id), todo); }

  async markEvent(event: AgendaEvent, start: number): Promise<void> {
    try { await this.events.update(event.id, current => isDeepStrictEqual(current, event) ? { ...current, remindedFor: start } : current); }
    catch (error) { if ((error as { code?: string }).code !== 'missing-key') throw error; }
  }
  async markTodo(todo: Todo): Promise<void> {
    try { await this.todos.update(todo.id, current => isDeepStrictEqual(current, todo) ? { ...current, remindedFor: todo.due } : current); }
    catch (error) { if ((error as { code?: string }).code !== 'missing-key') throw error; }
  }

  // ---- events ----

  /** Without `force`, a clash returns the clashing occurrences and writes nothing. */
  async addEvent(input: { title: unknown; start: unknown; end?: unknown; duration_minutes?: unknown; location?: unknown; note?: unknown; repeat?: unknown; remind_minutes?: unknown; force?: unknown }): Promise<{ event?: AgendaEvent; clashes: Occurrence[] }> {
    const title = clean(input.title, MAX_TITLE);
    if (!title) throw new Error('日程需要标题。');
    const start = parseDateTime(input.start, this.zone());
    if (start === undefined) throw new Error('开始时间要写成 YYYY-MM-DD HH:mm，例如 2026-09-22 15:00。');
    // duration_minutes 0 is a point in time: a reminder that takes no span.
    const end = input.end !== undefined && input.end !== null && input.end !== '' ? parseDateTime(input.end, this.zone())
      : start + 60_000 * (typeof input.duration_minutes === 'number' && input.duration_minutes >= 0 ? Math.min(MAX_EVENT_HOURS * 60, Math.floor(input.duration_minutes)) : 60);
    if (end === undefined) throw new Error('结束时间要写成 YYYY-MM-DD HH:mm。');
    if (end < start || (end === start && input.duration_minutes !== 0)) throw new Error('结束时间要晚于开始时间。');
    if (end - start > MAX_EVENT_HOURS * 3_600_000) throw new Error(`一条日程最长 ${MAX_EVENT_HOURS / 24} 天。`);
    if (this.events.size >= MAX_EVENTS) throw new Error(`日程最多 ${MAX_EVENTS} 条，先删掉过去的。`);
    const repeat = repeatInput(input.repeat);
    const remind = this.remindInput(input.remind_minutes);
    const clashes = conflicts(this.listEvents(), start, end, this.zone());
    if (clashes.length && input.force !== true) return { clashes };
    const event: AgendaEvent = { id: `ev-${randomBytes(4).toString('hex')}`, title, start, end, createdAt: this.now(),
      ...(optionalText(input.location, MAX_TITLE) ? { location: optionalText(input.location, MAX_TITLE) } : {}),
      ...(optionalText(input.note, MAX_TEXT) ? { note: optionalText(input.note, MAX_TEXT) } : {}),
      ...(repeat ? { repeat } : {}), ...(remind !== undefined ? { remindMinutes: remind } : {}) };
    await this.events.put(event.id, event);
    return { event, clashes };
  }

  async updateEvent(id: string, input: Record<string, unknown>): Promise<{ event?: AgendaEvent; clashes: Occurrence[] }> {
    const current = this.events.get(id);
    if (!current) throw new Error(`没有日程 ${id}。`);
    const next: AgendaEvent = { ...current };
    if (input.title !== undefined) { const title = clean(input.title, MAX_TITLE); if (!title) throw new Error('标题不能为空。'); next.title = title; }
    const duration = current.end - current.start;
    if (input.start !== undefined) {
      const start = parseDateTime(input.start, this.zone());
      if (start === undefined) throw new Error('开始时间要写成 YYYY-MM-DD HH:mm。');
      next.start = start;
      next.end = input.end === undefined ? start + duration : next.end;
      next.remindedFor = undefined;
    }
    if (input.end !== undefined) {
      const end = parseDateTime(input.end, this.zone());
      if (end === undefined) throw new Error('结束时间要写成 YYYY-MM-DD HH:mm。');
      next.end = end;
    }
    if (next.end < next.start || (next.end === next.start && current.end !== current.start)) throw new Error('结束时间要晚于开始时间。');
    if (input.location !== undefined) { const location = optionalText(input.location, MAX_TITLE); if (location) next.location = location; else delete next.location; }
    if (input.note !== undefined) { const note = optionalText(input.note, MAX_TEXT); if (note) next.note = note; else delete next.note; }
    if (input.repeat !== undefined) { const repeat = repeatInput(input.repeat); if (repeat) next.repeat = repeat; else delete next.repeat; }
    if (input.remind_minutes !== undefined) { const remind = this.remindInput(input.remind_minutes); if (remind === undefined) delete next.remindMinutes; else next.remindMinutes = remind; }
    if (next.remindedFor === undefined) delete next.remindedFor;
    const clashes = conflicts(this.listEvents(), next.start, next.end, this.zone(), id);
    if (clashes.length && input.force !== true) return { clashes };
    await this.events.put(id, next);
    return { event: next, clashes };
  }

  removeEvent(id: string): Promise<boolean> { return this.events.delete(id); }

  /** Minutes before the start; 0 is at the start, -1 means this event is not reminded. */
  private remindInput(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (value === -1) return -1;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < REMIND_MINUTES.min || value > REMIND_MINUTES.max) throw new Error(`提前提醒的分钟数要在 ${REMIND_MINUTES.min} 到 ${REMIND_MINUTES.max} 之间，-1 表示不提醒。`);
    return Math.floor(value);
  }

  /** Occurrences in a local day range; `days` counts from `from`'s day. */
  agenda(from: number, days: number): Occurrence[] {
    const zone = this.zone();
    const begin = startOfDay(from, zone);
    return agendaBetween(this.listEvents(), begin, addDays(begin, Math.max(1, Math.min(MAX_LIST_DAYS, days)), zone), zone);
  }

  // ---- todos ----

  async addTodo(input: { title: unknown; due?: unknown; note?: unknown }): Promise<Todo> {
    const title = clean(input.title, MAX_TITLE);
    if (!title) throw new Error('待办需要标题。');
    if (this.todos.size >= MAX_TODOS) throw new Error(`待办最多 ${MAX_TODOS} 条，先清掉已完成的。`);
    const due = this.dueInput(input.due);
    const todo: Todo = { id: `td-${randomBytes(4).toString('hex')}`, title, createdAt: this.now(), ...(due ? { due: due.at, ...(due.allDay ? { dueAllDay: true } : {}) } : {}),
      ...(optionalText(input.note, MAX_TEXT) ? { note: optionalText(input.note, MAX_TEXT) } : {}) };
    await this.todos.put(todo.id, todo);
    return todo;
  }

  async updateTodo(id: string, input: Record<string, unknown>): Promise<Todo> {
    const current = this.todos.get(id);
    if (!current) throw new Error(`没有待办 ${id}。`);
    const next: Todo = { ...current };
    if (input.title !== undefined) { const title = clean(input.title, MAX_TITLE); if (!title) throw new Error('标题不能为空。'); next.title = title; }
    if (input.due !== undefined) {
      const due = this.dueInput(input.due);
      delete next.due; delete next.dueAllDay; delete next.remindedFor;
      if (due) { next.due = due.at; if (due.allDay) next.dueAllDay = true; }
    }
    if (input.note !== undefined) { const note = optionalText(input.note, MAX_TEXT); if (note) next.note = note; else delete next.note; }
    if (input.done === true) next.doneAt = this.now();
    if (input.done === false) delete next.doneAt;
    await this.todos.put(id, next);
    return next;
  }

  removeTodo(id: string): Promise<boolean> { return this.todos.delete(id); }

  /** `YYYY-MM-DD` means the whole day; `YYYY-MM-DD HH:mm` a moment; empty clears. */
  private dueInput(value: unknown): { at: number; allDay: boolean } | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const moment = parseDateTime(value, this.zone());
    if (moment !== undefined) return { at: moment, allDay: false };
    const day = parseDate(value, this.zone());
    if (day !== undefined) return { at: day, allDay: true };
    throw new Error('截止时间要写成 YYYY-MM-DD（当天）或 YYYY-MM-DD HH:mm。');
  }

  close(): Promise<void> { return this.domain.close(); }
}
