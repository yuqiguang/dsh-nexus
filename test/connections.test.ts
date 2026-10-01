import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { TextMessage } from '@wecom/aibot-node-sdk';
import { ChannelManager, type ChannelDependencies } from '../src/channels/manager.js';
import { ConnectionStore, connectionInput, wechatBaseUrl } from '../src/channels/store.js';
import { DshRecords, type Credentials } from '../src/dsh/records.js';
import type { ChannelId, ConnectionState } from '../src/channels/types.js';
import { sessionIdFor } from '../src/channels/protocol.js';
import { WechatClient } from '../src/wechat/client.js';
import { normalizeWechat } from '../src/wechat/transport.js';
import { formerWechatBases } from '../src/wechat/state.js';
import { normalizeWecom } from '../src/wecom/transport.js';

export class MemoryCredentials implements Credentials {
  records = new Map<CredentialKey, CredentialRecord>();
  private queue: Promise<unknown> = Promise.resolve();
  async readRecord(key: CredentialKey) { return structuredClone(this.records.get(key)); }
  async listRecords() { return [...this.records].map(([key, record]) => ({ key, kind: record.kind })); }
  async modifyRecord(key: CredentialKey, update: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
    const next = this.queue.catch(() => {}).then(async () => {
      const value = await update(await this.readRecord(key));
      if (value) this.records.set(key, structuredClone(value));
      return this.readRecord(key);
    });
    this.queue = next;
    return next;
  }
}

const config = { accountId: 'cli_0123456789abcdef', ownerId: 'ou_owner', secret: 'never-return-this-fixture-secret' };
const mounted: { channel: ChannelId; workspaceRoot?: string }[] = [];
function fixture(credentials = new MemoryCredentials(), fetchImpl: typeof fetch = async () => { throw new Error('Unexpected network request'); }) {
  const started: ChannelId[] = [];
  const stopped: ChannelId[] = [];
  const callbacks: ((state: ConnectionState) => void)[] = [];
  const dependencies: ChannelDependencies = {
    transport(channel, _record, state) {
      callbacks.push(state);
      return { async start() { started.push(channel); }, stop() { stopped.push(channel); }, async sendText() {}, async sendFile() {} };
    },
    async mount(_transport, identity, record) {
      mounted.push({ channel: identity.channel, workspaceRoot: record.workspaceRoot });
      return { async receive() {}, async close() { await _transport.stop(); } };
    },
    wechatClient() { return new WechatClient(undefined, undefined, fetchImpl); },
    defaultWorkspace: '/shared/workspace',
  };
  const manager = new ChannelManager(new ConnectionStore(new DshRecords(credentials)), dependencies);
  return { credentials, manager, started, stopped, callbacks };
}
const connection = async (manager: ChannelManager, channel: ChannelId = 'feishu') => (await manager.view()).connections.find(item => item.channel === channel)!;
async function until(predicate: () => Promise<boolean>) {
  for (let count = 0; count < 100; count++) { if (await predicate()) return; await delay(5); }
  assert.fail('fixture condition timed out');
}

test('saving a connection is durable and redacted, and blank secret preserves the stored key', async () => {
  const { manager, credentials, started } = fixture();
  await manager.handle('save', { channel: 'feishu', revision: 0, config, connect: false });
  const first = await connection(manager);
  assert.equal(first.configured, true);
  assert.equal(first.phase, 'disconnected');
  assert.deepEqual(started, []);
  assert.equal(JSON.stringify(await manager.view()).includes(config.secret), false);
  await manager.handle('save', { channel: 'feishu', revision: first.revision, config: { ...config, secret: '' }, connect: false });
  const store = new ConnectionStore(new DshRecords(credentials));
  assert.equal((await store.read('feishu'))?.secret, config.secret);
  await manager.close();
  const restarted = fixture(credentials);
  await restarted.manager.restore();
  assert.equal((await connection(restarted.manager)).ownerId, config.ownerId);
  assert.deepEqual(restarted.started, []);
  await restarted.manager.close();
});

test('stale and invalid writes do not overwrite credentials or connect a channel', async () => {
  const { manager, credentials, started } = fixture();
  await manager.handle('save', { channel: 'feishu', revision: 0, config, connect: false });
  const before = structuredClone([...credentials.records]);
  await assert.rejects(manager.handle('save', { channel: 'feishu', revision: 0,
    config: { ...config, secret: 'must-not-overwrite' }, connect: true }), /configuration_changed/);
  await assert.rejects(manager.handle('save', { channel: 'feishu', revision: 1,
    config: { ...config, ownerId: '' }, connect: true }), /missing_credentials/);
  assert.deepEqual([...credentials.records], before);
  assert.deepEqual(started, []);
  assert.throws(() => connectionInput({ accountId: config.accountId, ownerId: 1 }), /invalid_configuration/);
  await manager.close();
});

