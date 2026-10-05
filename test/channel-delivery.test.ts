import { wecomDeliveryError } from '../src/wecom/transport.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelDeliveryStore, DurableChannelTransport, withDeliveryRecovery } from '../src/channels/durable.js';
import { ChannelError, type ConnectionState } from '../src/channels/types.js';
import type { ChannelTransport, InboundMessage } from '../src/channels/protocol.js';
import { MemoryRecords, until } from './helpers.js';

function fixture(channel: 'feishu' | 'wecom', records = new MemoryRecords(), workspace = process.cwd(), owner = 'owner') {
  const store = new ChannelDeliveryStore(records, channel, 'account', owner, workspace);
  const chatId = channel === 'wecom' ? owner : 'chat';
  const states: ConnectionState[] = [], wires: { text: string; id: string }[] = [], files: string[] = [];
  let receive!: (message: InboundMessage) => Promise<void>, state!: (state: ConnectionState) => void;
  let send: (text: string, id: string) => Promise<void> = async (text, id) => { wires.push({ text, id }); };
  const transport = new DurableChannelTransport(channel, owner, workspace, store, value => states.push(value), publish => {
    state = publish;
    return { async start(callback) { receive = callback; publish({ phase: 'connected' }); }, async stop() {},
      sendText: (_chat, text, id) => send(text, id), async sendFile(_chat, file) { files.push(file.bytes.toString()); } } satisfies ChannelTransport;
  });
  const inbound = (messageId: string, text = 'hello'): InboundMessage => ({ messageId, text, chatId, senderId: owner, chatType: 'p2p' });
  return { transport, store, states, wires, files, chatId, inbound, records,
    deliver: (message: InboundMessage) => receive(message), state: (value: ConnectionState) => state(value),
    sender: (value: typeof send) => { send = value; } };
}

