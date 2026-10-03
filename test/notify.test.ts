import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { BridgeRegistry } from '../src/channels/notify.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { installCoders, interruptedNotice } from '../src/coders/index.js';
import type { CoderDomain } from '../src/coders/store.js';
import type { HabitRule, TaskRecord } from '../src/coders/types.js';
import { DshChannelBridge } from '../src/dsh/bridge.js';

function bridgeFixture(channel: 'wechat' | 'feishu' | 'wecom') {
  const owner = { channel, accountId: `${channel}-bot`, ownerId: `${channel}-owner` };
  const sends: { chatId: string; text: string; deliveryId: string; durable?: boolean }[] = [];
  const ctx = {
    sessionController: { async create() {}, async resolveAgent() { return { agent: { id: 'x', session: { snapshotEvents: () => [] } } }; }, async prompt() {} },
    sessions: { async flush() { return true; } }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {},
    async sendText(chatId, text, deliveryId, options) { sends.push({ chatId, text, deliveryId, ...(options?.durable ? { durable: true } : {}) }); } };
  const bridge = new DshChannelBridge(ctx, transport, owner, '/local-notify-fixture', () => {});
  return { owner, bridge, sends, session: sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, channel) };
}

test('WeChat and WeCom bridges can be notified before any inbound message; Feishu only after one', async () => {
  const wechat = bridgeFixture('wechat');
  assert.equal(await wechat.bridge.notify(wechat.session, '重启汇报', 'n1'), true);
  assert.deepEqual(wechat.sends, [{ chatId: wechat.owner.ownerId, text: '重启汇报', deliveryId: 'n1', durable: true }]);
  assert.equal(await wechat.bridge.notify('nexus-wechat-' + 'f'.repeat(32), 'x', 'n2'), false);
  assert.equal(await bridgeFixture('wecom').bridge.notify(bridgeFixture('wecom').session, 'x', 'n3'), true);
  const feishu = bridgeFixture('feishu');
  assert.equal(await feishu.bridge.notify(feishu.session, 'x', 'n4'), false);
  const inbound: InboundMessage = { messageId: 'm1', chatId: feishu.owner.ownerId, senderId: feishu.owner.ownerId, chatType: 'p2p', text: '你好' };
  await feishu.bridge.receive(inbound);
  assert.equal(await feishu.bridge.notify(feishu.session, 'x', 'n5'), true);
  await wechat.bridge.close();
  assert.equal(await wechat.bridge.notify(wechat.session, 'x', 'n6'), false);
});

