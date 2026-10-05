import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { ChannelSettings, type ChannelApi } from '../src/client/ChannelSettings.js';
import { channelIds, type ChannelsView } from '../src/channels/types.js';

const initial = (): ChannelsView => ({ connections: channelIds.map(channel => ({ channel, revision: 0,
  accountId: '', ownerId: '', enabled: false, configured: false, secretConfigured: false, phase: 'disconnected' })) });

async function page(t: TestContext, api: ChannelApi) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(ChannelSettings, { api })));
  const input = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const enter = async (id: string, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input(id), value);
      input(id).dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    const form = input('feishu-account').closest('form')!;
    await act(async () => { form.dispatchEvent(new dom.window.SubmitEvent('submit', {
      bubbles: true, cancelable: true, submitter: form.querySelector('button[value="connect"]')!,
    })); });
  };
  return { dom, input, enter, submit };
}

test('settings forms save connection fields, clear entered secrets, and expose QR start/cancel', async t => {
  let view = initial();
  const calls: { method: string; payload: any }[] = [];
  const api: ChannelApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'save') view = { ...view, connections: view.connections.map(connection => connection.channel === payload.channel
      ? { ...connection, accountId: payload.config.accountId, ownerId: payload.config.ownerId,
        revision: connection.revision + 1, enabled: payload.connect, configured: true, secretConfigured: true, phase: 'connecting' } : connection) };
    if (method === 'qr/start') view = { ...view, wechatQr: { phase: 'waiting', image: 'data:image/png;base64,fixture' } };
    if (method === 'qr/cancel') view = { connections: view.connections };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  assert.deepEqual([...ui.dom.window.document.querySelectorAll('h3')].map(item => item.textContent), ['微信', '飞书', '企业微信']);
  await ui.enter('feishu-account', 'cli_0123456789abcdef');
  await ui.enter('feishu-secret', 'typed-secret-fixture');
  await act(async () => (ui.dom.window.document.querySelector('input[type=checkbox]') as HTMLInputElement).click());
  await ui.enter('feishu-owner', 'ou_owner');
  await ui.submit();
  const save = calls.find(call => call.method === 'save')!;
  assert.equal(save.payload.connect, true);
  assert.equal(save.payload.config.ownerId, 'ou_owner');
  assert.equal(save.payload.config.secret, 'typed-secret-fixture');
  assert.equal(ui.input('feishu-secret').value, '');
  await ui.enter('feishu-owner', 'ou_new_owner');
  await ui.submit();
  assert.equal(Object.hasOwn(calls.filter(call => call.method === 'save').at(-1)!.payload.config, 'secret'), false);
  const button = (text: string) => [...ui.dom.window.document.querySelectorAll('button')].find(item => item.textContent === text)!;
  await act(async () => button('扫码连接').click());
  assert.ok(ui.dom.window.document.querySelector('img[alt="微信连接二维码"]'));
  await act(async () => button('取消扫码').click());
  assert.equal(ui.dom.window.document.querySelector('img[alt="微信连接二维码"]'), null);
});

