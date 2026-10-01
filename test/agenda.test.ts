import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { AgendaData } from '../src/connectors/agenda/data.js';
import type { Context } from '@deepseek-ai/cordis';
import { AgendaConnector, type AgendaDomain } from '../src/connectors/agenda/index.js';
import { agendaBetween, conflicts, eventReminderText, occurrences, renderAgenda, renderTodo, sortTodos, todoReminderText, type AgendaEvent, type Todo } from '../src/connectors/agenda/render.js';
import { addDays, addMonths, describeNow, formatDateTime, parseDate, parseDateTime, startOfDay } from '../src/connectors/agenda/time.js';
import { PushGate, type AssistantDomain } from '../src/assistant/pushes.js';
import { defaultAssistantSettings } from '../src/assistant/settings.js';
import { DailyBriefing, briefingText } from '../src/assistant/briefing.js';
import { agendaInput, defaultAgendaSettings, redactConnectors, ConnectorSettingsStore, type AgendaSettings } from '../src/connectors/settings.js';
import { MemoryRecords, until } from './helpers.js';

const zone = 'Asia/Shanghai';
const at = (iso: string) => Date.parse(iso);
const T0 = at('2026-09-21T10:00:00+08:00'); // Monday

test('agenda time helpers parse local dates, count days on the calendar, and describe now for the model', () => {
  assert.equal(parseDateTime('2026-09-22 15:00', zone), at('2026-09-22T15:00:00+08:00'));
  assert.equal(parseDateTime('2026-09-22T15:00', zone), at('2026-09-22T15:00:00+08:00'));
  assert.equal(parseDateTime('2026-02-30 15:00', zone), undefined, 'no such day');
  assert.equal(parseDateTime('2026-09-22 25:00', zone), undefined);
  assert.equal(parseDateTime('明天下午', zone), undefined);
  assert.equal(parseDate('2026-09-22', zone), at('2026-09-22T00:00:00+08:00'));
  assert.equal(parseDate('2026-09-22 15:00', zone), undefined, 'a date is only a date');
  assert.equal(startOfDay(T0, zone), at('2026-09-21T00:00:00+08:00'));
  assert.equal(addDays(T0, 7, zone), at('2026-09-28T10:00:00+08:00'));
  assert.equal(addDays(at('2026-03-07T10:00:00-05:00'), 1, 'America/New_York'), at('2026-03-08T10:00:00-04:00'), 'a day across DST keeps the wall clock');
  assert.equal(formatDateTime(at('2026-09-22T15:05:00+08:00'), zone), '9/22（周二）15:05');
  assert.equal(describeNow(T0, zone), '2026-09-21（周一）10:00');
});

const event = (id: string, title: string, start: string, end: string, extra: Partial<AgendaEvent> = {}): AgendaEvent => ({ id, title, start: at(start), end: at(end), createdAt: 1, ...extra });

test('occurrences expand weekly events on the calendar, lists group by day, and conflicts see repeats', () => {
  const standup = event('ev-w', '周会', '2026-09-21T09:30:00+08:00', '2026-09-21T10:00:00+08:00', { repeat: 'weekly', location: '会议室' });
  const meeting = event('ev-1', '和张老师开会', '2026-09-22T15:00:00+08:00', '2026-09-22T16:00:00+08:00');
  const from = at('2026-09-21T00:00:00+08:00');
  const week = agendaBetween([meeting, standup], from, at('2026-09-28T00:00:00+08:00'), zone);
  assert.deepEqual(week.map(item => [item.event.id, formatDateTime(item.start, zone)]), [['ev-w', '9/21（周一）09:30'], ['ev-1', '9/22（周二）15:00']]);
  assert.deepEqual(occurrences(standup, at('2026-10-05T00:00:00+08:00'), at('2026-10-19T00:00:00+08:00'), zone).map(item => formatDateTime(item.start, zone)), ['10/5（周一）09:30', '10/12（周一）09:30']);
  assert.deepEqual(occurrences(standup, at('2026-09-14T00:00:00+08:00'), at('2026-09-21T00:00:00+08:00'), zone), [], 'nothing before the first occurrence');
  assert.equal(renderAgenda(week, from, at('2026-09-28T00:00:00+08:00'), zone), '9/21（周一）：\n[ev-w] 9/21（周一）09:30–10:00 周会 @ 会议室（每周）\n9/22（周二）：\n[ev-1] 9/22（周二）15:00–16:00 和张老师开会');
  assert.equal(renderAgenda([], from, at('2026-09-22T00:00:00+08:00'), zone), '9/21（周一） 到 9/21（周一） 没有日程。');
  assert.deepEqual(conflicts([meeting, standup], at('2026-10-05T09:45:00+08:00'), at('2026-10-05T10:30:00+08:00'), zone).map(item => item.event.id), ['ev-w']);
  assert.deepEqual(conflicts([meeting, standup], at('2026-09-22T16:00:00+08:00'), at('2026-09-22T17:00:00+08:00'), zone), [], 'back to back is not a clash');
  assert.deepEqual(conflicts([meeting], at('2026-09-22T15:30:00+08:00'), at('2026-09-22T15:45:00+08:00'), zone, 'ev-1'), [], 'an event does not clash with itself');
  assert.equal(eventReminderText({ event: meeting, start: meeting.start, end: meeting.end }, meeting.start - 15 * 60_000, zone), '日程提醒：15 分钟后（9/22（周二）15:00）和张老师开会。');
  const todos: Todo[] = [{ id: 'td-2', title: '无期限', createdAt: 3 }, { id: 'td-1', title: '交报告', due: at('2026-09-25T00:00:00+08:00'), dueAllDay: true, createdAt: 2 }, { id: 'td-0', title: '做完的', doneAt: 1, createdAt: 1 }];
  assert.deepEqual(sortTodos(todos).map(todo => todo.id), ['td-1', 'td-2', 'td-0']);
  assert.equal(renderTodo(todos[1]!, zone), '[td-1] 交报告，9/25（周五） 前');
  assert.equal(todoReminderText(todos[1]!, zone), '待办提醒：「交报告」今天到期。');
  assert.equal(todoReminderText({ id: 'td-3', title: '打电话', due: at('2026-09-22T14:00:00+08:00'), createdAt: 1 }, zone), '待办提醒：「打电话」9/22（周二）14:00 到期。');
});

