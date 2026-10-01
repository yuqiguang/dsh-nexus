import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelManager } from '../src/channels/manager.js';
import { ConnectionStore } from '../src/channels/store.js';
import type { ConnectionRecord, ConnectionState } from '../src/channels/types.js';
import { WechatClient } from '../src/wechat/client.js';
import { MemoryRecords, until, aborted } from './helpers.js';

const grant = { accountId: 'local-bot', ownerId: 'local-owner', secret: 'local-secret', baseUrl: 'https://ilinkai.weixin.qq.com' };
const confirmed = { status: 'confirmed', bot_token: grant.secret, baseurl: grant.baseUrl,
  ilink_user_id: grant.ownerId, ilink_bot_id: grant.accountId };

function fixture(records = new MemoryRecords(), fetchImpl: typeof fetch = async () => {
  throw new Error('Unexpected network request');
}, beforeStop: () => Promise<void> = async () => {}) {
  const store = new ConnectionStore(records);
  const mounts: { record: ConnectionRecord; state: (state: ConnectionState) => void; stopped: boolean }[] = [];
  let retries = 0;
  const manager = new ChannelManager(store, {
    transport(_channel, record, state) {
      const mount = { record, state, stopped: false };
      mounts.push(mount);
      return { async start() {}, async stop() { mount.stopped = true; await beforeStop(); },
        async sendText() {}, async sendFile() {}, async retryPending() { retries++; } };
    },
    async mount(transport) {
      return { async receive() { assert.fail('connection changes must not submit model work'); },
        async close() { await transport.stop(); }, retryPending: () => transport.retryPending!() };
    },
    wechatClient: () => new WechatClient(undefined, undefined, fetchImpl),
  });
  return { records, store, mounts, manager, retries: () => retries };
}

test('invalid WeChat credentials are cleared and cannot reconnect after restart', async t => {
  const f = fixture();
  t.after(() => f.manager.close());
  await f.store.saveWechat(0, grant);
  await f.manager.restore();
  f.mounts[0]!.state({ phase: 'error', error: 'authentication_failed' });
  await until(async () => (await f.store.read('wechat'))?.invalidated === true, 'invalid grant was not revoked');
  const saved = (await f.store.read('wechat'))!;
  assert.equal(saved.secret, '');
  assert.equal(saved.enabled, false);
  assert.equal(f.mounts[0]!.stopped, true);
  await f.manager.close();
  const restarted = fixture(f.records);
  t.after(() => restarted.manager.close());
  await restarted.manager.restore();
  assert.equal(restarted.mounts.length, 0);
  const view = (await restarted.manager.view()).connections.find(item => item.channel === 'wechat')!;
  assert.equal(view.error, 'authentication_failed');
  assert.equal(view.secretConfigured, false);
  await assert.rejects(restarted.manager.handle('connect', { channel: 'wechat', revision: saved.revision }), /missing_credentials/);
});

test('a delayed authentication failure cannot erase a replacement grant', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stops = 0;
  const f = fixture(undefined, undefined, async () => { if (++stops === 1) await gate; });
  t.after(() => { release(); return f.manager.close(); });
  await f.store.saveWechat(0, grant);
  await f.manager.restore();
  const old = f.mounts[0]!;
  old.state({ phase: 'error', error: 'authentication_failed' });
  await until(() => old.stopped, 'old connection did not stop');
  const replacement = await f.store.saveWechat(1, { ...grant, secret: 'replacement-secret' });
  await f.manager.handle('connect', { channel: 'wechat', revision: replacement.revision });
  f.mounts[1]!.state({ phase: 'connected' });
  release();
  await f.manager.close();
  assert.equal((await f.store.read('wechat'))?.secret, 'replacement-secret');
  assert.equal((await f.store.read('wechat'))?.enabled, true);
  assert.equal((await f.store.read('wechat'))?.invalidated, undefined);
  old.state({ phase: 'error', error: 'authentication_failed' });
  assert.equal((await f.store.read('wechat'))?.secret, 'replacement-secret');
});

test('rescanning pauses the old connection, and cancelling keeps it disabled', async t => {
  let waiting = false;
  const f = fixture(undefined, async (url, init) => {
    if (String(url).includes('get_bot_qrcode')) return Response.json({ qrcode: 'local-qr' });
    waiting = true;
    return aborted(init!.signal!);
  });
  t.after(() => f.manager.close());
  await f.store.saveWechat(0, grant);
  await f.manager.restore();
  await f.manager.handle('qr/start', { revision: 1 });
  await until(() => waiting, 'QR status was not requested');
  assert.equal(f.mounts[0]!.stopped, true);
  assert.equal((await f.store.read('wechat'))?.enabled, false);
  assert.equal((await f.store.read('wechat'))?.revision, 2);
  await f.manager.handle('qr/cancel', {});
  assert.equal((await f.manager.view()).wechatQr, undefined);
  assert.equal((await f.store.read('wechat'))?.enabled, false);
  assert.equal((await f.store.read('wechat'))?.secret, grant.secret);
  assert.equal(f.mounts.length, 1);
});

test('cancelling while a confirmed QR grant is being saved never starts its transport', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let committing = false;
  class DelayedRecords extends MemoryRecords {
    override modify(key: string, update: (current: unknown) => Promise<unknown>) {
      return super.modify(key, async current => {
        const next = await update(current);
        if (key === 'wechat' && (next as ConnectionRecord)?.enabled && !committing) {
          committing = true;
          await gate;
        }
        return next;
      });
    }
  }
  const f = fixture(new DelayedRecords(), async url => Response.json(String(url).includes('get_bot_qrcode')
    ? { qrcode: 'local-qr' } : confirmed));
  t.after(() => { release(); return f.manager.close(); });
  await f.manager.handle('qr/start', { revision: 0 });
  await until(() => committing, 'QR grant did not enter its atomic write');
  const cancellation = f.manager.handle('qr/cancel', {});
  release();
  await cancellation;
  assert.equal(f.mounts.length, 0);
  assert.equal((await f.store.read('wechat'))?.enabled, false);
  assert.equal((await f.manager.view()).wechatQr, undefined);
});

test('delivery retry requires the current enabled connection revision and submits no task', async t => {
  const f = fixture();
  t.after(() => f.manager.close());
  await f.store.saveWechat(0, grant);
  await f.manager.restore();
  await assert.rejects(f.manager.handle('retry-delivery', { channel: 'wechat', revision: 0 }), /configuration_changed/);
  await f.manager.handle('retry-delivery', { channel: 'wechat', revision: 1 });
  assert.equal(f.retries(), 1);
  await f.manager.handle('disconnect', { channel: 'wechat', revision: 1 });
  await assert.rejects(f.manager.handle('retry-delivery', { channel: 'wechat', revision: 2 }), /not_connected/);
  assert.equal(f.retries(), 1);
});
