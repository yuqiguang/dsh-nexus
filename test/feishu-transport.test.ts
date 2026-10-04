import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { LarkTransport, type LarkModule } from '../src/feishu/larkTransport.js';
import { identity } from '../src/channels/protocol.js';
import type { ConnectionState } from '../src/channels/types.js';

const config = { appId: 'cli_fixture', appSecret: 'secret_fixture', ownerOpenId: 'ou_owner' };

type Sent = { params?: unknown; data: { receive_id: string; msg_type: string; content: string; uuid: string } };
type Uploaded = { data: { file_type: string; file_name: string } };
type Reply = { code?: number; data?: { file_key?: string; message_id?: string } };

/** A recording stand-in for the parts of the SDK the transport builds its calls from. */
function fakeSdk() {
  const calls = { messages: [] as Sent[], files: [] as Uploaded[], closes: [] as unknown[] };
  const replies: { message?: Reply; file?: Reply } = {};
  let handlers: Record<string, (raw: unknown) => Promise<void>> = {};
  let options: Record<string, unknown> = {};
  let dispatcherInput: unknown;
  const sdk: LarkModule = {
    Client: class { im = { v1: {
      message: { create: (input: unknown): Promise<Reply> => { calls.messages.push(input as Sent); return Promise.resolve(replies.message ?? {}); } },
      file: { create: (input: unknown): Promise<Reply> => { calls.files.push(input as Uploaded); return Promise.resolve(replies.file ?? {}); } } } }; },
    EventDispatcher: class { register(next: Record<string, (raw: unknown) => Promise<void>>) { handlers = next; return this; } },
    WSClient: class { constructor(next: unknown) { options = next as Record<string, unknown>; }
      start(input: { eventDispatcher?: unknown }) { dispatcherInput = input.eventDispatcher; return Promise.resolve(); }
      close(input: { force: boolean }) { calls.closes.push(input); } },
  };
  /** Wait until start() has built the socket, then drive it to the state the test wants. */
  const settle = async () => { for (let i = 0; i < 200 && !options.onReady; i++) await delay(1); };
  const handler = (name: string) => {
    const found = handlers[name];
    if (!found) throw new Error(`no handler registered for ${name}`);
    return found;
  };
  return { sdk, calls, replies, handler, registered: (name: string) => typeof handlers[name] === 'function',
    options: () => options, dispatcher: () => dispatcherInput,
    connect: async () => { await settle(); (options.onReady as () => void)(); },
    fail: async () => { await settle(); (options.onError as () => void)(); } };
}

const event = (text: string) => ({ sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' } },
  message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } });

test('the installed Feishu SDK still exposes the surface LarkTransport builds its calls from', async () => {
  // Loaded through an indirection for the same reason the transport does: the SDK's generated declaration file is
  // tens of thousands of lines, and resolving the specifier statically makes every type check pay for it.
  const moduleName = '@larksuiteoapi/node-sdk';
  const sdk = await import(moduleName) as unknown as Record<string, unknown>;
  const silent = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(key => [key, () => {}]));
  // A dependency bump is the one change that can silently rename or drop these, and nothing else in the suite
  // loads the real SDK, so this is the only place that would notice.
  assert.equal(typeof sdk.Client, 'function', 'sdk.Client');
  assert.equal(typeof sdk.WSClient, 'function', 'sdk.WSClient');
  assert.equal(typeof sdk.EventDispatcher, 'function', 'sdk.EventDispatcher');
  type Rest = { im: { v1: { message: { create: unknown }; file: { create: unknown } } } };
  const client = new (sdk.Client as new (config: unknown) => Rest)({ ...config, logger: silent });
  assert.equal(typeof client.im.v1.message.create, 'function', 'im.v1.message.create');
  assert.equal(typeof client.im.v1.file.create, 'function', 'im.v1.file.create');
  const dispatcher = new (sdk.EventDispatcher as new (config: unknown) => { register: unknown })({ logger: silent });
  assert.equal(typeof dispatcher.register, 'function', 'EventDispatcher.register');
  const socket = new (sdk.WSClient as new (config: unknown) => { start: unknown; close: unknown })({ ...config, logger: silent });
  assert.equal(typeof socket.start, 'function', 'WSClient.start');
  assert.equal(typeof socket.close, 'function', 'WSClient.close');
});

test('Feishu connects through the SDK socket and reports the connection state it reaches', async () => {
  const fake = fakeSdk();
  const states: ConnectionState[] = [];
  const transport = new LarkTransport(config, () => {}, state => states.push(state), async () => fake.sdk);
  const started = transport.start(async () => {});
  await fake.connect();
  await started;
  assert.equal(fake.options().appId, config.appId);
  assert.equal(fake.options().handshakeTimeoutMs, 15_000);
  assert.equal(fake.options().autoReconnect, true);
  assert.equal(typeof fake.dispatcher(), 'object', 'the socket receives the dispatcher the handler was registered on');
  assert.deepEqual(states, [{ phase: 'connected' }]);
  (fake.options().onReconnecting as () => void)();
  (fake.options().onReconnected as () => void)();
  assert.deepEqual(states, [{ phase: 'connected' }, { phase: 'reconnecting' }, { phase: 'connected' }]);
  transport.stop();
  assert.deepEqual(fake.calls.closes, [{ force: true }]);
});

