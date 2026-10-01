import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelManager, type ChannelDependencies } from '../src/channels/manager.js';
import { ConnectionStore } from '../src/channels/store.js';
import { FeishuPairing, isFeishuPairingCode } from '../src/feishu/pairing.js';
import type { ConnectionRecord, ConnectionState } from '../src/channels/types.js';
import type { InboundMessage } from '../src/channels/protocol.js';
import { MemoryRecords, until } from './helpers.js';

const config = { accountId: 'cli_0123456789abcdef', secret: 'fixture-secret' };
const message = (text: string, senderId = 'ou_owner', chatType = 'p2p'): InboundMessage => ({ messageId: 'fixture-message', chatId: 'fixture-chat', senderId, chatType, text });
function fixture(records = new MemoryRecords()) {
  const store = new ConnectionStore(records), mounts: string[] = [], delivered: InboundMessage[] = [];
  const sockets: { state: (state: ConnectionState) => void; receive: (message: InboundMessage) => Promise<void>; stopped: boolean }[] = [];
  const dependencies: ChannelDependencies = {
    transport(_channel, _record, state) {
      const socket = { state, receive: async (_message: InboundMessage) => {}, stopped: false }; sockets.push(socket);
      return { async start(receive) { socket.receive = receive; }, stop() { socket.stopped = true; },
        async sendText() { assert.fail('pairing must not send real messages'); }, async sendFile() { assert.fail('pairing cannot deliver files'); } };
    },
    async mount(transport, identity) {
      assert.ok(identity.ownerId); mounts.push(identity.ownerId);
      return { async receive(message) { delivered.push(message); }, async close() { await transport.stop(); } };
    },
    wechatClient() { throw new Error('unexpected WeChat'); },
  };
  return { manager: new ChannelManager(store, dependencies), store, records, sockets, mounts, delivered };
}

test('Feishu pairs from an authenticated private message and only grants access after local confirmation', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  let view = await f.manager.handle('feishu/pair/start', { revision: 0, config });
  assert.equal(view.feishuPairing?.phase, 'connecting'); assert.equal(view.feishuPairing?.code, undefined);
  assert.equal(f.mounts.length, 0); assert.equal((await f.store.read('feishu'))?.enabled, false);
  assert.equal(JSON.stringify(view).includes(config.secret), false);
  await assert.rejects(f.manager.handle('connect', { channel: 'feishu', revision: 1 }), /missing_credentials/);
  f.sockets[0]!.state({ phase: 'connected' }); view = await f.manager.view();
  const pairing = view.feishuPairing!, code = pairing.code!; assert.ok(isFeishuPairingCode(code));
  assert.equal(view.connections[1]?.phase, 'disconnected', 'pairing is not a ready task connection');
  for (const item of [message('run a task'), message('允许'), message(code, 'ou_stranger', 'group'), message('DSH-wrong')]) await f.sockets[0]!.receive(item);
  assert.equal((await f.manager.view()).feishuPairing?.phase, 'waiting'); assert.equal(f.delivered.length, 0);
  await f.sockets[0]!.receive(message(code));
  await f.sockets[0]!.receive(message(code, 'ou_other'));
  assert.equal((await f.manager.view()).feishuPairing?.candidateOpenId, 'ou_owner');
  assert.equal((await f.store.read('feishu'))?.ownerId, '');
  await assert.rejects(f.manager.handle('feishu/pair/confirm', { id: 'old-pair', revision: pairing.revision }), /configuration_changed/);
  view = await f.manager.handle('feishu/pair/confirm', { id: pairing.id, revision: pairing.revision, ownerId: 'ou_injected' });
  assert.equal(view.feishuPairing, undefined); assert.deepEqual(f.mounts, ['ou_owner']);
  assert.equal(view.connections[1]?.phase, 'connecting'); assert.ok(f.sockets[0]!.stopped);
  const saved = (await f.store.read('feishu'))!; assert.equal(saved.ownerId, 'ou_owner'); assert.equal(saved.enabled, true);
  assert.equal(JSON.stringify([...f.records.values]).includes(code), false);
  await f.sockets[1]!.receive(message(code)); assert.equal(f.delivered.length, 0, 'pairing redelivery is not a task');
  await f.sockets[1]!.receive(message('hello')); assert.equal(f.delivered.length, 1);
  await f.manager.close();
  const restarted = fixture(f.records); t.after(() => restarted.manager.close()); await restarted.manager.restore();
  assert.deepEqual(restarted.mounts, ['ou_owner']); assert.equal((await restarted.manager.view()).feishuPairing, undefined);
  await restarted.sockets[0]!.receive(message(code)); assert.equal(restarted.delivered.length, 0, 'pairing control code stays excluded after restart');
});