test('connection state follows authentication and ignores callbacks after disconnect', async () => {
  const { manager, callbacks, stopped, credentials } = fixture();
  await manager.handle('save', { channel: 'feishu', revision: 0, config, connect: true });
  assert.equal((await connection(manager)).phase, 'connecting');
  callbacks[0]!({ phase: 'connected' });
  assert.equal((await connection(manager)).phase, 'connected');
  await manager.handle('disconnect', { channel: 'feishu', revision: 1 });
  callbacks[0]!({ phase: 'connected' });
  assert.equal((await connection(manager)).phase, 'disconnected');
  assert.deepEqual(stopped, ['feishu']);
  await manager.handle('connect', { channel: 'feishu', revision: 2 });
  // A poller conflict is an error state the user can retry from; unlike an authentication failure it keeps the secret and the enabled flag.
  callbacks.at(-1)!({ phase: 'error', error: 'wechat_poller_conflict' });
  const conflicted = await connection(manager);
  assert.deepEqual([conflicted.phase, conflicted.error, conflicted.enabled, conflicted.secretConfigured], ['error', 'wechat_poller_conflict', true, true]);
  await manager.close();
  const restarted = fixture(credentials);
  await restarted.manager.restore();
  assert.deepEqual(restarted.started, ['feishu']);
  await restarted.manager.close();
});

test('WeChat QR login binds the confirmed owner without returning the token', async () => {
  const token = 'wechat-fixture-token-stays-private';
  const requests: { url: string; init?: RequestInit }[] = [];
  const { manager, started, credentials } = fixture(undefined, async (url, init) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    return Response.json(String(url).includes('get_bot_qrcode') ? { qrcode: 'local-qr-fixture', qrcode_img_content: 'https://weixin.qq.com/local-fixture' }
      : { status: 'confirmed', bot_token: token, baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'wx-owner', ilink_bot_id: 'wx-bot' });
  });
  await manager.handle('qr/start', { revision: 0 });
  await until(async () => (await manager.view()).wechatQr?.phase === 'connected');
  assert.equal((await connection(manager, 'wechat')).ownerId, 'wx-owner');
  assert.equal((await new ConnectionStore(new DshRecords(credentials)).read('wechat'))?.secret, token);
  assert.equal(JSON.stringify(await manager.view()).includes(token), false);
  assert.deepEqual(started, ['wechat']);
  assert.equal(requests[0]!.init?.method, 'POST');
  assert.equal(new Headers(requests[0]!.init?.headers).has('Authorization'), false);
  assert.equal(requests[1]!.init?.method, 'GET');
  await manager.close();
});

test('cancelling QR login ignores a late confirmation and never enables the channel', async () => {
  let confirm!: (response: Response) => void;
  let waiting = false;
  const { manager, started, credentials } = fixture(undefined, async url => {
    if (String(url).includes('get_bot_qrcode')) return Response.json({ qrcode: 'local-qr-fixture' });
    waiting = true;
    return new Promise<Response>(resolve => { confirm = resolve; });
  });
  await manager.handle('qr/start', { revision: 0 });
  await until(async () => waiting);
  const cancelled = manager.handle('qr/cancel', {});
  confirm(Response.json({ status: 'confirmed', bot_token: 'late-token', baseurl: 'https://ilinkai.weixin.qq.com', ilink_user_id: 'owner', ilink_bot_id: 'bot' }));
  await cancelled;
  assert.equal(await new ConnectionStore(new DshRecords(credentials)).read('wechat'), undefined);
  assert.deepEqual(started, []);
  await manager.close();
});

test('WeChat trusts official HTTPS endpoints and sanitizes authentication failures', async () => {
  for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.example', 'https://name:secret@ilinkai.weixin.qq.com', 'https://127.0.0.1']) {
    assert.throws(() => wechatBaseUrl(url), /invalid_wechat_server/);
  }
  const client = new WechatClient(undefined, 'fixture-token', async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
    return Response.json({ ret: -14, errmsg: 'do not return fixture-token' });
  });
  await assert.rejects(client.updates('', new AbortController().signal), error =>
    error instanceof Error && error.message === 'authentication_failed');
  const taken = new WechatClient(undefined, 'fixture-token', async () => new Response('', { status: 403 }));
  await assert.rejects(taken.updates('', new AbortController().signal), error =>
    error instanceof Error && error.message === 'wechat_poller_conflict', 'a 403 is another poller, not an expired token');
});

