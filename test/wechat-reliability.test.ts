import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WechatClient } from '../src/wechat/client.js';
import { WechatRequestError } from '../src/wechat/errors.js';
import { DEFAULT_CONTEXT_MAX_AGE_MS, WechatTransport, type WechatTransportOptions } from '../src/wechat/transport.js';
import { MAX_DELIVERY_ATTEMPTS, WechatStateStore, type PendingText } from '../src/wechat/state.js';
import { backoff, type Wait } from '../src/wechat/retry.js';
import { ChannelError, type ConnectionRecord, type ConnectionState } from '../src/channels/types.js';
import { MemoryRecords, until, aborted } from './helpers.js';

const grant: ConnectionRecord = { version: 1, revision: 1, enabled: true, accountId: 'wx-bot', ownerId: 'wx-owner',
  secret: 'local-private-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
const message = (id: string, owner = grant.ownerId, token = 'reply-context') => ({ message_id: id,
  from_user_id: owner, message_type: 1, context_token: token, item_list: [{ type: 1, text_item: { text: '本地测试' } }] });
const immediate: Wait = async (_milliseconds, signal) => { signal.throwIfAborted(); };

function fixture(records = new MemoryRecords(), account = grant, sleep: Wait = immediate, options: WechatTransportOptions = {}) {
  const store = new WechatStateStore(records, account.accountId, account.ownerId);
  const states: ConnectionState[] = [];
  const requests: { path: string; body: any }[] = [];
  const updates: (Response | Error)[] = [];
  let send: (body: any) => Response | Promise<Response> = () => Response.json({ ret: 0 });
  let wake: (() => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ path, body });
    if (path.endsWith('sendmessage')) return send(body);
    assert.ok(path.endsWith('getupdates'));
    let response = updates.shift();
    if (!response && requests.filter(item => item.path.endsWith('getupdates')).length === 1) {
      return Response.json({ msgs: [], get_updates_buf: body.get_updates_buf });
    }
    // A poll with nothing queued waits, like the real long poll, until `feed` queues a response or the transport stops.
    while (!response) {
      await Promise.race([new Promise<void>(resolve => { wake = resolve; }), aborted(init!.signal!)]);
      response = updates.shift();
    }
    if (response instanceof Error) throw response;
    return response;
  };
  const transport = new WechatTransport(account, state => states.push(state), store, fetchImpl, sleep, options);
  return { records, store, transport, states, requests, updates, setSend: (handler: typeof send) => { send = handler; },
    feed: (response: Response | Error) => { updates.push(response); wake?.(); },
    sent: () => requests.filter(item => item.path.endsWith('sendmessage')).map(item => item.body.msg) };
}

test('WeChat transient sends retry a fixed wire payload and never retry invalid credentials', async () => {
  const ids: string[] = [];
  const waits: number[] = [];
  const status = [503, 429, 200];
  const client = new WechatClient(undefined, grant.secret, async (_input, init) => {
    ids.push(JSON.parse(String(init?.body)).msg.client_id);
    return Response.json({ ret: 0 }, { status: status.shift()! });
  }, async milliseconds => { waits.push(milliseconds); });
  await client.sendText(grant.ownerId, 'context', 'hello', 'fixed-id', new AbortController().signal);
  assert.deepEqual(ids, ['nexus:fixed-id', 'nexus:fixed-id', 'nexus:fixed-id']);
  assert.deepEqual(waits, [400, 1200]);
  let calls = 0;
  const expired = new WechatClient(undefined, grant.secret, async () => {
    calls++; return Response.json({ errmsg: grant.secret }, { status: 401 });
  }, async () => assert.fail('authentication errors must not retry'));
  await assert.rejects(expired.sendText(grant.ownerId, 'context', 'hello', 'fixed-id', new AbortController().signal), /authentication_failed/);
  assert.equal(calls, 1);
});

