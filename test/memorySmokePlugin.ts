/** Real DSH: the model stores memory through the tools, the next user message is preceded by an injected recall, a restart keeps the memory and still commits the session, and a deletion through the settings routes stops injection. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installBridge } from '../src/dsh/bridge.js';
import { installAssistantPrompt } from '../src/assistant/prompt.js';
import { installMemorySettings } from '../src/plugin.js';
import { MEMORY_PLUGIN } from '../src/memory/index.js';
import { projectScope, scopeId, LEGACY_SCOPE } from '../src/memory/scope.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';

export const name = 'nexus-memory-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'systemPrompt',
  'storageDomain', 'connection', 'webServer'];
const owner = { channel: 'wechat' as const, accountId: 'wx-memory-bot', ownerId: 'wx-memory-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });

interface Seen { user: string; recall?: string }

class FixtureModel extends LlmAdapter {
  calls = 0;
  seen: Seen[] = [];
  sawTools = false;
  sawSection = false;
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local memory fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
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
    this.sawTools = ['memory_remember', 'memory_recall', 'memory_forget'].every(tool => options.tools?.some(item => item.name === tool));
    this.sawSection = options.messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text.includes('memory_remember')));
    const textOf = (message: GenerateOptions['messages'][number]) => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const lastUser = options.messages.findLastIndex(message => message.source?.kind === 'user');
    const user = options.messages[lastUser]!;
    const recall = options.messages.slice(0, lastUser).findLast(message => message.source?.kind === MEMORY_PLUGIN);
    // Record each user turn once, with the recall message that immediately preceded it, if any.
    const previous = options.messages.slice(lastUser - 1, lastUser)[0];
    const recallBefore = previous && previous.source?.kind === MEMORY_PLUGIN ? textOf(previous) : undefined;
    const userText = textOf(user);
    if (!this.seen.some(item => item.user === userText)) this.seen.push({ user: userText, ...(recallBefore !== undefined ? { recall: recallBefore } : {}) });
    const answered = (callId: string) => options.messages.some(message => message.role === 'tool' && message.toolCallId === callId);
    if (userText === '记住：我叫老于，不吃香菜；上周和王总谈了合作') {
      if (!answered('p1')) { yield* this.toolCall('p1', 'memory_remember', { kind: 'profile', key: '称呼', text: '老于' }); return; }
      if (!answered('p2')) { yield* this.toolCall('p2', 'memory_remember', { kind: 'profile', key: '饮食', text: '不吃香菜' }); return; }
      if (!answered('e1')) { yield* this.toolCall('e1', 'memory_remember', { kind: 'event', text: '上周和王总谈了合作', tags: ['王总'] }); return; }
      yield* this.text('记住了。'); return;
    }
    if (userText === '王总那边后来怎么样') {
      yield* this.text(recall ? `注入里有：${/王总谈了合作/.test(textOf(recall)) ? '王总' : '无'}` : '没有注入'); return;
    }
    if (userText === '我叫什么') {
      yield* this.text(recallBefore && /称呼：老于/.test(recallBefore) ? '你叫老于' : '不知道'); return;
    }
    if (userText === '我叫什么来着') {
      yield* this.text(recallBefore && /称呼/.test(recallBefore) ? '还记得' : '已忘记'); return;
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
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  const service = await installMemorySettings(ctx);
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts, seen: model.seen,
          profile: service.store.profile(), events: service.store.events(), injections: service.store.injections() }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    const checks: string[] = [];
    const channelScope = await projectScope(config.workspace, String(sessionId));
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method: string, payload: object = {}) => {
      const response = await fetch(`${origin}/api/nexus-memory/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'memory-smoke', method, payload: { scopeId: scopeId(channelScope), ...payload } }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.ok, true, body.result.error?.code);
      return body.result.value as { profile: { key: string; value: string; source: string }[]; events: { id: string; text: string }[]; injections: { sessionId: string; profile: boolean; eventIds: string[] }[]; counts: { profile: number; events: number } };
    };
    const turn = async (messageId: string, text: string) => {
      await bridge.receive(inbound(messageId, text));
      await ctx.agents.get(sessionId)!.whenIdle();
      await bridge.drain();
    };
    if (config.phase === 17) {
      assert.equal(service.store.policy().remember, 'ask');
      // The fixture deliberately opts into automatic writes to exercise tool persistence.
      await service.handle('policy', { remember: 'auto', inject: true });
      await service.legacy.setProfile('旧版秘密', 'legacy-must-stay-hidden', 'model');
      await turn('m1', '记住：我叫老于，不吃香菜；上周和王总谈了合作');
      assert.equal(texts.at(-1), '记住了。');
      assert.equal(model.calls, 4, 'three remember calls and the reply');
      assert.ok(model.sawTools, 'memory tools must be in the model tool set');
      assert.ok(model.sawSection, 'the system prompt must describe the memory tools');
      assert.equal(model.seen[0]!.recall, undefined, 'nothing is injected before anything is stored');
      const stored = await rpc('list');
      assert.deepEqual(stored.profile.map(entry => [entry.key, entry.value, entry.source]), [['称呼', '老于', 'model'], ['饮食', '不吃香菜', 'model']]);
      assert.equal(stored.events.length, 1);
      assert.equal(stored.events[0]!.text, '上周和王总谈了合作');
      await turn('m2', '王总那边后来怎么样');
      assert.equal(texts.at(-1), '注入里有：王总');
      assert.equal(model.calls, 5);
      const second = model.seen[1]!;
      assert.ok(second.recall, 'the recall message must directly precede the user message');
      assert.match(second.recall, /^\[记忆\]/);
      assert.match(second.recall, /称呼：老于/);
      assert.match(second.recall, /饮食：不吃香菜/);
      assert.match(second.recall, /王总谈了合作/);
      assert.doesNotMatch(second.recall, /legacy-must-stay-hidden/);
      const audit = (await rpc('list')).injections;
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.sessionId, sessionId);
      assert.equal(audit[0]!.profile, true);
      assert.equal(audit[0]!.eventIds.length, 1);
      // The injected message is part of the durable session: a resume must find it.
      const found = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      const recalls = found.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === MEMORY_PLUGIN);
      assert.equal(recalls.length, 1, 'exactly one recall event is in the session log');
      await bridge.close();
      checks.push('memory_tools_in_model_toolset', 'memory_prompt_section_present', 'memory_remember_stores_profile_and_event_via_native_tools',
        'memory_recall_injected_before_next_user_message', 'memory_injection_audited', 'memory_recall_event_persisted_in_native_session');
    } else {
      // Restart: memory lives in native storage; the first message of the resumed session gets the profile again.
      assert.equal(service.store.policy().remember, 'auto', 'the fixture policy survives initialization on restart');
      assert.equal(model.calls, 0);
      const before = await rpc('list');
      assert.deepEqual(before.counts, { profile: 2, events: 1, proposals: 0 });
      await turn('m3', '我叫什么');
      assert.equal(texts.at(-1), '你叫老于');
      assert.equal(model.calls, 1, 'the stored memory needs no extra model call');
      assert.match(model.seen[0]!.recall ?? '', /称呼：老于/);
      // A deletion through the settings routes takes effect at once: the profile changes, so it is re-injected without the deleted key.
      await rpc('profile/delete', { key: '称呼' });
      await rpc('profile/delete', { key: '饮食' });
      await turn('m4', '我叫什么来着');
      assert.equal(texts.at(-1), '已忘记');
      assert.equal(model.seen[1]!.recall, undefined, 'an empty profile and no relevant event mean nothing is injected');
      const after = await rpc('list');
      assert.equal(after.counts.profile, 0);
      assert.equal(after.events.length, 1, 'the event is untouched');
      const found = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      const recalls = found.agent.session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.source.kind === MEMORY_PLUGIN);
      assert.equal(recalls.length, 2, 'one recall from before the restart, one after');
      await bridge.close();
      checks.push('memory_survives_restart_in_native_storage', 'memory_profile_reinjected_in_resumed_session', 'memory_settings_delete_stops_injection',
        'memory_resumed_session_loads_with_recall_events');
    }
    // Two native local sessions with different cwd values, beside the channel owner above.
    const localA = SessionId('memory-project-a'), localB = SessionId('memory-project-b');
    const other = join(config.workspace, 'memory-project-b'); await mkdir(other, { recursive: true });
    if (config.phase === 17) {
      await ctx.sessionController.create({ sessionId: localA, cwd: config.workspace });
      await ctx.sessionController.create({ sessionId: localB, cwd: other });
    }
    for (const id of [localA, localB]) {
      const resolved = await ctx.sessionController.resolveAgent(id);
      if ('error' in resolved) throw resolved.error;
    }
    if (config.phase === 17) {
      await service.remember({ sessionId: localA, kind: 'profile', key: '数据库', text: 'private-project-a' });
      await service.remember({ sessionId: localB, kind: 'profile', key: '数据库', text: 'private-project-b' });
      await service.handle('profile/set', { key: '语言', value: 'local-global-preference' });
    }
    const a = await service.recall('数据库', 8, localA), b = await service.recall('数据库', 8, localB);
    assert.match(a, /private-project-a/); assert.doesNotMatch(a, /private-project-b|legacy-must-stay-hidden|老于/);
    assert.match(b, /private-project-b/); assert.doesNotMatch(b, /private-project-a|legacy-must-stay-hidden|老于/);
    assert.match(a, /local-global-preference/); assert.match(b, /local-global-preference/);
    assert.doesNotMatch(await service.recall('数据库', 8, sessionId), /private-project-a|private-project-b|local-global-preference/);
    const legacy = await service.handle('export', { scopeId: LEGACY_SCOPE });
    assert.match(legacy.exportJson!, /legacy-must-stay-hidden/);
    checks.push('native_cwd_project_memory_isolated', 'native_channel_identity_memory_isolated', 'global_preferences_owner_scoped', 'legacy_memory_preserved_not_injected');
    const localScope = await projectScope(config.workspace);
    const localStore = service.store.forScope(localScope);
    if (config.phase === 17) {
      for (let n = 0; n < 221; n++) await localStore.addEvent({ text: `分页记录-${n}`, tags: n === 0 ? ['旧记录标签'] : [], source: 'user' }, n);
      for (let n = 0; n < 25; n++) await localStore.recordInjection({ at: n, sessionId: localA, query: `分页日志-${n}`, profile: true, eventIds: [] });
    }
    const page = await rpc('list', { scopeId: scopeId(localScope), eventPage: 1, injectionPage: 1 });
    assert.equal(page.events.length, 20);
    assert.equal(page.injections.length, 10);
    assert.equal(page.counts.events, 221);
    const older = await rpc('list', { scopeId: scopeId(localScope), eventQuery: '旧记录标签' });
    assert.deepEqual(older.events.map(event => event.text), ['分页记录-0']);
    assert.equal((await rpc('list')).counts.events, 1, 'paged local records never enter the channel scope');
    const complete = await service.handle('export', { scopeId: scopeId(localScope), eventQuery: '旧记录标签', eventPage: 5 });
    assert.equal(JSON.parse(complete.exportJson!).events.length, 221);
    checks.push('native_memory_paging_and_full_search', 'native_memory_export_unfiltered', 'native_memory_pages_owner_isolated');
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls, checks }, null, 2));
  }
}
