import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ChannelNotifier } from '../../channels/notify.js';
import { identity } from '../../channels/protocol.js';
import { REMIND_MINUTES, type AgendaSettings } from '../settings.js';
import { REPEATS, agendaBetween, conflicts, eventReminderText, renderAgenda, renderOccurrence, renderTodo, renderTodos, sortTodos, todoReminderText, type AgendaEvent, type Occurrence, type Repeat, type Todo } from './render.js';
import { addDays, describeNow, parseDate, parseDateTime, startOfDay } from './time.js';

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

export interface AgendaStatus {
  toolsRegistered: boolean;
  events: number;
  openTodos: number;
  /** The next occurrence the reminder loop will announce, if any. */
  nextReminderAt?: number;
  lastReminderAt?: number;
}

export interface AgendaConnectorDeps {
  ctx: Context;
  opener: AgendaDomainOpener;
  /** Where reminders go: every bound chat, through the quiet-hours gate. */
  notifier: ChannelNotifier;
  sessions(): string[];
  timeZone(): string;
  now?: () => number;
  report?: (message: string) => void;
  /** Test seam: replaces setTimeout for the reminder loop. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const MAX_EVENTS = 2000;
const MAX_TODOS = 1000;
const MAX_TITLE = 120;
const MAX_TEXT = 500;
const MAX_EVENT_HOURS = 24 * 14;
const MAX_LIST_DAYS = 92;
const TICK_MS = 30_000;
/** A reminder that comes due while the service is down is still sent this long after its time; older ones are dropped, not replayed. */
const GRACE_MS = 30 * 60_000;

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  timer.unref?.();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
});

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

/**
 * The assistant's own calendar and todo list: nothing external, so no
 * authorization; the model reads and writes them through tools, and a loop
 * pushes a reminder shortly before each event and on a todo's due time.
 */