test('a slow status read cannot restore old settings after a successful save', async t => {
  let view = initial();
  view.connections[1] = { ...view.connections[1]!, revision: 1, configured: true, secretConfigured: true,
    accountId: 'cli_0123456789abcdef', ownerId: 'ou_old' };
  let reads = 0;
  let release!: (value: ChannelsView) => void;
  const old = structuredClone(view);
  const api: ChannelApi = async (method, payload: any) => {
    if (method === 'list' && ++reads === 2) return new Promise(resolve => { release = resolve; });
    if (method === 'save') view.connections[1] = { ...view.connections[1]!, revision: 2, ownerId: payload.config.ownerId, enabled: true, phase: 'connected' };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  await act(async () => { await delay(1600); });
  assert.ok(release);
  await act(async () => (ui.dom.window.document.querySelector('input[type=checkbox]') as HTMLInputElement).click());
  await ui.enter('feishu-owner', 'ou_updated');
  await ui.submit();
  await act(async () => release(old));
  assert.equal(ui.input('feishu-owner').value, 'ou_updated');
  assert.equal(ui.input('feishu-secret').value, '');
  assert.match(ui.input('feishu-owner').closest('article')!.textContent!, /已连接/);
});

test('WeChat pending replies expose a revision-scoped retry and clear after delivery', async t => {
  const view = initial();
  view.connections[0] = { ...view.connections[0]!, revision: 7, enabled: true, configured: true,
    secretConfigured: true, phase: 'connected', pendingDeliveries: 2, deliveryError: 'server_unavailable' };
  const calls: { method: string; payload: unknown }[] = [];
  const ui = await page(t, async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'retry-delivery') view.connections[0] = { ...view.connections[0]!, pendingDeliveries: 0, deliveryError: undefined };
    return structuredClone(view);
  });
  const card = ui.dom.window.document.querySelector('article')!;
  assert.match(card.textContent!, /有 2 条回复待发送/);
  assert.match(card.textContent!, /微信服务暂时不可用/);
  assert.match(card.textContent!, /消息尚未送达不代表编码任务失败/);
  assert.match(card.textContent!, /只补发已保存的未发送部分.*不会重新执行任务.*不会重放审批提示/);
  const retry = [...card.querySelectorAll('button')].find(button => button.textContent === '重试发送')!;
  assert.equal(retry.disabled, false);
  await act(async () => retry.click());
  assert.deepEqual(calls.find(call => call.method === 'retry-delivery')?.payload, { channel: 'wechat', revision: 7 });
  assert.doesNotMatch(card.textContent!, /回复待发送|微信服务暂时不可用|重试发送/);
});

test('authenticated WeChat with refused sends shows reply recovery and numeric diagnostics without enabling blind retry', async t => {
  const view = initial();
  view.connections[0] = { ...view.connections[0]!, enabled: true, configured: true, secretConfigured: true, phase: 'connected',
    pendingDeliveries: 4, waitingForReply: true, deliveryError: 'wechat_send_rejected',
    deliveryDiagnostic: { operation: 'send', httpStatus: 200, ret: -54321 } };
  const ui = await page(t, async () => view);
  const card = ui.dom.window.document.querySelector('article')!;
  assert.match(card.textContent!, /收消息连接已认证，发送已暂停/);
  assert.match(card.textContent!, /原绑定微信账号发送一条新消息/);
  assert.match(card.textContent!, /HTTP 200，ret=-54321/);
  assert.match(card.textContent!, /旧审批提示不会补发/);
  assert.equal([...card.querySelectorAll('button')].find(button => button.textContent === '重试发送')!.disabled, true);
});

test('pending delivery cannot retry before authentication or with an expired reply window', async t => {
  for (const state of [
    { phase: 'reconnecting' as const, error: 'connection_failed', deliveryError: 'server_unavailable', expected: /等待连接通过认证/ },
    { phase: 'error' as const, error: 'authentication_failed', deliveryError: 'server_unavailable', expected: /原绑定账号重新扫码/ },
    { phase: 'connected' as const, error: undefined, deliveryError: 'wechat_context_stale', expected: /原绑定微信账号发送一条新消息/ },
  ]) {
    await t.test(`${state.phase}: ${state.deliveryError}`, async t => {
    const view = initial();
    view.connections[0] = { ...view.connections[0]!, revision: 7, enabled: true, configured: true, secretConfigured: true,
      pendingDeliveries: 1, phase: state.phase, error: state.error, deliveryError: state.deliveryError };
    const calls: string[] = [];
    const ui = await page(t, async method => { calls.push(method); return structuredClone(view); });
    const card = ui.dom.window.document.querySelector('article')!;
    const retry = [...card.querySelectorAll('button')].find(button => button.textContent === '重试发送')!;
    assert.equal(retry.disabled, true);
    assert.match(card.textContent!, state.expected);
    await act(async () => retry.click());
    assert.deepEqual(calls, ['list']);
    });
  }
});