for (const channel of ['feishu', 'wecom'] as const) {
  test(`${channel}: persisted receipts and chat bindings are owner scoped; concurrent duplicates are admitted once`, async t => {
    const f = fixture(channel); t.after(() => f.transport.stop());
    let calls = 0;
    await f.transport.start(async () => { calls++; });
    await f.deliver({ ...f.inbound('foreign'), senderId: 'other' });
    await Promise.all([f.deliver(f.inbound('one')), f.deliver(f.inbound('one'))]);
    assert.equal(calls, 1);
    assert.deepEqual(await f.transport.knownChats(), [f.chatId]);
    await assert.rejects(f.transport.sendText('other', 'secret', 'bad', { durable: true }), /invalid_recipient/);
    await f.transport.stop();
    const restarted = fixture(channel, f.records); t.after(() => restarted.transport.stop());
    await restarted.transport.start(async () => { calls++; });
    await restarted.deliver(restarted.inbound('one'));
    assert.equal(calls, 1);
    const moved = fixture(channel, f.records, tmpdir()); t.after(() => moved.transport.stop());
    await moved.transport.start(async () => { calls++; });
    await moved.deliver(moved.inbound('one'));
    assert.equal(calls, 1, 'moving the workspace does not allow a duplicate event to run again');
    const changedOwner = fixture(channel, f.records, process.cwd(), 'other');
    assert.deepEqual((await changedOwner.store.read()).pending, []);
    assert.deepEqual(await changedOwner.transport.knownChats(), []);
  });

  test(`${channel}: restart resumes exact unsent parts after a definite rejection without replaying tasks`, async t => {
    const f = fixture(channel); t.after(() => f.transport.stop());
    let calls = 0, sent = 0;
    await f.transport.start(async () => { calls++; }); await f.deliver(f.inbound('bind'));
    f.sender(async (text, id) => { if (++sent === 2) throw new ChannelError('delivery_rejected'); f.wires.push({ text, id }); });
    const text = '😀'.repeat(7010);
    await f.transport.sendText(f.chatId, text, 'result', { durable: true });
    await until(async () => (await f.store.read()).pending[0]?.error === 'delivery_rejected', 'rejection persisted');
    const pending = (await f.store.read()).pending[0]!;
    assert.equal(pending.next, 1);
    const expected = pending.parts!.slice(1);
    await f.transport.stop();
    const restarted = fixture(channel, f.records); t.after(() => restarted.transport.stop());
    await restarted.transport.start(async () => { calls++; });
    await until(async () => (await restarted.store.read()).pending.length === 0, 'outbox drained');
    assert.deepEqual(restarted.wires, expected.map(part => ({ text: part.text, id: part.id })));
    assert.equal(f.wires[0]!.text + restarted.wires.map(x => x.text).join(''), text);
    assert.equal(calls, 1, 'recovery never invokes the inbound task');
    await restarted.transport.sendText(restarted.chatId, text, 'result', { durable: true });
    assert.equal((await restarted.store.read()).pending.length, 0, 'completed receipt deduplicates delivery');
    assert.equal(restarted.states.at(-1)?.pendingDeliveries, 0);
  });

  test(`${channel}: ambiguous acceptance and process interruption wait for explicit retry`, async t => {
    const f = fixture(channel); t.after(() => f.transport.stop());
    await f.transport.start(async () => {}); await f.deliver(f.inbound('bind'));
    f.sender(async (text, id) => { f.wires.push({ text, id }); throw new Error('request URL and secret must never reach state'); });
    await f.transport.sendText(f.chatId, 'result', 'unknown', { durable: true });
    await until(async () => (await f.store.read()).pending[0]?.error === 'delivery_uncertain', 'uncertain send held');
    await f.transport.stop();
    const restarted = fixture(channel, f.records); t.after(() => restarted.transport.stop());
    await restarted.transport.start(async () => {});
    await restarted.deliver(restarted.inbound('new-message'));
    assert.equal(restarted.wires.length, 0, 'neither restart nor a new message retries ambiguous acceptance');
    assert.equal(restarted.states.at(-1)?.deliveryError, 'delivery_uncertain');
    assert.doesNotMatch(JSON.stringify(restarted.states), /request URL|secret/);
    await restarted.transport.retryPending();
    await until(async () => !(await restarted.store.read()).pending.length, 'explicit retry drains');
    assert.equal(restarted.wires[0]!.id, f.wires[0]!.id);
    f.state({ phase: 'disconnected' });
    await restarted.store.enqueue({ id: 'crashed', chatId: f.chatId, parts: [{ id: 'wire', text: 'crashed' }], next: 0, attempts: 0, sending: true });
    await restarted.transport.stop();
    const crashed = fixture(channel, f.records); t.after(() => crashed.transport.stop());
    await crashed.transport.start(async () => {});
    assert.equal((await crashed.store.read()).pending[0]?.error, 'delivery_uncertain');
    assert.equal(crashed.wires.length, 0);
  });

  test(`${channel}: approvals stay ephemeral, and cancelled prompts are never sent or replayed`, async t => {
    const f = fixture(channel); t.after(() => f.transport.stop());
    await f.transport.start(async () => {}); await f.deliver(f.inbound('bind'));
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.transport.sendText(f.chatId, 'approval', 'prompt', { signal: controller.signal }));
    assert.deepEqual(f.wires, []);
    f.sender(async () => { throw new Error('network'); });
    await assert.rejects(f.transport.sendText(f.chatId, 'approval', 'prompt'));
    assert.deepEqual((await f.store.read()).pending, []);
    await f.transport.stop();
    const restarted = fixture(channel, f.records); t.after(() => restarted.transport.stop());
    await restarted.transport.start(async () => {});
    assert.deepEqual(restarted.wires, []);
  });
}