test('poll failures back off to 60 seconds and successful receipt clears retry state', async t => {
  const waits: number[] = [];
  const f = fixture(undefined, undefined, async (milliseconds, signal) => { signal.throwIfAborted(); waits.push(milliseconds); });
  t.after(() => f.transport.stop());
  f.updates.push(...Array.from({ length: 8 }, () => Response.json({}, { status: 503 })),
    Response.json({ msgs: [message('backoff-message')], get_updates_buf: 'healthy-cursor' }));
  await f.transport.start(async () => {});
  await until(async () => (await f.store.read()).cursor === 'healthy-cursor', 'poll did not recover');
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  assert.equal(f.states.at(-1)?.phase, 'connected');
  assert.equal(f.states.at(-1)?.retryAfterMs, undefined);
  assert.equal(backoff(100), 60_000);
});

test('startup uses the first successful receive response without requiring typing configuration', async t => {
  const store = new WechatStateStore(new MemoryRecords(), grant.accountId, grant.ownerId);
  const paths: string[] = [];
  const states: ConnectionState[] = [];
  const received: string[] = [];
  const transport = new WechatTransport(grant, state => states.push(state), store, async (input, init) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith('getconfig')) return Response.json({ ret: -2 });
    assert.ok(path.endsWith('getupdates'));
    return paths.filter(item => item.endsWith('getupdates')).length === 1
      ? Response.json({ msgs: [message('first-message')], get_updates_buf: 'first-cursor' }) : aborted(init!.signal!);
  }, immediate);
  t.after(() => transport.stop());
  await transport.start(async incoming => { received.push(incoming.messageId); });
  await until(async () => (await store.read()).cursor === 'first-cursor', 'startup was blocked by an optional typing request');
  assert.deepEqual(received, ['first-message']);
  assert.equal(states.at(-1)?.phase, 'connected');
  assert.ok(paths.every(path => !path.endsWith('getconfig')));
});

test('large numeric WeChat message IDs retain their exact JSON digits', async () => {
  const client = new WechatClient(undefined, grant.secret, async () => new Response(
    '{"ret":0,"msgs":[{"message_id":9223372036854775806},{"message_id":9223372036854775807}]}',
    { headers: { 'Content-Type': 'application/json' } }));
  const updates = await client.updates('', new AbortController().signal);
  assert.deepEqual(updates?.msgs?.map(item => item.message_id), ['9223372036854775806', '9223372036854775807']);
});

test('large numeric WeChat message IDs admit distinct tasks and deduplicate them after restart', async t => {
  const ids = ['9223372036854775806', '9223372036854775807'];
  const batch = (cursor: string) => {
    // Emit actual JSON numbers; Response.json would already round these IDs in the fixture.
    let body = JSON.stringify({ msgs: ids.map(id => message(id)), get_updates_buf: cursor });
    for (const id of ids) body = body.replace(`"message_id":"${id}"`, `"message_id":${id}`);
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  };
  const admitted: string[] = [];
  const f = fixture();
  t.after(() => f.transport.stop());
  f.updates.push(batch('large-id-cursor'));
  await f.transport.start(async incoming => { admitted.push(incoming.messageId); });
  await until(async () => (await f.store.read()).cursor === 'large-id-cursor', 'numeric ID batch was not processed');
  assert.deepEqual(admitted, ids, 'valid messages must not be dropped or merged after numeric rounding');
  assert.deepEqual((await f.store.read()).received, ids);
  await f.transport.stop();
  const restarted = fixture(f.records);
  t.after(() => restarted.transport.stop());
  restarted.updates.push(batch('large-id-replayed'));
  await restarted.transport.start(async incoming => { admitted.push(incoming.messageId); });
  await until(async () => (await restarted.store.read()).cursor === 'large-id-replayed', 'replayed ID batch was not processed');
  assert.deepEqual(admitted, ids, 'replayed messages must not create new tasks');
});