test('cancelled pairing and old callbacks cannot bind an owner; re-pair preserves workspace and the paused prior owner', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  const saved = await f.store.save('feishu', 0, { ...config, ownerId: 'ou_previous' }, true);
  await f.store.setWorkspace('feishu', saved.revision, join(tmpdir(), 'nexus-fixture-workspace')); await f.manager.restore();
  let view = await f.manager.handle('feishu/pair/start', { revision: 2, config: { accountId: config.accountId } });
  assert.ok(f.sockets[0]!.stopped); assert.equal((await f.store.read('feishu'))?.ownerId, 'ou_previous');
  const first = view.feishuPairing!; f.sockets[1]!.state({ phase: 'connected' });
  const code = (await f.manager.view()).feishuPairing!.code!;
  await f.manager.handle('feishu/pair/cancel', { id: first.id, revision: first.revision });
  await f.sockets[1]!.receive(message(code)); f.sockets[1]!.state({ phase: 'connected' });
  assert.equal((await f.manager.view()).feishuPairing, undefined); assert.ok(f.sockets[1]!.stopped);
  assert.equal((await f.store.read('feishu'))?.enabled, false); assert.equal((await f.store.read('feishu'))?.workspaceRoot, join(tmpdir(), 'nexus-fixture-workspace'));
  view = await f.manager.handle('feishu/pair/start', { revision: 3, config: { accountId: config.accountId } });
  await assert.rejects(f.manager.handle('feishu/pair/cancel', { id: first.id, revision: first.revision }), /configuration_changed/);
  f.sockets[2]!.state({ phase: 'connected' });
  assert.equal((await f.manager.view()).feishuPairing?.phase, 'waiting');
  await assert.rejects(f.manager.handle('feishu/pair/start', { revision: 4, config: { accountId: 'cli_ffffffffffffffff' } }), /missing_application_credentials/);
  assert.equal((await f.manager.view()).feishuPairing?.id, view.feishuPairing?.id);
  await f.manager.close();
  const restarted = fixture(f.records); t.after(() => restarted.manager.close()); await restarted.manager.restore();
  assert.equal(restarted.sockets.length, 0, 'a restart never resumes an unfinished pairing listener');
});

test('pairing expiry and failed authentication clear the code and stop the temporary transport', async () => {
  const record: ConnectionRecord = { version: 1, revision: 1, enabled: false, accountId: config.accountId, secret: config.secret, ownerId: '' };
  let now = 100, stopped = false, receive!: (message: InboundMessage) => Promise<void>;
  const pair = new FeishuPairing(record, () => now, 1000);
  pair.start({ async start(fn) { receive = fn; }, stop() { stopped = true; }, async sendText() {}, async sendFile() {} });
  pair.state({ phase: 'connected' }); const code = pair.view().code!; now = 1101;
  await receive(message(code)); assert.equal(pair.view().phase, 'expired'); assert.equal(pair.view().code, undefined);
  assert.throws(() => pair.owner(pair.id, 1), /not_ready/); await pair.stopTransport(); assert.ok(stopped);
  const bad = new FeishuPairing(record);
  bad.start({ async start() { throw new Error('do not expose provider secrets'); }, stop() {}, async sendText() {}, async sendFile() {} });
  await until(() => bad.view().phase === 'error', 'authentication failure did not settle');
  assert.equal(bad.view().error, 'connection_failed'); assert.equal(bad.view().code, undefined); bad.cancel();
});

test('cancellation while native credentials commit restores the paused binding without mounting tasks', async t => {
  let release!: () => void, committing = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedRecords extends MemoryRecords {
    override modify(key: string, update: (current: unknown) => Promise<unknown>) {
      return super.modify(key, async current => {
        const next = await update(current);
        if (key === 'feishu' && (next as ConnectionRecord)?.enabled && !committing) { committing = true; await gate; }
        return next;
      });
    }
  }
  const f = fixture(new DelayedRecords()); t.after(() => { release(); return f.manager.close(); });
  await f.manager.handle('feishu/pair/start', { revision: 0, config }); f.sockets[0]!.state({ phase: 'connected' });
  const pair = (await f.manager.view()).feishuPairing!; await f.sockets[0]!.receive(message(pair.code!));
  const confirm = f.manager.handle('feishu/pair/confirm', { id: pair.id, revision: pair.revision });
  await until(() => committing, 'confirmation did not reach native credential write');
  const cancelled = f.manager.handle('feishu/pair/cancel', { id: pair.id, revision: pair.revision }); release();
  await Promise.all([confirm, cancelled]);
  assert.equal(f.mounts.length, 0); assert.equal((await f.store.read('feishu'))?.ownerId, '');
  assert.equal((await f.store.read('feishu'))?.enabled, false); assert.equal((await f.manager.view()).feishuPairing, undefined);
});


test('saving application information without a user is allowed only while disabled, and drafts survive restart', async t => {
  const f = fixture(); t.after(() => f.manager.close());
  await f.manager.handle('save', { channel: 'feishu', revision: 0, connect: false, config: { ...config, ownerId: '' } });
  const view = await f.manager.view(); assert.equal(view.connections[1]?.configured, false); assert.equal(view.connections[1]?.secretConfigured, true);
  await f.manager.handle('save-workspace', { channel: 'feishu', revision: 1, workspaceRoot: join(tmpdir(), 'pairing-workspace') });
  await assert.rejects(f.manager.handle('connect', { channel: 'feishu', revision: 2 }), /missing_credentials/);
  await f.manager.close(); const next = fixture(f.records); t.after(() => next.manager.close()); await next.manager.restore();
  assert.equal(next.sockets.length, 0); assert.equal((await next.store.read('feishu'))?.workspaceRoot, join(tmpdir(), 'pairing-workspace'));
});
