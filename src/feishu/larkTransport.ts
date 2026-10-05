import type { FeishuConfig } from './config.js';
import { normalizeInbound } from './protocol.js';
import { identity, type ChannelTransport, type InboundMessage, type OutboundFile } from '../channels/protocol.js';
import { ChannelError, type ConnectionState } from '../channels/types.js';

type ApiResponse = { code?: number; data?: { file_key?: string; message_id?: string } };
type RestClient = { im: { v1: {
  message: { create(input: unknown): Promise<ApiResponse> };
  file: { create(input: unknown): Promise<ApiResponse> };
} } };
type Socket = { start(input: unknown): Promise<void>; close(input: { force: boolean }): void };
type Dispatcher = { register(handlers: Record<string, (raw: unknown) => Promise<void>>): Dispatcher };
export type LarkModule = {
  Client: new (config: unknown) => RestClient;
  WSClient: new (config: unknown) => Socket;
  EventDispatcher: new (config: unknown) => Dispatcher;
};

/**
 * The SDK is loaded lazily so the disabled Web-only profile never pays for it, and through an indirection so the
 * type checker does not have to load its generated declaration file (tens of thousands of lines) on every `check`.
 */
const loadLarkSdk = async (): Promise<LarkModule> => {
  const moduleName = '@larksuiteoapi/node-sdk';
  return await import(moduleName) as LarkModule;
};

export class LarkTransport implements ChannelTransport {
  private client?: RestClient;
  private socket?: Socket;
  private readonly lifetime = new AbortController();

  constructor(private readonly config: FeishuConfig, private readonly report: (code: string) => void,
    private readonly state: (state: ConnectionState) => void = () => {},
    private readonly load: () => Promise<LarkModule> = loadLarkSdk) {}

  async start(receive: (message: InboundMessage) => Promise<void>): Promise<void> {
    // Do not load the SDK or connect to Feishu in the disabled Web-only profile.
    const sdk = await this.load();
    this.lifetime.signal.throwIfAborted();
    // SDK error payloads can contain request credentials. Report stable local codes only.
    const silentLogger = Object.fromEntries(['trace', 'debug', 'info', 'warn', 'error'].map(key => [key, () => {}]));
    const credentials = { appId: this.config.appId, appSecret: this.config.appSecret, logger: silentLogger };
    this.client = new sdk.Client(credentials);
    const dispatcher = new sdk.EventDispatcher({ logger: silentLogger }).register({
      'im.message.receive_v1': async raw => {
        const message = normalizeInbound(raw);
        if (!message) return;
        try { await receive(message); }
        catch { this.report('feishu_inbound_failed'); }
      },
    });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new ChannelError('connection_cancelled'));
      const timer = setTimeout(() => finish(new ChannelError('connection_timeout')), 20_000);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      this.socket = new sdk.WSClient({ ...credentials, autoReconnect: true, handshakeTimeoutMs: 15_000,
        onReady: () => { this.state({ phase: 'connected' }); finish(); },
        onError: () => { this.state({ phase: 'error', error: 'connection_failed' }); finish(new ChannelError('connection_failed')); },
        onReconnecting: () => this.state({ phase: 'reconnecting' }),
        onReconnected: () => this.state({ phase: 'connected' }),
      });
      void this.socket.start({ eventDispatcher: dispatcher }).catch(() => finish(new ChannelError('connection_failed')));
    });
  }

  stop(): void {
    this.lifetime.abort();
    this.socket?.close({ force: true });
    this.socket = undefined;
    this.client = undefined;
  }

  async sendText(chatId: string, text: string, deliveryId: string): Promise<void> {
    const characters = Array.from(text);
    for (let offset = 0; offset < characters.length; offset += 3500) {
      await this.send(chatId, 'text', { text: characters.slice(offset, offset + 3500).join('') },
        identity(deliveryId, String(offset)));
    }
  }

  async sendFile(chatId: string, file: OutboundFile, deliveryId: string): Promise<void> {
    if (!this.client) throw new ChannelError('not_connected');
    const response = await this.client.im.v1.file.create({
      data: { file_type: 'stream', file_name: file.name, file: file.bytes },
    });
    if (response.code !== 0 || !response.data?.file_key) throw new Error('feishu_file_upload_failed');
    await this.send(chatId, 'file', { file_key: response.data.file_key }, deliveryId);
  }

  private async send(chatId: string, type: string, content: unknown, deliveryId: string): Promise<void> {
    if (!this.client) throw new ChannelError('not_connected');
    const response = await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: type, content: JSON.stringify(content), uuid: deliveryId },
    });
    if (response.code !== undefined && response.code !== 0) throw new ChannelError('delivery_rejected');
    if (response.code !== 0 || !response.data?.message_id) throw new ChannelError('delivery_uncertain');
  }
}
