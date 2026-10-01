/** Real DSH plus real WeChat transport over loopback iLink and CDN: a picture and a document come in, the picture reaches the model as an image, the reply's presented file goes out encrypted; a CDN outage leaves the file queued and a restart sends it exactly once without re-admitting the message. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installBridge } from '../src/dsh/bridge.js';
import { DshRecords } from '../src/dsh/records.js';
import { sessionIdFor } from '../src/channels/protocol.js';
import type { ConnectionRecord, ConnectionState } from '../src/channels/types.js';
import { WechatTransport } from '../src/wechat/transport.js';
import { WechatStateStore, isFileDelivery } from '../src/wechat/state.js';
import { decryptMedia, encryptMedia, parseAesKey } from '../src/wechat/media.js';
import { aborted, until } from './helpers.js';

export const name = 'nexus-media-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'credentials', 'tools', 'sandboxPolicy', 'agents'];
const grant: ConnectionRecord = { version: 1, revision: 1, enabled: true, accountId: 'wx-media-bot', ownerId: 'wx-media-owner',
  secret: 'local-media-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
const owner = { channel: 'wechat' as const, accountId: grant.accountId, ownerId: grant.ownerId };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const cdnOrigin = 'https://cdn.local.test';
const key = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90', 'hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const document = Buffer.from('会议纪要：本地媒体验证。');
const reportPath = 'outputs/summary.txt';
const reportContent = '图片和文件已收到并整理。\n';
const mediaMessageId = '9223372036854775806';

const mediaUpdate = (cursor: string) => ({ get_updates_buf: cursor, msgs: [{ message_id: mediaMessageId, from_user_id: owner.ownerId, message_type: 1,
  context_token: 'local-media-context', item_list: [
    { type: 1, text_item: { text: '整理一下这两份材料' } },
    { type: 2, image_item: { media: { encrypt_query_param: 'inbound-picture' }, aeskey: key.toString('hex') } },
    { type: 4, file_item: { media: { encrypt_query_param: 'inbound-document', aes_key: Buffer.from(key.toString('hex')).toString('base64') }, file_name: '纪要.txt', len: String(document.length) } },
  ] }] });

class FixtureModel extends LlmAdapter {
  calls = 0;
  sawImage = false;
  sawInboxPaths = false;
  constructor(private readonly phase: number) { super(); }
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local media fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048, inputModalities: ['text', 'image'] };
  }
  private *toolCall(id: string, name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
  private *text(text: string): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const step = this.calls++;
    const user = options.messages.filter(message => message.source?.kind === 'user');
    const last = user.at(-1)!;
    this.sawImage = last.content.some(block => block.type === 'image' && typeof (block as { attachment?: { attachmentId?: unknown } }).attachment?.attachmentId === 'string');
    const text = last.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    this.sawInboxPaths = /已保存到 inbox\/\d{4}-\d{2}-\d{2}\/image-\d{6}\.png/.test(text) && /已保存到 inbox\/\d{4}-\d{2}-\d{2}\/纪要\.txt/.test(text);
    if (this.phase === 16) { yield* this.text('重启后的新回复'); return; }
    if (step === 0) { yield* this.toolCall('media-write', 'write', { file_path: reportPath, content: reportContent }); return; }
    if (step === 1) { yield* this.toolCall('media-present', 'present', { files: [{ path: reportPath, description: '整理结果' }] }); return; }
    yield* this.text('两份材料已整理，结果见附件。');
  }
}

/** Loopback iLink and CDN. Uploads are refused with 503 while `cdnDown` is set. */
async function loopback(cdnDown: boolean) {
  const objects = new Map<string, Buffer>([['inbound-picture', encryptMedia(png, key)], ['inbound-document', encryptMedia(document, key)]]);
  const replies: { client_id: string; context_token: string; item_list: Record<string, any>[] }[] = [];
  const uploads: Record<string, unknown>[] = [];
  const queued: unknown[] = [];
  const waiting: ServerResponse[] = [];
  const failures: string[] = [];
  let polls = 0;
  const respond = (response: ServerResponse, value: unknown, status = 200) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://loopback');
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      if (url.pathname.startsWith('/cdn/')) {
        if (url.pathname.endsWith('/download')) {
          const object = objects.get(url.searchParams.get('encrypted_query_param') ?? '');
          if (!object) { response.writeHead(404); response.end(); return; }
          response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(object); return;
        }
        assert.ok(url.pathname.endsWith('/upload'));
        if (cdnDown) { response.writeHead(503); response.end('cdn down'); return; }
        const filekey = url.searchParams.get('filekey')!;
        objects.set(`outbound-${filekey}`, raw);
        response.writeHead(200, { 'x-encrypted-param': `outbound-${filekey}` }); response.end(); return;
      }
      const body = JSON.parse(raw.toString('utf8'));
      if (url.pathname === '/ilink/bot/getuploadurl') { uploads.push(body); return respond(response, { ret: 0, upload_param: `slot-${body.filekey}` }); }
      if (url.pathname === '/ilink/bot/sendmessage') { replies.push(body.msg); return respond(response, { ret: 0 }); }
      assert.equal(url.pathname, '/ilink/bot/getupdates');
      polls++;
      const next = queued.shift();
      if (next) return respond(response, next);
      if (polls === 1) return respond(response, { msgs: [], get_updates_buf: body.get_updates_buf });
      waiting.push(response);
      response.once('close', () => { const index = waiting.indexOf(response); if (index !== -1) waiting.splice(index, 1); });
    })().catch(error => { failures.push(String(error)); if (!response.destroyed) respond(response, {}, 500); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin === cdnOrigin) return fetch(new URL(`/cdn${url.pathname}${url.search}`, origin), init);
    assert.equal(url.origin, 'https://ilinkai.weixin.qq.com');
    return fetch(new URL(url.pathname, origin), init);
  };
  return { objects, replies, uploads, failures, fetchImpl,
    enqueue(update: unknown) { const response = waiting.shift(); if (response) respond(response, update); else queued.push(update); },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel(config.phase);
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  const http = await loopback(config.phase === 15);
  ctx.effect(() => () => http.close());
  const store = new WechatStateStore(new DshRecords(ctx.credentials), owner.accountId, owner.ownerId);
  const states: ConnectionState[] = [];
  const failures: string[] = [];
  const transport = new WechatTransport(grant, state => states.push(state), store, http.fetchImpl,
    async (milliseconds, signal) => {
      signal.throwIfAborted();
      // Phase 15 holds every wait after the first upload attempt so the failed file is observed in the queue, not retried; the message is already admitted by then.
      if (config.phase === 15 && http.uploads.length > 0) await aborted(signal);
    }, { workspace: config.workspace, cdnBaseUrl: `${cdnOrigin}/c2c` });
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent?.session.id === sessionId) setSandboxMode(execution.agent.session, 'workspace-write');
    return next();
  }, { prepend: true });
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true; clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, states, httpFailures: http.failures,
          outbox: await store.read().catch(() => undefined), uploads: http.uploads.length, replies: http.replies.map(reply => reply.item_list[0]!.type) }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    const checks: string[] = [];
    if (config.phase === 15) {
      http.enqueue(mediaUpdate('media-cursor-1'));
      await transport.start(message => bridge.receive(message));
      await until(async () => (await store.read()).received.includes(mediaMessageId), 'media message was not admitted', 15_000);
      const found = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      await found.agent.whenIdle();
      await bridge.drain();
      assert.equal(model.calls, 3, 'write, present, and the final reply');
      assert.equal(model.sawImage, true, 'the picture must reach the model as a durable image attachment');
      assert.equal(model.sawInboxPaths, true, 'both saved paths must be described to the model');
      const inbox = await readdir(join(config.workspace, 'inbox'));
      assert.equal(inbox.length, 1);
      const files = (await readdir(join(config.workspace, 'inbox', inbox[0]!))).sort();
      assert.equal(files.length, 2);
      assert.ok(files.includes('纪要.txt'));
      assert.deepEqual(await readFile(join(config.workspace, 'inbox', inbox[0]!, '纪要.txt')), document);
      assert.deepEqual(await readFile(join(config.workspace, 'inbox', inbox[0]!, files.find(file => file.startsWith('image-'))!)), png);
      assert.equal(await readFile(join(config.workspace, reportPath), 'utf8'), reportContent);
      // The text reply went out; the file is queued with the CDN failure recorded and no notice replaced it.
      await until(async () => (await store.read()).pending.some(item => isFileDelivery(item) && item.attempts === 1), 'file upload failure was not recorded', 15_000);
      const saved = await store.read();
      assert.equal(saved.pending.length, 1);
      assert.equal(saved.pending[0]!.error, 'server_unavailable');
      assert.ok(http.replies.some(reply => reply.item_list[0]!.type === 1 && reply.item_list[0]!.text_item.text === '两份材料已整理，结果见附件。'));
      assert.ok(http.replies.every(reply => reply.item_list[0]!.type === 1), 'no file message may be sent while the CDN refuses uploads');
      await until(() => states.at(-1)?.deliveryError === 'server_unavailable' && states.at(-1)?.pendingDeliveries === 1, 'settings state did not show the held file', 5000);
      await bridge.close();
      checks.push('wechat_inbound_picture_decrypted_to_inbox', 'wechat_inbound_document_decrypted_to_inbox', 'wechat_picture_admitted_as_native_image',
        'wechat_inbox_paths_described_to_model', 'wechat_presented_file_queued_by_path', 'wechat_cdn_failure_keeps_file_pending',
        'wechat_text_reply_not_blocked_by_file');
    } else {
      // Restart: the queued file goes out once the poll authenticates; the redelivered inbound message is not admitted again.
      http.enqueue(mediaUpdate('media-cursor-1'));
      await transport.start(message => bridge.receive(message));
      await until(async () => (await store.read()).pending.length === 0, 'queued file was not delivered after restart', 15_000);
      assert.equal(model.calls, 0, 'delivering a queued file must not run the model');
      const fileMessages = http.replies.filter(reply => reply.item_list[0]!.type === 4);
      assert.equal(fileMessages.length, 1);
      const item = fileMessages[0]!.item_list[0]!.file_item;
      assert.equal(item.file_name, 'summary.txt');
      assert.equal(item.len, String(Buffer.byteLength(reportContent)));
      assert.equal(fileMessages[0]!.context_token, 'local-media-context');
      assert.match(fileMessages[0]!.client_id, /^nexus:[a-f0-9]{32}$/);
      assert.equal(http.uploads.length, 1);
      assert.equal((http.uploads[0] as { media_type: number }).media_type, 3);
      assert.equal(decryptMedia(http.objects.get(item.media.encrypt_query_param)!, parseAesKey(item.media.aes_key)).toString('utf8'), reportContent);
      const inbox = await readdir(join(config.workspace, 'inbox'));
      assert.equal((await readdir(join(config.workspace, 'inbox', inbox[0]!))).length, 2, 'a redelivered message must not duplicate inbox files');
      // A new text message continues the same session with the picture still in history.
      http.enqueue({ get_updates_buf: 'media-cursor-2', msgs: [{ message_id: 'media-follow-up', from_user_id: owner.ownerId, message_type: 1,
        context_token: 'local-media-context', item_list: [{ type: 1, text_item: { text: '谢谢' } }] }] });
      await until(async () => (await store.read()).received.includes('media-follow-up'), 'follow-up was not admitted', 15_000);
      const found = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      await found.agent.whenIdle();
      await bridge.drain();
      await until(() => http.replies.some(reply => reply.item_list[0]!.type === 1 && reply.item_list[0]!.text_item.text === '重启后的新回复'), 'follow-up reply was not delivered', 15_000);
      assert.equal(model.calls, 1);
      await bridge.close();
      checks.push('wechat_queued_file_sent_once_after_restart', 'wechat_file_recovery_zero_model_calls', 'wechat_outbound_file_encrypted_and_named',
        'wechat_media_message_not_readmitted', 'wechat_inbox_not_duplicated_after_restart', 'wechat_session_continues_after_media');
    }
    assert.deepEqual(http.failures, []);
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls, checks }, null, 2));
  }
}
