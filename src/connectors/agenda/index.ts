import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools';
import { ChannelError } from '../../channels/types.js';
import type { ChannelNotifier } from '../../channels/notify.js';
import { identity } from '../../channels/protocol.js';
import { REMIND_MINUTES, type AgendaSettings } from '../settings.js';
import { REPEATS, agendaBetween, eventReminderText, renderAgenda, renderOccurrence, renderTodo, renderTodos, todoReminderText, type AgendaEvent, type Occurrence, type Repeat, type Todo } from './render.js';
import { addDays, describeNow, parseDate, startOfDay } from './time.js';

import { AgendaData, type AgendaDomainOpener } from './data.js';
export { agendaDomain, type AgendaDomain, type AgendaDomainOpener } from './data.js';

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
  data?: AgendaData;
  /** Where reminders go: every bound chat, through the quiet-hours gate. */
  notifier: ChannelNotifier;
  sessions(): string[];
  timeZone(): string;
  now?: () => number;
  report?: (message: string) => void;
  /** Test seam: replaces setTimeout for the reminder loop. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

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

/**
 * The assistant's own calendar and todo list: nothing external, so no
 * authorization; the model reads and writes them through tools, and a loop
 * pushes a reminder shortly before each event and on a todo's due time.
 */
export class AgendaConnector {
  private settings!: AgendaSettings;
  private data!: AgendaData;
  private closed = false;
  private generation = new AbortController();
  private changes: Promise<void> = Promise.resolve();
  private readonly admissions = new WeakMap<ToolExecution, AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private ticking?: Promise<number>;
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
    this.data = this.deps.data ?? await AgendaData.open(this.deps.opener, this.deps.timeZone, this.now);
    await this.apply(settings);
  }

  get enabled(): boolean { return !this.closed && !this.generation.signal.aborted && this.settings?.enabled === true; }
  private current(generation: AbortController): boolean { return this.enabled && this.generation === generation; }
  private assertCurrent(generation: AbortController): void { if (!this.current(generation)) throw new ChannelError('module_disabled'); }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  view(): AgendaStatus {
    const next = this.enabled ? this.dueReminders(Infinity).map(item => item.at).sort((a, b) => a - b)[0] : undefined;
    return { toolsRegistered: this.enabled && this.disposers.length > 0, events: this.listEvents().length, openTodos: this.listTodos().filter(todo => !todo.doneAt).length,
      ...(next !== undefined ? { nextReminderAt: next } : {}), ...(this.lastReminderAt !== undefined ? { lastReminderAt: this.lastReminderAt } : {}) };
  }

  apply(settings: AgendaSettings): Promise<void> {
    if (this.closed) return Promise.reject(new ChannelError('module_disabled'));
    const previous = this.settings;
    this.settings = settings;
    // Lead time and the todo hour remain live preferences.
    if (previous && previous.enabled === settings.enabled) return this.changes;
    this.generation.abort();
    const generation = this.generation = new AbortController();
    const change = this.changes.catch(() => {}).then(async () => {
      await this.stopRuntime();
      if (!this.current(generation)) return;
      this.registerTools(generation);
      const controller = new AbortController();
      this.loop = { controller, done: this.run(controller.signal, generation).catch(() => {}) };
    });
    this.changes = change;
    return change;
  }

  private async stopRuntime(): Promise<void> {
    for (const dispose of this.disposers.splice(0)) dispose();
    const loop = this.loop;
    this.loop = undefined;
    loop?.controller.abort(new Error('agenda stopped'));
    await loop?.done;
    await this.ticking?.catch(() => {});
    await Promise.allSettled([...this.pending]);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.generation.abort();
    await this.changes.catch(() => {});
    await this.stopRuntime();
    if (!this.deps.data) await this.data?.close();
  }

  private zone(): string { return this.deps.timeZone(); }

  /** What the model is told about the current moment, so relative dates resolve without a clock tool. */
  private nowText(): string { return `现在是 ${describeNow(this.now(), this.zone())}（${this.zone()}）。`; }

  listEvents(...args: Parameters<AgendaData['listEvents']>): ReturnType<AgendaData['listEvents']> { return this.data.listEvents(...args); }
  listTodos(...args: Parameters<AgendaData['listTodos']>): ReturnType<AgendaData['listTodos']> { return this.data.listTodos(...args); }
  addEvent(...args: Parameters<AgendaData['addEvent']>): ReturnType<AgendaData['addEvent']> { return this.data.addEvent(...args); }
  updateEvent(...args: Parameters<AgendaData['updateEvent']>): ReturnType<AgendaData['updateEvent']> { return this.data.updateEvent(...args); }
  removeEvent(...args: Parameters<AgendaData['removeEvent']>): ReturnType<AgendaData['removeEvent']> { return this.data.removeEvent(...args); }
  agenda(...args: Parameters<AgendaData['agenda']>): ReturnType<AgendaData['agenda']> { return this.data.agenda(...args); }
  addTodo(...args: Parameters<AgendaData['addTodo']>): ReturnType<AgendaData['addTodo']> { return this.data.addTodo(...args); }
  updateTodo(...args: Parameters<AgendaData['updateTodo']>): ReturnType<AgendaData['updateTodo']> { return this.data.updateTodo(...args); }
  removeTodo(...args: Parameters<AgendaData['removeTodo']>): ReturnType<AgendaData['removeTodo']> { return this.data.removeTodo(...args); }

  /** How far ahead an event reminds, or undefined when it does not: its own lead (0 is at the start), else the default, where 0 means off. */
  leadOf(event: AgendaEvent): number | undefined {
    const lead = event.remindMinutes ?? (this.settings.remindMinutes > 0 ? this.settings.remindMinutes : -1);
    return lead >= 0 ? lead : undefined;
  }

  // ---- reminders ----

  /** Reminders whose time is at or before `now` and not yet sent for that occurrence, oldest first. */
  private dueReminders(now: number): { key: string; at: number; text: string; current(): boolean; mark(): Promise<void> }[] {
    const zone = this.zone();
    const due: { key: string; at: number; text: string; current(): boolean; mark(): Promise<void> }[] = [];
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
        current: () => this.data.eventCurrent(event), mark: () => this.data.markEvent(event, first.start) });
    }
    const [hh, mm] = this.settings.todoReminderTime.split(':').map(Number);
    for (const todo of this.listTodos()) {
      if (todo.doneAt || todo.due === undefined || todo.remindedFor === todo.due) continue;
      const at = todo.dueAllDay ? todo.due + ((hh ?? 9) * 60 + (mm ?? 0)) * 60_000 : todo.due;
      if (at > now) continue;
      due.push({ key: identity('agenda-todo', todo.id, String(todo.due)), at, text: todoReminderText(todo, zone), current: () => this.data.todoCurrent(todo), mark: () => this.data.markTodo(todo) });
    }
    return due.sort((a, b) => a.at - b.at);
  }

  /** One pass of the reminder loop: send what is due within the grace window, mark the rest as missed. Exposed for tests. */
  tick(): Promise<number> {
    if (!this.enabled) return Promise.resolve(0);
    if (this.ticking) return this.ticking;
    const generation = this.generation;
    const pending = Promise.resolve().then(() => this.tickDue(generation));
    this.ticking = pending;
    void pending.then(() => { this.ticking = undefined; }, () => { this.ticking = undefined; });
    return pending;
  }

  private async tickDue(generation: AbortController): Promise<number> {
    if (!this.current(generation)) return 0;
    const now = this.now();
    let sent = 0;
    for (const item of this.dueReminders(now)) {
      if (!this.current(generation)) break;
      if (!item.current()) continue;
      if (now - item.at > GRACE_MS) { await item.mark(); this.report(`reminder missed by more than ${GRACE_MS / 60_000} minutes, skipped`); continue; }
      let delivered = false;
      for (const sessionId of this.deps.sessions()) {
        if (!this.current(generation) || !item.current()) break;
        try { if (await this.deps.notifier.notify(sessionId, item.text, identity('agenda', item.key, sessionId))) delivered = true; }
        catch { this.report('reminder delivery failed'); }
      }
      // An accepted delivery (including the quiet-hours queue) must be recorded
      // even when disable happened while waiting. Never restore an edited/deleted record.
      if (!delivered) continue;
      await item.mark();
      this.lastReminderAt = now;
      sent++;
    }
    return sent;
  }

  private async run(signal: AbortSignal, generation: AbortController): Promise<void> {
    while (!signal.aborted && this.current(generation)) {
      try { await this.tick(); }
      catch { if (signal.aborted || !this.current(generation)) return; this.report('reminder tick failed'); }
      if (signal.aborted || !this.current(generation)) return;
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      });
      try { await Promise.race([this.sleep(TICK_MS, signal), cancelled]); } catch { return; }
      finally { signal.removeEventListener('abort', abort); }
    }
  }

  // ---- tools ----

  private registerTools(generation: AbortController): void {
    const { ctx } = this.deps;
    const connector = this;
    const register = (tool: Parameters<Context['tools']['register']>[0]) => {
      const execute = tool.execute;
      return ctx.tools.register({ ...tool, execute: (args, exec) => {
        connector.assertCurrent(generation);
        if (connector.admissions.get(exec) !== generation) throw new ChannelError('module_disabled');
        exec.signal?.throwIfAborted();
        return connector.track(Promise.resolve(execute(args, exec)));
      } });
    };
    this.disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
      const owns = exec.name === 'calendar' || exec.name === 'todo';
      if (owns) this.admissions.set(exec, generation);
      const decision = await next();
      if (!owns || decision.kind !== 'allow') return decision;
      return this.current(generation) ? decision : { kind: 'deny', reason: '日历与待办组件已停用，旧请求未执行。' };
    }));
    const text = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const } } },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] };
    const clashText = (clashes: Occurrence[]) => ['这个时间和已有日程冲突：', ...clashes.map(item => renderOccurrence(item, connector.zone())), '先告诉用户，用户仍要安排时再带 force: true 调用。'].join('\n');
    this.disposers.push(register(defineTool({
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
    this.disposers.push(register(defineTool({
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
      text: () => !connector.current(generation) ? '' : [connector.nowText(),
        `日历与待办：用户的日程和待办由你用 calendar 和 todo 两个工具保管，不在别处。用户说“明天下午三点和张老师开会”“下周二上午十点去医院”就 calendar add；问“今天有什么安排”“这周排了什么”就 calendar list；说“记个待办”“周五前要交报告”就 todo add；说“报告交了”就 todo done。日期时间都换算成本地时间 YYYY-MM-DD HH:mm 再调用，含糊的（比如没说几点）先问一句。日程开始前和待办到期时系统会自动推送提醒，不要再为它们建 schedule_create 提醒。calendar 返回冲突时先告诉用户，用户坚持再带 force。`,
        `日历的重复日程用 repeat daily、weekly 或 monthly；日历到点只发送已保存的提醒文字，不调用助理执行任务，也不出现在 DSH 自动化列表。需要助理定时执行工作的请求应使用当前会话可用的原生自动化工具，并将完整工作要求写入任务；不要把它保存成日历项后声称已安排自动执行。原生自动化工具不可用时如实说明，不能用日历通知代替。`,
      ].join('\n'),
    }));
  }
}
