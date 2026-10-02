import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement, type ComponentType } from 'react';
import { JSDOM } from 'jsdom';
import { coderTaskPanel, coderTaskRow, dispatchedTaskId, taskAddress, taskIdOf, type TaskApi } from '../src/client/CoderTasks.js';
import type { TaskDetailView } from '../src/coders/index.js';

const detail = (overrides: Partial<TaskDetailView> = {}): TaskDetailView => ({
  id: 'ct-0000abcd', coder: 'codex', coderName: 'Codex', status: 'running', statusLabel: '运行中', active: true,
  description: '画一只骑自行车的鹈鹕', cwd: '/home/dev/workspace', createdAt: 1, updatedAt: 2, runningFor: '已运行 12 秒；最近一步在 3 秒前',
  activity: '执行：npm test', escalations: 0, autoAllowed: 2, decisions: [], trace: [{ at: 1, text: '执行：npm test' }],
  transcript: { entries: [], source: '/home/dev/.codex/sessions/x.jsonl' }, ...overrides,
});

async function render(t: TestContext, component: ComponentType<never>, props: Record<string, unknown>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(component, props as never)));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return Object.assign(dom.window.document, { rerender: async (next: Record<string, unknown>) => {
    await act(async () => root.render(createElement(component, next as never)));
  } });
}

test('task addresses and the dispatched id round-trip', () => {
  assert.equal(taskIdOf(taskAddress('ct-0000abcd')), 'ct-0000abcd');
  assert.equal(taskIdOf('dsh-resource://file/x'), '');
  assert.equal(dispatchedTaskId([{ type: 'text', text: '已派发编码任务 ct-0000abcd，后台 job coder-1，状态：运行中。' }]), 'ct-0000abcd');
  assert.equal(dispatchedTaskId([{ type: 'text', text: '工作目录不存在' }]), undefined);
});

test('finished task details open the owning session and refresh versioned goal acceptance without dispatching work', async t => {
  const opened: string[] = [];
  let reads = 0;
  const api: TaskApi = async () => detail({ ownerSession: 'original-session', active: false, status: 'completed',
    brief: { id: 'goal', revision: 1, objective: '旧目标', constraints: '', acceptance: [{ id: 'a1', text: '旧验收项' }] },
    goal: { id: 'goal', revision: 2, report: ++reads === 1 ? '当前目标：检查通过；业务验收待确认' : '当前目标：用户已确认' } });
  const document = await render(t, coderTaskPanel(api, id => opened.push(id)) as ComponentType<never>,
    { useTabInfo: () => ({ tab: { contentId: taskAddress('ct-0000abcd'), visible: true } }) });
  assert.match(document.body.textContent!, /此任务属于旧目标版本 v1/);
  assert.match(document.body.textContent!, /业务验收待确认/);
  const click = (label: string) => act(async () => { [...document.querySelectorAll('button')].find(button => button.textContent === label)!.click(); });
  await click('回到所属会话');
  assert.deepEqual(opened, ['original-session']); assert.equal(reads, 1);
  await click('刷新结果');
  assert.equal(reads, 2); assert.match(document.body.textContent!, /用户已确认/);
});

test('the coder_task row shows the task and opens its panel; a refused dispatch says why', async t => {
  const opened: string[] = [];
  const asked: [string, boolean][] = [];
  const api: TaskApi = async (id, brief) => { asked.push([id, brief]); return detail({ status: 'waiting-user', statusLabel: '等待用户回答', activity: undefined, pending: { at: 1, summary: '命令：git push' } }); };
  const document = await render(t, coderTaskRow(address => { opened.push(address); }, api) as ComponentType<never>,
    { phase: 'result', block: { content: [{ type: 'text', text: '已派发编码任务 ct-0000abcd，后台 job coder-1，状态：运行中。' }], isError: false } });
  assert.match(document.body.textContent!, /Codex 任务 ct-0000abcd/);
  assert.match(document.body.textContent!, /等待用户回答/);
  assert.match(document.body.textContent!, /等你回答：命令：git push/);
  assert.deepEqual(asked, [['ct-0000abcd', true]], 'the row asks for status only');
  await act(async () => { (document.querySelector('.nexus-coder-row-open') as HTMLButtonElement).click(); });
  assert.deepEqual(opened, ['dsh-resource://nexus-coder-task/ct-0000abcd']);
});

test('a refused or still-dispatching coder_task row reads no task', async t => {
  const api: TaskApi = async () => { throw new Error('should not be called'); };
  const refused = await render(t, coderTaskRow(() => {}, api) as ComponentType<never>, { phase: 'result', block: { content: [{ type: 'text', text: '工作目录不存在：/x' }], isError: true } });
  assert.match(refused.body.textContent!, /编码任务没有派发工作目录不存在：\/x/);
});