test('a channel workspace is saved, shown as the directory in effect, and mounted', async () => {
  const { manager, credentials, started } = fixture();
  await manager.handle('save', { channel: 'feishu', revision: 0, config, connect: false });
  // Before anything is set, the shared workspace is what the channel works in — the settings page shows it.
  assert.equal((await connection(manager)).workspaceRoot, '/shared/workspace');
  await assert.rejects(manager.handle('save-workspace', { channel: 'feishu', revision: 1, workspaceRoot: 'relative/path' }), /invalid_workspace/);
  await manager.handle('save-workspace', { channel: 'feishu', revision: 1, workspaceRoot: '/home/you/nexus-feishu/' });
  const moved = await connection(manager);
  assert.equal(moved.workspaceRoot, '/home/you/nexus-feishu', 'a trailing slash names the same directory');
  assert.equal((await new ConnectionStore(new DshRecords(credentials)).read('feishu'))?.workspaceRoot, '/home/you/nexus-feishu');
  // A stale write cannot move the workspace of a connection someone else just changed.
  await assert.rejects(manager.handle('save-workspace', { channel: 'feishu', revision: 1, workspaceRoot: '/home/you/other' }), /configuration_changed/);
  await manager.handle('connect', { channel: 'feishu', revision: moved.revision });
  assert.deepEqual(mounted.at(-1), { channel: 'feishu', workspaceRoot: '/home/you/nexus-feishu' });
  assert.deepEqual(started, ['feishu']);
  // An unset workspace returns the channel to the shared one, and the grant survives a re-scan of it.
  await manager.handle('save-workspace', { channel: 'feishu', revision: moved.revision + 1, workspaceRoot: '' });
  assert.equal((await connection(manager)).workspaceRoot, '/shared/workspace');
  assert.deepEqual(await manager.workspaces(), ['/shared/workspace']);
  await manager.close();
  const restarted = fixture(credentials);
  await restarted.manager.restore();
  assert.deepEqual(await restarted.manager.workspaces(), ['/shared/workspace']);
  await restarted.manager.close();
});

test('new channels normalize only user text and keep their native sessions separate', () => {
  const wechat = { message_id: 1, from_user_id: 'owner', context_token: 'context', message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'hello' } }] };
  assert.equal(normalizeWechat(wechat)?.text, 'hello');
  assert.equal(normalizeWechat({ ...wechat, group_id: 'group' }), undefined);
  assert.equal(normalizeWechat({ ...wechat, message_type: 2 }), undefined);
  assert.equal(normalizeWechat({ ...wechat, message_id: undefined }), undefined);
  const wecom = { msgid: '1', aibotid: 'bot', chattype: 'single', from: { userid: 'owner' }, msgtype: 'text', text: { content: 'hello' } } as TextMessage;
  assert.equal(normalizeWecom(wecom)?.senderId, 'owner');
  assert.equal(normalizeWecom({ ...wecom, chattype: 'group' }), undefined);
  assert.equal(normalizeWecom(undefined), undefined);
  assert.equal(new Set(['wechat', 'feishu', 'wecom'].map(channel => sessionIdFor('app', 'owner', 'chat', channel as ChannelId))).size, 3);
});

test('earlier WeChat bindings of the same person are found from the delivery records each bot account left behind', async () => {
  const credentials = new MemoryCredentials();
  const records = new DshRecords(credentials);
  const state = (accountId: string, ownerId: string) => ({ version: 1, accountId, ownerId, cursor: '', received: [], pending: [], delivered: [] });
  await records.modify('wechat-delivery-a', async () => state('bot-old', 'owner-1'));
  await records.modify('wechat-delivery-b', async () => state('bot-older', 'owner-1'));
  await records.modify('wechat-delivery-c', async () => state('bot-now', 'owner-1'));
  await records.modify('wechat-delivery-d', async () => state('bot-other', 'owner-2'));
  await records.modify('wechat-delivery-e', async () => ({ version: 1 }));
  await records.modify('wechat', async () => ({ version: 1, accountId: 'bot-now', ownerId: 'owner-1' }));
  // Another scope's record with a matching name is not this channel's.
  await new DshRecords(credentials, 'nexus-coders').modify('wechat-delivery-x', async () => state('bot-stray', 'owner-1'));
  assert.deepEqual((await records.list('wechat-delivery-')).map(item => item.key).sort(), ['wechat-delivery-a', 'wechat-delivery-b', 'wechat-delivery-c', 'wechat-delivery-d', 'wechat-delivery-e']);
  assert.deepEqual((await formerWechatBases(records, { accountId: 'bot-now', ownerId: 'owner-1' })).sort(),
    [sessionIdFor('bot-old', 'owner-1', 'owner-1', 'wechat'), sessionIdFor('bot-older', 'owner-1', 'owner-1', 'wechat')].sort());
  // A store that cannot enumerate finds nothing rather than failing the mount.
  assert.deepEqual(await formerWechatBases({ read: records.read.bind(records), modify: records.modify.bind(records) }, { accountId: 'bot-now', ownerId: 'owner-1' }), []);
});