test('queued file references stay inside their original workspace and cannot send changed bytes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-delivery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const f = fixture('wecom', new MemoryRecords(), dir); t.after(() => f.transport.stop());
  await f.transport.start(async () => {}); f.state({ phase: 'reconnecting' });
  await writeFile(join(dir, 'result.txt'), 'original');
  await f.transport.sendFile(f.chatId, { name: 'result.txt', path: 'result.txt', bytes: Buffer.from('original') }, 'file');
  await f.transport.stop();
  await writeFile(join(dir, 'result.txt'), 'changed');
  const restarted = fixture('wecom', f.records, dir); t.after(() => restarted.transport.stop());
  await restarted.transport.start(async () => {});
  await until(async () => (await restarted.store.read()).pending.length === 0, 'changed file becomes a delivered notice');
  assert.match(restarted.wires[0]!.text, /没有发送/);
  assert.deepEqual(restarted.files, []);
  const elsewhere = fixture('wecom', f.records, tmpdir());
  assert.deepEqual((await elsewhere.store.read()).pending, [], 'changing directory never picks up the old outbox');
  await assert.rejects(restarted.transport.sendFile(f.chatId, { name: 'outside', path: '../outside', bytes: Buffer.from('x') }, 'outside'));
});

test('outbox is bounded and malformed persisted state fails closed', async () => {
  const records = new MemoryRecords(); const f = fixture('wecom', records);
  await f.store.admitChat(f.chatId);
  for (let i = 0; i < 50; i++) await f.store.enqueue({ id: String(i), chatId: f.chatId, parts: [{ id: String(i), text: 'pending' }], next: 0, attempts: 0 });
  await assert.rejects(f.store.enqueue({ id: 'overflow', chatId: f.chatId, parts: [{ id: 'overflow', text: 'x' }], next: 0, attempts: 0 }), /delivery_queue_full/);
  records.values.set([...records.values.keys()][0]!, { version: 999 });
  await assert.rejects(f.store.read(), /invalid_delivery_state/);
});


test('WeCom distinguishes a negative SDK acknowledgment from an ambiguous network error without copying payloads', () => {
  assert.equal(wecomDeliveryError({ errcode: 45009, errmsg: 'sensitive body' }).code, 'delivery_rejected');
  assert.equal(wecomDeliveryError(new Error('errcode=45009 https://private/?token=secret')).code, 'delivery_uncertain');
  assert.equal(wecomDeliveryError({ errcode: 0 }).code, 'delivery_uncertain');
  assert.doesNotMatch(wecomDeliveryError({ errcode: 45009, errmsg: 'secret' }).message, /secret/);
});


test('Feishu pairing remains candidate-scoped and never drains the previous owner outbox', async () => {
  const records = new MemoryRecords();
  const store = new ChannelDeliveryStore(records, 'feishu', 'account', 'old-owner', process.cwd());
  await store.admitChat('old-chat');
  await store.enqueue({ id: 'old-result', chatId: 'old-chat', parts: [{ id: 'old-wire', text: 'private old result' }], next: 0, attempts: 0 });
  let receive!: (message: InboundMessage) => Promise<void>;
  const raw: ChannelTransport = { async start(callback) { receive = callback; }, async stop() {}, async sendText() { throw new Error('pairing must not send old output'); }, async sendFile() {} };
  const pairing = withDeliveryRecovery('feishu', { version: 1, revision: 1, enabled: false, accountId: 'account', ownerId: 'old-owner', secret: 'fixture' },
    process.cwd(), records, () => {}, () => raw);
  assert.equal(pairing, raw);
  const seen: string[] = [];
  await pairing.start(async message => { seen.push(message.senderId); });
  await receive({ messageId: 'new-candidate', chatId: 'new-chat', senderId: 'new-owner', chatType: 'p2p', text: 'pair-code' });
  assert.deepEqual(seen, ['new-owner']);
  assert.equal((await store.read()).pending.length, 1);
  assert.deepEqual(await store.received(), []);
  await pairing.stop();
});
