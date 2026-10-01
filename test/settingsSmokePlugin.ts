/** Real DSH settings/credentials/HTTP boundaries, with local-only channel and model fixtures. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { LlmAdapter, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installChannels, installCoderSettings } from '../src/plugin.js';
import { chmod, mkdir, writeFile as writeFixture } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { WechatClient } from '../src/wechat/client.js';
import { sessionIdFor, type InboundMessage } from '../src/channels/protocol.js';
import type { ChannelId, ChannelsView, ConnectionState } from '../src/channels/types.js';

export const name = 'nexus-settings-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'credentials', 'connection', 'webServer', 'agents', 'tools', 'sandboxPolicy'];
const feishuSecret = 'local-feishu-secret-fixture';
const coderKey = 'local-coder-token-fixture';
const wechatToken = 'local-wechat-token-fixture';

class Fixture extends LlmAdapter {
  calls = 0;
  restored = false;
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local channel fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 512 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls++;
    this.restored = options.messages.some(message => message.source?.kind === 'model' &&
      message.content.some(block => block.type === 'text' && block.text.includes('渠道文本回复')));
    const text = '渠道文本回复';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new Fixture();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  const started: ChannelId[] = [];
  const receivers = new Map<ChannelId, (message: InboundMessage) => Promise<void>>();
  const states = new Map<ChannelId, (state: ConnectionState) => void>();
  const replies: { channel: ChannelId; text: string }[] = [];
  const manager = await installChannels(ctx, config.workspace, undefined, {
    transport(channel, record, state) {
      states.set(channel, state);
      if (channel === 'feishu') assert.equal(record.secret, feishuSecret);
      if (channel === 'wechat') assert.equal(record.secret, wechatToken);
      return {
        async start(receive) { started.push(channel); receivers.set(channel, receive); state({ phase: 'connected' }); },
        stop() { receivers.delete(channel); },
        async sendText(_chatId, text) { replies.push({ channel, text }); }, async sendFile() {},
      };
    },
    wechatClient: () => new WechatClient(undefined, undefined, async url => Response.json(String(url).includes('get_bot_qrcode')
      ? { qrcode: 'native-settings-qr-fixture' }
      : { status: 'confirmed', bot_token: wechatToken, baseurl: 'https://ilinkai.weixin.qq.com',
        ilink_user_id: 'wx-native-owner', ilink_bot_id: 'wx-native-bot' })),
  });
  // Coder settings share the carrier; detection sees a scripted codex on PATH and no plugin SDK, so the result does not depend on the machine.
  const fixtureBin = joinPath(config.workspace, 'fixture-bin');
  await mkdir(fixtureBin, { recursive: true });
  await writeFixture(joinPath(fixtureBin, 'codex'), '#!/bin/sh\necho "codex-cli 0.0.0-smoke"\n');
  await chmod(joinPath(fixtureBin, 'codex'), 0o755);
  const coders = await installCoderSettings(ctx, [config.workspace], undefined, { env: { ...process.env, PATH: fixtureBin },
    detect: { pluginSdk: async () => undefined }, loginStatus: async () => 'Logged in using an API key - sk-smoke***' });
  let running = false;
  const timer = setInterval(() => {
    void readFile(config.triggerFile).then(() => {
      if (running) return;
      running = true; clearInterval(timer);
      void run().catch(async error => { await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error) })); });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
    assert.equal(exchange.status, 303);
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const html = await (await fetch(origin, { headers: { cookie } })).text();
    assert.ok(html.includes('nexus-next'), 'custom settings bundle must enter the official boot graph');
    const envelope = (method: string, payload = {}) => JSON.stringify({ type: 'client-request', rpcId: 'settings-smoke', method, payload });
    const anonymous = await fetch(`${origin}/api/nexus-channels/list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: envelope('list'),
    });
    assert.equal(anonymous.status, 401);
    const crossOrigin = await fetch(`${origin}/api/nexus-channels/list`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie, Origin: 'https://invalid.example' }, body: envelope('list'),
    });
    assert.equal(crossOrigin.status, 403);
    const invalidEnvelope = await fetch(`${origin}/api/nexus-channels/save`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: envelope('list'),
    });
    assert.equal(invalidEnvelope.status, 400);
    const wrongType = await fetch(`${origin}/api/nexus-channels/save`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain', cookie }, body: envelope('save'),
    });
    assert.equal(wrongType.status, 415);
    async function call(method: string, payload = {}, errorCode?: string): Promise<ChannelsView> {
      const response = await fetch(`${origin}/api/nexus-channels/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: envelope(method, payload),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(body.rpcId, 'settings-smoke');
      if (errorCode) { assert.equal(body.result.error?.code, errorCode); return (await manager.view()); }
      assert.equal(body.result.ok, true, body.result.error?.code);
      const json = JSON.stringify(body);
      assert.ok(!json.includes(feishuSecret) && !json.includes(wechatToken), 'RPC responses must not disclose keys');
      return body.result.value as ChannelsView;
    }
    const coderCall = async (method: string, payload: object = {}, errorCode?: string) => {
      const response = await fetch(`${origin}/api/nexus-coders/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: envelope(method, payload),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      if (errorCode) { assert.equal(body.result.error?.code, errorCode); return coders.view(); }
      assert.equal(body.result.ok, true, body.result.error?.code);
      assert.ok(!JSON.stringify(body).includes(coderKey), 'coder RPC responses must not disclose keys');
      return body.result.value as Awaited<ReturnType<typeof coders.view>>;
    };
    const anonymousCoders = await fetch(`${origin}/api/nexus-coders/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: envelope('list') });
    assert.equal(anonymousCoders.status, 401);
    let view = await call('list');
    if (config.phase === 3) {
      let coderView = await coderCall('list');
      assert.deepEqual([coderView.codex.system.installed, coderView.codex.system.version, coderView.codex.active, coderView.codex.fallback],
        [true, '0.0.0-smoke', 'system', true]);
      assert.equal(coderView.codex.login, 'Logged in using an API key - sk-smoke***');
      assert.deepEqual([coderView.claude.active, coderView.claude.ready], ['none', false]);
      assert.deepEqual(coderView.effectiveRoots, [config.workspace]);
      coderView = await coderCall('save', { revision: 0, config: { defaultCoder: 'claude', roots: `${config.workspace}\n`,
        codex: { source: 'system', model: 'smoke-model' }, claude: { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', authHeader: 'auth-token', token: coderKey } } });
      assert.deepEqual([coderView.settings.revision, coderView.settings.defaultCoder, coderView.settings.claude.tokenConfigured, coderView.settings.codex.model],
        [1, 'claude', true, 'smoke-model']);
      assert.equal(coderView.claude.login, '使用设置里的 token，端点 https://api.deepseek.com/anthropic');
      await coderCall('save', { revision: 0, config: {} }, 'configuration_changed');
      await coderCall('install', { coder: 'other' }, 'invalid_configuration');
      const stored = await ctx.credentials.readRecord(credentialKey('nexus-coders', 'coders'));
      assert.equal(stored?.kind, 'grant');
      assert.ok(view.connections.every(item => !item.configured));
      view = await call('save', { channel: 'feishu', revision: 0, connect: false,
        config: { accountId: 'cli_0123456789abcdef', ownerId: 'ou_native_owner', secret: feishuSecret } });
      assert.equal(started.length, 0, 'save-only must not connect');
      await call('save', { channel: 'feishu', revision: 0, connect: true,
        config: { accountId: 'cli_0123456789abcdef', ownerId: 'ou_native_owner', secret: 'must-not-be-saved' } }, 'configuration_changed');
      await call('connect', { channel: 'feishu', revision: 1 });
      await call('save', { channel: 'wecom', revision: 0, connect: true,
        config: { accountId: 'wc-native-bot', ownerId: 'wc-native-owner', secret: 'local-wecom-secret-fixture' } });
      await call('qr/start', { revision: 0 });
      for (let count = 0; count < 100 && (await manager.view()).wechatQr?.phase !== 'connected'; count++) await delay(20);
      assert.equal((await manager.view()).wechatQr?.phase, 'connected');
      for (const channel of ['wechat', 'wecom'] as const) await prompt(channel, 'channel-message-1');
      assert.equal(model.calls, 2);
      for (const channel of ['wechat', 'wecom']) assert.ok(replies.some(item => item.channel === channel && item.text === '渠道文本回复'));
      view = await call('disconnect', { channel: 'wecom', revision: 1 });
      states.get('wecom')!({ phase: 'connected' });
      assert.equal((await call('list')).connections.find(item => item.channel === 'wecom')?.phase, 'disconnected');
    } else {
      const coderView = await coderCall('list');
      assert.deepEqual([coderView.settings.revision, coderView.settings.defaultCoder, coderView.settings.claude.tokenConfigured, coderView.settings.claude.model],
        [1, 'claude', true, 'deepseek-flash']);
      assert.deepEqual(coderView.effectiveRoots, [config.workspace]);
      assert.deepEqual(started.sort(), ['feishu', 'wechat']);
      assert.ok(view.connections.every(item => item.configured));
      assert.equal(view.connections.find(item => item.channel === 'wecom')?.enabled, false);
      assert.equal(view.connections.find(item => item.channel === 'wechat')?.ownerId, 'wx-native-owner');
      await prompt('wechat', 'channel-message-1');
      assert.equal(model.calls, 0, 'restored channel must reuse native request deduplication');
      await prompt('wechat', 'channel-message-2');
      assert.equal(model.calls, 1);
      assert.equal(model.restored, true);
    }
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, modelCalls: model.calls,
      checks: config.phase === 3 ? ['settings_client_boot_graph', 'settings_requires_login', 'settings_rejects_cross_origin',
        'settings_rejects_invalid_envelopes',
        'settings_save_without_connect', 'settings_secret_redaction', 'settings_stale_write_refused',
        'wechat_qr_owner_binding', 'wechat_native_session', 'wecom_native_session', 'disconnect_ignores_late_events',
        'coder_settings_requires_login', 'coder_settings_detects_installs', 'coder_settings_save_redacted', 'coder_settings_stale_write_refused']
        : ['saved_connections_restored', 'disabled_connection_stays_off', 'wechat_owner_restored', 'wechat_restart_deduplication', 'wechat_native_history_restored',
          'coder_settings_restored'],
    }, null, 2));
  }

  async function prompt(channel: 'wechat' | 'wecom', messageId: string) {
    const item = (await manager.view()).connections.find(item => item.channel === channel)!;
    const sessionId = SessionId(sessionIdFor(item.accountId, item.ownerId, item.ownerId, channel));
    // The QR view says "connected" before the channel is mounted and its transport started (the manager sets it,
    // then applies the record), so the first message waits for the transport rather than for the view.
    for (let count = 0; count < 100 && !receivers.has(channel); count++) await delay(20);
    await receivers.get(channel)!({ messageId, chatId: item.ownerId, senderId: item.ownerId, chatType: 'p2p', text: '本地渠道联调' });
    const found = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in found) throw found.error;
    await found.agent.whenIdle();
    assert.equal(await ctx.sessions.flush(found.agent.session), true);
    // Delivery follows the durable turn/end event on the channel's microtask chain.
    await delay(30);
  }
}