test('a channel workspace is edited in its own form, with the directory in effect as the current value', async t => {
  let view = initial();
  view.connections[1] = { ...view.connections[1]!, revision: 4, configured: true, secretConfigured: true, workspaceRoot: '/shared/workspace' };
  const calls: { method: string; payload: any }[] = [];
  const api: ChannelApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'save-workspace') {
      // The server refuses anything but an absolute path, exactly as the store does.
      if (payload.workspaceRoot && !isAbsolute(payload.workspaceRoot)) throw new Error('invalid_workspace');
      view = { ...view, connections: view.connections.map(connection => connection.channel === payload.channel
        ? { ...connection, revision: connection.revision + 1, workspaceRoot: payload.workspaceRoot || '/shared/workspace' } : connection) };
    }
    return structuredClone(view);
  };
  const ui = await page(t, api);
  const field = ui.input('feishu-workspace') as HTMLInputElement;
  const form = field.closest('form')!;
  const submitWorkspace = async () => { await act(async () => { form.dispatchEvent(new ui.dom.window.SubmitEvent('submit',
    { bubbles: true, cancelable: true, submitter: form.querySelector('button[type="submit"]')! })); }); };
  assert.equal(field.value, '/shared/workspace', 'the directory in effect is what the page shows');
  assert.equal([...ui.dom.window.document.querySelectorAll('button')].some(button => button.textContent === '保存工作区' && !button.disabled), false,
    'an untouched workspace is not offered for saving');
  await ui.enter('feishu-workspace', 'relative/path');
  await submitWorkspace();
  assert.deepEqual(calls.filter(call => call.method === 'save-workspace').map(call => call.payload),
    [{ channel: 'feishu', revision: 4, workspaceRoot: 'relative/path' }]);
  assert.match(ui.dom.window.document.body.textContent!, /工作区目录要写绝对路径/, 'the server’s reason reaches the page');
  assert.equal(field.value, 'relative/path', 'a refused save keeps the draft for editing');
  await ui.enter('feishu-workspace', '/home/you/nexus-feishu');
  await submitWorkspace();
  assert.deepEqual(calls.filter(call => call.method === 'save-workspace').at(-1)!.payload,
    { channel: 'feishu', revision: 4, workspaceRoot: '/home/you/nexus-feishu' });
  assert.equal(field.value, '/home/you/nexus-feishu');
  assert.doesNotMatch(ui.dom.window.document.body.textContent!, /要写绝对路径/);
});

test('a failed configured WeChat connection can reconnect without scanning again', async t => {
  const view = initial();
  view.connections[0] = { ...view.connections[0]!, revision: 3, enabled: true, configured: true,
    secretConfigured: true, phase: 'error', error: 'wechat_request_failed' };
  const calls: { method: string; payload: unknown }[] = [];
  const ui = await page(t, async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'connect') view.connections[0] = { ...view.connections[0]!, revision: 4, phase: 'connecting', error: undefined };
    return structuredClone(view);
  });
  const card = ui.dom.window.document.querySelector('article')!;
  const reconnect = [...card.querySelectorAll('button')].find(button => button.textContent === '重新连接');
  assert.ok(reconnect, 'a saved grant must offer reconnection without QR login');
  await act(async () => reconnect.click());
  assert.deepEqual(calls.find(call => call.method === 'connect')?.payload, { channel: 'wechat', revision: 3 });
  assert.ok(calls.every(call => call.method !== 'qr/start'));
  assert.match(card.textContent!, /连接中/);
});

