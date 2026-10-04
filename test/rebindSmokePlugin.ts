/**
 * A QR scan that binds a new bot account starts the chat's sessions over. Phase 23 is the state the live
 * service was in on 2026-09-26: the earlier account's session holds a reminder the model created with the
 * native tool, the new account's session has already been used, and both accounts left their WeChat
 * delivery records. Phase 24 restarts with only the new account mounted: the earlier line is found through
 * the stored records, merged at the chat's next message, and its reminder fires from the new session.
 */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import { access, writeFile } from 'node:fs/promises';
import { installBridge } from '../src/dsh/bridge.js';
import { storedEvents } from '../src/dsh/history.js';
import { DshRecords } from '../src/dsh/records.js';
import { installAssistantPrompt } from '../src/assistant/prompt.js';
import { sessionIdFor, type ChannelIdentity, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { SessionRoster } from '../src/sessions/index.js';
import { WechatStateStore, formerWechatBases } from '../src/wechat/state.js';
import { until } from './helpers.js';

export const name = 'nexus-rebind-smoke';
export const inject = ['schedule', 'llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'systemPrompt',
  'credentials', 'storageDomain', 'workspaceRegistry'];
const person = 'wx-rebind-owner';
const before: ChannelIdentity = { channel: 'wechat', accountId: 'wx-rebind-bot-before', ownerId: person };
const after: ChannelIdentity = { channel: 'wechat', accountId: 'wx-rebind-bot-after', ownerId: person };
const earlier = SessionId(sessionIdFor(before.accountId, person, person, 'wechat'));
const current = SessionId(sessionIdFor(after.accountId, person, person, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: person, senderId: person, chatType: 'p2p' });

class FixtureModel extends LlmAdapter {
  calls = 0;
  reminders: string[] = [];
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local rebind fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
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
    this.calls++;
    const lastUser = options.messages.findLastIndex(message => message.source?.kind === 'user');
    const reminderIndex = options.messages.findLastIndex(message => (message.source?.kind as string | undefined) === 'schedule');
    const reminder = reminderIndex > lastUser ? options.messages[reminderIndex] : undefined;
    if (reminder) {
      const text = reminder.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
      this.reminders.push(text);
      yield* this.text(`提醒：${/reminder_prompt_json: "([^"]+)"/.exec(text)?.[1] ?? '到点了'}`);
      return;
    }
    const asked = options.messages[lastUser]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
    const answered = (callId: string) => options.messages.some(message => message.role === 'tool' && message.toolCallId === callId);
    if (asked === '二十秒后提醒我喝水') {
      if (!answered('drink')) { yield* this.toolCall('drink', 'schedule_create', { title: '本地验证提醒', prompt: '喝水', after_seconds: 20 }); return; }
      yield* this.text('好，二十秒后提醒你喝水。'); return;
    }
    yield* this.text('收到。');
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  installAssistantPrompt(ctx);
  const records = new DshRecords(ctx.credentials);
  const roster = await SessionRoster.open(ctx.storageDomain);
  ctx.effect(() => () => { void roster.close(); });
  const failures: string[] = [];
  const digests: { text: string; sessionId: string }[] = [];
  const channel = (texts: string[]): ChannelTransport => ({ async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } });
  const oldTexts: string[] = [];
  const texts: string[] = [];
  // Phase 23 mounts both accounts, as the service did before and after the scan; phase 24 only the current one, as it does now.
  const oldBridge = config.phase === 23 ? installBridge(ctx, channel(oldTexts), before, config.workspace, code => failures.push(code), undefined, { sessions: roster }) : undefined;
  const bridge = installBridge(ctx, channel(texts), after, config.workspace, code => failures.push(code), undefined, {
    sessions: roster, memory: { async remember(text, sessionId) { digests.push({ text, sessionId }); } },
    ...(config.phase === 24 ? { formerBases: () => formerWechatBases(records, after) } : {}) });
  void bridge.resumeBound().catch(() => failures.push('resume_failed'));
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts, oldTexts, reminders: model.reminders }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    if (config.phase === 23) {
      // Each account leaves its delivery record, as the WeChat transport writes it on the first inbound message.
      await new WechatStateStore(records, before.accountId, person).rememberContext('context-before');
      await new WechatStateStore(records, after.accountId, person).rememberContext('context-after');
      await oldBridge!.receive(inbound('a1', '二十秒后提醒我喝水'));
      await ctx.agents.get(earlier)!.whenIdle();
      await oldBridge!.drain();
      assert.equal(oldTexts.at(-1), '好，二十秒后提醒你喝水。');
      assert.deepEqual((await ctx.schedule.list({ sessionId: earlier })).map(record => record.prompt), ['喝水']);
      await bridge.receive(inbound('b1', '你好'));
      await ctx.agents.get(current)!.whenIdle();
      await bridge.drain();
      assert.equal(texts.at(-1), '收到。');
      assert.equal(await ctx.sessions.flush(ctx.agents.get(earlier)!.session), true);
      assert.equal(await ctx.sessions.flush(ctx.agents.get(current)!.session), true);
      assert.deepEqual(failures, []);
      await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId: current, modelCalls: model.calls,
        checks: ['earlier_account_session_holds_native_reminder', 'current_account_session_used_before_the_fix'] }, null, 2));
      return;
    }
    // Native host scheduling resumes the old Session itself; routing is restored before new input.
    await until(() => ctx.agents.get(current) !== undefined, 'current session not resumed', 10_000);
    assert.deepEqual(await formerWechatBases(records, after), [earlier]);
    const beforeTask = (await ctx.schedule.catalog()).find(record => record.sessionId === earlier)!;
    assert.ok(beforeTask);
    await until(() => texts.some(text => text.startsWith(`[历史微信会话 ${earlier}]\n提醒：喝水\n`)), 'native reminder was not routed after restart/rebind', 35_000);
    const agent = ctx.agents.get(current)!;
    await bridge.drain();
    assert.equal(texts.filter(text => text.startsWith(`[历史微信会话 ${earlier}]\n提醒：喝水\n`)).length, 1);
    const delivered = (await ctx.schedule.catalog()).find(record => record.id === beforeTask.id)!;
    assert.equal(delivered.sessionId, earlier);
    assert.equal(delivered.status, 'inactive');
    assert.ok(delivered.lastDelivery);
    const history = await ctx.schedule.history({ sessionId: earlier, id: delivered.id, limit: 10 });
    assert.ok('records' in history && history.records.length === 1);
    assert.deepEqual(await ctx.schedule.list({ sessionId: current }), []);
    assert.equal(model.reminders.length, 1);
    await bridge.receive(inbound('b2', '在吗'));
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(roster.get(earlier)?.supersededBy, current);
    await bridge.receive(inbound('b3', '再问一句'));
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(model.reminders.length, 1, 'no replay on admission');
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId: current, modelCalls: model.calls,
      checks: ['earlier_account_found_from_delivery_records', 'native_reminder_delivered_before_new_input',
        'original_task_binding_and_delivery_history_preserved', 'no_task_recreated', 'reminder_delivered_once', 'rebind_metadata_persisted'] }, null, 2));
  }
}
