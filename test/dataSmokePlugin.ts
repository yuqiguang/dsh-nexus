/**
 * The user's data leaves and comes back. Phase 25 makes some (a conversation turn, a native reminder, a native
 * storage record, a credential), exports it through the real route, adds more on top, then imports the export
 * through the real route, which only stages it. Between the phases the runner does what `scripts/start.mjs` does
 * before DSH starts: swap the staged import in. Phase 26 starts on the imported data and finds what was exported,
 * not what came after, with the replaced data kept aside.
 */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parse } from 'yaml';
import { installBridge } from '../src/dsh/bridge.js';
import { storedEvents } from '../src/dsh/history.js';
import { DshRecords } from '../src/dsh/records.js';
import { installAssistantPrompt } from '../src/assistant/prompt.js';
import { installDataRoutes } from '../src/data/index.js';
import { sessionIdFor, type ChannelIdentity, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { SessionRoster } from '../src/sessions/index.js';

export const name = 'nexus-data-smoke';
export const inject = ['schedule', 'llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'systemPrompt',
  'credentials', 'storageDomain', 'workspaceRegistry', 'connection', 'webServer'];
const owner: ChannelIdentity = { channel: 'wechat', accountId: 'wx-data-bot', ownerId: 'wx-data-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });
const userTexts = (events: readonly { type: string; data: unknown }[]) => events.flatMap(event => event.type === 'user/message'
  && (event.data as { source?: { kind?: string } }).source?.kind === 'user' ? [(event.data as { content: { type: string; text?: string }[] }).content.map(part => part.text ?? '').join('')] : []);

class FixtureModel extends LlmAdapter {
  calls = 0;
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local data fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
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
    const asked = options.messages[lastUser]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
    const answered = (callId: string) => options.messages.some(message => message.role === 'tool' && message.toolCallId === callId);
    if (asked === '一小时后提醒我喝水') {
      if (!answered('drink')) { yield* this.toolCall('drink', 'schedule_create', { title: '本地验证提醒', prompt: '喝水', after_seconds: 3600 }); return; }
      yield* this.text('好，一小时后提醒你喝水。'); return;
    }
    yield* this.text('收到。');
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  installAssistantPrompt(ctx);
  const home = dshHomePath();
  const failures: string[] = [];
  const texts: string[] = [];
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const roster = await SessionRoster.open(ctx.storageDomain);
  ctx.effect(() => () => { void roster.close(); });
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code), undefined, { sessions: roster });
  void bridge.resumeBound().catch(() => failures.push('resume_failed'));
  let restarts = 0;
  installDataRoutes({ ctx, importEnabled: true, home, dshVersion: '0.2.0-rc.2', restart: () => { restarts++; return false; }, report: message => { if (/failed/.test(message)) failures.push(message); } });
  const marker = new DshRecords(ctx.credentials, 'nexus-data-smoke');
  const archivePath = config.reportFile.replace(/\.json$/, '.zip');
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const turn = async (messageId: string, text: string) => {
      await bridge.receive(inbound(messageId, text));
      await ctx.agents.get(sessionId)!.whenIdle();
      await bridge.drain();
    };
    if (config.phase === 25) {
      await turn('d1', '一小时后提醒我喝水');
      assert.equal(texts.at(-1), '好，一小时后提醒你喝水。');
      await roster.supersede('nexus-wechat-00000000000000000000000000000000', sessionId, Date.now());
      await marker.modify('marker', async () => ({ version: 1, when: 'before-export' }));
      const exportUrl = `${origin}/api/nexus-data/export`;
      assert.equal((await fetch(exportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401, 'the export needs the login');
      assert.equal((await fetch(exportUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain', cookie }, body: '{}' })).status, 415);
      const response = await fetch(exportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: '{}' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/zip');
      const archive = Buffer.from(await response.arrayBuffer());
      await writeFile(archivePath, archive, { mode: 0o600 });
      const zip = await JSZip.loadAsync(archive);
      const names = Object.keys(zip.files);
      // The chat's session log, flushed before the read, is in it, as are native storage, the credentials and the profile's settings.
      assert.ok(names.some(path => path.startsWith('sessions/') && path.includes(`/${sessionId}/`)), 'the chat session is exported');
      assert.ok(names.includes('storages/nexus_sessions/chats/nexus-wechat-00000000000000000000000000000000.json'), 'native storage is exported');
      assert.ok(names.includes('profiles/nexus/cordis.patch.yml'));
      assert.equal(names.some(path => path.includes('session_projcache')), false);
      const credentials = parse(await zip.file('.credentials.yaml')!.async('string')) as { records: Record<string, { payload: unknown }> };
      assert.deepEqual(credentials.records['nexus-data-smoke/marker']?.payload, { version: 1, when: 'before-export' }, 'credentials travel in plain text');
      // More happens after the export: a turn, and the credential changes.
      await turn('d2', '导出之后说的话');
      await marker.modify('marker', async () => ({ version: 1, when: 'after-export' }));
      // The import only stages: nothing live changes while DSH runs, and here the process cannot restart itself.
      const importUrl = `${origin}/api/nexus-data/import`;
      assert.equal((await fetch(importUrl, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archive })).status, 401, 'the import needs the login');
      assert.equal((await fetch(importUrl, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', cookie }, body: archive })).status, 415);
      assert.deepEqual(await (await fetch(importUrl, { method: 'POST', headers: { 'Content-Type': 'application/zip', cookie }, body: Buffer.from('not a zip') })).json(), { ok: false, error: { code: 'archive_unreadable' } });
      const staged = await (await fetch(importUrl, { method: 'POST', headers: { 'Content-Type': 'application/zip', cookie }, body: archive })).json() as { ok: boolean; value: { restarting: boolean; pending: { replacedDir: string; summary: { sessions: number; credentials: number } } } };
      assert.equal(staged.ok, true, JSON.stringify(staged));
      assert.equal(staged.value.restarting, false);
      assert.equal(restarts, 1);
      assert.ok(staged.value.pending.summary.sessions >= 1);
      assert.deepEqual(userTexts(ctx.agents.get(sessionId)!.session.snapshotEvents()), ['一小时后提醒我喝水', '导出之后说的话'], 'the live session is untouched by staging');
      assert.ok((await readdir(home)).includes('import-pending.json'));
      assert.equal(await ctx.sessions.flush(ctx.agents.get(sessionId)!.session), true);
      assert.deepEqual(failures, []);
      await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls, replacedDir: staged.value.pending.replacedDir,
        checks: ['data_routes_need_login_and_their_content_type', 'export_carries_flushed_session_storage_credentials_and_settings', 'import_refuses_a_non_archive', 'import_stages_without_touching_live_data'] }, null, 2));
      return;
    }
    // Phase 26: started on the imported data.
    const replaced = (await readdir(home)).filter(name => name.startsWith('replaced-'));
    assert.equal(replaced.length, 1, 'what the import replaced is kept aside');
    assert.equal((await readdir(home)).some(name => name === 'import-pending.json' || name === 'import-staging'), false);
    const events = await storedEvents(ctx, sessionId);
    assert.deepEqual(userTexts(events), ['一小时后提醒我喝水'], 'the session is as exported: the turn after the export is not in it');
    assert.deepEqual((await ctx.schedule.list({ sessionId })).map(record => record.prompt), ['喝水'], 'the native reminder came back with it');
    assert.equal(roster.get('nexus-wechat-00000000000000000000000000000000')?.supersededBy, sessionId, 'native storage came back');
    assert.deepEqual(await marker.read('marker'), { version: 1, when: 'before-export' }, 'so did the credentials');
    // The replaced data is whole: its session has the later turn and its credential the later value.
    const keptCredentials = parse(await readFile(join(home, replaced[0]!, '.credentials.yaml'), 'utf8')) as { records: Record<string, { payload: unknown }> };
    assert.deepEqual(keptCredentials.records['nexus-data-smoke/marker']?.payload, { version: 1, when: 'after-export' });
    // The chat carries on in the imported session.
    await until(() => ctx.agents.get(sessionId) !== undefined, 10_000);
    await turn('d3', '恢复之后还在吗');
    assert.equal(texts.at(-1), '收到。');
    assert.deepEqual(userTexts(ctx.agents.get(sessionId)!.session.snapshotEvents()), ['一小时后提醒我喝水', '恢复之后还在吗']);
    assert.equal(await ctx.sessions.flush(ctx.agents.get(sessionId)!.session), true);
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
      checks: ['import_swapped_in_before_start_and_replaced_data_kept', 'imported_session_is_as_exported', 'imported_reminder_storage_and_credentials_restored', 'chat_continues_in_imported_session'] }, null, 2));
  }
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
