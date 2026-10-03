import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { AskUserQuestionItem, AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';
import { DshChannelBridge } from '../src/dsh/bridge.js';
import { parseCommand, sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { until } from './helpers.js';

const owner = { channel: 'wechat' as const, accountId: 'question-bot', ownerId: 'question-owner' };
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text,
  chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });
const choice: AskUserQuestionItem = { id: 'format', header: '交付格式', question: '选择输出格式',
  detail: '完整说明必须先发送。', options: [{ label: 'Markdown', description: '便于修改' }, { label: 'PDF' }] };

async function fixture() {
  const prompts: unknown[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const events: any[] = [{ type: 'turn/start', data: { turn: 0 } }];
  const session = { id: sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'), snapshotEvents: () => events };
  const agent = { id: session.id, session };
  let activations = 0;
  let live = true;
  let readClosed = false;
  const ctx = {
    sessionController: { async create() { activations++; }, async resolveAgent() { activations++; return { agent }; },
      async prompt(input: unknown) { prompts.push(input); } },
    sessions: { async flush() { return true; }, get: () => live ? session : undefined },
    sessionPersistence: { async open(_id: string, access: string) {
      assert.equal(access, 'read');
      return { async read() { return { events }; }, async close() { readClosed = true; } };
    } },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  let send: (text: string) => Promise<void> = async () => {};
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {},
    async sendText(_chatId, text) { texts.push(text); await send(text); } };
  const bridge = new DshChannelBridge(ctx, transport, owner, '/local-question-fixture', code => errors.push(code));
  await bridge.receive(inbound('task', '生成报告'));
  prompts.length = 0;
  activations = 0;
  function ask(questions = [choice], signal?: AbortSignal, local: (signal?: AbortSignal) => Promise<AskUserQuestionAnswer> = async () => { throw new Error('must use channel question'); }) {
    return bridge.ask({ agent, questions, signal } as unknown as AskUserQuestionRequest, local);
  }
  const questions = () => texts.filter(text => text.startsWith('需要你补充信息'));
  return { bridge, prompts, texts, errors, events, ask, questions, setSend: (handler: typeof send) => { send = handler; },
    setCold: () => { live = false; }, activations: () => activations, readClosed: () => readClosed };
}

test('answers and status use explicit commands, preserving ordinary task text', () => {
  assert.deepEqual(parseCommand('回答 1'), { kind: 'answer', value: '1' });
  assert.deepEqual(parseCommand('回答'), { kind: 'answer', value: '' });
  assert.deepEqual(parseCommand(`/answer ${'a'.repeat(32)} 文本 123`), { kind: 'answer', token: 'a'.repeat(32), value: '文本 123' });
  assert.deepEqual(parseCommand('状态'), { kind: 'status' });
  for (const text of ['1', 'PDF', '回答这个问题', '帮我查看状态']) assert.equal(parseCommand(text), undefined);
  assert.deepEqual(parseCommand('回答1'), { kind: 'answer', value: '1' });
  assert.deepEqual(parseCommand('回答1,2'), { kind: 'answer', value: '1,2' });
  assert.deepEqual(parseCommand('回答文本 本地报告'), { kind: 'answer', value: '文本 本地报告' });
});

test('native batches retain ids, selections, free text and ignore duplicate or unrelated replies', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  const answer = f.ask([choice, { ...choice, id: 'sections', multiSelect: true }, { id: 'title', question: '标题是什么？' }]);
  await until(() => f.questions().length === 1, 'first question missing');
  assert.match(f.questions()[0]!, /完整说明/);
  assert.match(f.questions()[0]!, /Markdown — 便于修改/);
  await f.bridge.receive(inbound('status', '状态'));
  assert.match(f.texts.at(-1)!, /等待你的回答/);
  await f.bridge.receive(inbound('new-task', '另外再生成摘要'));
  assert.equal(f.prompts.length, 1);
  assert.match(f.texts.at(-1)!, /排队.*等待回答/);
  await f.bridge.receive(inbound('approval-word', '允许'));
  assert.equal(f.questions().length, 1);
  await f.bridge.receive(inbound('out-of-range', '回答 8'));
  assert.match(f.texts.at(-1)!, /答案格式不正确/);
  await f.bridge.receive(inbound('first-answer', '回答 2'));
  await until(() => f.questions().length === 2, 'second question missing');
  await f.bridge.receive(inbound('first-answer', '回答 2'));
  assert.equal(f.questions().length, 2);
  await f.bridge.receive(inbound('second-answer', '回答 1,2'));
  await until(() => f.questions().length === 3, 'third question missing');
  await f.bridge.receive(inbound('third-answer', '回答 自定义报告标题'));
  assert.deepEqual(await answer, { answers: [
    { id: 'format', selected: ['PDF'] }, { id: 'sections', selected: ['Markdown', 'PDF'] },
    { id: 'title', selected: [], custom: '自定义报告标题' },
  ] });
  assert.equal(f.prompts.length, 1, 'control replies must not queue model tasks');
  assert.deepEqual(f.errors, []);
});

test('parallel questions require a presented reference scoped to the owner and chat', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  f.setSend(async text => { if (text.startsWith('需要你补充信息')) await gate; });
  let completed = 0;
  const first = f.ask().then(result => { completed++; return result; });
  await until(() => f.questions().length === 1, 'first question missing');
  const token = /[a-f0-9]{32}/.exec(f.questions()[0]!)![0];
  await f.bridge.receive(inbound('too-early', `回答 ${token} 1`));
  assert.match(f.texts.at(-1)!, /还在发送/);
  const second = f.ask().then(result => { completed++; return result; });
  await until(() => f.questions().length === 2, 'second question missing');
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.bridge.receive({ ...inbound('wrong-owner', `回答 ${token} 1`), senderId: 'stranger' });
  await f.bridge.receive({ ...inbound('wrong-chat', `回答 ${token} 1`), chatId: 'other-chat' });
  await f.bridge.receive(inbound('ambiguous', '回答 1'));
  assert.equal(completed, 0);
  assert.match(f.texts.at(-1)!, /多项待回答/);
  await f.bridge.receive(inbound('specific', `回答 ${token} Markdown`));
  assert.deepEqual((await first).answers, [{ id: 'format', selected: ['Markdown'] }]);
  await f.bridge.receive(inbound('remaining', '回答 文本 123'));
  assert.deepEqual((await second).answers, [{ id: 'format', selected: [], custom: '123' }]);
  assert.equal(f.prompts.length, 0);
});

