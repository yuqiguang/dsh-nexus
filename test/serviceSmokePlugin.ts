/**
 * Real DSH: the health route answers on loopback; a crash (SIGKILL) while a question waits for the user, plus a reply whose
 * delivery failed, are both made good at the next start: the restart is announced with the health check's reason, the
 * undelivered reply goes out, the interrupted turn is described, and no model call is spent on any of it.
 */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeliveryLedger } from '../src/channels/ledger.js';
import { BridgeRegistry } from '../src/channels/notify.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { installBridge } from '../src/dsh/bridge.js';
import { installAssistantPrompt } from '../src/assistant/prompt.js';
import { installAssistant } from '../src/plugin.js';
import { HEALTH_PATH, installHealth } from '../src/service/health.js';
import { RESTART_REASON_FILE, RUN_FILE, startLifecycle } from '../src/service/lifecycle.js';
import { until } from './helpers.js';

export const name = 'nexus-service-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'systemPrompt',
  'credentials', 'storageDomain', 'connection', 'webServer', 'userQuestions'];
const owner = { channel: 'wechat' as const, accountId: 'wx-service-bot', ownerId: 'wx-service-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });
const UNDELIVERED = '这条回复在重启前没能送出。';

class FixtureModel extends LlmAdapter {
  calls = 0;
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local service fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
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
    const asked = options.messages.findLast(message => message.source?.kind === 'user');
    const askedText = asked?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
    if (askedText === '这条会发不出去') { yield* this.text(UNDELIVERED); return; }
    if (askedText === '问我一个问题') {
      const block = { type: 'tool-call' as const, id: ToolCallId('ask-1'), name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'db', header: '数据库', question: '用哪个数据库？', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }] }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    yield* this.text('收到。');
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  installAssistantPrompt(ctx);
  const texts: string[] = [];
  const failures: string[] = [];
  let dropDelivery = false;
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {},
    async sendText(_chatId, text) { if (dropDelivery && text === UNDELIVERED) throw new Error('transport down'); texts.push(text); } };
  const ledger = await DeliveryLedger.open(ctx.storageDomain);
  ctx.effect(() => () => { void ledger.close(); });
  const registry = new BridgeRegistry();
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code), undefined, { ledger });
  registry.add(bridge);
  const assistant = await installAssistant(ctx, registry, { report: message => failures.push(`assistant: ${message}`) });
  const startedAt = Date.now();
  installHealth(ctx, { startedAt, heldPushes: () => assistant.heldPushes(), coders: () => [],
    async channels() { return [{ channel: 'wechat', enabled: true, phase: 'connected' }]; } });
  const home = dshHomePath();
  // Read before startLifecycle rewrites it: what the previous run left behind.
  const previousRun = await readFile(join(home, RUN_FILE), 'utf8').then(text => JSON.parse(text) as { pid: number; clean?: boolean }, () => undefined);
  let restartNotice: string | undefined;
  const startup = (async () => {
    restartNotice = await startLifecycle({ home, notifier: registry, sessions: () => registry.bound(), report: message => failures.push(`lifecycle: ${message}`) }, dispose => ctx.effect(() => dispose));
    await registry.catchUp();
  })();
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts, restartNotice }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    await startup;
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    if (config.phase === 19) {
      assert.equal(previousRun, undefined, 'a fresh runtime has no run record');
      assert.equal(restartNotice, undefined, 'the first start says nothing');
      // The health route: no login, loopback only, a snapshot of what the health check needs.
      const health = await fetch(`${origin}${HEALTH_PATH}`);
      assert.equal(health.status, 200);
      const snapshot = await health.json() as { ok: boolean; uptimeMs: number; channels: { phase: string }[]; coders: { active: string[] }; heldPushes: number };
      assert.equal(snapshot.ok, true);
      assert.ok(snapshot.uptimeMs >= 0);
      assert.deepEqual([snapshot.channels[0]?.phase, snapshot.coders.active, snapshot.heldPushes], ['connected', [], 0]);
      assert.equal((await fetch(`${origin}${HEALTH_PATH}`, { method: 'POST' })).status, 405);
      // One delivered turn marks the ledger; the next reply fails to send and stays unmarked.
      await bridge.receive(inbound('m1', '你好'));
      const agent = ctx.agents.get(sessionId)!;
      await agent.whenIdle();
      await bridge.drain();
      assert.equal(texts.at(-1), '收到。');
      dropDelivery = true;
      await bridge.receive(inbound('m2', '这条会发不出去'));
      await agent.whenIdle();
      await bridge.drain();
      assert.ok(!texts.includes(UNDELIVERED));
      assert.deepEqual(failures, ['channel_delivery_failed']);
      failures.length = 0;
      // A question goes out to the channel and waits; the process is then killed the hard way, as a crash would.
      void bridge.receive(inbound('m3', '问我一个问题')).catch(() => {});
      await until(() => texts.some(text => text.includes('用哪个数据库？')), 'question prompt was not sent', 10_000);
      assert.equal(await ctx.sessions.flush(agent.session), true);
      // Leave the health check's note so the next start attributes the restart to it.
      await writeFile(join(home, RESTART_REASON_FILE), JSON.stringify({ at: Date.now(), reason: 'smoke 模拟的健康检查重启' }));
      assert.deepEqual(failures, []);
      await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
        checks: ['health_route_loopback_snapshot', 'health_route_rejects_other_methods', 'first_start_is_silent', 'failed_delivery_leaves_turn_unmarked', 'question_pending_at_crash'] }, null, 2));
      // Not SIGTERM: no disposer runs, the run record stays without a clean stop, and the log ends inside the turn.
      process.kill(process.pid, 'SIGKILL');
      return;
    }
    // Phase 20: everything the crash left behind is made good before any user message, with no model call.
    assert.ok(previousRun && previousRun.clean !== true, `the crashed run must have no clean-stop mark: ${JSON.stringify(previousRun)}`);
    assert.match(restartNotice ?? '', /由健康检查重新启动：smoke 模拟的健康检查重启/);
    await until(() => texts.length >= 3, 'restart notice, undelivered reply, and interrupted notice were not all sent', 10_000);
    assert.deepEqual(texts[0], restartNotice);
    assert.equal(texts[1], UNDELIVERED, 'the reply whose delivery failed before the crash is sent first');
    assert.match(texts[2]!, /^服务重启打断了上一轮（.*）。\n当时在等你回答：用哪个数据库？\n这些操作都没有完成。/);
    assert.equal(model.calls, 0, 'catch-up spends no model call');
    await access(join(home, RESTART_REASON_FILE)).then(() => assert.fail('the restart reason must be consumed'), () => {});
    // The session goes on: a new message gets a reply and nothing old is sent again.
    await bridge.receive(inbound('m4', '还在吗'));
    const agent = ctx.agents.get(sessionId)!;
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '收到。');
    assert.equal(texts.length, 4);
    assert.equal(model.calls, 1);
    await registry.catchUp();
    await bridge.drain();
    assert.equal(texts.length, 4, 'catching up again sends nothing');
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
      checks: ['crash_detected_from_run_record', 'restart_announced_with_health_check_reason', 'undelivered_reply_sent_after_restart', 'interrupted_question_reported',
        'catch_up_without_model_call', 'restart_reason_consumed', 'session_continues_after_catch_up', 'catch_up_idempotent'] }, null, 2));
  }
}
