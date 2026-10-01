import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { readFeishuConfig } from '../src/feishu/config.js';
import { normalizeInbound } from '../src/feishu/protocol.js';
import { parseCommand, sessionIdFor } from '../src/channels/protocol.js';
import { ApprovalReplies } from '../src/channels/approvals.js';

test('Feishu is opt-in and requires an explicitly configured owner', () => {
  assert.equal(readFeishuConfig({}), undefined);
  assert.throws(() => readFeishuConfig({ NEXUS_FEISHU_ENABLED: 'true' }), /must be 0 or 1/);
  assert.throws(() => readFeishuConfig({
    NEXUS_FEISHU_ENABLED: '1', NEXUS_FEISHU_APP_ID: 'cli_test', NEXUS_FEISHU_APP_SECRET: 'secret-fixture',
  }), /Missing NEXUS_FEISHU_OWNER_OPEN_ID/);
});

test('normalization rejects bot messages, malformed JSON, and non-text bodies', () => {
  const event = {
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
    message: { message_id: 'om_test', chat_id: 'oc_test', chat_type: 'p2p', message_type: 'text', content: '{"text":"hello"}' },
  };
  assert.equal(normalizeInbound(event)?.text, 'hello');
  assert.equal(normalizeInbound({ ...event, sender: { ...event.sender, sender_type: 'app' } }), undefined);
  assert.equal(normalizeInbound({ ...event, message: { ...event.message, content: 'invalid' } }), undefined);
  assert.equal(normalizeInbound({ ...event, message: { ...event.message, content: '{"text":3}' } }), undefined);
  assert.equal(normalizeInbound({ ...event, message: { ...event.message, message_type: 'file' } }), undefined);
});

test('stable native session identities separate applications, owners, and conversations', () => {
  const first = sessionIdFor('app', 'owner', 'chat');
  assert.equal(first, sessionIdFor('app', 'owner', 'chat'));
  for (const other of [['app2', 'owner', 'chat'], ['app', 'owner2', 'chat'], ['app', 'owner', 'chat2']]) {
    assert.notEqual(first, sessionIdFor(other[0]!, other[1]!, other[2]!));
  }
});

test('Chinese approval commands are explicit and unrelated chat is not a decision', () => {
  assert.deepEqual(parseCommand('同意'), { kind: 'approve' });
  assert.deepEqual(parseCommand(' 允许 '), { kind: 'approve' });
  assert.deepEqual(parseCommand('拒绝'), { kind: 'deny' });
  const token = 'a'.repeat(32);
  assert.deepEqual(parseCommand(`允许 ${token}`), { kind: 'approve', token });
  assert.deepEqual(parseCommand(`拒绝 ${token}`), { kind: 'deny', token });
  assert.deepEqual(parseCommand(`/approve ${token}`), { kind: 'approve', token });
  assert.deepEqual(parseCommand(`/deny ${token}`), { kind: 'deny', token });
  for (const text of ['好的', '可以', '继续', '我同意这个方案', '请解释允许是什么意思']) assert.equal(parseCommand(text), undefined);
  assert.equal(parseCommand('/approve'), undefined);
  assert.equal(parseCommand('/approve short'), undefined);
  assert.deepEqual(parseCommand('/cancel'), { kind: 'cancel' });
});

test('approval replies are one-shot and cannot cross conversations', async () => {
  const replies = new ApprovalReplies();
  const pending = replies.open('chat-a');
  assert.equal(replies.answer('chat-b', pending.token, 'allowed-once'), false);
  assert.equal(replies.answer('chat-a', pending.token, 'allowed-once'), true);
  assert.equal(await pending.outcome, 'allowed-once');
  assert.equal(replies.answer('chat-a', pending.token, 'allowed-once'), false);
  replies.close();
});

test('cancellation, expiry, and shutdown never grant an approval', async () => {
  const replies = new ApprovalReplies(10);
  const controller = new AbortController();
  const cancelled = replies.open('chat', controller.signal);
  controller.abort();
  assert.equal(await cancelled.outcome, 'cancelled');
  const expired = replies.open('chat');
  await delay(20);
  assert.equal(await expired.outcome, 'cancelled');
  const shutdown = replies.open('chat');
  replies.close();
  assert.equal(await shutdown.outcome, 'cancelled');
  assert.equal(replies.answer('chat', shutdown.token, 'allowed-once'), false);
});