test('poll API rejection reconnects with the same cursor instead of permanently stopping', async t => {
  const waits: number[] = [];
  const f = fixture(undefined, undefined, async (milliseconds, signal) => { signal.throwIfAborted(); waits.push(milliseconds); });
  t.after(() => f.transport.stop());
  await f.store.advanceCursor('saved-cursor');
  f.updates.push(Response.json({ ret: -1, errmsg: 'temporary fixture refusal' }),
    Response.json({ msgs: [message('recovered-message')], get_updates_buf: 'recovered-cursor' }));
  await f.transport.start(async () => {});
  await until(async () => (await f.store.read()).cursor === 'recovered-cursor', 'a single API rejection permanently stopped polling');
  assert.deepEqual(waits, [1000]);
  assert.deepEqual(f.requests.filter(item => item.path.endsWith('getupdates')).slice(0, 2).map(item => item.body.get_updates_buf),
    ['saved-cursor', 'saved-cursor']);
  assert.ok(f.states.some(state => state.phase === 'reconnecting'));
  assert.equal(f.states.at(-1)?.phase, 'connected');
});

test('a receive timeout cannot falsely authenticate a new connection', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  f.updates.push(Object.assign(new Error('local timeout'), { name: 'TimeoutError' }));
  await f.transport.start(async () => assert.fail('timeout must not admit a message'));
  await until(() => f.requests.filter(item => item.path.endsWith('getupdates')).length === 2, 'polling did not continue after timeout');
  assert.ok(f.states.every(state => state.phase !== 'connected'));
  assert.equal((await f.store.read()).cursor, '');
});

test('authentication rejection stops before reporting connected or sending queued replies', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  await f.store.rememberContext('old-context');
  await f.store.enqueue('held-result', 'do not send with invalid credentials');
  f.updates.push(Response.json({ ret: -14 }));
  await f.transport.start(async () => assert.fail('invalid credentials must not admit a message'));
  await until(() => f.states.at(-1)?.error === 'authentication_failed', 'authentication rejection was not surfaced');
  assert.ok(f.states.every(state => state.phase !== 'connected'));
  assert.equal(f.sent().length, 0);
  assert.equal((await f.store.read()).pending.length, 1);
});

test('a 403 from iLink is a poller conflict: polling stops, credentials are kept, and the page gets the reason', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  await f.store.rememberContext('old-context');
  await f.store.enqueue('held-result', 'do not send while another poller holds the account');
  f.updates.push(new Response('forbidden', { status: 403 }));
  await f.transport.start(async () => assert.fail('a conflicting poller must not admit a message'));
  await until(() => f.states.at(-1)?.phase === 'error', 'the conflict was not surfaced');
  assert.equal(f.states.at(-1)?.error, 'wechat_poller_conflict');
  assert.ok(f.states.every(state => state.error !== 'authentication_failed'), 'a conflict must not invalidate the grant');
  assert.ok(f.states.every(state => state.phase !== 'connected'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.requests.filter(item => item.path.endsWith('getupdates')).length, 1, 'no retry after a conflict');
  assert.equal(f.sent().length, 0);
  assert.equal((await f.store.read()).pending.length, 1);
});

test('cursor acknowledges admission, and owner-scoped context and receipts survive restart', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  f.updates.push(Response.json({ msgs: [message('stranger', 'other-owner', 'foreign-context'), message('message-1')], get_updates_buf: 'cursor-1' }));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let received = 0;
  await f.transport.start(async () => { received++; await gate; });
  await until(() => received === 1, 'owner message was not admitted');
  assert.equal((await f.store.read()).cursor, '');
  assert.equal((await f.store.read()).contextToken, 'reply-context');
  release();
  await until(async () => (await f.store.read()).cursor === 'cursor-1', 'cursor was not saved');
  await f.transport.stop();
  const restarted = fixture(f.records);
  t.after(() => restarted.transport.stop());
  restarted.updates.push(Response.json({ msgs: [message('message-1')], get_updates_buf: 'cursor-2' }));
  await restarted.transport.start(async () => { received++; });
  await until(async () => (await restarted.store.read()).cursor === 'cursor-2', 'restart cursor was not saved');
  assert.equal(restarted.requests.find(item => item.path.endsWith('getupdates'))?.body.get_updates_buf, 'cursor-1');
  assert.equal(received, 1);
  await restarted.transport.sendText(grant.ownerId, '重启后的回复', 'restored-context', { durable: true });
  await until(async () => (await restarted.store.read()).pending.length === 0, 'reply was not sent');
  assert.equal(restarted.sent()[0].context_token, 'reply-context');
  await assert.rejects(restarted.transport.sendText('other-owner', 'must not send', 'wrong-owner', { durable: true }), /invalid_recipient/);
});