test('agenda settings validate, default for records saved before the agenda existed, and are exposed unredacted', async () => {
  const previous = defaultAgendaSettings();
  assert.deepEqual(agendaInput({ remindMinutes: '30', todoReminderTime: '08:30', enabled: 'true' }, previous), { enabled: true, remindMinutes: 30, todoReminderTime: '08:30' });
  assert.throws(() => agendaInput({ remindMinutes: 5000 }, previous), /invalid_remind_minutes/);
  assert.throws(() => agendaInput({ todoReminderTime: '8am' }, previous), /invalid_clock_time/);
  const records = new MemoryRecords();
  records.values.set('settings', { version: 1, revision: 3, mail: { enabled: false, address: '', password: '', imapHost: '', smtpHost: '', imapPort: 993, smtpPort: 465, imapSecure: true, smtpSecure: true, pollSeconds: 60, allowRecipients: [] } });
  const store = new ConnectorSettingsStore(records);
  const read = await store.read();
  assert.deepEqual(read.agenda, previous, 'an old record gets the defaults');
  const saved = await store.save(3, { agenda: { remindMinutes: 10 } });
  assert.deepEqual([saved.revision, saved.agenda.remindMinutes, saved.mail.pollSeconds], [4, 10, 60]);
  assert.deepEqual(redactConnectors(saved).agenda, saved.agenda);
  const cleared = await store.clearSecret(4);
  assert.equal(cleared.agenda.remindMinutes, 10, 'clearing the mail password leaves the agenda alone');
});

function fakeDomain() {
  const tables = new Map<string, Map<string, unknown>>();
  const tableOf = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    const records = tables.get(name)!;
    return { get: (key: string) => records.get(key), entries: () => [...records.entries()][Symbol.iterator](), keys: () => [...records.keys()][Symbol.iterator](),
      get size() { return records.size; }, async put(key: string, value: unknown) { records.set(key, structuredClone(value)); }, async delete(key: string) { return records.delete(key); },
      async update(key: string, fn: (current: unknown) => unknown) {
        if (!records.has(key)) throw Object.assign(new Error('missing-key'), { code: 'missing-key' });
        const value = structuredClone(fn(records.get(key))); records.set(key, value); return value;
      } };
  };
  return { opener: { async open() { return { name: 'nexus_agenda', table: tableOf, async close() {} } as unknown as AgendaDomain; } }, tables };
}

function fakeContext() {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ text: string }> }>();
  const sections: { name: string; text: () => string }[] = [];
  const hooks: ((exec: ToolExecution, next: () => Promise<{ kind: string }>) => Promise<{ kind: string }>)[] = [];
  const ctx = {
    on(_name: string, hook: typeof hooks[number]) { hooks.push(hook); return () => { const i = hooks.indexOf(hook); if (i >= 0) hooks.splice(i, 1); }; },
    tools: { register(tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } },
    systemPrompt: { section(section: { name: string; text: () => string }) { sections.push(section); return () => { sections.splice(sections.indexOf(section), 1); }; }, getSectionOrder() { return 10; } },
  } as unknown as Context;
  const execution = (name: string, args: unknown) => ({ name, arguments: args, signal: new AbortController().signal }) as ToolExecution;
  const prepare = async (exec: ToolExecution) => {
    let decision = { kind: 'allow' };
    for (const hook of [...hooks]) decision = await hook(exec, async () => decision);
    return decision;
  };
  const run = async (name: string, args: unknown) => {
    const exec = execution(name, args);
    if ((await prepare(exec)).kind !== 'allow') throw new Error('denied');
    const tool = tools.get(name); if (!tool) throw new Error(`tool ${name} is not registered`);
    return tool.execute(args, exec);
  };
  return { ctx, tools, sections, run, hooks, prepare, execution };
}

