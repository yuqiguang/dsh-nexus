/** Real DSH execution and credential persistence, with fault-injected loopback iLink HTTP. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { installBridge } from '../src/dsh/bridge.js';
import { DshRecords } from '../src/dsh/records.js';
import { identity, sessionIdFor, type InboundMessage } from '../src/channels/protocol.js';
import type { ConnectionRecord, ConnectionState } from '../src/channels/types.js';
import { WechatTransport } from '../src/wechat/transport.js';
import { WechatStateStore, type PendingText } from '../src/wechat/state.js';
import { aborted, until } from './helpers.js';
import { wechatHttpFixture, type WireReply } from './wechatHttpFixture.js';

export const name = 'nexus-wechat-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'credentials', 'tools', 'sandboxPolicy', 'agents'];
const grant: ConnectionRecord = { version: 1, revision: 1, enabled: true, accountId: 'wx-delivery-bot', ownerId: 'wx-delivery-owner',
  secret: 'local-delivery-token', baseUrl: 'https://ilinkai.weixin.qq.com' };
const owner = { channel: 'wechat' as const, accountId: grant.accountId, ownerId: grant.ownerId };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const longReply = '微信结果'.repeat(450);
const firstMessageId = '9223372036854775807';
const inbound = (id: string): InboundMessage => ({ messageId: id, chatId: owner.ownerId, senderId: owner.ownerId,
  chatType: 'p2p', text: '本地微信可靠性验证' });
const update = (id: string, cursor: string) => ({ get_updates_buf: cursor, msgs: [{ message_id: id, from_user_id: owner.ownerId,
  message_type: 1, context_token: 'local-durable-context', item_list: [{ type: 1, text_item: { text: inbound(id).text } }] }] });

class FixtureModel extends LlmAdapter {
  calls = 0;
  restoredHistory = false;
  constructor(private readonly phase: number) { super(); }
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local delivery fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 4096 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    this.calls++;
    assert.equal(this.calls, 1, 'delivery retries must never submit another model turn');
    this.restoredHistory = options.messages.some(message => message.source?.kind === 'model' &&
      message.content.some(block => block.type === 'text' && block.text === longReply));
    const text = this.phase === 5 ? longReply : '沿用原生历史的新回复';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel(config.phase);
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  const http = await wechatHttpFixture(config.phase === 5);
  ctx.effect(() => () => http.close());
  const store = new WechatStateStore(new DshRecords(ctx.credentials), owner.accountId, owner.ownerId);
  const states: ConnectionState[] = [];
  const failures: string[] = [];
  const transport = new WechatTransport(grant, state => states.push(state), store, http.fetchImpl,
    async (milliseconds, signal) => {
      signal.throwIfAborted();
      // Hold only phase 5's failed delivery until shutdown; restart polling must keep running.
      if (config.phase === 5 && milliseconds === 1000 && http.replies.length > 1) await aborted(signal);
    });
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  let flushedAdmission = false;
  ctx.on('session/flush', session => {
    if (session.id === sessionId && session.snapshotEvents().flatMap(event => event.type === 'user/message'
      ? [event.data] : event.type === 'agent/inbox/spliced' ? event.data.inserted : []).some(message =>
      'rpcId' in message.source && message.source.rpcId === `wechat-${identity(owner.accountId, firstMessageId)}`)) flushedAdmission = true;
  });
  let running = false;
  const timer = setInterval(() => {
    void readFile(config.triggerFile).then(() => {
      if (running) return;
      running = true; clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error), failures, states }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    const checks: string[] = [];
    let firstPart: WireReply | undefined;
    let remainingParts: { id: string; text: string }[] | undefined;
    if (config.phase === 5) {
      // Preserve the numeric wire literal so the real HTTP parser must handle a 64-bit ID.
      http.enqueue(JSON.stringify(update(firstMessageId, 'durable-cursor-1'))
        .replace(`"message_id":"${firstMessageId}"`, `"message_id":${firstMessageId}`));
    }
    await transport.start(async message => {
      await bridge.receive(message);
      if (message.messageId === firstMessageId) assert.equal(flushedAdmission, true, 'receive must await the native flush');
    });
    if (config.phase === 5) {
      await until(async () => (await store.read()).pending[0]?.attempts === 1, 'partial delivery was not saved', 10_000);
      const found = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      await found.agent.whenIdle();
      await bridge.drain();
      const saved = await store.read();
      assert.equal(saved.cursor, 'durable-cursor-1');
      assert.deepEqual(http.cursors.slice(0, 2), ['', '']);
      assert.ok(states.some(state => state.phase === 'reconnecting' && state.error === 'wechat_request_failed'));
      assert.ok(saved.received.includes(firstMessageId));
      assert.equal(flushedAdmission, true);
      assert.equal((saved.pending[0] as PendingText).nextPart, 1);
      assert.equal(http.replies.length, 4);
      assert.deepEqual(http.replies[1], http.replies[2]);
      assert.deepEqual(http.replies[2], http.replies[3]);
      assert.equal(model.calls, 1);
      firstPart = http.replies[0];
      remainingParts = (saved.pending[0] as PendingText).parts.slice(1);
      await assert.rejects(transport.sendText(owner.ownerId, '仅当前连接有效：/approve local-fixture', 'ephemeral-approval'), /server_unavailable/);
      assert.equal((await store.read()).pending.length, 1, 'interactive prompt must not join the durable outbox');
      http.rejectSends(-54321); // Synthetic code; do not infer a production quota number from it.
      await assert.rejects(transport.sendText(owner.ownerId, 'live question', 'quota-prompt'), /wechat_send_rejected/);
      assert.equal((await store.read()).replyWait?.diagnostic?.ret, -54321);
      await bridge.close();
      checks.push('wechat_loopback_http_transport', 'wechat_cursor_after_native_flush', 'wechat_partial_progress_persisted',
        'wechat_transient_retry_keeps_wire_payload', 'wechat_interactive_prompt_not_persisted',
        'wechat_rejected_poll_recovers', 'wechat_connects_without_typing_configuration', 'wechat_numeric_message_id_native_admission', 'wechat_reply_rejection_diagnostics_persisted');
    } else {
      const previous = JSON.parse(await readFile(join(dirname(config.reportFile), 'phase-5.json'), 'utf8'));
      await until(() => states.some(state => state.phase === 'connected'), 'restart authentication');
      assert.equal(http.replies.length, 0, 're-authentication must not reset the reply hold');
      assert.equal((await store.read()).replyWait?.diagnostic?.ret, -54321);
      const refresh = update('refresh-reply', 'durable-cursor-refresh');
      refresh.msgs[0]!.item_list[0]!.text_item.text = '状态';
      http.enqueue(refresh); // Same token, new owner message; control reply does not launch a model turn.
      await until(async () => http.replies.length === 3 && (await store.read()).pending.length === 0,
        'restart did not deliver exactly the remaining parts', 10_000);
      const recovered = http.replies.slice(1); // The first send answers the explicit status request.
      assert.match(http.replies[0]!.item_list[0]!.text_item.text, /当前没有执行中的任务，上一轮已完成/);
      assert.equal(model.calls, 0);
      assert.equal(http.cursors[0], 'durable-cursor-1');
      assert.ok(http.replies.every(reply => reply.client_id !== previous.firstPart.client_id));
      assert.deepEqual(recovered.map(reply => ({ id: reply.client_id.slice('nexus:'.length), text: reply.item_list[0]!.text_item.text })),
        previous.remainingParts);
      assert.ok(http.replies.every(reply => reply.context_token === 'local-durable-context'));
      assert.ok(http.replies.every(reply => !reply.item_list.some(item => item.text_item.text.includes('/approve'))));
      // Independently verify native request deduplication, beyond the transport's saved receipt.
      await bridge.receive(inbound(firstMessageId));
      const found = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      await found.agent.whenIdle();
      await bridge.drain();
      assert.equal(model.calls, 0);
      assert.equal(http.replies.length, 3);
      http.enqueue(update('delivery-message-2', 'durable-cursor-2'));
      await until(async () => (await store.read()).received.includes('delivery-message-2'), 'new message was not admitted', 10_000);
      await found.agent.whenIdle();
      await bridge.drain();
      await until(() => http.replies.length === 4, 'new native result was not delivered', 10_000);
      assert.equal(model.calls, 1);
      assert.equal(model.restoredHistory, true);
      assert.equal(http.replies[3]!.item_list[0]!.text_item.text, '沿用原生历史的新回复');
      await bridge.close();
      checks.push('wechat_outbox_restored_after_process_restart', 'wechat_remaining_parts_only', 'wechat_recovery_zero_model_calls',
        'wechat_no_old_approval_replay', 'wechat_native_dedup_after_delivery_restart', 'wechat_history_continues_after_delivery_restart',
        'wechat_reply_hold_survives_process_restart', 'wechat_same_token_new_message_resumes_outbox', 'wechat_cold_status_reads_native_history');
    }
    assert.deepEqual(http.failures, []);
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
      recoveryModelCalls: config.phase === 6 ? 0 : undefined, checks, firstPart, remainingParts }, null, 2));
  }
}