test('failed native admission leaves the cursor and receipt available for retry', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(undefined, undefined, async () => gate);
  t.after(() => { release(); return f.transport.stop(); });
  const batch = () => Response.json({ msgs: [message('admission-message')], get_updates_buf: 'admitted' });
  f.updates.push(batch(), batch());
  let calls = 0;
  await f.transport.start(async () => { if (++calls === 1) throw new ChannelError('channel_prompt_admission_failed'); });
  await until(() => f.states.at(-1)?.phase === 'reconnecting', 'admission error was not surfaced');
  assert.equal((await f.store.read()).cursor, '');
  assert.deepEqual((await f.store.read()).received, []);
  release();
  await until(async () => (await f.store.read()).cursor === 'admitted', 'admission did not recover');
  assert.equal(calls, 2);
});

test('disconnect during admission cannot acknowledge an unfinished receive', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  f.updates.push(Response.json({ msgs: [message('disconnect-message')], get_updates_buf: 'must-not-advance' }));
  await f.transport.start(async () => { entered = true; await gate; });
  try {
    await until(() => entered, 'receive was not entered');
    const stopping = f.transport.stop();
    release();
    await stopping;
    assert.equal((await f.store.read()).cursor, '');
    assert.deepEqual((await f.store.read()).received, []);
  } finally { release(); await f.transport.stop(); }
});

test('a partially delivered result resumes its remaining exact parts without admitting another task', async t => {
  const f = fixture(undefined, undefined, async (milliseconds, signal) => {
    if (milliseconds === 1000) await aborted(signal);
  });
  t.after(() => f.transport.stop());
  await f.store.rememberContext('durable-context');
  let sent = 0;
  f.setSend(() => ++sent === 1 ? Response.json({ ret: 0 }) : Response.json({}, { status: 503 }));
  await f.transport.sendText(grant.ownerId, '文'.repeat(1700), 'long-result', { durable: true });
  let tasks = 0;
  await f.transport.start(async () => { tasks++; });
  await until(async () => (await f.store.read()).pending[0]?.attempts === 1, 'send failure was not persisted');
  const pending = (await f.store.read()).pending[0]!;
  assert.equal((pending as PendingText).nextPart, 1);
  assert.equal(f.sent().length, 4);
  assert.equal(new Set(f.sent().slice(1).map(item => item.client_id)).size, 1);
  await f.transport.stop();
  const restarted = fixture(f.records);
  t.after(() => restarted.transport.stop());
  await restarted.transport.start(async () => { tasks++; });
  await until(async () => (await restarted.store.read()).pending.length === 0, 'pending parts were not recovered');
  assert.equal(restarted.sent().length, 2);
  assert.equal(restarted.sent()[0].client_id, f.sent()[1].client_id);
  assert.equal(restarted.sent()[0].item_list[0].text_item.text, f.sent()[1].item_list[0].text_item.text);
  assert.ok(restarted.sent().every(item => item.client_id !== f.sent()[0].client_id));
  assert.equal(tasks, 0);
  await restarted.transport.sendText(grant.ownerId, '文'.repeat(1700), 'long-result', { durable: true });
  assert.equal(restarted.sent().length, 2);
});

test('interactive approval prompts are never stored for later replay', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  await f.store.rememberContext('context');
  f.setSend(() => Response.json({}, { status: 503 }));
  await assert.rejects(f.transport.sendText(grant.ownerId, '审批 /approve abc', 'live-approval'), /server_unavailable/);
  assert.deepEqual((await f.store.read()).pending, []);
});