test('a failed Feishu connection rejects with a local code and never echoes credentials', async () => {
  const fake = fakeSdk();
  const states: ConnectionState[] = [];
  const transport = new LarkTransport(config, () => {}, state => states.push(state), async () => fake.sdk);
  const started = transport.start(async () => {});
  await fake.fail();
  await assert.rejects(started, (error: Error) => error.message === 'connection_failed' && !error.message.includes(config.appSecret));
  assert.deepEqual(states, [{ phase: 'error', error: 'connection_failed' }]);
});

test('Feishu inbound is normalized before delivery and a downstream failure is reported, not thrown', async () => {
  const fake = fakeSdk();
  const report: string[] = [];
  const received: string[] = [];
  const transport = new LarkTransport(config, code => report.push(code), () => {}, async () => fake.sdk);
  const started = transport.start(async message => {
    if (message.text === 'boom') throw new Error('downstream');
    received.push(message.text);
  });
  await fake.connect();
  assert.equal(fake.registered('im.message.receive_v1'), true, 'the receive handler is registered for im.message.receive_v1');
  const handler = fake.handler('im.message.receive_v1');
  await handler(event('hello'));
  await handler(event('boom'));
  await handler({ nonsense: true });
  assert.deepEqual(received, ['hello'], 'only the valid message reached the channel');
  assert.deepEqual(report, ['feishu_inbound_failed'], 'a downstream failure becomes a stable local code');
  transport.stop();
  await started;
});

test('Feishu text is split at 3500 characters with a distinct delivery identity per part', async () => {
  const fake = fakeSdk();
  fake.replies.message = { code: 0, data: { message_id: 'om_sent' } };
  const transport = new LarkTransport(config, () => {}, () => {}, async () => fake.sdk);
  const started = transport.start(async () => {});
  await fake.connect();
  const text = '字'.repeat(3500) + 'tail';
  await transport.sendText('oc_chat', text, 'dlv_1');
  assert.equal(fake.calls.messages.length, 2);
  const [first, second] = fake.calls.messages;
  assert.deepEqual(first!.params, { receive_id_type: 'chat_id' });
  assert.equal(first!.data.receive_id, 'oc_chat');
  assert.equal(first!.data.msg_type, 'text');
  assert.equal(first!.data.uuid, identity('dlv_1', '0'));
  assert.equal(second!.data.uuid, identity('dlv_1', '3500'));
  assert.equal(JSON.parse(first!.data.content).text + JSON.parse(second!.data.content).text, text,
    'the parts rejoin to the original text, with no character split across the boundary');
  transport.stop();
  await started;
});

test('Feishu file delivery uploads first, then posts the returned key, and rejects without a client', async () => {
  const fake = fakeSdk();
  fake.replies.file = { code: 0, data: { file_key: 'fk_1' } };
  fake.replies.message = { code: 0, data: { message_id: 'om_1' } };
  const transport = new LarkTransport(config, () => {}, () => {}, async () => fake.sdk);
  await assert.rejects(transport.sendFile('oc_chat', { name: 'r.txt', bytes: Buffer.from('x') }, 'dlv_1'), /feishu_not_connected/);
  const started = transport.start(async () => {});
  await fake.connect();
  await transport.sendFile('oc_chat', { name: 'r.txt', bytes: Buffer.from('x') }, 'dlv_1');
  assert.equal(fake.calls.files[0]!.data.file_type, 'stream');
  assert.equal(fake.calls.files[0]!.data.file_name, 'r.txt');
  assert.equal(fake.calls.messages[0]!.data.msg_type, 'file', 'the upload is followed by a file message');
  assert.deepEqual(JSON.parse(fake.calls.messages[0]!.data.content), { file_key: 'fk_1' });
  transport.stop();
  await started;
});

test('a Feishu response that is not a success is rejected with a stable local code', async () => {
  const fake = fakeSdk();
  const transport = new LarkTransport(config, () => {}, () => {}, async () => fake.sdk);
  const started = transport.start(async () => {});
  await fake.connect();
  fake.replies.message = { code: 99, data: { message_id: 'om_1' } };
  await assert.rejects(transport.sendText('oc_chat', 'hi', 'dlv_1'), /feishu_message_send_failed/);
  fake.replies.file = { code: 99 };
  await assert.rejects(transport.sendFile('oc_chat', { name: 'r.txt', bytes: Buffer.from('x') }, 'dlv_1'), /feishu_file_upload_failed/);
  fake.replies.file = { code: 0, data: {} };
  await assert.rejects(transport.sendFile('oc_chat', { name: 'r.txt', bytes: Buffer.from('x') }, 'dlv_1'), /feishu_file_upload_failed/,
    'a success code without a usable file key is still a failure');
  transport.stop();
  await started;
});