test('the task panel shows the standing and the coder\'s own process, folding outputs, thinking and diffs', async t => {
  const asked: [string, boolean][] = [];
  const api: TaskApi = async (id, brief) => {
    asked.push([id, brief]);
    return detail({ status: 'completed', statusLabel: '已完成', active: false, runningFor: undefined, activity: undefined,
      decisions: ['[硬规则·拒绝] Bash: cat ~/.ssh/id_rsa — 命令涉及凭据或密钥文件'],
      result: { summary: '做好了动画版。', changedFiles: ['/home/dev/workspace/pelican.html'], outsideRoots: [], verifyOk: true, execution: 'completed', verification: 'passed' },
      transcript: { source: '/x.jsonl', entries: [
        { at: 1, kind: 'user', title: '发给 Codex', body: '画一只骑自行车的鹈鹕' },
        { at: 2, kind: 'message', title: 'Codex 说', body: '先看看工作区里有什么。' },
        { at: 3, kind: 'reasoning', title: 'Codex 思考', body: '也许先列目录' },
        { at: 4, kind: 'command', title: 'ls -la', body: 'pelican-bicycle.svg', exitCode: 0, durationMs: 1200 },
        { at: 5, kind: 'interrupted', title: '这一回合被打断' },
        { at: 6, kind: 'edit', title: '改文件：pelican.html', body: '--- pelican.html\n+<svg/>' },
      ] } });
  };
  const document = await render(t, coderTaskPanel(api) as ComponentType<never>,
    { useTabInfo: () => ({ tab: { contentId: 'dsh-resource://nexus-coder-task/ct-0000abcd', visible: true } }) });
  const text = document.body.textContent!;
  assert.deepEqual(asked, [['ct-0000abcd', false]], 'a finished task is read once, with its process');
  for (const expected of ['Codex 任务 ct-0000abcd', '已完成', '做好了动画版。', '改动文件 1 个，验证通过', '/home/dev/workspace/pelican.html', '监工的决定',
    '先看看工作区里有什么。', 'ls -la', '退出码 0，1.2 秒', '这一回合被打断', '改文件：pelican.html']) assert.ok(text.includes(expected), expected);
  const folded = [...document.querySelectorAll('.nexus-coder-entry details')];
  assert.equal(folded.length, 3, 'thinking, output and diff are folded');
  assert.ok(folded.every(element => !(element as HTMLDetailsElement).open));
  assert.equal(document.querySelector('.nexus-coder-entry[data-kind="message"] .nexus-coder-entry-body')!.textContent, '先看看工作区里有什么。', 'messages are shown in full');
});

test('without the coder\'s log the panel falls back to the supervisor\'s steps', async t => {
  const api: TaskApi = async () => detail({ transcript: { entries: [], problem: '没有找到 Codex 的会话记录（t）。' } });
  const document = await render(t, coderTaskPanel(api) as ComponentType<never>,
    { useTabInfo: () => ({ tab: { contentId: 'dsh-resource://nexus-coder-task/ct-0000abcd', visible: true } }) });
  assert.match(document.body.textContent!, /没有找到 Codex 的会话记录（t）。下面是监工记下的步骤。/);
  assert.match(document.body.textContent!, /执行：npm test/);
  assert.match(document.body.textContent!, /已运行 12 秒；最近一步在 3 秒前/);
});

test('failed verification shows executed and unexecuted checks separately from the coder report', async t => {
  const api: TaskApi = async () => detail({ active: false, status: 'failed', statusLabel: '执行结束，验证失败',
    recovery: { title: '独立验证未通过', nextStep: '回到所属会话核对失败检查。', context: '可尝试在原上下文续接。', blockers: [], followingTasks: [] },
    result: { summary: '编码工具说已完成', detail: '已留下实现', execution: 'completed', verification: 'failed', verifyOk: false, changedFiles: [], outsideRoots: [],
      verifyChecks: [{ command: 'node unit.cjs', ok: true, executed: true, output: 'unit passed' },
        { command: 'node integration.cjs', ok: false, executed: true, output: 'assertion failed' },
        { command: 'node release.cjs', ok: false, executed: false, output: 'previous check failed' }], verifyOutput: '尚未完成所有检查' } });
  const doc = await render(t, coderTaskPanel(api) as ComponentType<never>, { useTabInfo: () => ({ tab: { contentId: taskAddress('ct-0000abcd'), visible: true } }) });
  for (const text of ['编码工具报告', '独立验证未通过', '执行说明：已留下实现', '通过：node unit.cjs', '失败：node integration.cjs', '未执行：node release.cjs', 'assertion failed', '尚未完成所有检查']) assert.ok(doc.body.textContent!.includes(text), text);
  assert.doesNotMatch(doc.body.textContent!, /失败：node release.cjs/);
});

