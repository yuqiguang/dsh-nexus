/** Native reminders reach the channel: the model creates one, it fires into the idle session, the reply is pushed; a quiet monitoring reply is not; after a restart the resumed session still fires. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import { access, writeFile } from 'node:fs/promises';
import { installBridge } from '../src/dsh/bridge.js';
import { BridgeRegistry } from '../src/channels/notify.js';
import { installAssistant } from '../src/plugin.js';
import { localMinutes } from '../src/assistant/clock.js';
import { installAssistantPrompt } from '../src/assistant/prompt.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { ROTATION_NOTICES, SessionRoster } from '../src/sessions/index.js';
import { until } from './helpers.js';

export const name = 'nexus-reminder-smoke';
export const inject = ['schedule', 'llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'systemPrompt',
  'credentials', 'storageDomain', 'connection', 'webServer', 'workspaceRegistry'];
const owner = { channel: 'wechat' as const, accountId: 'wx-reminder-bot', ownerId: 'wx-reminder-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });

class FixtureModel extends LlmAdapter {
  calls = 0;
  reminders: string[] = [];
  /** The system message of the latest call, so the smoke can check the persona the model actually saw. */
  systemText = '';
  constructor(private readonly phase: number) { super(); }
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local reminder fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
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
    assert.ok(options.tools?.some(tool => tool.name === 'schedule_create'), `schedule_create missing from ${options.tools?.map(tool => tool.name).join(',')}`);
    const prompt = [options.system ?? '', ...options.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))].join('\n');
    assert.ok(prompt.includes('schedule_create'), 'system prompt must describe reminders');
    this.systemText = options.messages.filter(message => message.role === 'system').flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n');
    this.calls++;
    // A reminder counts only when it arrived after the user's latest message; older ones are history.
    const lastUser = options.messages.findLastIndex(message => message.source?.kind === 'user');
    const reminderIndex = options.messages.findLastIndex(message => (message.source?.kind as string | undefined) === 'schedule');
    const reminder = reminderIndex > lastUser ? options.messages[reminderIndex] : undefined;
    const answered = (callId: string) => options.messages.some(message => message.role === 'tool' && message.toolCallId === callId);
    const reminderText = reminder?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
    if (reminder && !this.reminders.includes(reminderText)) {
      this.reminders.push(reminderText);
      assert.match(reminderText, /^\[SCHEDULE REMINDER/);
      const quiet = reminderText.includes('monitor-quiet');
      yield* this.text(quiet ? '静默' : `提醒：${/reminder_prompt_json: "([^"]+)"/.exec(reminderText)?.[1] ?? '到点了'}`);
      return;
    }
    const asked = options.messages.findLast(message => message.source?.kind === 'user');
    const askedText = asked?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
    if (askedText.startsWith('[外部事件]')) { yield* this.text(`外部事件已处理：${/来源：(\S+)/.exec(askedText)?.[1]}｜${askedText.split('---\n')[1]}`); return; }
    if (askedText === '两秒后提醒我带合同') {
      if (!answered('remind')) { yield* this.toolCall('remind', 'schedule_create', { title: '本地验证提醒', prompt: '带合同', after_seconds: 2 }); return; }
      yield* this.text('好，两秒后提醒你带合同。'); return;
    }
    if (askedText === '盯着价格') {
      if (!answered('monitor')) { yield* this.toolCall('monitor', 'schedule_create', { title: '本地验证提醒', prompt: 'monitor-quiet: 检查价格，没降就静默', every_seconds: 300 }); return; }
      yield* this.text('已建立监控。'); return;
    }
    if (askedText === '三秒后提醒我') {
      if (!answered('later')) { yield* this.toolCall('later', 'schedule_create', { title: '本地验证提醒', prompt: '重启后的提醒', after_seconds: 3 }); return; }
      yield* this.text('好。'); return;
    }
    if (askedText === '六秒后提醒我交报告') {
      if (!answered('report')) { yield* this.toolCall('report', 'schedule_create', { title: '本地验证提醒', prompt: '交报告', after_seconds: 6 }); return; }
      yield* this.text('好，六秒后提醒你。'); return;
    }
    yield* this.text('收到。');
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel(config.phase);
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  installAssistantPrompt(ctx);
  const texts: string[] = [];
  const failures: string[] = [];
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  // Phase 14 rotates the chat's session on demand; the roster is real native storage, the memory sink records the digest.
  const digests: { text: string; sessionId: string }[] = [];
  const roster = await SessionRoster.open(ctx.storageDomain);
  ctx.effect(() => () => { void roster.close(); });
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code), undefined,
    { sessions: roster, memory: { async remember(text, sessionId) { digests.push({ text, sessionId }); } } });
  const registry = new BridgeRegistry();
  registry.add(bridge);
  await installAssistant(ctx, registry, { report: message => failures.push(`assistant: ${message}`) });
  // The plugin entry does this on mount; phase 14 depends on it so the reminder created in phase 13's session fires with no user message.
  void bridge.resumeBound().catch(() => failures.push('resume_failed'));
  const startedAt = Date.now();
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts, reminders: model.reminders }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    // Assistant routes share the authenticated /api carrier; the hook is its own public route on the web server.
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method: string, payload: object = {}, errorCode?: string) => {
      const response = await fetch(`${origin}/api/nexus-assistant/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'assistant-smoke', method, payload }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      if (errorCode) { assert.equal(body.result.error?.code, errorCode); return body.result; }
      assert.equal(body.result.ok, true, body.result.error?.code);
      return body.result.value as { settings: { revision: number; hookEnabled: boolean; quietStart?: string }; quietNow: boolean; heldPushes: number; hookUrl?: string; hookToken?: string; nextBriefingAt?: number };
    };
    if (config.phase === 13) {
      await bridge.receive(inbound('m1', '两秒后提醒我带合同'));
      const agent = ctx.agents.get(sessionId)!;
      await agent.whenIdle();
      await bridge.drain();
      assert.equal(texts.at(-1), '好，两秒后提醒你带合同。');
      // The persona replaces both upstream identity lines; the preset's suffix and the tool guidance stay.
      assert.match(model.systemText, /^你是 Nexus，用户的私人助理/);
      assert.doesNotMatch(model.systemText, /powered by DeepSeek Harness|coding agent powered by/);
      assert.match(model.systemText, /Your working directory is/);
      assert.match(model.systemText, /schedule_create/);
      await bridge.receive(inbound('s1', '状态'));
      assert.match(texts.at(-1)!, /待触发的提醒（1）/);
      assert.match(texts.at(-1)!, /schedule-/);
      // The reminder fires into the idle agent; the model's reply is pushed with no user message.
      await until(() => texts.some(text => text === '提醒：带合同'), 'reminder was not pushed to the channel', 20_000);
      assert.equal(model.reminders.length, 1);
      assert.match(model.reminders[0]!, /\[SCHEDULE REMINDER\]/);
      await bridge.receive(inbound('s2', '状态'));
      assert.doesNotMatch(texts.at(-1)!, /待触发的提醒/);
      // A monitoring reminder that answers 静默 is not delivered.
      await bridge.receive(inbound('m2', '盯着价格'));
      await agent.whenIdle();
      await bridge.drain();
      assert.equal(texts.at(-1), '已建立监控。');
      await bridge.receive(inbound('s3', '状态'));
      assert.match(texts.at(-1)!, /每 5 分钟/);
      assert.equal((await fetch(`${origin}/api/nexus-assistant/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      let view = await rpc('list');
      assert.deepEqual([view.settings.revision, view.quietNow, view.heldPushes, view.settings.hookEnabled], [0, false, 0, false]);
      // A saved persona reaches the very next model call of the running session, without a restart.
      view = await rpc('save', { revision: 0, config: { persona: { name: '小秘', userName: '老于', tone: 'brisk', initiative: 'high' } } });
      await rpc('save', { revision: 1, config: { persona: { name: '' } } }, 'invalid_persona');
      await bridge.receive(inbound('p1', '随便说点什么'));
      await agent.whenIdle();
      await bridge.drain();
      assert.match(model.systemText, /^你是 小秘，用户的私人助理.*称呼用户“老于”/);
      assert.match(model.systemText, /干练直接/);
      // Briefing: composed by Nexus from the session fold, pushed to the chat with no model call.
      const callsBefore = model.calls;
      view = await rpc('save', { revision: 1, config: { briefingTime: '08:00' } });
      assert.ok(view.nextBriefingAt! > Date.now());
      await rpc('briefing/send');
      await until(() => texts.some(text => text.includes('的简报：')), 'briefing was not pushed', 5_000);
      assert.match(texts.at(-1)!, /进行中的监控（1）：\n- schedule-\S+ 每 5 分钟/);
      assert.equal(model.calls, callsBefore, 'the briefing must not call the model');
      // Hook: bearer token minted once; a POST becomes a framed message in the bound session and the reply is pushed.
      await rpc('save', { revision: 2, config: { timeZone: 'Mars/Olympus' } }, 'invalid_time_zone');
      view = await rpc('hook/rotate', { revision: 2, enabled: true });
      const token = view.hookToken!;
      const hookUrl = view.hookUrl!;
      assert.match(token, /^[A-Za-z0-9_-]{32}$/);
      assert.equal(hookUrl, `${origin}/nexus-hooks/inbound`);
      assert.equal((await rpc('list')).hookToken, undefined, 'the token is never shown again');
      const post = (body: unknown, auth = `Bearer ${token}`) => fetch(hookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth }, body: JSON.stringify(body) });
      assert.equal((await post({ text: 'x' }, 'Bearer wrong')).status, 401);
      assert.equal((await post({ text: '' })).status, 400);
      const accepted = await post({ text: '房东：下周二修水管', source: 'mail' });
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), { accepted: 1 });
      await until(() => texts.some(text => text === '外部事件已处理：mail｜房东：下周二修水管'), 'hook event reply was not pushed', 15_000);
      // Quiet hours around now: the next hook reply is held, counted, then flushed on request as a merged digest.
      const minute = localMinutes(Date.now(), 'Asia/Shanghai');
      const clock = (offset: number) => { const m = (minute + offset + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
      view = await rpc('save', { revision: 3, config: { quietStart: clock(-60), quietEnd: clock(60), briefingTime: '08:00' } });
      assert.equal(view.quietNow, true);
      const beforeQuiet = texts.length;
      assert.equal((await post({ text: '夜里的事件', source: 'mail' })).status, 202);
      assert.equal((await post({ text: '第二件', source: 'mail' })).status, 202);
      await until(async () => (await rpc('list')).heldPushes === 2, 'quiet-hour replies were not held', 15_000);
      assert.equal(texts.length, beforeQuiet, 'nothing reaches the chat during quiet hours');
      await bridge.receive(inbound('s4', '状态'));
      assert.equal(texts.length, beforeQuiet + 1, 'a reply to the user is never held');
      view = await rpc('flush');
      assert.equal(view.heldPushes, 0, JSON.stringify({ failures, tail: texts.slice(-3) }));
      assert.match(texts.at(-1)!, /^安静时段里有 2 条消息：\n\n1\. 外部事件已处理：mail｜夜里的事件\n\n2\. 外部事件已处理：mail｜第二件$/);
      view = await rpc('hook/rotate', { revision: 4, enabled: false });
      assert.equal((await post({ text: 'x' })).status, 404);
      assert.equal(await ctx.sessions.flush(agent.session), true);
      assert.deepEqual(failures, []);
      await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls, elapsedMs: Date.now() - startedAt,
        checks: ['schedule_create_in_channel_session', 'persona_replaces_harness_identity', 'persona_change_applies_to_next_model_call', 'status_lists_active_reminders', 'due_reminder_pushed_without_user_message', 'fired_reminder_leaves_status',
          'monitoring_reminder_created', 'assistant_settings_requires_login', 'briefing_pushed_without_model', 'hook_token_minted_once', 'hook_rejects_bad_token',
          'hook_event_reply_pushed', 'quiet_hours_hold_pushes_not_replies', 'held_pushes_flushed_merged', 'hook_disabled_returns_404'] }, null, 2));
      return;
    }
    // Phase 14: the session was resumed by the bridge at startup, so a reminder created earlier still fires; a 静默 reply from the monitor is suppressed.
    await until(() => ctx.agents.get(sessionId) !== undefined, 'bound session was not resumed at startup', 10_000);
    const agent = ctx.agents.get(sessionId)!;
    // Settings survived the restart: quiet hours from phase 13 are still active, so the reminder that fires now is held, not pushed.
    let view = await rpc('list');
    assert.deepEqual([view.settings.revision, view.quietNow, view.settings.hookEnabled], [5, true, false]);
    await bridge.receive(inbound('m3', '三秒后提醒我'));
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '好。', 'a reply to the user goes out even in quiet hours');
    await until(async () => (await rpc('list')).heldPushes === 1, 'reminder during quiet hours was not held', 20_000);
    assert.ok(!texts.some(text => text === '提醒：重启后的提醒'));
    // Turning quiet hours off releases it as a single message.
    view = await rpc('save', { revision: 5, config: { quietStart: '', quietEnd: '', briefingTime: '08:00' } });
    assert.equal(view.quietNow, false);
    await until(() => texts.some(text => text === '提醒：重启后的提醒'), 'held reminder was not released', 10_000);
    assert.equal((await rpc('list')).heldPushes, 0);
    assert.ok(!texts.includes('静默'), 'a quiet reply must never reach the channel');
    // Rotation on demand: a reminder created just before /new fires from the new generation; the monitor is carried; the old session is digested.
    await bridge.receive(inbound('m4', '六秒后提醒我交报告'));
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '好，六秒后提醒你。');
    await bridge.receive(inbound('n1', '/new'));
    assert.equal(texts.at(-1), ROTATION_NOTICES.user);
    const nextId = SessionId(`${sessionId}-1`);
    assert.equal(roster.activeFor(sessionId), nextId);
    await until(() => ctx.agents.get(nextId) !== undefined, 'new generation was not created', 5_000);
    const next = ctx.agents.get(nextId)!;
    const original = await ctx.schedule.list({ sessionId });
    assert.deepEqual(original.map(record => record.prompt), ['monitor-quiet: 检查价格，没降就静默', '交报告']);
    assert.deepEqual(await ctx.schedule.list({ sessionId: nextId }), [], 'rotation preserves original native bindings');
    assert.equal(digests.length, 1);
    assert.equal(digests[0]!.sessionId, sessionId);
    assert.match(digests[0]!.text, /微信对话（\d+ 件事）：.*六秒后提醒我交报告→好，六秒后提醒你/);
    await bridge.receive(inbound('m5', '新会话里的第一句'));
    await next.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '收到。');
    await until(() => texts.includes('提醒：交报告'), 'reminder carried into the new generation did not fire', 20_000);
    const delivered = (await ctx.schedule.catalog()).find(record => record.prompt === '交报告');
    assert.equal(delivered?.sessionId, sessionId);
    assert.equal(delivered?.status, 'inactive');
    assert.ok(delivered?.lastDelivery, 'native durable delivery receipt is preserved');
    assert.equal(model.reminders.filter(text => text.includes('交报告')).length, 1, 'fired once, not from both sessions');
    await bridge.receive(inbound('s5', '状态'));
    assert.match(texts.at(-1)!, /待触发的提醒（1）：\n- schedule-\S+ 每 5 分钟/);
    // The user archived the active session in the Web UI. DSH's archive gate rejects every step it proposes, so the
    // next message must open a new generation instead of being answered by a session that can no longer run.
    // The monitor still owns the session, so this is the archive the Web UI asks the user to confirm: stop the work, then archive.
    const turnsBefore = next.session.snapshotEvents().filter(event => event.type === 'turn/end').length;
    await ctx.workspaceRegistry.archiveSession(next.session.id, { stopActivity: true });
    assert.deepEqual([...ctx.workspaceRegistry.archivedSessionIds], [next.session.id]);
    await bridge.receive(inbound('a1', '归档之后再说一句'));
    assert.equal(texts.at(-1), ROTATION_NOTICES.archived);
    const movedId = SessionId(`${sessionId}-2`);
    assert.equal(roster.activeFor(sessionId), movedId);
    assert.equal(roster.get(sessionId)?.reason, 'archived');
    await until(() => ctx.agents.get(movedId) !== undefined, 'the generation after the archived one was not created', 5_000);
    const moved = ctx.agents.get(movedId)!;
    await moved.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '收到。', 'the archived session must not answer the message');
    assert.equal(next.session.snapshotEvents().filter(event => event.type === 'turn/end').length, turnsBefore, 'the archived session ran no turn after the archive');
    assert.equal(await ctx.sessions.flush(agent.session), true);
    assert.equal(await ctx.sessions.flush(next.session), true);
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
      checks: ['bound_session_resumed_at_startup', 'assistant_settings_restored', 'reminder_after_restart_held_in_quiet_hours', 'ending_quiet_hours_releases_held_push',
        'new_command_opens_next_generation', 'reminders_carried_to_new_generation', 'carried_reminder_fires_once_from_new_session', 'old_session_digested_to_memory', 'status_reads_new_generation',
        'archived_session_is_left_behind'] }, null, 2));
  }
}