test('Feishu default setup pairs without an open_id and confirms only the received candidate', async t => {
  let view = initial();
  const calls: { method: string; payload: any }[] = [];
  const api: ChannelApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'feishu/pair/start') view = { connections: view.connections.map(item => item.channel === 'feishu'
      ? { ...item, revision: 1, accountId: payload.config.accountId, secretConfigured: true } : item),
      feishuPairing: { id: 'pair-fixture', revision: 1, phase: 'waiting', expiresAt: Date.now() + 600000, code: 'DSH-1234-5678-ABCD-EF00-0000' } };
    if (method === 'feishu/pair/confirm') view = { connections: view.connections.map(item => item.channel === 'feishu'
      ? { ...item, revision: 2, ownerId: 'ou_paired', enabled: true, configured: true, phase: 'connecting' } : item) };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  assert.equal(ui.input('feishu-owner'), null, 'default setup must not require users to find open_id');
  await ui.enter('feishu-account', 'cli_0123456789abcdef'); await ui.enter('feishu-secret', 'fixture-private-secret'); await ui.submit();
  const start = calls.find(call => call.method === 'feishu/pair/start'); assert.ok(start);
  assert.equal(start.payload.config.ownerId, ''); assert.equal(ui.input('feishu-secret').value, '');
  assert.match(ui.dom.window.document.body.textContent!, /私聊发送/);
  assert.equal([...ui.dom.window.document.querySelectorAll('button')].some(button => button.textContent === '确认绑定并连接'), false);
  view.feishuPairing = { id: 'pair-fixture', revision: 1, phase: 'confirm', expiresAt: Date.now() + 600000, candidateOpenId: 'ou_paired' };
  await act(async () => { await delay(1600); });
  const confirm = [...ui.dom.window.document.querySelectorAll('button')].find(button => button.textContent === '确认绑定并连接')!;
  assert.ok(confirm); await act(async () => confirm.click());
  assert.deepEqual(calls.find(call => call.method === 'feishu/pair/confirm')!.payload, { id: 'pair-fixture', revision: 1 });
  assert.match(ui.dom.window.document.body.textContent!, /已绑定飞书用户/);
  assert.equal(ui.dom.window.document.querySelector('[aria-label="飞书配对码"]'), null);
});

test('Feishu pairing cancellation is scoped to the visible challenge and never saves a typed owner', async t => {
  let view = initial();
  view.feishuPairing = { id: 'current-pair', revision: 3, phase: 'waiting', expiresAt: Date.now() + 600000, code: 'DSH-1234-5678-ABCD-EF00-0000' };
  const calls: { method: string; payload: unknown }[] = [];
  const ui = await page(t, async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'feishu/pair/cancel') view = { connections: view.connections };
    return structuredClone(view);
  });
  const cancel = [...ui.dom.window.document.querySelectorAll('button')].find(button => button.textContent === '取消配对')!;
  await act(async () => cancel.click());
  assert.deepEqual(calls.find(call => call.method === 'feishu/pair/cancel')!.payload, { id: 'current-pair', revision: 3 });
  assert.equal(ui.dom.window.document.querySelector('[aria-label="飞书配对码"]'), null);
  assert.ok(!calls.some(call => call.method === 'save'));
});


for (const channel of ['feishu', 'wecom'] as const) {
  test(`${channel} shows durable delivery recovery and retries only that configured connection`, async t => {
    const view = initial();
    view.connections = view.connections.map(connection => connection.channel === channel
      ? { ...connection, enabled: true, configured: true, phase: 'connected', pendingDeliveries: 2, deliveryError: 'delivery_uncertain' } : connection);
    const calls: { method: string; payload: unknown }[] = [];
    const ui = await page(t, async (method, payload) => { calls.push({ method, payload }); return structuredClone(view); });
    assert.match(ui.dom.window.document.body.textContent!, /无法确认平台是否已接收上一分片/);
    const button = [...ui.dom.window.document.querySelectorAll('button')].find(button => button.textContent === '重试发送（可能重复上一分片）')!;
    assert.ok(button && !button.disabled);
    await act(async () => button.click());
    assert.deepEqual(calls.at(-1), { method: 'retry-delivery', payload: { channel, revision: view.connections.find(connection => connection.channel === channel)!.revision } });
  });
}
