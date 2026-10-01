import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WechatTransport } from '../src/wechat/transport.js';
import { WechatStateStore, isFileDelivery } from '../src/wechat/state.js';
import { decryptMedia, encryptMedia, parseAesKey } from '../src/wechat/media.js';
import type { Wait } from '../src/wechat/retry.js';
import type { ConnectionRecord, ConnectionState } from '../src/channels/types.js';
import type { InboundMessage } from '../src/channels/protocol.js';
import { MemoryRecords, until, aborted } from './helpers.js';

const grant: ConnectionRecord = { version: 1, revision: 1, enabled: true, accountId: 'wx-media-bot', ownerId: 'wx-media-owner',
  secret: 'local-private-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
const immediate: Wait = async (_milliseconds, signal) => { signal.throwIfAborted(); };
const cdn = 'https://cdn.local.test/c2c';
const key = Buffer.from('0f1e2d3c4b5a69788796a5b4c3d2e1f0', 'hex');

/** Loopback iLink plus CDN: uploads are stored by filekey, downloads served by query parameter. */
function fixture(records = new MemoryRecords(), options: { workspace?: string; cdnFailures?: number } = {}) {
  const store = new WechatStateStore(records, grant.accountId, grant.ownerId);
  const states: ConnectionState[] = [];
  const requests: { path: string; body: any }[] = [];
  const updates: Response[] = [];
  const objects = new Map<string, Buffer>();
  const uploads: { filekey: string; media_type: number; rawsize: number; filesize: number; aeskey: string }[] = [];
  let cdnFailures = options.cdnFailures ?? 0;
  let wake: (() => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === new URL(cdn).origin) {
      if (cdnFailures > 0) { cdnFailures--; return new Response('busy', { status: 503 }); }
      if (url.pathname.endsWith('/upload')) {
        const filekey = url.searchParams.get('filekey')!;
        objects.set(`dl-${filekey}`, Buffer.from(await new Response(init!.body as BodyInit).arrayBuffer()));
        return new Response('', { status: 200, headers: { 'x-encrypted-param': `dl-${filekey}` } });
      }
      const object = objects.get(url.searchParams.get('encrypted_query_param') ?? '');
      return object ? new Response(new Uint8Array(object), { status: 200 }) : new Response('missing', { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith('sendmessage')) return Response.json({ ret: 0 });
    if (url.pathname.endsWith('getuploadurl')) {
      uploads.push(body);
      return Response.json({ ret: 0, upload_param: `up-${body.filekey}` });
    }
    assert.ok(url.pathname.endsWith('getupdates'));
    let response = updates.shift();
    if (!response && requests.filter(item => item.path.endsWith('getupdates')).length === 1) {
      return Response.json({ msgs: [], get_updates_buf: body.get_updates_buf });
    }
    while (!response) {
      await Promise.race([new Promise<void>(resolve => { wake = resolve; }), aborted(init!.signal!)]);
      response = updates.shift();
    }
    return response;
  };
  const transport = new WechatTransport(grant, state => states.push(state), store, fetchImpl, immediate,
    { cdnBaseUrl: cdn, ...(options.workspace ? { workspace: options.workspace } : {}) });
  return { records, store, transport, states, requests, objects, uploads,
    feed: (response: Response) => { updates.push(response); wake?.(); },
    sent: () => requests.filter(item => item.path.endsWith('sendmessage')).map(item => item.body.msg) };
}

const message = (id: string, items: unknown[]) => ({ message_id: id, from_user_id: grant.ownerId, message_type: 1, context_token: 'reply-context', item_list: items });

test('an inbound picture and document are downloaded from the CDN, decrypted, and handed over with the text', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const document = Buffer.from('%PDF-1.4 fixture');
  f.objects.set('pic-param', encryptMedia(picture, key));
  f.objects.set('doc-param', encryptMedia(document, key));
  const received: InboundMessage[] = [];
  f.feed(Response.json({ msgs: [message('m1', [
    { type: 1, text_item: { text: '这是什么' } },
    { type: 2, image_item: { media: { encrypt_query_param: 'pic-param' }, aeskey: key.toString('hex') } },
    { type: 4, file_item: { media: { encrypt_query_param: 'doc-param', aes_key: Buffer.from(key.toString('hex')).toString('base64') }, file_name: '说明.pdf', len: String(document.length) } },
    { type: 5, video_item: { media: { encrypt_query_param: 'v', aes_key: key.toString('base64') } } },
  ])], get_updates_buf: 'c1' }));
  await f.transport.start(async item => { received.push(item); });
  await until(() => received.length === 1, 'media message was not admitted');
  const [item] = received;
  assert.equal(item!.text, '这是什么');
  assert.equal(item!.attachments?.length, 2);
  assert.deepEqual(item!.attachments![0], { kind: 'image', bytes: picture });
  assert.deepEqual(item!.attachments![1], { kind: 'file', name: '说明.pdf', bytes: document });
  assert.deepEqual(item!.dropped, [{ kind: 'video', reason: 'unsupported' }]);
});

test('voice with a server transcript is text marked as transcribed; voice without one is fetched, decrypted, and decoded from SILK to WAV', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  const { encode } = await import('silk-wasm');
  const silk = Buffer.from((await encode(Buffer.alloc(24_000 * 2), 24_000)).data);
  f.objects.set('voice-param', encryptMedia(silk, key));
  f.objects.set('bad-voice', encryptMedia(Buffer.from('not silk at all'), key));
  const received: InboundMessage[] = [];
  f.feed(Response.json({ msgs: [
    message('m3', [{ type: 3, voice_item: { media: { encrypt_query_param: 'x', aes_key: key.toString('base64') }, text: '明天下午三点开会', playtime: 3 } }]),
    message('m4', [{ type: 3, voice_item: { media: { encrypt_query_param: 'voice-param', aes_key: Buffer.from(key.toString('hex')).toString('base64') }, playtime: 1000 } }]),
    message('m5', [{ type: 3, voice_item: { media: { encrypt_query_param: 'bad-voice', aes_key: key.toString('base64') } } }]),
  ], get_updates_buf: 'c1' }));
  await f.transport.start(async item => { received.push(item); });
  await until(() => received.length === 3, 'voice messages were not admitted', 10_000);
  assert.deepEqual([received[0]!.text, received[0]!.transcribed, received[0]!.attachments], ['明天下午三点开会', true, undefined]);
  const clip = received[1]!.attachments![0]!;
  assert.deepEqual([received[1]!.text, received[1]!.transcribed, clip.kind, clip.seconds], ['', undefined, 'voice', 1]);
  assert.equal(clip.bytes.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(clip.bytes.readUInt32LE(24), 24_000, 'WAV sample rate matches the SILK clip');
  assert.ok(clip.bytes.length > 44 + 40_000, `one second of 24 kHz 16-bit audio, got ${clip.bytes.length} bytes`);
  assert.deepEqual(received[2]!.dropped, [{ kind: 'voice', reason: 'decode_failed' }]);
});

test('a picture whose download fails is reported as dropped while the rest of the message still arrives', async t => {
  const f = fixture(undefined, { cdnFailures: 1 });
  t.after(() => f.transport.stop());
  const received: InboundMessage[] = [];
  f.feed(Response.json({ msgs: [message('m2', [
    { type: 1, text_item: { text: '图呢' } },
    { type: 2, image_item: { media: { encrypt_query_param: 'gone' }, aeskey: key.toString('hex') } },
  ])], get_updates_buf: 'c1' }));
  await f.transport.start(async item => { received.push(item); });
  await until(() => received.length === 1, 'message was not admitted');
  assert.equal(received[0]!.text, '图呢');
  assert.equal(received[0]!.attachments, undefined);
  assert.deepEqual(received[0]!.dropped, [{ kind: 'image', reason: 'download_failed' }]);
  assert.ok((await f.store.read()).received.includes('m2'));
});

test('a file the sender declares larger than the limit is refused before any download', async t => {
  const f = fixture();
  t.after(() => f.transport.stop());
  const received: InboundMessage[] = [];
  f.feed(Response.json({ msgs: [message('m3', [
    { type: 4, file_item: { media: { encrypt_query_param: 'huge', aes_key: key.toString('base64') }, file_name: 'big.zip', len: String(30 * 1024 * 1024) } },
  ])], get_updates_buf: 'c1' }));
  await f.transport.start(async item => { received.push(item); });
  await until(() => received.length === 1, 'message was not admitted');
  assert.deepEqual(received[0]!.dropped, [{ kind: 'file', reason: 'too_large' }]);
  assert.equal(f.objects.size, 0);
});

test('a presented file is queued by path, uploaded encrypted when a reply context exists, and survives a restart in the queue', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-wx-out-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bytes = Buffer.from('report,value\n1,2\n');
  await writeFile(join(workspace, 'report.csv'), bytes);
  // No reply context yet: the file waits.
  const first = fixture(undefined, { workspace });
  await first.transport.sendFile(grant.ownerId, { name: 'report.csv', bytes, path: 'report.csv' }, 'file-1');
  const queued = (await first.store.read()).pending;
  assert.equal(queued.length, 1);
  assert.ok(isFileDelivery(queued[0]!));
  assert.equal(first.uploads.length, 0);
  await first.transport.stop();
  // After a restart the first inbound message supplies the context and the queued file goes out.
  const second = fixture(first.records, { workspace });
  t.after(() => second.transport.stop());
  second.feed(Response.json({ msgs: [message('m4', [{ type: 1, text_item: { text: '好了吗' } }])], get_updates_buf: 'c2' }));
  await second.transport.start(async () => {});
  await until(async () => (await second.store.read()).pending.length === 0, 'file was not delivered after restart');
  assert.equal(second.uploads.length, 1);
  assert.equal(second.uploads[0]!.media_type, 3);
  assert.equal(second.uploads[0]!.rawsize, bytes.length);
  const item = second.sent().find(msg => msg.item_list[0].type === 4)!;
  assert.equal(item.client_id, 'nexus:file-1');
  assert.equal(item.context_token, 'reply-context');
  assert.equal(item.item_list[0].file_item.file_name, 'report.csv');
  assert.equal(item.item_list[0].file_item.len, String(bytes.length));
  const stored = second.objects.get(item.item_list[0].file_item.media.encrypt_query_param)!;
  assert.deepEqual(decryptMedia(stored, parseAesKey(item.item_list[0].file_item.media.aes_key)), bytes);
  assert.ok((await second.store.read()).delivered.includes('file-1'));
  // A picture goes out as an image item.
  await writeFile(join(workspace, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await second.transport.sendFile(grant.ownerId, { name: 'chart.png', bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), path: 'chart.png' }, 'file-2');
  await until(async () => (await second.store.read()).delivered.includes('file-2'), 'picture was not delivered');
  assert.equal(second.uploads.at(-1)!.media_type, 1);
  assert.equal(second.sent().at(-1)!.item_list[0].type, 2);
});

test('a queued file that disappeared from the workspace is replaced by a notice under the same delivery id', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-wx-gone-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const f = fixture(undefined, { workspace });
  t.after(() => f.transport.stop());
  await f.transport.sendFile(grant.ownerId, { name: 'draft.txt', bytes: Buffer.from('x'), path: 'draft.txt' }, 'file-3');
  f.feed(Response.json({ msgs: [message('m5', [{ type: 1, text_item: { text: '发我' } }])], get_updates_buf: 'c3' }));
  await f.transport.start(async () => {});
  await until(async () => (await f.store.read()).delivered.includes('file-3'), 'notice was not delivered');
  assert.equal(f.uploads.length, 0);
  const notice = f.sent().find(msg => msg.item_list[0].type === 1)!;
  assert.match(notice.item_list[0].text_item.text, /draft\.txt 已不在工作区/);
});

test('a CDN outage keeps the file in the queue for retry instead of dropping it', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-wx-retry-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(join(workspace, 'a.txt'), 'a');
  const f = fixture(undefined, { workspace, cdnFailures: 1 });
  t.after(() => f.transport.stop());
  await f.transport.sendFile(grant.ownerId, { name: 'a.txt', bytes: Buffer.from('a'), path: 'a.txt' }, 'file-4');
  f.feed(Response.json({ msgs: [message('m6', [{ type: 1, text_item: { text: '来' } }])], get_updates_buf: 'c4' }));
  await f.transport.start(async () => {});
  await until(async () => (await f.store.read()).delivered.includes('file-4'), 'file was not delivered after the retry', 5000);
  assert.equal(f.uploads.length, 2, 'the retry asks for a fresh upload slot');
});
