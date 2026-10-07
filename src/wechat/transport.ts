import type { ChannelTransport, DeliveryOptions, DroppedAttachment, InboundAttachment, InboundMessage, OutboundFile } from '../channels/protocol.js';
import { readDelivery } from '../channels/files.js';
import { MAX_INBOUND_BYTES } from '../channels/inbox.js';
import { ChannelError, type ConnectionRecord, type ConnectionState } from '../channels/types.js';
import { WechatClient, type WechatMessage } from './client.js';
import { decryptMedia, inboundItems, mediaItem, outboundKind, prepareUpload, type WechatMediaRef } from './media.js';
import { codecLabel, silkToWav } from './voice.js';
import { WechatRequestError } from './errors.js';
import { isFileDelivery, MAX_DELIVERY_ATTEMPTS, textParts, WechatStateStore } from './state.js';
import { backoff, retryable, wait, type Wait } from './retry.js';

/** A user message before its media is fetched: text, references still on the CDN, and kinds this version does not take. */
export interface WechatInbound extends InboundMessage { media: WechatMediaRef[] }

export function normalizeWechat(message: WechatMessage): WechatInbound | undefined {
  const messageId = typeof message.message_id === 'string' ? message.message_id
    : Number.isSafeInteger(message.message_id) ? String(message.message_id) : '';
  if (!messageId || message.message_type !== 1 || message.group_id || !message.from_user_id || !message.context_token) return undefined;
  const { text, media, unsupported, transcribed } = inboundItems(message.item_list);
  if (!text && media.length === 0 && unsupported.length === 0) return undefined;
  const dropped = unsupported.map(kind => ({ kind, reason: 'unsupported' }) as DroppedAttachment);
  return { messageId, chatId: message.from_user_id, senderId: message.from_user_id, chatType: 'p2p', text, media,
    ...(dropped.length ? { dropped } : {}), ...(transcribed ? { transcribed: true } : {}) };
}

export interface WechatTransportOptions {
  now?: () => number;
  /** Channel workspace; presented files are queued as paths under it and re-read when their turn comes. */
  workspace?: string;
  /** Loopback fixtures point the CDN at a local server. */
  cdnBaseUrl?: string;
}

export class WechatTransport implements ChannelTransport {
  private readonly lifetime = new AbortController();
  private polling?: Promise<void>;
  private outgoing?: Promise<void>;
  private wire = Promise.resolve();
  private flushRequested = false;
  private verified = false;
  private status: ConnectionState = { phase: 'connecting' };
  private readonly client: WechatClient;

  private readonly now: () => number;
  private readonly workspace?: string;

  constructor(private readonly config: ConnectionRecord, private readonly state: (state: ConnectionState) => void,
    private readonly store: WechatStateStore, fetchImpl: typeof fetch = fetch, private readonly sleep: Wait = wait,
    options: WechatTransportOptions = {}) {
    this.client = new WechatClient(config.baseUrl, config.secret, fetchImpl, sleep, options.cdnBaseUrl);
    this.now = options.now ?? Date.now;
    this.workspace = options.workspace;
  }

  async start(receive: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (this.polling) return;
    this.polling = this.poll(receive).catch(error => {
      // Polling stops here on purpose: a poller conflict is only made worse by retrying, and credentials must not be invalidated for it.
      if (!this.lifetime.signal.aborted) this.publish({ phase: 'error', error: this.code(error) });
    });
  }

  async stop(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([this.polling, this.outgoing, this.wire]);
  }

  async sendText(chatId: string, text: string, deliveryId: string, options?: DeliveryOptions): Promise<void> {
    if (chatId !== this.config.ownerId) throw new ChannelError('invalid_recipient');
    if (options?.durable) {
      try { await this.store.enqueue(deliveryId, text, options.batchKey); }
      catch (error) { this.publish({ deliveryError: this.code(error) }); throw error; }
      await this.health();
      this.flush();
      return;
    }
    await this.sendWithContext(async (contextToken, signal) => {
      for (const part of textParts(text, deliveryId)) {
        signal.throwIfAborted();
        await this.client.sendText(chatId, contextToken, part.text, part.id, signal);
      }
    }, options?.signal);
  }