test('question cancellation, shutdown, and failed delivery release native waiters', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const cancelled = assert.rejects(f.ask([choice], controller.signal), { code: 'ASK_ABORTED' });
    await until(() => f.questions().length === 1, 'question missing');
    controller.abort();
    await cancelled;
    f.setSend(async () => { throw new Error('local send failure'); });
    await assert.rejects(f.ask(), { code: 'NO_PROVIDER' });
    f.setSend(async () => {});
    const closed = assert.rejects(f.ask(), { code: 'ASK_ABORTED' });
    await until(() => f.questions().length === 3, 'shutdown question missing');
    await f.bridge.close();
    await closed;
  } finally { await f.bridge.close(); }
});

test('an oversized plan stays in the native UI without dropping its details', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  const result = { answers: [{ id: 'format', selected: ['PDF'] }] };
  const answer = await f.ask([{ ...choice, detail: '完整计划'.repeat(1000), intent: { kind: 'plan-review', approve: 'PDF' } }],
    undefined, async () => result as never);
  assert.deepEqual(answer, result);
  assert.equal(f.questions().length, 0);
  assert.ok(f.texts.some(text => /本机 DSH.*完整/.test(text)));
  await f.bridge.drain();
  assert.match(f.texts.at(-1)!, /已在电脑端完成回答/);
});

test('failed answer acknowledgments cannot settle the following question', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  const answer = f.ask([choice, { ...choice, id: 'second' }]);
  await until(() => f.questions().length === 1, 'first question missing');
  f.setSend(async text => { if (text.startsWith('已收到回答')) throw new Error('local ack failure'); });
  await f.bridge.receive(inbound('same-answer', '回答 1'));
  await until(() => f.questions().length === 2, 'second question missing');
  f.setSend(async () => {});
  await f.bridge.receive(inbound('same-answer', '回答 1'));
  await f.bridge.receive(inbound('last-answer', '回答 2'));
  assert.deepEqual((await answer).answers.map(item => item.selected), [['Markdown'], ['PDF']]);
  assert.deepEqual(f.errors, ['channel_answer_ack_failed']);
});

test('status reads live or cold native history without activating an agent or creating a turn', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  await f.bridge.receive(inbound('running-status', '/status'));
  assert.match(f.texts.at(-1)!, /正在执行/);
  f.setCold();
  await f.bridge.receive(inbound('cold-status', '状态'));
  assert.match(f.texts.at(-1)!, /没有结束记录/);
  f.events.push({ type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } });
  await f.bridge.receive(inbound('completed-status', '状态'));
  assert.match(f.texts.at(-1)!, /已完成/);
  assert.equal(f.activations(), 0);
  assert.equal(f.prompts.length, 0);
  assert.equal(f.readClosed(), true);
});

test('desktop answers cancel channel questions, and late replies do not queue a new task', async t => {
  const f = await fixture(); t.after(() => f.bridge.close());
  let localSignal: AbortSignal | undefined;
  const expected = { answers: [{ id: 'format', selected: ['PDF'] }] };
  assert.deepEqual(await f.ask([choice], undefined, async signal => { localSignal = signal; return expected; }), expected);
  assert.equal(localSignal?.aborted, true);
  await f.bridge.receive(inbound('late-answer', '回答 1'));
  assert.equal(f.prompts.length, 0);
  assert.match(f.texts.at(-1)!, /没有|失效/);
});

test('channel answers cancel the desktop question lifetime', async t => {
  const f = await fixture(); t.after(() => f.bridge.close());
  let cancelled = false;
  const result = f.ask([choice], undefined, signal => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => { cancelled = true; reject(new Error('native presentation cancelled')); }, { once: true });
  }));
  await until(() => f.questions().length === 1, 'question missing');
  await f.bridge.receive(inbound('remote-wins', '回答 2'));
  assert.deepEqual((await result).answers, [{ id: 'format', selected: ['PDF'] }]);
  assert.equal(cancelled, true);
});

test('desktop coder approval selections get a short receipt without details or free text', async t => {
  const f = await fixture(); t.after(() => f.bridge.close());
  const question = { id: 'approve', header: '编码任务 ct-fixture', question: 'Codex 请求：安装依赖', detail: '完整命令和参数不应重复出现在回执', options: [{ label: '允许' }, { label: '拒绝' }] };
  await f.ask([question], undefined, async () => ({ answers: [{ id: 'approve', selected: ['允许'], custom: 'private free-text answer' }] }));
  await f.bridge.drain();
  assert.match(f.texts.at(-1)!, /已在电脑端完成回答.*\n.*编码任务 ct-fixture：Codex 请求：安装依赖：允许/);
  assert.match(f.texts.at(-1)!, /这组提示已失效/);
  assert.doesNotMatch(f.texts.at(-1)!, /private free-text|完整命令和参数/);
});
