import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import { DshChannelBridge } from '../src/dsh/bridge.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { until } from './helpers.js';

const owner = { channel: 'wechat' as const, accountId: 'approval-bot', ownerId: 'approval-owner' };
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text,
  chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });

async function fixture() {
  const prompts: unknown[] = [];
  const texts: string[] = [];
  const errors: string[] = [];
  const calls: { type: 'tool/call'; data: { callId: string; arguments: string } }[] = [];
  const session = { id: sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'), snapshotEvents: () => calls };
  const agent = { id: session.id, session };
  let onPrompt: (() => void) | undefined;
  const ctx = {
    sessionController: { async create() {}, async resolveAgent() { return { agent }; }, async prompt(input: unknown) { prompts.push(input); onPrompt?.(); } },
    sessions: { async flush() { return true; } }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  let send: (text: string) => Promise<void> = async () => {};
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {},
    async sendText(_chatId, text) { texts.push(text); await send(text); } };
  const bridge = new DshChannelBridge(ctx, transport, owner, '/local-approval-fixture', code => errors.push(code));
  await bridge.receive(inbound('initial-task', '创建本地测试文件'));
  prompts.length = 0;
  function ask(callId: string, args = { command: 'printf hello > result.txt', description: '写入测试文件', sandbox_permissions: 'require_escalated' }, local: (signal?: AbortSignal) => Promise<ApprovalOutcome> = async () => { throw new Error('no desktop'); }) {
    const serialized = JSON.stringify(args);
    calls.push({ type: 'tool/call', data: { callId, arguments: serialized } });
    return bridge.approve({ agent, callId, toolName: 'bash', reason: '需要在沙盒外执行这一次操作。' } as unknown as ApprovalRequest,
      local);
  }
  return { bridge, prompts, texts, errors, ask, setSend: (handler: typeof send) => { send = handler; },
    setPrompt: (handler: () => void) => { onPrompt = handler; } };
}

for (const [reply, outcome] of [['允许', 'allowed-once'], ['拒绝', 'rejected']] as const) {
  test(`a contextual Chinese approval reply (${reply}) settles the question without queuing a task`, async t => {
    const f = await fixture();
    t.after(() => f.bridge.close());
    const decision = f.ask('first-call');
    await until(() => f.texts.length === 1, 'approval prompt was not sent');
    await f.bridge.receive(inbound('decision', reply));
    assert.equal(f.prompts.length, 0, 'an approval reply must not become a model task');
    assert.equal(await decision, outcome);
    assert.match(f.texts[0]!, /写入测试文件/);
    assert.match(f.texts[0]!, /"command": "printf hello > result.txt"/);
    assert.match(f.texts[0]!, /"sandbox_permissions": "require_escalated"/);
    assert.match(f.texts.at(-1)!, reply === '允许' ? /已允许.*本次/ : /已拒绝.*本次/);
  });
}

test('an approval reply without a pending question receives guidance without starting a task', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  await f.bridge.receive(inbound('late-decision', '同意'));
  assert.equal(f.prompts.length, 0);
  assert.match(f.texts.at(-1)!, /没有.*待审批/);
});

test('multiple questions require an exact reference and cannot be approved from another owner or chat', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  let completed = 0;
  const first = f.ask('first-call').then(outcome => { completed++; return outcome; });
  const second = f.ask('second-call').then(outcome => { completed++; return outcome; });
  await until(() => f.texts.length === 2, 'both approval prompts were not sent');
  const token = /[a-f0-9]{32}/.exec(f.texts[0]!)![0];
  await f.bridge.receive({ ...inbound('foreign-owner', '允许'), senderId: 'somebody-else' });
  await f.bridge.receive({ ...inbound('foreign-chat', `允许 ${token}`), chatId: 'another-chat' });
  await f.bridge.receive(inbound('ambiguous', '允许'));
  assert.equal(f.prompts.length, 0);
  assert.equal(completed, 0);
  assert.match(f.texts.at(-1)!, /多项.*审批/);
  await f.bridge.receive(inbound('specific', `允许 ${token}`));
  assert.equal(await first, 'allowed-once');
  assert.equal(completed, 1);
  await f.bridge.receive(inbound('last-decision', '拒绝'));
  assert.equal(await second, 'rejected');
});