export class AgendaConnector {
  private settings!: AgendaSettings;
  private domain!: AgendaDomain;
  private disposers: (() => void)[] = [];
  private loop?: { controller: AbortController; done: Promise<void> };
  private lastReminderAt?: number;
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: AgendaConnectorDeps) {
    this.now = deps.now ?? Date.now;
    this.report = deps.report ?? (message => console.error(`[nexus-agenda] ${message}`));
    this.sleep = deps.sleep ?? sleep;
  }

  async start(settings: AgendaSettings): Promise<void> {
    this.domain = await this.deps.opener.open(agendaDomain);
    await this.apply(settings);
  }

  private get events() { return this.domain.table('events'); }
  private get todos() { return this.domain.table('todos'); }

  listEvents(): AgendaEvent[] { return [...this.events.entries()].map(([, event]) => event); }
  listTodos(): Todo[] { return sortTodos([...this.todos.entries()].map(([, todo]) => todo)); }

  view(): AgendaStatus {
    const next = this.settings?.enabled ? this.dueReminders(Infinity).map(item => item.at).sort((a, b) => a - b)[0] : undefined;
    return { toolsRegistered: this.disposers.length > 0, events: this.events.size, openTodos: this.listTodos().filter(todo => !todo.doneAt).length,
      ...(next !== undefined ? { nextReminderAt: next } : {}), ...(this.lastReminderAt !== undefined ? { lastReminderAt: this.lastReminderAt } : {}) };
  }

  async apply(settings: AgendaSettings): Promise<void> {
    const previous = this.settings;
    this.settings = settings;
    // Lead time and the todo hour are read live; only the enabled flag changes what runs.
    if (previous && previous.enabled === settings.enabled) return;
    await this.stopRuntime();
    if (!settings.enabled) return;
    this.registerTools();
    const controller = new AbortController();
    this.loop = { controller, done: this.run(controller.signal).catch(() => {}) };
  }

  private async stopRuntime(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.loop) { this.loop.controller.abort(new Error('agenda stopped')); await this.loop.done; this.loop = undefined; }
  }

  async close(): Promise<void> {
    await this.stopRuntime();
    await this.domain?.close();
  }

  private zone(): string { return this.deps.timeZone(); }

  /** What the model is told about the current moment, so relative dates resolve without a clock tool. */
  private nowText(): string { return `现在是 ${describeNow(this.now(), this.zone())}（${this.zone()}）。`; }

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

  /** How far ahead an event reminds, or undefined when it does not: its own lead (0 is at the start), else the default, where 0 means off. */
  leadOf(event: AgendaEvent): number | undefined {
    const lead = event.remindMinutes ?? (this.settings.remindMinutes > 0 ? this.settings.remindMinutes : -1);
    return lead >= 0 ? lead : undefined;
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

  // ---- reminders ----

  /** Reminders whose time is at or before `now` and not yet sent for that occurrence, oldest first. */
  private dueReminders(now: number): { key: string; at: number; text: string; mark(): Promise<void> }[] {
    const zone = this.zone();
    const due: { key: string; at: number; text: string; mark(): Promise<void> }[] = [];
    // Only the next occurrence not yet reminded matters: eight days ahead always hold one of a daily or weekly
    // event, and 93 days one of a monthly event even when a month without its day is skipped.
    const ahead = (repeat: Repeat) => (repeat === 'monthly' ? 93 : 8) * 24 * 60 * 60_000 + REMIND_MINUTES.max * 60_000;
    for (const event of this.listEvents()) {
      const lead = this.leadOf(event);
      if (lead === undefined) continue;
      const first = agendaBetween([event], (event.remindedFor ?? 0) + 1, event.repeat ? this.now() + ahead(event.repeat) : Infinity, zone).find(item => item.start > (event.remindedFor ?? -1));
      if (!first) continue;
      const at = first.start - lead * 60_000;
      if (at > now) continue;
      due.push({ key: identity('agenda-event', event.id, String(first.start)), at, text: eventReminderText(first, this.now(), zone),
        mark: () => this.events.put(event.id, { ...event, remindedFor: first.start }) });
    }
    const [hh, mm] = this.settings.todoReminderTime.split(':').map(Number);
    for (const todo of this.listTodos()) {
      if (todo.doneAt || todo.due === undefined || todo.remindedFor === todo.due) continue;
      const at = todo.dueAllDay ? todo.due + ((hh ?? 9) * 60 + (mm ?? 0)) * 60_000 : todo.due;
      if (at > now) continue;
      due.push({ key: identity('agenda-todo', todo.id, String(todo.due)), at, text: todoReminderText(todo, zone), mark: () => this.todos.put(todo.id, { ...todo, remindedFor: todo.due }) });
    }
    return due.sort((a, b) => a.at - b.at);
  }

  /** One pass of the reminder loop: send what is due within the grace window, mark the rest as missed. Exposed for tests. */
  async tick(): Promise<number> {
    const now = this.now();
    let sent = 0;
    for (const item of this.dueReminders(now)) {
      if (now - item.at > GRACE_MS) { await item.mark(); this.report(`reminder missed by more than ${GRACE_MS / 60_000} minutes, skipped: ${item.text}`); continue; }
      let delivered = false;
      for (const sessionId of this.deps.sessions()) {
        try { if (await this.deps.notifier.notify(sessionId, item.text, identity('agenda', item.key, sessionId))) delivered = true; }
        catch (error) { this.report(`reminder to ${sessionId} failed: ${(error as Error)?.message ?? error}`); }
      }
      // With no chat to reach, keep it due: a channel that binds within the grace window still gets it.
      if (!delivered) continue;
      await item.mark();
      this.lastReminderAt = now;
      sent++;
    }
    return sent;
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.tick(); }
      catch (error) { if (signal.aborted) return; this.report(`reminder tick failed: ${(error as Error)?.message ?? error}`); }
      const abort = new Promise<never>((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
      try { await Promise.race([this.sleep(TICK_MS, signal), abort]); } catch { return; }
    }
  }

  // ---- tools ----

  private registerTools(): void {
    const { ctx } = this.deps;
    const connector = this;
    const text = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const } } },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] };
    const clashText = (clashes: Occurrence[]) => ['这个时间和已有日程冲突：', ...clashes.map(item => renderOccurrence(item, connector.zone())), '先告诉用户，用户仍要安排时再带 force: true 调用。'].join('\n');
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'calendar',
      description: '用户自己的日历，由助理保管。action=list 列某段日期的日程（from 默认今天，days 默认 1）；add 新建（title、start 必填，end 或 duration_minutes 二选一，默认 1 小时，duration_minutes 0 表示只是一个时间点；有冲突时不会写入而是返回冲突，用户确认后带 force: true 再调）；update 按 id 改任意字段；remove 按 id 删。时间一律写本地时间 YYYY-MM-DD HH:mm，用系统提示里的“现在是…”换算“明天”“下周三”。',
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], required: true },
        from: { type: 'string', description: 'list：起始日期 YYYY-MM-DD，默认今天。' },
        days: { type: 'number', description: `list：从起始日期起看几天，默认 1，最多 ${MAX_LIST_DAYS}。` },
        id: { type: 'string', description: 'update/remove：日程 id（ev-xxxx）。' },
        title: { type: 'string', description: 'add 必填：做什么，例如“和张老师开会”。' },
        start: { type: 'string', description: 'add 必填：开始时间 YYYY-MM-DD HH:mm。' },
        end: { type: 'string', description: '结束时间 YYYY-MM-DD HH:mm。' },
        duration_minutes: { type: 'number', description: '不给 end 时的时长，默认 60；0 表示时间点（叫起床、吃药这类到点提醒），不占时段、不算冲突。' },
        location: { type: 'string', description: '地点。' },
        note: { type: 'string', description: '备注。' },
        repeat: { type: 'string', enum: ['none', ...REPEATS], description: 'daily 每天、weekly 每周同一天、monthly 每月同一日（没有这一日的月份跳过），都是同一时刻；none 不重复。' },
        remind_minutes: { type: 'number', description: `提前多少分钟提醒，默认按设置（当前 ${connector.settings.remindMinutes > 0 ? connector.settings.remindMinutes : '不提醒'}）；0 表示到点提醒，-1 表示这条不提醒。` },
        force: { type: 'boolean', description: '有冲突也要安排。' },
      },
      output: text,
      async execute(args) {
        const zone = connector.zone();
        if (args.action === 'list') {
          const from = args.from ? parseDate(args.from, zone) : connector.now();
          if (from === undefined) throw new Error('from 要写成 YYYY-MM-DD。');
          const days = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : 1;
          const begin = startOfDay(from, zone);
          return { text: renderAgenda(connector.agenda(from, days), begin, addDays(begin, Math.min(MAX_LIST_DAYS, days), zone), zone) };
        }
        if (args.action === 'remove') {
          if (!args.id) throw new Error('remove 需要日程 id。');
          return { text: await connector.removeEvent(args.id) ? `已删除日程 ${args.id}。` : `没有日程 ${args.id}。` };
        }
        if (args.action === 'update') {
          if (!args.id) throw new Error('update 需要日程 id。');
          const { event, clashes } = await connector.updateEvent(args.id, args as Record<string, unknown>);
          if (!event) return { text: clashText(clashes) };
          return { text: `已更新：${renderOccurrence({ event, start: event.start, end: event.end }, zone)}` };
        }
        const { event, clashes } = await connector.addEvent(args as Parameters<AgendaConnector['addEvent']>[0]);
        if (!event) return { text: clashText(clashes) };
        const lead = connector.leadOf(event);
        return { text: `已安排：${renderOccurrence({ event, start: event.start, end: event.end }, zone)}${clashes.length ? '（与已有日程冲突，按用户要求照排）' : ''}${lead === undefined ? '' : lead === 0 ? '，到点提醒' : `，开始前 ${lead} 分钟提醒`}。` };
      },
    })));
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'todo',
      description: '用户的待办清单，由助理保管。action=list 列未完成的（include_done: true 连已完成的一起）；add 新建（title 必填；due 可选，YYYY-MM-DD 表示当天到期，YYYY-MM-DD HH:mm 表示到点提醒）；done 按 id 标记完成；update 改标题、截止、备注或撤销完成（done: false）；remove 按 id 删。用户说“记个待办”“要做的事”“周五前交报告”时用它，不要用 schedule_create。',
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'done', 'update', 'remove'], required: true },
        id: { type: 'string', description: 'done/update/remove：待办 id（td-xxxx）。' },
        title: { type: 'string', description: 'add 必填：要做什么。' },
        due: { type: 'string', description: '截止：YYYY-MM-DD 或 YYYY-MM-DD HH:mm；update 时给空字符串清除。' },
        note: { type: 'string', description: '备注。' },
        done: { type: 'boolean', description: 'update：true 标记完成，false 撤销。' },
        include_done: { type: 'boolean', description: 'list：也列已完成的。' },
      },
      output: text,
      async execute(args) {
        const zone = connector.zone();
        if (args.action === 'list') return { text: renderTodos(connector.listTodos().filter(todo => args.include_done === true || !todo.doneAt), zone) };
        if (args.action === 'add') {
          const todo = await connector.addTodo(args as Parameters<AgendaConnector['addTodo']>[0]);
          return { text: `已记下：${renderTodo(todo, zone)}${todo.due !== undefined ? (todo.dueAllDay ? `，当天 ${connector.settings.todoReminderTime} 提醒` : '，到点提醒') : ''}。` };
        }
        if (!args.id) throw new Error(`${args.action} 需要待办 id。`);
        if (args.action === 'remove') return { text: await connector.removeTodo(args.id) ? `已删除待办 ${args.id}。` : `没有待办 ${args.id}。` };
        const todo = await connector.updateTodo(args.id, args.action === 'done' ? { done: true } : args as Record<string, unknown>);
        return { text: `${args.action === 'done' ? '已完成' : '已更新'}：${renderTodo(todo, zone)}` };
      },
    })));
    this.disposers.push(ctx.systemPrompt.section({
      name: 'nexus:agenda',
      order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS') + 5,
      text: () => [connector.nowText(),
        `日历与待办：用户的日程和待办由你用 calendar 和 todo 两个工具保管，不在别处。用户说“明天下午三点和张老师开会”“下周二上午十点去医院”就 calendar add；问“今天有什么安排”“这周排了什么”就 calendar list；说“记个待办”“周五前要交报告”就 todo add；说“报告交了”就 todo done。日期时间都换算成本地时间 YYYY-MM-DD HH:mm 再调用，含糊的（比如没说几点）先问一句。日程开始前和待办到期时系统会自动推送提醒，不要再为它们建 schedule_create 提醒。calendar 返回冲突时先告诉用户，用户坚持再带 force。`,
        `固定时间重复的提醒也放进日历：用户说“每天七点半叫我起床”“每周一早上提醒我交周报”“每月 1 号提醒我交房租”，就 calendar add，repeat 选 daily、weekly 或 monthly，duration_minutes 给 0（只是一个时间点，不占时段、不算冲突），remind_minutes 给 0（到点提醒），title 写提醒时要说的话。系统到点推送，不经过你，也不会漏掉一天；不要用 schedule_create 一次一次地排下一次。`,
      ].join('\n'),
    }));
  }
}