test('send rejection pauses delivery and requires a new owner message instead of manual retries', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  await f.store.rememberContext('context');
  f.setSend(() => Response.json({}, { status: 400 }));
  await f.transport.sendText(grant.ownerId, 'pending result', 'permanent-result', { durable: true });
  await f.transport.start(async () => {});
  await until(async () => (await f.store.read()).pending[0]?.attempts === MAX_DELIVERY_ATTEMPTS, 'permanent failure did not pause');
  assert.equal(f.sent().length, 1);
  assert.equal(f.states.at(-1)?.pendingDeliveries, 1);
  f.setSend(() => Response.json({ ret: 0 }));
  await assert.rejects(f.transport.retryPending(), /wechat_send_rejected/);
  f.feed(Response.json({ msgs: [message('resume-after-refusal')], get_updates_buf: 'fresh' }));
  await until(async () => (await f.store.read()).pending.length === 0, 'new owner message did not drain the result');
  assert.equal(f.sent().length, 2);
  assert.equal(f.sent()[0].client_id, f.sent()[1].client_id);
});

test('delivery records isolate owners and accounts and never silently discard an overflowing queue', async () => {
  const records = new MemoryRecords();
  const own = new WechatStateStore(records, 'bot', 'owner');
  await Promise.all([own.rememberContext('private-context'), own.advanceCursor('cursor'),
    ...Array.from({ length: 50 }, (_, i) => own.enqueue(`result-${i}`, `text ${i}`))]);
  await assert.rejects(own.enqueue('overflow', 'must remain in the native session'), /delivery_queue_full/);
  assert.equal((await own.read()).pending.length, 50);
  assert.equal((await own.read()).contextToken, 'private-context');
  assert.equal((await own.read()).cursor, 'cursor');
  for (const store of [new WechatStateStore(records, 'bot', 'another-owner'), new WechatStateStore(records, 'another-bot', 'owner')]) {
    assert.equal((await store.read()).contextToken, undefined);
    assert.deepEqual((await store.read()).pending, []);
  }
});

test('a reply context older than the verified age holds proactive sends until the next inbound message', async t => {
  let clock = 1_000_000;
  const records = new MemoryRecords();
  const first = fixture(records, grant, immediate, { now: () => clock });
  t.after(() => first.transport.stop());
  first.updates.push(Response.json({ msgs: [message('m1', grant.ownerId, 'token-1')], get_updates_buf: 'c1' }));
  await first.transport.start(async () => {});
  await until(() => first.requests.length >= 2, 'poll did not run');
  assert.equal((await first.store.read()).contextAt, clock);
  clock += DEFAULT_CONTEXT_MAX_AGE_MS + 60_000;
  await first.transport.sendText(grant.ownerId, '重启后的汇报', 'notice-1', { durable: true });
  await until(() => first.states.some(state => state.deliveryError === 'wechat_context_stale'), 'stale context not reported');
  assert.equal(first.sent().length, 0, 'a stale token must not be used');
  assert.equal((await first.store.read()).pending.length, 1);
  await assert.rejects(first.transport.sendText(grant.ownerId, '交互提示', 'prompt-1'), /wechat_context_stale/);
  // The owner writes again: the fresh token releases the held text with its original id.
  first.feed(Response.json({ msgs: [message('m2', grant.ownerId, 'token-2')], get_updates_buf: 'c2' }));
  await until(() => first.sent().length === 1, 'held delivery did not flush after a fresh token');
  assert.equal(first.sent()[0].context_token, 'token-2');
  assert.match(first.sent()[0].client_id, /^nexus:/);
  await until(async () => (await first.store.read()).pending.length === 0, 'delivery not recorded');
  assert.equal(first.states.at(-1)?.deliveryError, undefined);
});

test('a reply context recorded before ages were kept is still used, and a fresh one within the limit is used at once', async t => {
  const records = new MemoryRecords();
  await fixture(records).store.rememberContext('legacy');
  const legacyKey = [...records.values.keys()][0]!;
  await records.modify(legacyKey, async raw => { const state = raw as { contextAt?: number }; delete state.contextAt; return state; });
  const legacy = fixture(records, grant, immediate, { now: () => 5_000_000_000 });
  t.after(() => legacy.transport.stop());
  legacy.updates.push(Response.json({ msgs: [], get_updates_buf: 'c1' }));
  await legacy.transport.start(async () => {});
  await until(() => legacy.states.some(state => state.phase === 'connected'), 'not connected');
  await legacy.transport.sendText(grant.ownerId, '旧记录', 'legacy-1', { durable: true });
  await until(() => legacy.sent().length === 1, 'legacy token was not used');
  assert.equal(legacy.sent()[0].context_token, 'legacy');
});