test('legacy verification flags alone do not claim independently verified results', async t => {
  const api: TaskApi = async () => detail({ active: false, status: 'completed', result: { summary: 'done', verifyOk: true, changedFiles: [], outsideRoots: [] } });
  const doc = await render(t, coderTaskPanel(api) as ComponentType<never>, { useTabInfo: () => ({ tab: { contentId: taskAddress('ct-0000abcd'), visible: true } }) });
  assert.match(doc.body.textContent!, /尚未独立验证/);
  assert.doesNotMatch(doc.body.textContent!, /验证通过/);
});

test('following-task navigation reads a new record and clears the old recovery view while loading', async t => {
  const opened: string[] = [];
  let finish!: (view: TaskDetailView) => void;
  const api: TaskApi = async id => id === 'ct-0000abcd' ? detail({ active: false, status: 'interrupted', ownerSession: 'old-owner',
    recovery: { title: '旧任务已有后续', nextStep: '查看后续', blockers: [], followingTasks: ['ct-0000dcba'] } }) : new Promise(resolve => { finish = resolve; });
  const props = (id: string) => ({ useTabInfo: () => ({ tab: { contentId: taskAddress(id), visible: true } }) });
  const doc = await render(t, coderTaskPanel(api, id => opened.push(id), id => opened.push(id)) as ComponentType<never>, props('ct-0000abcd'));
  await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === '查看后续任务 ct-0000dcba')!.click());
  assert.deepEqual(opened, ['ct-0000dcba']);
  await doc.rerender(props('ct-0000dcba'));
  assert.match(doc.body.textContent!, /正在读取任务/);
  assert.doesNotMatch(doc.body.textContent!, /旧任务已有后续|回到所属会话|ct-0000abcd/);
  await act(async () => finish(detail({ id: 'ct-0000dcba', ownerSession: 'new-owner', active: false, status: 'completed' })));
  await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === '回到所属会话')!.click());
  assert.deepEqual(opened, ['ct-0000dcba', 'new-owner']);
});

test('an unread task card does not invent running state and ignores a late response for the previous id', async t => {
  let finish!: (view: TaskDetailView) => void;
  const api: TaskApi = async id => id === 'ct-0000abcd' ? new Promise(resolve => { finish = resolve; })
    : detail({ id, status: 'queued', statusLabel: '排队中', active: false });
  const props = (id: string) => ({ phase: 'result', block: { content: [{ type: 'text', text: `已派发编码任务 ${id}，后台 job coder-1。` }] } });
  const doc = await render(t, coderTaskRow(() => {}, api) as ComponentType<never>, props('ct-0000abcd'));
  assert.match(doc.body.textContent!, /正在读取状态/);
  assert.doesNotMatch(doc.body.textContent!, /运行中/);
  await doc.rerender(props('ct-0000dcba'));
  await act(async () => finish(detail()));
  assert.match(doc.body.textContent!, /ct-0000dcba.*排队中/);
  assert.doesNotMatch(doc.body.textContent!, /ct-0000abcd|运行中/);
});


test('task panel displays retry source, attempt, scheduled time and stop reason without a replay button', async t => {
  const api: TaskApi = async () => detail({ statusLabel: '等待自动续接', retry: { source: 'nexus', phase: 'waiting', attempt: 1, maxAttempts: 2,
    retryAt: Date.now() + 15000, reason: '模型服务暂时限流；等待后恢复原会话' } });
  const doc = await render(t, coderTaskPanel(api) as ComponentType<never>, { useTabInfo: () => ({ tab: { contentId: taskAddress('ct-0000abcd'), visible: true } }) });
  const panel = doc.querySelector('[aria-label="请求恢复状态"]')!;
  assert.match(panel.textContent!, /自动续接（第 1\/2 次）/);
  assert.match(panel.textContent!, /预计重试时间/);
  assert.match(panel.textContent!, /等待计入本次运行时限/);
  assert.equal(panel.querySelectorAll('button').length, 0);
});

import { taskFeeds, type TaskFeedApi } from '../src/client/CoderTaskFeed.js';
import { coderTaskDock, coderTaskTrigger, installTaskPlacement, type TaskSlots, type TriggerProps } from '../src/client/CoderTaskPlacement.js';
import type { TaskSummary } from '../src/coders/presentation.js';
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots';

