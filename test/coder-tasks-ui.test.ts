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
