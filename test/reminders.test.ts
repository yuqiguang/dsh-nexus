import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { DshChannelBridge, TRANSCRIBED_NOTE, describeToolCall, heartbeatText, type BridgeExtras } from '../src/dsh/bridge.js';
import { describeReminders, isQuietReply, pluginInitiated } from '../src/dsh/schedule.js';
import { sessionIdFor, type ChannelTransport } from '../src/channels/protocol.js';

test('quiet replies and plugin-initiated messages are recognised', () => {
  for (const text of ['静默', ' 静默 ', '【静默】', '[静默]', '静默。']) assert.equal(isQuietReply(text), true, text);
  for (const text of ['静默一下', '价格降了', '', '静默：没有变化']) assert.equal(isQuietReply(text), false, text);
  assert.equal(pluginInitiated({ source: { kind: 'plugin', plugin: 'schedule' } } as never), true);
  assert.equal(pluginInitiated({ source: { kind: 'user' } } as never), false);
  const lines = describeReminders([
    { id: 'schedule-1', kind: 'at', prompt: '带合同', scheduledAt: '2026-09-20T00:00:00.000Z' },
    { id: 'schedule-2', kind: 'every', prompt: 'x'.repeat(80), everySeconds: 600, scheduledAt: '2026-09-20T01:00:00.000Z' },
  ] as never);
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /schedule-1 .*9\/20 08:00：带合同/);
  assert.match(lines[1]!, /每 10 分钟，下次 9\/20 09:00：x{60}…/);
});

function fixture(heartbeat = { firstMs: 60_000, everyMs: 300_000 }, extras: BridgeExtras = {}) {
  let clock = Date.parse('2026-09-20T10:00:00+08:00');
  const owner = { channel: 'wechat' as const, accountId: 'r-bot', ownerId: 'r-owner' };
  const texts: string[] = [];
  const events: any[] = [];
  const session = { id: sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'), snapshotEvents: () => events };
  const resolved: string[] = [];
  const ctx = {
    sessionController: { async create() {}, async resolveAgent(id: string) { resolved.push(id); return { agent: { id, session } }; }, async prompt() {} },
    sessions: { async flush() { return true; }, get: () => session }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const bridge = new DshChannelBridge(ctx, transport, owner, '/local-reminder-fixture', () => {}, heartbeat, () => clock, extras);
  let seq = 0;
  const push = (type: string, data: unknown) => { events.push({ type, data, seq: seq++ }); return events.at(-1); };
  const turn = (n: number, source: unknown, reply: string, userText = 'x') => {
    push('turn/start', { turn: n });
    push('user/message', { id: `u${n}`, role: 'user', content: [{ type: 'text', text: userText }], source });
    push('assistant/message', { turn: n, message: { content: [{ type: 'text', text: reply }] } });
    const end = push('turn/end', { turn: n, reason: { kind: 'completed' } });
    bridge.onEvent(session as never, end);
    return bridge.drain();
  };
  return { bridge, texts, turn, resolved, session, push, advance: (ms: number) => { clock += ms; } };
}

test('a plugin-initiated turn whose reply is 静默 is not delivered, but user turns and real reminders are', async () => {
  const { turn, texts } = fixture();
  await turn(1, { kind: 'user' }, '静默');
  assert.deepEqual(texts, ['静默'], 'the user asked for it: deliver even a quiet-looking reply');
  await turn(2, { kind: 'plugin', plugin: 'schedule' }, '静默');
  assert.equal(texts.length, 1);
  await turn(3, { kind: 'plugin', plugin: 'schedule' }, '提醒：带合同');
  assert.deepEqual(texts.at(-1), '提醒：带合同');
  await turn(4, { kind: 'plugin', plugin: 'tool-jobs' }, '编码任务完成了。');
  assert.deepEqual(texts.at(-1), '编码任务完成了。');
});

test('resumeBound resolves the pre-registered session so native runtimes attach', async () => {
  const { bridge, resolved, session } = fixture();
  await bridge.resumeBound();
  assert.deepEqual(resolved, [session.id]);
});

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a long user turn sends heartbeats with the last tool step; pushed turns and finished turns stay silent', async t => {
  const { bridge, texts, push, session, advance } = fixture({ firstMs: 15, everyMs: 60 });
  t.after(() => bridge.close());
  // A reminder-started turn: no heartbeat however long it runs.
  push('turn/start', { turn: 1 });
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'schedule' } });
  bridge.onEvent(session as never, push('step/start', { turn: 1, step: 1 }));
  await tick(40);
  assert.deepEqual(texts, []);
  bridge.onEvent(session as never, push('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await bridge.drain();
  texts.length = 0;
  // A user turn: first beat after firstMs names the running tool, later beats follow everyMs, the end stops them.
  push('turn/start', { turn: 2 });
  push('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: '整理一下仓库' }], source: { kind: 'user' } });
  bridge.onEvent(session as never, push('step/start', { turn: 2, step: 1 }));
  push('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'npm test', description: '跑测试' }) });
  advance(90_000);
  await tick(25);
  assert.equal(texts.length, 1);
  assert.equal(texts[0], '还在处理，已用 2 分钟。最近一步：bash：跑测试。回复“状态”查看，/cancel 停止。');
  bridge.onEvent(session as never, push('step/start', { turn: 2, step: 2 }));
  advance(300_000);
  await tick(70);
  assert.equal(texts.length, 2, 'a second step of the same turn does not restart the schedule');
  assert.match(texts[1]!, /已用 7 分钟/);
  push('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '整理好了。' }] } });
  bridge.onEvent(session as never, push('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await bridge.drain();
  await tick(80);
  assert.deepEqual(texts.slice(2), ['整理好了。'], 'no heartbeat after the turn ended');
});

test('heartbeat text picks a readable detail from the tool arguments and truncates', () => {
  assert.equal(describeToolCall({ name: 'read', arguments: '{"path":"/a"}' }), 'read');
  assert.equal(describeToolCall({ name: 'coder_task', arguments: JSON.stringify({ task: '  修复登录\n页 ' }) }), 'coder_task：修复登录 页');
  assert.equal(describeToolCall({ name: 'bash', arguments: '{"command":"' }), 'bash', 'partial JSON falls back to the name');
  assert.equal(describeToolCall({ name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(100) }) }).length, 80);
  assert.equal(heartbeatText(20_000), '还在处理，已用 1 分钟。回复“状态”查看，/cancel 停止。');
});

test('a voice question is answered in text, exactly like a typed one', async () => {
  const { turn, texts } = fixture({ firstMs: 60_000, everyMs: 300_000 });
  await turn(1, { kind: 'user' }, '明天下午三点。', `几点开会？${TRANSCRIBED_NOTE}`);
  assert.deepEqual(texts, ['明天下午三点。'], 'a transcribed question gets the ordinary text reply');
  await turn(2, { kind: 'user' }, '好的。', '写下来');
  assert.deepEqual(texts, ['明天下午三点。', '好的。']);
  await turn(3, { kind: 'plugin', plugin: 'schedule' }, '提醒：带合同', `带合同${TRANSCRIBED_NOTE}`);
  assert.equal(texts.at(-1), '提醒：带合同');
  // A spoken reply was removed on 2026-09-22: iLink accepted the voice item but the WeChat client rendered nothing.
  assert.equal(texts.length, 3, 'nothing extra goes out for a voice question');
});