const summary = (extra: Partial<TaskSummary> = {}): TaskSummary => ({ id: 'ct-0000abcd', ownerSession: 'owner', coderName: 'Codex',
  status: 'running', statusLabel: '运行中', active: true, description: '修复任务显示', updatedAt: 10, ...extra });
const settleUI = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); }); };

test('the session dock keeps a finished task until its native notice card mounts; other tasks remain and navigation is shared', async t => {
  let tasks = [summary(), summary({ id: 'ct-00000002', updatedAt: 9 })];
  const opened: string[] = [], calls: string[] = [];
  const api: TaskFeedApi = async <T,>(method: string) => { calls.push(method); return (method === 'list' ? tasks : null) as T; };
  const feeds = taskFeeds(api, 10), Dock = coderTaskDock(address => opened.push(address), feeds);
  const Native = () => createElement('section', { 'data-turn-trigger': true }, '后台任务状态更新');
  const Trigger = coderTaskTrigger(Native, address => opened.push(address), feeds);
  const App = ({ show }: { show: boolean }) => createElement('main', null,
    show && createElement(Trigger, { sessionId: 'owner', node: { data: { seq: 40, source: { kind: 'tool-jobs', form: 'notice' } } } }),
    createElement(Dock, { sessionId: 'owner' }));
  const doc = await render(t, App as ComponentType<never>, { show: false });
  assert.match(doc.body.textContent!, /2 个任务进行中/);
  await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === '查看全部 2 个任务')!.click());
  tasks = [summary({ status: 'completed', statusLabel: '执行结束，尚未独立验证', active: false }), tasks[1]!]; await settleUI();
  assert.equal(doc.querySelectorAll('.nexus-coder-dock [data-task-id]').length, 2);
  tasks = [{ ...tasks[0]!, completionNotice: { seq: 40, at: 30, messageId: 'message-40' } }, tasks[1]!]; await settleUI();
  assert.equal(doc.querySelectorAll('.nexus-coder-dock [data-task-id]').length, 2, 'a delayed renderer must not lose the finished card');
  await doc.rerender({ show: true }); await settleUI();
  assert.equal(doc.querySelector('[data-turn-trigger]')!.previousElementSibling?.getAttribute('data-task-id'), 'ct-0000abcd');
  assert.match(doc.querySelector('[data-turn-trigger]')!.previousElementSibling!.textContent!, /尚未独立验证/);
  assert.deepEqual([...doc.querySelectorAll('.nexus-coder-dock [data-task-id]')].map(row => row.getAttribute('data-task-id')), ['ct-00000002']);
  await act(async () => (doc.querySelector('[data-task-id="ct-0000abcd"] button') as HTMLButtonElement).click());
  assert.deepEqual(opened, [taskAddress('ct-0000abcd')]);
  assert.equal(calls.filter(call => call === 'notice').length, 0, 'a known notice reuses the shared list');
  await doc.rerender({ show: false });
  assert.equal(doc.querySelector('.nexus-coder-dock [data-task-id="ct-0000abcd"]'), null, 'scrolling an archived card out of view does not re-pin it');
});

test('reload restores archived placement and leaves an interrupted task available as a dismissible bottom result', async t => {
  const finished = summary({ active: false, status: 'failed', statusLabel: '执行结束，验证失败', completionNotice: { seq: 4, at: 30, messageId: 'm' } });
  const interrupted = summary({ id: 'ct-00000002', active: false, status: 'interrupted', statusLabel: '已中断' });
  const api: TaskFeedApi = async <T,>(method: string) => (method === 'list' ? [finished, interrupted] : finished) as T;
  const feeds = taskFeeds(api, 1000), Dock = coderTaskDock(() => {}, feeds), Trigger = coderTaskTrigger(() => createElement('div', { 'data-turn-trigger': true }), () => {}, feeds);
  const App = () => createElement('main', null, createElement(Trigger, { sessionId: 'owner', node: { data: { seq: 4, source: { kind: 'tool-jobs', form: 'notice' } } } }), createElement(Dock, { sessionId: 'owner' }));
  const doc = await render(t, App as ComponentType<never>, {});
  assert.match(doc.querySelector('[data-turn-trigger]')!.previousElementSibling!.textContent!, /验证失败/);
  assert.match(doc.querySelector('.nexus-coder-dock')!.textContent!, /已中断/);
  assert.equal(doc.querySelectorAll('[data-task-id="ct-0000abcd"]').length, 1);
  await act(async () => [...doc.querySelectorAll('button')].find(button => button.textContent === '收起结果')!.click());
  assert.equal(doc.querySelector('.nexus-coder-dock'), null);
});

