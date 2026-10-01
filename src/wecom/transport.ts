import type { WSClient, TextMessage } from '@wecom/aibot-node-sdk';
import type { ChannelTransport, InboundMessage, OutboundFile } from '../channels/protocol.js';
import { ChannelError, type ConnectionRecord, type ConnectionState } from '../channels/types.js';

export function normalizeWecom(body: TextMessage | undefined): InboundMessage | undefined {
  if (body?.chattype !== 'single' || body.msgtype !== 'text' || typeof body.msgid !== 'string' ||
      !body.msgid || typeof body.from?.userid !== 'string' || !body.from.userid ||
      typeof body.text?.content !== 'string' || !body.text.content.trim()) return undefined;
  return { messageId: body.msgid, chatId: body.from.userid, senderId: body.from.userid,
    chatType: 'p2p', text: body.text.content.trim() };
}

export class WecomTransport implements ChannelTransport {
  private client?: WSClient;
  private readonly lifetime = new AbortController();

  constructor(private readonly config: ConnectionRecord, private readonly state: (state: ConnectionState) => void,
    private readonly report: (code: string) => void) {}

  async start(receive: (message: InboundMessage) => Promise<void>): Promise<void> {
    const sdk = await import('@wecom/aibot-node-sdk');
    this.lifetime.signal.throwIfAborted();
    const client = this.client = new sdk.WSClient({
      botId: this.config.accountId, secret: this.config.secret,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    client.on('message.text', frame => {
      const message = normalizeWecom(frame.body);
      if (message) void receive(message).catch(() => this.report('channel_inbound_failed'));
    });
    client.on('reconnecting', () => this.state({ phase: 'reconnecting' }));
    client.on('disconnected', () => this.state({ phase: 'disconnected' }));
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.lifetime.signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new ChannelError('connection_cancelled'));
      const timer = setTimeout(() => finish(new ChannelError('connection_timeout')), 20_000);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      client.on('authenticated', () => { this.state({ phase: 'connected' }); finish(); });
      client.on('error', () => {
        this.state({ phase: 'error', error: 'connection_failed' });
        finish(new ChannelError('connection_failed'));
      });
      client.connect();
    });
  }

  stop(): void { this.lifetime.abort(); this.client?.disconnect(); this.client = undefined; }

  async sendText(chatId: string, text: string): Promise<void> {
    if (!this.client) throw new ChannelError('not_connected');
    const characters = Array.from(text);
    for (let offset = 0; offset < characters.length; offset += 3500) {
      await this.client.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: characters.slice(offset, offset + 3500).join('') } });
    }
  }

  async sendFile(chatId: string, file: OutboundFile): Promise<void> {
    if (!this.client) throw new ChannelError('not_connected');
    const media = await this.client.uploadMedia(file.bytes, { type: 'file', filename: file.name });
    await this.client.sendMediaMessage(chatId, 'file', media.media_id);
  }
}