test('WeChat rejection preserves only numeric diagnostics and distinguishes send refusal from authentication and polling', async () => {
  for (const sample of [
    { status: 200, value: { ret: '-54321', errcode: -54322, errmsg: 'private-token https://private.example/?token=secret' }, code: 'wechat_send_rejected' },
    { status: 403, value: { errcode: -54322 }, code: 'wechat_send_rejected' },
    { status: 401, value: {}, code: 'authentication_failed' },
    { status: 200, value: { ret: '-14' }, code: 'authentication_failed' },
  ]) {
    const client = new WechatClient(undefined, grant.secret, async () => Response.json(sample.value, { status: sample.status }));
    await assert.rejects(client.sendText(grant.ownerId, 'private-context', 'private-text', 'id', new AbortController().signal), error => {
      assert.ok(error instanceof WechatRequestError);
      assert.equal(error.code, sample.code);
      assert.equal(error.diagnostic?.httpStatus, sample.status);
      assert.equal(error.diagnostic?.operation, 'send');
      if (sample.value.errcode) assert.equal(error.diagnostic?.errcode, -54322);
      assert.doesNotMatch(JSON.stringify(error), /private|secret|https/);
      return true;
    });
  }
});

test('send refusal pauses the whole outbox across restart and a new owner message with the same token restores only unsent parts', async t => {
  const f = fixture(); t.after(() => f.transport.stop());
  await f.store.rememberContext('same-token', Date.now(), 'old');
  f.setSend(() => f.sent().length === 1 ? Response.json({ ret: 0 }) : Response.json({ ret: -54321 }));
  await f.transport.start(async () => assert.fail('no task should run'));
  await f.transport.sendText(grant.ownerId, '文'.repeat(1700), 'long-result', { durable: true });
  await until(async () => !!(await f.store.read()).replyWait, 'refusal did not hold the reply allowance');
  const before = await f.store.read();
  assert.equal((before.pending[0] as PendingText).nextPart, 1);
  assert.equal(before.replyWait?.diagnostic?.ret, -54321);
  await f.transport.sendText(grant.ownerId, 'following result', 'after', { durable: true });
  await assert.rejects(f.transport.sendText(grant.ownerId, 'interactive approval', 'prompt'), /wechat_send_rejected/);
  await assert.rejects(f.transport.retryPending(), /wechat_send_rejected/);
  assert.equal(f.sent().length, 2, 'no later item or approval should spend another API request');
  await f.transport.stop();
  const restored = fixture(f.records); t.after(() => restored.transport.stop());
  const admitted: string[] = [];
  await restored.transport.start(async incoming => { admitted.push(incoming.messageId); });
  await until(() => restored.requests.filter(r => r.path.endsWith('getupdates')).length >= 2, 'restored polling');
  assert.equal(restored.sent().length, 0, 'authentication and process restart must not reset the hold');
  restored.feed(Response.json({ msgs: [message('foreign', 'stranger', 'same-token')], get_updates_buf: 'foreign' }));
  await until(async () => (await restored.store.read()).cursor === 'foreign', 'foreign update');
  assert.equal(restored.sent().length, 0);
  restored.feed(Response.json({ msgs: [message('new-owner-message', grant.ownerId, 'same-token')], get_updates_buf: 'new' }));
  await until(async () => (await restored.store.read()).pending.length === 0, 'new message did not resume delivery');
  assert.deepEqual(admitted, ['new-owner-message']);
  assert.equal(restored.sent().length, 3);
  assert.equal(restored.sent()[0].client_id, f.sent()[1].client_id, 'resume the failed wire part with its original client id');
  assert.ok(restored.sent().every(sent => sent.client_id !== f.sent()[0].client_id));
  assert.ok(restored.sent().every(sent => !sent.item_list[0].text_item.text.includes('interactive approval')));
  assert.equal((await restored.store.read()).replyWait, undefined);
});