test('plain approval waits until the complete prompt has been delivered', async t => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setSend(async text => { if (text.includes('printf hello')) await gate; });
  t.after(() => { release(); return f.bridge.close(); });
  let completed = false;
  const decision = f.ask('sending-call').then(outcome => { completed = true; return outcome; });
  await until(() => f.texts.length === 1, 'approval was not being sent');
  await f.bridge.receive(inbound('too-early', '允许'));
  assert.equal(f.prompts.length, 0);
  assert.equal(completed, false);
  assert.match(f.texts.at(-1)!, /发送/);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.bridge.receive(inbound('after-delivery', '允许'));
  assert.equal(await decision, 'allowed-once');
});

test('a failed acknowledgment cannot replay a plain decision against the next approval', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  const first = f.ask('first-call');
  await until(() => f.texts.length === 1, 'approval prompt was not sent');
  f.setSend(async text => { if (text.startsWith('已允许')) throw new Error('local acknowledgment failure'); });
  await f.bridge.receive(inbound('original-decision', '允许'));
  assert.equal(f.prompts.length, 0);
  assert.equal(await first, 'allowed-once');
  assert.deepEqual(f.errors, ['channel_approval_ack_failed']);
  f.setSend(async () => {});
  let completed = false;
  const previousTexts = f.texts.length;
  const second = f.ask('next-call').then(outcome => { completed = true; return outcome; });
  await until(() => f.texts.length > previousTexts, 'next approval prompt was not sent');
  await f.bridge.receive(inbound('original-decision', '允许'));
  assert.equal(completed, false);
  await f.bridge.receive(inbound('fresh-decision', '拒绝'));
  assert.equal(await second, 'rejected');
});

test('ordinary follow-up messages keep native queuing and explain the pending approval', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  let completed = false;
  void f.ask('waiting-call').then(() => { completed = true; });
  await until(() => f.texts.length === 1, 'approval prompt was not sent');
  await f.bridge.receive(inbound('follow-up', '接下来再生成一份摘要'));
  assert.equal(f.prompts.length, 1);
  assert.equal(completed, false);
  assert.match(f.texts.at(-1)!, /排队/);
  assert.match(f.texts.at(-1)!, /审批/);
});

test('a new task reaching approval is not mislabeled as waiting behind another task', async t => {
  const f = await fixture();
  t.after(() => f.bridge.close());
  f.setPrompt(() => { void f.ask('new-task-call'); });
  await f.bridge.receive(inbound('new-task', '生成一份摘要'));
  assert.equal(f.prompts.length, 1);
  assert.ok(f.texts.some(text => text.startsWith('需要你确认后继续')));
  assert.equal(f.texts.filter(text => text.includes('排队')).length, 0);
});

test('desktop approval wins even during a slow send and invalidates the channel token', async t => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setSend(() => gate);
  t.after(() => { release(); return f.bridge.close(); });
  let signal: AbortSignal | undefined;
  const result = await f.ask('desktop-wins', undefined, async s => { signal = s; return 'rejected'; });
  assert.equal(result, 'rejected');
  assert.equal(signal?.aborted, true);
  release();
  f.setSend(async () => {});
  const token = /允许 ([a-f0-9]{32})/.exec(f.texts[0]!)![1];
  await f.bridge.receive(inbound('late-desktop-decision', `允许 ${token}`));
  assert.equal(f.prompts.length, 0);
  assert.match(f.texts.at(-1)!, /失效|没有/);
});

test('channel decision cancels native pending presentation; unavailable desktop cannot settle it early', async t => {
  const f = await fixture(); t.after(() => f.bridge.close());
  let cancelled = false;
  const result = f.ask('channel-wins', undefined, signal => new Promise(resolve => {
    signal!.addEventListener('abort', () => { cancelled = true; resolve('cancelled'); }, { once: true });
  }));
  await until(() => f.texts.length === 1, 'channel prompt missing');
  await f.bridge.receive(inbound('remote-decision', '允许'));
  assert.equal(await result, 'allowed-once');
  assert.equal(cancelled, true);
  const second = f.ask('desktop-unavailable', undefined, async () => 'unavailable');
  await until(() => f.texts.some(text => text.includes('desktop-unavailable')) || f.texts.length === 3, 'second prompt missing');
  await f.bridge.receive(inbound('second-remote-decision', '拒绝'));
  assert.equal(await second, 'rejected');
});

test('failed channel delivery falls back to the desktop approval', async t => {
  const f = await fixture(); t.after(() => f.bridge.close());
  f.setSend(async () => { throw new Error('offline fixture'); });
  const result = await f.ask('desktop-fallback', undefined, async () => { await new Promise(resolve => setImmediate(resolve)); return 'allowed-once'; });
  assert.equal(result, 'allowed-once');
});