  /** One sender at a time, checking the latest reply allowance before touching the API. */
  private sendWithContext(send: (token: string, signal: AbortSignal, revision: number) => Promise<void>, requestSignal?: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, ...(requestSignal ? [requestSignal] : [])]);
    const sent = this.wire.then(async () => {
      signal.throwIfAborted();
      const snapshot = await this.store.read();
      if (!snapshot.contextToken) throw new ChannelError('wechat_reply_context_missing');
      if (snapshot.replyWait) throw new WechatRequestError('wechat_send_rejected', snapshot.replyWait.diagnostic);
      // The oldest verified token is not an expiry limit. Try the saved context;
      // an explicit API refusal below pauses further sends until a new owner message.
      try { await send(snapshot.contextToken, signal, snapshot.contextRevision ?? 0); }
      catch (error) {
        const code = this.code(error), diagnostic = error instanceof WechatRequestError ? error.diagnostic : undefined;
        if (code === 'wechat_send_rejected') await this.store.waitForReply(snapshot.contextRevision ?? 0, diagnostic);
        if (code === 'authentication_failed' || code === 'wechat_poller_conflict') this.publish({ phase: 'error', error: code });
        else this.publish({ deliveryError: code, deliveryDiagnostic: diagnostic });
        await this.health();
        throw error;
      }
    });
    this.wire = sent.catch(() => {});
    return sent;
  }

  /**
   * Files are always durable: the outbox keeps the workspace path, and the
   * flush loop re-reads, encrypts, uploads, and sends it when a usable reply
   * context exists. Without a workspace the bytes are sent at once instead.
   */
  async sendFile(chatId: string, file: OutboundFile, deliveryId: string): Promise<void> {
    if (chatId !== this.config.ownerId) throw new ChannelError('invalid_recipient');
    if (this.workspace && file.path) {
      try { await this.store.enqueueFile(deliveryId, { name: file.name, path: file.path }); }
      catch (error) { this.publish({ deliveryError: this.code(error) }); throw error; }
      await this.health();
      this.flush();
      return;
    }
    await this.sendWithContext(token => this.sendMedia(token, file, deliveryId));
  }

  private async sendMedia(contextToken: string, file: OutboundFile, deliveryId: string): Promise<void> {
    const kind = outboundKind(file.name);
    const upload = prepareUpload(file.bytes);
    const downloadParam = await this.client.upload(this.config.ownerId, kind, upload, this.lifetime.signal);
    await this.client.sendItem(this.config.ownerId, contextToken, mediaItem(kind, file.name, upload, downloadParam), deliveryId, this.lifetime.signal);
  }

  /** Fetch and decrypt what the user attached; a failure drops that attachment with a reason and keeps the message. */
  private async resolveMedia(message: WechatInbound): Promise<InboundMessage> {
    const { media, ...rest } = message;
    const attachments: InboundAttachment[] = [];
    const dropped: DroppedAttachment[] = [...(rest.dropped ?? [])];
    for (const ref of media) {
      if (this.lifetime.signal.aborted) throw new ChannelError('connection_cancelled');
      if (ref.declaredBytes !== undefined && ref.declaredBytes > MAX_INBOUND_BYTES) { dropped.push({ kind: ref.kind, reason: 'too_large' }); continue; }
      try {
        const ciphertext = await this.client.download(ref, MAX_INBOUND_BYTES, this.lifetime.signal);
        const plaintext = decryptMedia(ciphertext, ref.aesKey);
        if (ref.kind === 'voice') {
          // WeChat declares its own clips Speex wideband (encode_type 4 at 16 kHz); SILK is what other senders use,
          // and it is the only one of the two anything here can decode.
          const wav = await silkToWav(plaintext);
          if (!wav) {
            // A clip with no transcript is the only place the real container ever shows itself, so name what the bytes were.
            console.error(`[nexus-channels] wechat_voice_decode_failed codec=${codecLabel(plaintext)} bytes=${plaintext.length}`);
            dropped.push({ kind: 'voice', reason: 'decode_failed' }); continue;
          }
          attachments.push({ kind: 'voice', bytes: wav, ...(ref.seconds !== undefined ? { seconds: ref.seconds } : {}) });
          continue;
        }
        attachments.push({ kind: ref.kind, bytes: plaintext, ...(ref.name ? { name: ref.name } : {}) });
      } catch (error) {
        if (this.lifetime.signal.aborted) throw error;
        const code = this.code(error);
        console.error(`[nexus-channels] wechat_media_download_failed kind=${ref.kind} code=${code}`);
        dropped.push({ kind: ref.kind, reason: code === 'wechat_media_too_large' ? 'too_large' : 'download_failed' });
      }
    }
    return { ...rest, ...(attachments.length ? { attachments } : {}), ...(dropped.length ? { dropped } : {}) };
  }

  async retryPending(): Promise<void> {
    await this.store.retry();
    await this.health();
    this.flush();
  }

  private publish(patch: Partial<ConnectionState>): void {
    if (this.lifetime.signal.aborted) return;
    this.status = { ...this.status, ...patch };
    this.state({ ...this.status });
  }

  private code(error: unknown): string { return error instanceof ChannelError ? error.code : 'connection_failed'; }

  private async health(): Promise<void> {
    const snapshot = await this.store.read();
    const { pending } = snapshot;
    const held = pending.length > 0 && !snapshot.contextToken ? 'wechat_reply_context_missing' : undefined;
    const failed = pending.find(item => item.error);
    this.publish({ pendingDeliveries: pending.length, waitingForReply: !!snapshot.replyWait,
      deliveryError: snapshot.replyWait ? 'wechat_send_rejected' : held ?? failed?.error,
      deliveryDiagnostic: snapshot.replyWait?.diagnostic ?? failed?.diagnostic });
  }

  private flush(): void {
    this.flushRequested = true;
    if (this.outgoing || !this.verified || this.lifetime.signal.aborted || this.status.phase === 'error') return;
    this.flushRequested = false;
    this.outgoing = this.flushPending().catch(error => {
      if (this.lifetime.signal.aborted) return;
      const code = this.code(error);
      if (code === 'authentication_failed' || code === 'wechat_poller_conflict') this.publish({ phase: 'error', error: code });
      else this.publish({ deliveryError: code });
    }).finally(() => {
      this.outgoing = undefined;
      if (this.flushRequested) this.flush();
    });
  }

  private async flushPending(): Promise<void> {
    while (!this.lifetime.signal.aborted) {
      const snapshot = await this.store.read();
      const candidate = snapshot.pending.find(item => item.attempts < MAX_DELIVERY_ATTEMPTS);
      if (!candidate || !snapshot.contextToken || snapshot.replyWait) return;
      const item = await this.store.seal(candidate.id);
      if (!item) continue;
      const part = isFileDelivery(item) ? { id: item.id, text: '' } : item.parts[item.nextPart]!;
      let revision = snapshot.contextRevision ?? 0;
      try {
        if (isFileDelivery(item)) {
          let file: OutboundFile;
          try {
            if (!this.workspace) throw new ChannelError('delivery_outside_workspace');
            file = await readDelivery(this.workspace, item.file.path);
          } catch {
            // The source moved or changed since it was presented: tell the user in its place rather than retrying forever.
            await this.store.replaceWithText(item.id, `文件 ${item.file.name} 已不在工作区或已改动，未能回传，请在本机 DSH 查看。`);
            continue;
          }
          await this.sendWithContext(async (token, _signal, current) => { revision = current; await this.sendMedia(token, file, item.id); });
        } else {
          await this.sendWithContext(async (token, signal, current) => { revision = current; await this.client.sendText(this.config.ownerId, token, part.text, part.id, signal); });
        }
        await this.store.sent(item.id, part.id);
        await this.health();
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        if (['authentication_failed', 'wechat_poller_conflict'].includes(this.code(error))) throw error;
        const canRetry = retryable(error);
        await this.store.failed(item.id, this.code(error), canRetry, error instanceof WechatRequestError ? error.diagnostic : undefined, revision);
        await this.health();
        if (!canRetry || item.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) return;
        await this.sleep(backoff(item.attempts + 1), this.lifetime.signal);
      }
    }
  }

  private async poll(receive: (message: InboundMessage) => Promise<void>): Promise<void> {
    let failures = 0;
    while (!this.lifetime.signal.aborted) {
      try {
        const snapshot = await this.store.read();
        const updates = await this.client.updates(snapshot.cursor, this.lifetime.signal);
        if (this.lifetime.signal.aborted) return;
        if (!updates) continue;
        // Authenticate the receive channel itself. getconfig is optional typing configuration.
        if (!this.verified) {
          this.verified = true;
          this.publish({ phase: 'connected', error: undefined });
          await this.health();
          this.flush();
        }
        for (const raw of updates.msgs ?? []) {
          if (this.lifetime.signal.aborted) return;
          const normalized = normalizeWechat(raw);
          if (!normalized || normalized.senderId !== this.config.ownerId) continue;
          if ((await this.store.read()).received.includes(normalized.messageId)) continue;
          await this.store.rememberContext(raw.context_token!, this.now(), normalized.messageId);
          if (this.lifetime.signal.aborted) return;
          const message = await this.resolveMedia(normalized);
          if (this.lifetime.signal.aborted) return;
          await receive(message);
          if (this.lifetime.signal.aborted) return;
          await this.store.acknowledge(message.messageId);
        }
        if (this.lifetime.signal.aborted) return;
        if (updates.get_updates_buf !== undefined && updates.get_updates_buf !== snapshot.cursor) {
          await this.store.advanceCursor(updates.get_updates_buf);
        }
        failures = 0;
        this.publish({ phase: 'connected', error: undefined, retryAfterMs: undefined });
        await this.health();
        this.flush();
        if (!updates.msgs?.length) await this.sleep(1000, this.lifetime.signal);
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        if (error instanceof ChannelError && ['authentication_failed', 'wechat_poller_conflict', 'invalid_delivery_state'].includes(error.code)) throw error;
        const retryAfterMs = backoff(++failures);
        this.publish({ phase: 'reconnecting', error: this.code(error), retryAfterMs });
        await this.sleep(retryAfterMs, this.lifetime.signal);
      }
    }
  }
}