test('the agenda tools add, list, update, complete and remove; clashes are reported before anything is written', async () => {
  const { ctx, tools, sections, run } = fakeContext();
  let now = T0;
  const settings: AgendaSettings = { enabled: true, remindMinutes: 15, todoReminderTime: '09:00' };
  const connector = new AgendaConnector({ ctx, opener: fakeDomain().opener, notifier: { async notify() { return true; } }, sessions: () => ['s1'], timeZone: () => zone, now: () => now, report: () => {},
    sleep: (_ms, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  await connector.start({ ...settings, enabled: false });
  assert.deepEqual([...tools.keys()], []);
  await connector.apply(settings);
  assert.deepEqual([...tools.keys()], ['calendar', 'todo']);
  assert.match(sections[0]!.text(), /^现在是 2026-09-21（周一）10:00（Asia\/Shanghai）。\n日历与待办：/);
  assert.equal((await run('calendar', { action: 'list' })).text, '9/21（周一） 到 9/21（周一） 没有日程。');
  const added = await run('calendar', { action: 'add', title: '和张老师开会', start: '2026-09-22 15:00', location: '会议室' });
  assert.match(added.text, /^已安排：\[ev-[0-9a-f]{8}\] 9\/22（周二）15:00–16:00 和张老师开会 @ 会议室，开始前 15 分钟提醒。$/);
  const id = /ev-[0-9a-f]{8}/.exec(added.text)![0];
  await assert.rejects(run('calendar', { action: 'add', title: 'x', start: '明天三点' }), /YYYY-MM-DD HH:mm/);
  await assert.rejects(run('calendar', { action: 'add', title: 'x', start: '2026-09-22 15:00', end: '2026-09-22 14:00' }), /晚于开始时间/);
  // A clash is reported, nothing is written, and force writes it anyway.
  const clash = await run('calendar', { action: 'add', title: '看牙', start: '2026-09-22 15:30', duration_minutes: 30 });
  assert.match(clash.text, /^这个时间和已有日程冲突：\n\[ev-.*和张老师开会 @ 会议室\n先告诉用户/);
  assert.equal(connector.listEvents().length, 1);
  const forced = await run('calendar', { action: 'add', title: '看牙', start: '2026-09-22 15:30', duration_minutes: 30, force: true, remind_minutes: -1 });
  assert.match(forced.text, /^已安排：.*看牙（与已有日程冲突，按用户要求照排）。$/);
  assert.equal(connector.listEvents().length, 2);
  const weekly = await run('calendar', { action: 'add', title: '周会', start: '2026-09-21 09:30', duration_minutes: 30, repeat: 'weekly' });
  assert.match(weekly.text, /周会（每周），开始前 15 分钟提醒/);
  const week = (await run('calendar', { action: 'list', from: '2026-09-21', days: 7 })).text;
  assert.match(week, /^9\/21（周一）：\n\[ev-.*周会（每周）\n9\/22（周二）：\n\[ev-.*15:00–16:00 和张老师开会 @ 会议室\n\[ev-.*15:30–16:00 看牙$/);
  assert.match((await run('calendar', { action: 'list', from: '2026-10-05' })).text, /10\/5（周一）09:30–10:00 周会（每周）/, 'weekly events show in later weeks');
  // Update moves the event, keeps the duration, and clears the reminder mark.
  const moved = await run('calendar', { action: 'update', id, start: '2026-09-23 10:00', note: '带合同' });
  assert.match(moved.text, /^已更新：\[ev-.*9\/23（周三）10:00–11:00 和张老师开会 @ 会议室｜带合同$/);
  await assert.rejects(run('calendar', { action: 'update', id: 'ev-none', title: 'x' }), /没有日程 ev-none/);
  assert.equal((await run('calendar', { action: 'remove', id })).text, `已删除日程 ${id}。`);
  assert.equal((await run('calendar', { action: 'remove', id })).text, `没有日程 ${id}。`);
  // Todos.
  assert.equal((await run('todo', { action: 'list' })).text, '没有待办。');
  const todo = await run('todo', { action: 'add', title: '交报告', due: '2026-09-25' });
  assert.match(todo.text, /^已记下：\[td-[0-9a-f]{8}\] 交报告，9\/25（周五） 前，当天 09:00 提醒。$/);
  const todoId = /td-[0-9a-f]{8}/.exec(todo.text)![0];
  await run('todo', { action: 'add', title: '打电话给房东', due: '2026-09-21 14:00' });
  await run('todo', { action: 'add', title: '买菜' });
  await assert.rejects(run('todo', { action: 'add', title: 'x', due: '周五' }), /截止时间要写成/);
  assert.match((await run('todo', { action: 'list' })).text, /^\[td-.*打电话给房东，9\/21（周一）14:00 前\n\[td-.*交报告，9\/25（周五） 前\n\[td-.*买菜$/);
  assert.match((await run('todo', { action: 'done', id: todoId })).text, /^已完成：\[td-.*✓ 交报告/);
  assert.doesNotMatch((await run('todo', { action: 'list' })).text, /交报告/);
  assert.match((await run('todo', { action: 'list', include_done: true })).text, /✓ 交报告/);
  assert.match((await run('todo', { action: 'update', id: todoId, done: false, due: '' })).text, /^已更新：\[td-.*\] 交报告$/);
  assert.equal((await run('todo', { action: 'remove', id: todoId })).text, `已删除待办 ${todoId}。`);
  assert.equal(connector.view().openTodos, 2);
  // Disabling takes the tools and the prompt section away.
  await connector.apply({ ...settings, enabled: false });
  assert.deepEqual([[...tools.keys()], sections.length, connector.view().toolsRegistered], [[], 0, false]);
  await connector.close();
});

test('reminders go out once per occurrence before an event and at a todo\'s due time, wait for a chat, and are not replayed after a long outage', async () => {
  const { ctx, run } = fakeContext();
  let now = T0;
  const sent: { sessionId: string; text: string; deliveryId: string }[] = [];
  let bound: string[] = ['s1'];
  const connector = new AgendaConnector({ ctx, opener: fakeDomain().opener, notifier: { async notify(sessionId, text, deliveryId) { sent.push({ sessionId, text, deliveryId }); return true; } },
    sessions: () => bound, timeZone: () => zone, now: () => now, report: () => {},
    sleep: (_ms, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  await connector.start({ enabled: true, remindMinutes: 15, todoReminderTime: '09:00' });
  await run('calendar', { action: 'add', title: '和张老师开会', start: '2026-09-21 15:00', location: '会议室' });
  await run('calendar', { action: 'add', title: '周会', start: '2026-09-21 16:00', duration_minutes: 30, repeat: 'weekly', remind_minutes: 5 });
  await run('calendar', { action: 'add', title: '不提醒的', start: '2026-09-21 17:00', remind_minutes: -1 });
  await run('todo', { action: 'add', title: '打电话给房东', due: '2026-09-21 14:00' });
  await run('todo', { action: 'add', title: '交报告', due: '2026-09-22' });
  assert.equal(connector.view().nextReminderAt, at('2026-09-21T14:00:00+08:00'));
  assert.equal(await connector.tick(), 0, 'nothing due yet');
  now = at('2026-09-21T14:00:30+08:00');
  assert.equal(await connector.tick(), 1);
  assert.deepEqual(sent.map(item => item.text), ['待办提醒：「打电话给房东」9/21（周一）14:00 到期。']);
  assert.equal(await connector.tick(), 0, 'the same due time is not announced twice');
  now = at('2026-09-21T14:46:00+08:00');
  assert.equal(await connector.tick(), 1);
  assert.equal(sent.at(-1)!.text, '日程提醒：14 分钟后（9/21（周一）15:00）和张老师开会，地点 会议室。');
  // No chat bound: the reminder stays due until one appears, within the grace window.
  bound = [];
  now = at('2026-09-21T15:55:30+08:00');
  assert.equal(await connector.tick(), 0);
  bound = ['s1', 's2'];
  assert.equal(await connector.tick(), 1);
  assert.deepEqual(sent.slice(-2).map(item => [item.sessionId, item.text]), [['s1', '日程提醒：5 分钟后（9/21（周一）16:00）周会。'], ['s2', '日程提醒：5 分钟后（9/21（周一）16:00）周会。']]);
  assert.notEqual(sent.at(-1)!.deliveryId, sent.at(-2)!.deliveryId);
  // The event with remind_minutes -1 never reminds; the weekly one reminds again next week.
  now = at('2026-09-21T17:30:00+08:00');
  assert.equal(await connector.tick(), 0);
  now = at('2026-09-28T15:56:00+08:00');
  assert.equal(await connector.tick(), 1);
  assert.equal(sent.at(-1)!.text, '日程提醒：4 分钟后（9/28（周一）16:00）周会。');
  // The all-day todo was due 9/22 at 09:00; by now that is far past the grace window, so it is marked missed, not sent.
  assert.doesNotMatch(sent.map(item => item.text).join('\n'), /交报告/);
  assert.equal(connector.view().nextReminderAt, at('2026-10-05T15:55:00+08:00'));
  // A push failure leaves the reminder due for the next tick.
  await run('calendar', { action: 'add', title: '晚饭', start: '2026-09-28 18:00', remind_minutes: 10 });
  now = at('2026-09-28T17:50:10+08:00');
  const original = connector['deps'].notifier.notify;
  connector['deps'].notifier.notify = async () => { throw new Error('boom'); };
  assert.equal(await connector.tick(), 0);
  connector['deps'].notifier.notify = original;
  assert.equal(await connector.tick(), 1);
  assert.match(sent.at(-1)!.text, /晚饭/);
  await connector.close();
});

test('daily and monthly repeats keep the wall clock, a point in time clashes with nothing, and remind_minutes 0 reminds at the moment itself', async () => {
  // Expansion: daily every calendar day; monthly on the same day, skipping months that lack it; DST keeps the clock.
  const wake = event('ev-d', '七点半了，该起床了', '2026-09-21T07:30:00+08:00', '2026-09-21T07:30:00+08:00', { repeat: 'daily' });
  assert.deepEqual(occurrences(wake, at('2026-09-27T00:00:00+08:00'), at('2026-09-30T00:00:00+08:00'), zone).map(item => formatDateTime(item.start, zone)),
    ['9/27（周日）07:30', '9/28（周一）07:30', '9/29（周二）07:30']);
  assert.deepEqual(occurrences(wake, at('2026-09-20T00:00:00+08:00'), at('2026-09-21T00:00:00+08:00'), zone), [], 'nothing before the first');
  assert.deepEqual(occurrences(wake, at('2026-09-27T07:30:00+08:00'), at('2026-09-27T07:31:00+08:00'), zone).length, 1, 'a point counts at its own instant');
  assert.equal(occurrences(wake, at('2036-01-01T00:00:00+08:00'), at('2036-01-02T00:00:00+08:00'), zone).length, 1, 'years later without walking every day from the start');
  const rent = event('ev-m', '交房租', '2026-01-31T09:00:00+08:00', '2026-01-31T09:00:00+08:00', { repeat: 'monthly' });
  assert.deepEqual(occurrences(rent, at('2026-01-01T00:00:00+08:00'), at('2026-06-01T00:00:00+08:00'), zone).map(item => formatDateTime(item.start, zone)),
    ['1/31（周六）09:00', '3/31（周二）09:00', '5/31（周日）09:00'], 'February and April have no 31st');
  assert.equal(addMonths(at('2026-01-31T09:00:00+08:00'), 1, zone), undefined);
  assert.equal(addMonths(at('2026-03-07T10:00:00-05:00'), 1, 'America/New_York'), at('2026-04-07T10:00:00-04:00'), 'a month across DST keeps the wall clock');
  const nyDaily = event('ev-ny', '晨跑', '2026-03-07T06:00:00-05:00', '2026-03-07T06:30:00-05:00', { repeat: 'daily' });
  assert.deepEqual(occurrences(nyDaily, at('2026-03-08T00:00:00-05:00'), at('2026-03-10T00:00:00-04:00'), 'America/New_York').map(item => item.start),
    [at('2026-03-08T06:00:00-04:00'), at('2026-03-09T06:00:00-04:00')]);
  // A point in time takes no span: it neither clashes with a meeting nor is clashed with, and it renders as one moment.
  const meeting = event('ev-1', '晨会', '2026-09-28T07:00:00+08:00', '2026-09-28T08:00:00+08:00');
  assert.deepEqual(conflicts([wake], at('2026-09-28T07:00:00+08:00'), at('2026-09-28T08:00:00+08:00'), zone), []);
  assert.deepEqual(conflicts([meeting], at('2026-09-28T07:30:00+08:00'), at('2026-09-28T07:30:00+08:00'), zone), []);
  const day = agendaBetween([meeting, wake], at('2026-09-28T00:00:00+08:00'), at('2026-09-29T00:00:00+08:00'), zone);
  assert.equal(renderAgenda(day, at('2026-09-28T00:00:00+08:00'), at('2026-09-29T00:00:00+08:00'), zone),
    '9/28（周一）：\n[ev-1] 9/28（周一）07:00–08:00 晨会\n[ev-d] 9/28（周一）07:30 七点半了，该起床了（每天）');

  // Through the tool and the reminder loop: the wake-up call the model now files, pushed at 07:30 every day, missed days not replayed.
  const { ctx, run, sections } = fakeContext();
  let now = at('2026-09-27T06:10:00+08:00');
  const sent: string[] = [];
  const connector = new AgendaConnector({ ctx, opener: fakeDomain().opener, notifier: { async notify(_sessionId, text) { sent.push(text); return true; } },
    sessions: () => ['s1'], timeZone: () => zone, now: () => now, report: () => {},
    sleep: (_ms, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  await connector.start({ enabled: true, remindMinutes: 15, todoReminderTime: '09:00' });
  assert.match(sections[0]!.text(), /每天七点半叫我起床.*repeat 选 daily、weekly 或 monthly，duration_minutes 给 0.*remind_minutes 给 0（到点提醒）/);
  await run('calendar', { action: 'add', title: '晨会', start: '2026-09-28 07:00', duration_minutes: 60, remind_minutes: -1 });
  const added = await run('calendar', { action: 'add', title: '七点半了，该起床了', start: '2026-09-27 07:30', duration_minutes: 0, remind_minutes: 0, repeat: 'daily' });
  assert.match(added.text, /^已安排：\[ev-[0-9a-f]{8}\] 9\/27（周日）07:30 七点半了，该起床了（每天），到点提醒。$/, 'no clash with the meeting, one moment, reminded at it');
  await assert.rejects(run('calendar', { action: 'add', title: 'x', start: '2026-09-27 08:00', end: '2026-09-27 08:00' }), /晚于开始时间/, 'an equal end is only a point when asked for with duration 0');
  await assert.rejects(run('calendar', { action: 'add', title: 'x', start: '2026-09-27 08:00', remind_minutes: -2 }), /-1 表示不提醒/);
  assert.equal(connector.view().nextReminderAt, at('2026-09-27T07:30:00+08:00'));
  now = at('2026-09-27T07:29:40+08:00');
  assert.equal(await connector.tick(), 0);
  now = at('2026-09-27T07:30:10+08:00');
  assert.equal(await connector.tick(), 1);
  assert.equal(sent.at(-1), '日程提醒：现在（9/27（周日）07:30）七点半了，该起床了。');
  assert.equal(await connector.tick(), 0);
  now = at('2026-09-28T07:30:05+08:00');
  assert.equal(await connector.tick(), 1, 'again the next day, with nobody re-arming it');
  assert.equal(sent.at(-1), '日程提醒：现在（9/28（周一）07:30）七点半了，该起床了。');
  // Down for two days: the missed mornings are skipped, the third morning is announced.
  now = at('2026-10-01T07:30:20+08:00');
  assert.equal(await connector.tick(), 0, '9/29 is past the grace window and marked missed');
  assert.equal(await connector.tick(), 0, '9/30 too');
  assert.equal(await connector.tick(), 1);
  assert.equal(sent.at(-1), '日程提醒：现在（10/1（周四）07:30）七点半了，该起床了。');
  assert.equal(sent.filter(text => text.includes('晨会')).length, 0, '-1 is still "not reminded"');
  // A default lead of 0 in the settings still means "off" for events that name none; only an event's own 0 means "at the moment".
  await connector.apply({ enabled: true, remindMinutes: 0, todoReminderTime: '09:00' });
  await run('calendar', { action: 'add', title: '默认的', start: '2026-10-01 10:00' });
  now = at('2026-10-01T10:00:10+08:00');
  assert.equal(await connector.tick(), 0);
  // Monthly through the tool.
  const monthly = await run('calendar', { action: 'add', title: '交房租', start: '2026-10-31 09:00', duration_minutes: 0, remind_minutes: 0, repeat: 'monthly' });
  assert.match(monthly.text, /10\/31（周六）09:00 交房租（每月），到点提醒/);
  assert.match((await run('calendar', { action: 'list', from: '2026-12-31' })).text, /12\/31（周四）09:00 交房租（每月）/);
  assert.doesNotMatch((await run('calendar', { action: 'list', from: '2026-11-30' })).text, /交房租/, 'November has no 31st');
  await connector.close();
});

test('the briefing lists the day\'s events and open todos ahead of the reminders', () => {
  const now = at('2026-09-21T08:00:00+08:00');
  const meeting = event('ev-1', '和张老师开会', '2026-09-21T15:00:00+08:00', '2026-09-21T16:00:00+08:00');
  const text = briefingText(now, zone, [], { occurrences: [{ event: meeting, start: meeting.start, end: meeting.end }],
    todos: [{ id: 'td-1', title: '交报告', due: at('2026-09-21T00:00:00+08:00'), dueAllDay: true, createdAt: 1 }, { id: 'td-2', title: '买菜', createdAt: 2 }] });
  assert.equal(text, '早上好，9/21 的简报：\n今天的日程（1）：\n[ev-1] 9/21（周一）15:00–16:00 和张老师开会\n今天到期或已过期的待办（1）：\n[td-1] 交报告，9/21（周一） 前\n其他待办（1）：\n[td-2] 买菜\n今天没有待触发的提醒。');
  assert.match(briefingText(now, zone, [], { occurrences: [], todos: [] }), /^早上好，9\/21 的简报：\n今天没有日程。\n今天没有待触发的提醒。$/);
  assert.match(briefingText(now, zone, []), /^早上好，9\/21 的简报：\n今天没有待触发的提醒。$/, 'without the connector the briefing reads as before');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const noSleep = () => new Promise<void>(() => {});
const dueEvent = (title: string) => ({ title, start: '2026-09-21 10:00', duration_minutes: 0, remind_minutes: 0 });

async function runtimeFixture(notify: (sessionId: string, text: string, deliveryId: string) => Promise<boolean> = async () => true) {
  const fake = fakeContext();
  const storage = fakeDomain();
  const data = await AgendaData.open(storage.opener, () => zone, () => T0);
  const deps = { ctx: fake.ctx, data, opener: storage.opener, notifier: { notify }, sessions: () => ['s1', 's2'], timeZone: () => zone, now: () => T0, sleep: noSleep, report: () => {} };
  const connector = new AgendaConnector(deps);
  await connector.start(defaultAgendaSettings());
  return { ...fake, storage, data, deps, connector };
}

test('old prepared requests and captured tools cannot write after disable and reactivation', async () => {
  const f = await runtimeFixture();
  const args = { action: 'add', title: 'stale todo' };
  const oldExec = f.execution('todo', args);
  await f.prepare(oldExec);
  const oldTool = f.tools.get('todo')!;
  const delayed = deferred<{ kind: string }>();
  const oldGate = f.hooks[0]!(f.execution('calendar', {}), () => delayed.promise);
  await f.connector.close();
  assert.equal(f.tools.size, 0);
  assert.equal(f.hooks.length, 0);
  assert.equal(f.sections.length, 0);
  delayed.resolve({ kind: 'allow' });
  assert.equal((await oldGate).kind, 'deny');
  const fresh = new AgendaConnector(f.deps);
  await fresh.start(defaultAgendaSettings());
  await assert.rejects(async () => oldTool.execute(args, oldExec), /module_disabled/);
  await assert.rejects(async () => f.tools.get('todo')!.execute(args, oldExec), /module_disabled/, 'native dispatch resolves the new tool after policy');
  assert.equal(f.data.listTodos().length, 0);
  await f.run('todo', args);
  assert.equal(f.data.listTodos().length, 1);
  await fresh.close(); await f.data.close();
});

test('disabling during notification drains the accepted reminder, skips further recipients and does not replay it', async () => {
  const accepted = deferred<boolean>();
  const calls: { sessionId: string; text: string }[] = [];
  const f = await runtimeFixture(async (sessionId, text) => { calls.push({ sessionId, text }); return accepted.promise; });
  await f.data.addEvent(dueEvent('first'));
  await f.data.addEvent(dueEvent('second'));
  const ticking = f.connector.tick();
  await until(() => calls.length === 1, 'first notification missing');
  assert.equal(f.connector.tick(), ticking, 'overlapping ticks share one delivery pass');
  let closed = false;
  const closing = f.connector.close().then(() => { closed = true; });
  assert.equal(f.connector.view().toolsRegistered, false);
  assert.equal(await f.connector.tick(), 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  accepted.resolve(true);
  assert.equal(await ticking, 1);
  await closing;
  assert.equal(calls.length, 1, 'no second recipient or second reminder admitted after disable');
  assert.equal(f.data.listEvents().find(e => e.title === 'first')!.remindedFor, T0);
  assert.equal(f.data.listEvents().find(e => e.title === 'second')!.remindedFor, undefined);
  const fresh = new AgendaConnector({ ...f.deps, notifier: { async notify(sessionId, text) { calls.push({ sessionId, text }); return true; } } });
  await fresh.start(defaultAgendaSettings());
  await fresh.tick();
  assert.equal(calls.filter(c => c.text.includes('first')).length, 1);
  assert.equal(calls.filter(c => c.text.includes('second')).length, 2);
  await fresh.close(); await f.data.close();
});

test('a reminder receipt cannot recreate a deleted event or deliver a stale later event snapshot', async () => {
  const accepted = deferred<boolean>();
  const texts: string[] = [];
  const f = await runtimeFixture(async (_sessionId, text) => { texts.push(text); return accepted.promise; });
  const first = (await f.data.addEvent(dueEvent('delete me'))).event!;
  const second = (await f.data.addEvent(dueEvent('old title'))).event!;
  const ticking = f.connector.tick();
  await until(() => texts.length === 1, 'notification missing');
  await f.data.removeEvent(first.id);
  await f.data.updateEvent(second.id, { title: 'new title' });
  accepted.resolve(true);
  await ticking;
  assert.equal(f.data.listEvents().some(e => e.id === first.id), false);
  assert.equal(f.data.listEvents()[0]!.title, 'new title');
  assert.equal(f.data.listEvents()[0]!.remindedFor, undefined);
  assert.equal(texts.length, 1);
  await f.connector.tick();
  assert.ok(texts.slice(1).every(text => text.includes('new title')));
  await f.connector.close(); await f.data.close();
});

test('a reminder receipt cannot undo completion or overwrite a changed todo deadline', async () => {
  const accepted = deferred<boolean>();
  let calls = 0;
  const f = await runtimeFixture(async () => { calls++; return accepted.promise; });
  const todo = await f.data.addTodo({ title: 'report', due: '2026-09-21 10:00' });
  const ticking = f.connector.tick();
  await until(() => calls === 1, 'notification missing');
  await f.data.updateTodo(todo.id, { done: true, due: '2026-09-22 10:00', note: 'owner edit' });
  accepted.resolve(true);
  await ticking;
  assert.equal(calls, 1);
  const saved = f.data.listTodos()[0]!;
  assert.equal(saved.doneAt, T0);
  assert.equal(saved.due, T0 + 86_400_000);
  assert.equal(saved.note, 'owner edit');
  assert.equal(saved.remindedFor, undefined);
  await f.connector.close(); await f.data.close();
});

test('an admitted data write completes before runtime disposal and owner management stays usable', async () => {
  const f = await runtimeFixture();
  const store = (await f.storage.opener.open()).table('todos');
  // Keep the real shared table but delay its durability acknowledgement.
  const release = deferred<void>();
  const original = f.data['domain'].table.bind(f.data['domain']);
  let writing = false;
  f.data['domain'].table = ((name: 'todos' | 'events') => name === 'todos' ? { ...store, async put(key: string, value: Todo) {
    writing = true; await release.promise; await store.put(key, value);
  } } : original(name)) as typeof f.data['domain']['table'];
  const writingTool = f.run('todo', { action: 'add', title: 'accepted write' });
  await until(() => writing, 'write missing');
  let closed = false;
  const closing = f.connector.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  await writingTool; await closing;
  assert.equal(f.data.listTodos()[0]!.title, 'accepted write');
  await f.data.updateTodo(f.data.listTodos()[0]!.id, { done: true });
  assert.equal(f.data.listTodos()[0]!.doneAt, T0);
  await f.data.close();
});

test('an accepted quiet-hours reminder survives runtime disable without being generated twice', async () => {
  let now = T0;
  const queueStore = fakeDomain();
  const sent: string[] = [];
  const gate = await PushGate.open({ async open() { return await queueStore.opener.open() as unknown as AssistantDomain; } },
    { async notify(_session, text) { sent.push(text); return true; } }, { ...defaultAssistantSettings(), timeZone: zone, quietStart: '09:00', quietEnd: '11:00' }, () => now);
  const f = await runtimeFixture((...args) => gate.notify(...args));
  f.deps.sessions = () => ['s1'];
  await f.data.addEvent(dueEvent('quiet fixture'));
  assert.equal(await f.connector.tick(), 1);
  assert.equal(gate.pending().length, 1);
  assert.equal(sent.length, 0);
  await f.connector.close();
  assert.equal(gate.pending().length, 1);
  now += 2 * 3_600_000;
  await gate.flush();
  assert.equal(sent.length, 1);
  const fresh = new AgendaConnector(f.deps);
  await fresh.start(defaultAgendaSettings());
  assert.equal(await fresh.tick(), 0);
  assert.equal(gate.pending().length, 0);
  await fresh.close(); await f.data.close(); await gate.close();
});

test('a briefing waiting on native reminders reads agenda availability at delivery time', async () => {
  const catalog = deferred<[]>();
  const sent: string[] = [];
  let enabled = true;
  let reads = 0;
  const briefing = new DailyBriefing({ ctx: { schedule: { catalog: () => catalog.promise } } as unknown as Pick<Context, 'schedule'>,
    notifier: { async notify(_session, text) { sent.push(text); return true; } }, sessions: () => ['s1'], now: () => T0 }, defaultAssistantSettings());
  briefing.attachAgenda(() => { reads++; return enabled ? { occurrences: [], todos: [{ id: 'td-1', title: 'hidden after disable', createdAt: T0 }] } : undefined; });
  const sending = briefing.send(true);
  enabled = false;
  catalog.resolve([]);
  await sending;
  assert.equal(reads, 1);
  assert.doesNotMatch(sent[0]!, /hidden after disable|今天没有日程/);
  assert.match(sent[0]!, /今天没有待触发的提醒/);
  briefing.close();
});