test('changing sessions aborts the old feed and ignores its late response', async t => {
  let oldSignal!: AbortSignal, finish!: (value: TaskSummary[]) => void;
  const api: TaskFeedApi = async <T,>(_method: string, payload: Record<string, unknown>, signal: AbortSignal) => {
    if (payload.ownerSession === 'owner') { oldSignal = signal; return new Promise<TaskSummary[]>(resolve => { finish = resolve; }) as Promise<T>; }
    return [summary({ id: 'ct-00000002', ownerSession: 'new-owner', pending: '确认本次命令' })] as T;
  };
  const doc = await render(t, coderTaskDock(() => {}, taskFeeds(api)) as ComponentType<never>, { sessionId: 'owner' });
  await doc.rerender({ sessionId: 'new-owner' });
  assert.equal(oldSignal.aborted, true);
  await act(async () => finish([summary()]));
  assert.doesNotMatch(doc.body.textContent!, /ct-0000abcd/);
  assert.match(doc.body.textContent!, /等你回答：确认本次命令/);
});

test('the tool receipt does not poll or claim completion once the dock owns live status', async t => {
  const doc = await render(t, coderTaskRow(() => {}, async () => { throw new Error('must not read'); }, false) as ComponentType<never>,
    { phase: 'result', block: { content: [{ type: 'text', text: '已派发编码任务 ct-0000abcd，运行中' }] } });
  assert.match(doc.body.textContent!, /已派发/); assert.doesNotMatch(doc.body.textContent!, /读取失败|已完成/);
});

test('notification decoration preserves native props, locale, unrelated notices and plugin registration lifecycle', async t => {
  const core = new SlotCore();
  const registerFactory = core.registerFactory as unknown as (options: object, component: unknown) => () => void;
  const releaseRoot = registerFactory({ name: 'fixture', scope: 'root', children: {
    'conversation.chat.node': { kind: 'keyed', scope: 'session' }, 'conversation.input.dock': { kind: 'list', scope: 'session' },
  } }, () => null);
  const releases: (() => void)[] = [];
  const slots: TaskSlots = { inject(_name, callback) { releases.push(callback()); }, register: core.register.bind(core) as TaskSlots['register'], entries: core.entries.bind(core), subscribe: core.subscribe.bind(core) };
  t.after(() => { for (const release of releases) release(); releaseRoot(); });
  installTaskPlacement(slots, () => {}, taskFeeds(async () => { throw new Error('unrelated notice must not read tasks'); }));
  assert.equal(core.entries('conversation.input.dock').length, 1);
  const props = { sessionId: 'owner', node: { data: { seq: 1, source: { kind: 'schedule', form: 'notice' } } }, t: 'native translator', extra: 'kept' };
  let received: unknown;
  const Native = (value: TriggerProps) => { received = value; return createElement('button', { 'data-turn-trigger': true }, '原生通知'); };
  let unload = slots.register({ name: 'conversation.chat.node', key: 'turn-trigger', locale: 'chat' }, Native);
  await Promise.resolve(); await Promise.resolve();
  const winner = core.entriesOfSlot('conversation.chat.node')[0]!;
  assert.equal(winner.options.priority, -1); assert.equal(winner.locale, 'chat');
  const doc = await render(t, winner.component as ComponentType<never>, props);
  assert.deepEqual(received, props); assert.match(doc.body.textContent!, /原生通知/);
  assert.equal(doc.querySelector('[data-task-id]'), null);
  unload(); await Promise.resolve(); await Promise.resolve();
  assert.equal(core.entriesOfSlot('conversation.chat.node').length, 0);
  unload = slots.register({ name: 'conversation.chat.node', key: 'turn-trigger', locale: 'chat' }, Native);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(core.entriesOfSlot('conversation.chat.node')[0]!.options.priority, -1);
  for (const release of releases) release();
  assert.equal(core.entriesOfSlot('conversation.chat.node')[0]!.component, Native, 'unloading Nexus restores the native entry');
  unload();
});

test('a mapped notice that is folded as native context still leaves a bottom result after reload', async t => {
  const task = summary({ active: false, status: 'completed', statusLabel: '执行结束，尚未独立验证', completionNotice: { seq: 4, at: 30, messageId: 'm' } });
  const api: TaskFeedApi = async <T,>() => [task] as T;
  const doc = await render(t, coderTaskDock(() => {}, taskFeeds(api)) as ComponentType<never>, { sessionId: 'owner' });
  assert.match(doc.querySelector('.nexus-coder-dock')!.textContent!, /尚未独立验证/);
  assert.equal(doc.querySelectorAll('[data-task-id]').length, 1);
});