test('/cancel before any session exists replies without throwing, and cancels a live session otherwise', async () => {
  const owner = { channel: 'wechat' as const, accountId: 'cancel-bot', ownerId: 'cancel-owner' };
  const texts: string[] = [];
  const cancelled: string[] = [];
  let attached = false;
  const ctx = {
    sessionController: { async create() { attached = true; }, async resolveAgent() { return { agent: { id: 'x', session: { snapshotEvents: () => [] } } }; },
      async prompt() {}, cancel(request: { sessionId: string }) { if (!attached) throw new Error('session/not-found'); cancelled.push(request.sessionId); return { accepted: true }; } },
    sessions: { async flush() { return true; } }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const bridge = new DshChannelBridge(ctx, transport, owner, '/local-cancel-fixture', () => {});
  const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });
  await bridge.receive(inbound('c1', '/cancel'));
  assert.deepEqual(cancelled, []);
  assert.equal(texts.at(-1), '当前没有正在执行的任务。');
  await bridge.receive(inbound('t1', '开始一个任务'));
  await bridge.receive(inbound('c2', '/cancel'));
  assert.deepEqual(cancelled, [sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat')]);
  assert.equal(texts.at(-1), '已请求停止当前执行；历史记录保留在 DSH。');
});

test('the registry tries each mounted bridge and forgets removed ones', async () => {
  const registry = new BridgeRegistry();
  const calls: string[] = [];
  const stub = { bound: () => [] as string[], async inject() { return false; }, setPushGate() {}, async catchUp() {} };
  const first = { ...stub, async notify(id: string) { calls.push(`a:${id}`); return id === 'one'; } };
  const second = { ...stub, async notify(id: string) { calls.push(`b:${id}`); return id === 'two'; } };
  registry.add(first);
  registry.add(second);
  assert.equal(await registry.notify('two', 'x', 'd'), true);
  assert.deepEqual(calls, ['a:two', 'b:two']);
  assert.equal(await registry.notify('three', 'x', 'd'), false);
  registry.remove(first);
  calls.length = 0;
  assert.equal(await registry.notify('one', 'x', 'd'), false);
  assert.deepEqual(calls, ['b:one']);
});

function coderContext(seed: TaskRecord[]) {
  const tasks = new Map(seed.map(task => [task.id, structuredClone(task)]));
  const rules = new Map<string, HabitRule>();
  const tableFor = (records: Map<string, unknown>) => ({
    get: (key: string) => records.get(key), entries: () => [...records.entries()][Symbol.iterator](), keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size; },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    async delete(key: string) { return records.delete(key); },
    async update(key: string, fn: (current: unknown) => unknown) {
      const current = records.get(key);
      if (!current) throw new Error('missing-key');
      const next = structuredClone(fn(current));
      records.set(key, next);
      return next;
    },
  });
  const domain = { name: 'nexus_coders', global: undefined as never, table: (name: string) => tableFor(name === 'rules' ? rules : tasks as Map<string, unknown>), async close() {} } as unknown as CoderDomain;
  const registered: string[] = [];
  const ctx = {
    effect(run: () => unknown) { run(); },
    on(name: string) { assert.ok(['tools/pre-execute', 'session/event'].includes(name)); return () => {}; },
    storageDomain: { async open() { return domain; } },
    tools: { register(tool: { name: string }) { registered.push(tool.name); return () => {}; } },
    systemPrompt: { section() { return () => {}; }, getSectionOrder() { return 10; } },
    sessionController: { async resolveAgent() { return { error: new Error('not live') }; } },
    userQuestions: { async ask() { throw new Error('unused'); } },
    jobs: { start() { throw new Error('unused'); } },
  } as unknown as Context;
  return { ctx, tasks, registered };
}

test('interrupted tasks are pushed to the dispatching chat at startup, and a missing route only logs', async () => {
  const running: TaskRecord = { id: 'ct-run', coder: 'codex', description: '修复登录页', cwd: '/home/dev/project', status: 'waiting-user',
    ownerSession: 'nexus-wechat-' + '1'.repeat(32), coderSessionId: 'thread-9', createdAt: 1, updatedAt: 1, escalations: 1, decisions: [],
    pending: { at: 1, kind: 'command', summary: '命令：npm test' } };
  const done: TaskRecord = { ...running, id: 'ct-done', status: 'completed', pending: undefined };
  const notices: { sessionId: string; text: string; deliveryId: string }[] = [];
  const { ctx, tasks, registered } = coderContext([running, done]);
  const store = await installCoders(ctx, { roots: ['/home/dev/project'], notifier: { async notify(sessionId, text, deliveryId) { notices.push({ sessionId, text, deliveryId }); return true; } } });
  assert.deepEqual(registered, ['coder_brief', 'coder_task', 'coder_status', 'coder_steer', 'coder_rules', 'coder_package']);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.sessionId, running.ownerSession);
  assert.equal(notices[0]!.text, interruptedNotice(running));
  assert.match(notices[0]!.text, /编码任务 ct-run 因服务重启而中断（Codex）/);
  assert.match(notices[0]!.text, /中断时正在等待你回答：命令：npm test/);
  assert.match(notices[0]!.text, /Codex 会话 thread-9 已保留/);
  assert.equal(store.get('ct-run')!.status, 'interrupted');
  assert.equal(tasks.get('ct-done')!.status, 'completed');
  const silent = coderContext([{ ...running, id: 'ct-2' }]);
  await installCoders(silent.ctx, { roots: ['/home/dev/project'], notifier: { async notify() { return false; } } });
  await new Promise(resolve => setImmediate(resolve));
  const failing = coderContext([{ ...running, id: 'ct-3' }]);
  await installCoders(failing.ctx, { roots: ['/home/dev/project'], notifier: { async notify() { throw new Error('transport down'); } } });
  await new Promise(resolve => setImmediate(resolve));
  const none = coderContext([{ ...running, id: 'ct-4' }]);
  const plain = await installCoders(none.ctx, { roots: ['/home/dev/project'] });
  assert.equal(plain.get('ct-4')!.status, 'interrupted');
});