test('duplicate inbound messages and delayed rejections cannot reset or consume a newer reply allowance', async t => {
  const f = fixture(); t.after(() => f.transport.stop());
  await f.store.rememberContext('same', Date.now(), 'old');
  let release!: (value: Response) => void;
  f.setSend(() => new Promise(resolve => { release = resolve; }));
  const old = assert.rejects(f.transport.sendText(grant.ownerId, 'old', 'old'), /wechat_send_rejected/);
  await until(() => !!release, 'old request');
  await f.store.rememberContext('same', Date.now(), 'new');
  release(Response.json({ ret: -54321 }));
  await old;
  assert.equal((await f.store.read()).replyWait, undefined, 'old failure must not block a newer owner message');
  const revision = (await f.store.read()).contextRevision!;
  await f.store.waitForReply(revision);
  await f.store.rememberContext('same', Date.now(), 'new');
  assert.equal((await f.store.read()).replyWait?.contextRevision, revision, 'replayed message cannot refill allowance');
  await f.store.rememberContext('same', Date.now(), 'newer');
  assert.equal((await f.store.read()).replyWait, undefined);
});

test('receipt batches keep every result and source id, never rewrite sealed or partial wire messages, and survive restart', async () => {
  const records = new MemoryRecords();
  const store = new WechatStateStore(records, 'bot', 'owner');
  await store.enqueue('receipt-1', 'first allowed', 'session-a');
  await store.enqueue('receipt-2', 'second denied', 'session-a');
  const sealed = await store.seal('receipt-1') as PendingText;
  assert.deepEqual(sealed.sourceIds, ['receipt-1', 'receipt-2']);
  assert.equal(sealed.parts[0]!.text, 'first allowed\n\nsecond denied');
  await store.failed(sealed.id, 'wechat_send_rejected', false);
  await store.enqueue('receipt-3', 'third allowed', 'session-a');
  await store.enqueue('receipt-4', 'fourth denied', 'session-b');
  await store.enqueue('result', 'complete task result');
  assert.deepEqual(((await store.read()).pending[0] as PendingText).parts, sealed.parts);
  assert.equal((await store.read()).pending.length, 4);
  const reopened = new WechatStateStore(records, 'bot', 'owner');
  await reopened.sent(sealed.id, sealed.parts[0]!.id);
  await reopened.enqueue('receipt-2', 'duplicate must not appear', 'session-a');
  assert.equal((await reopened.read()).pending.length, 3);
  assert.deepEqual((await reopened.read()).delivered, ['receipt-1', 'receipt-2']);
  assert.equal((await reopened.read()).pending[2]!.id, 'result');
});

test('cancelling a live prompt stops remaining parts without persisting an approval for recovery', async t => {
  const f = fixture(); t.after(() => f.transport.stop());
  await f.store.rememberContext('context');
  const controller = new AbortController();
  f.setSend(() => { controller.abort(); return Response.json({ ret: 0 }); });
  await assert.rejects(f.transport.sendText(grant.ownerId, 'approval'.repeat(300), 'prompt', { signal: controller.signal }));
  assert.equal(f.sent().length, 1);
  assert.deepEqual((await f.store.read()).pending, []);
  assert.equal((await f.store.read()).replyWait, undefined);
});

test('all reply-state transitions satisfy the native credential JSON round-trip contract', async () => {
  const memory = new MemoryRecords();
  const store = new WechatStateStore({
    read: key => memory.read(key),
    modify: (key, update) => memory.modify(key, async current => {
      const next = await update(current);
      assert.deepEqual(next, JSON.parse(JSON.stringify(next)), 'native credentials reject undefined payload fields');
      return next;
    }),
  }, 'bot', 'owner');
  await store.rememberContext('context', Date.now(), 'one');
  await store.enqueue('receipt', 'allowed', 'session');
  await store.seal('receipt');
  await store.failed('receipt', 'connection_failed', true);
  await store.waitForReply(1);
  await store.rememberContext('context', Date.now(), 'two');
  await store.waitForReply(2, { operation: 'send', httpStatus: 200, ret: -54321 });
  await store.rememberContext('context', Date.now(), 'three');
  await store.retry();
  const item = (await store.read()).pending[0] as PendingText;
  await store.sent(item.id, item.parts[0]!.id);
});
