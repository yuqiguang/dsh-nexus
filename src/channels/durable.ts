import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Records } from './records.js';
import { identity, parseCommand, type ChannelTransport, type DeliveryOptions, type InboundMessage, type OutboundFile } from './protocol.js';
import { ChannelError, type ChannelId, type ConnectionState, type ConnectionRecord } from './types.js';
import { readDelivery } from './files.js';

const LIMIT = 50;
const BYTE_LIMIT = 1024 * 1024;
const ATTEMPTS = 12;
const partSchema = z.object({ id: z.string(), text: z.string() });
const itemSchema = z.object({ id: z.string(), chatId: z.string(), parts: z.array(partSchema).optional(),
  file: z.object({ path: z.string(), name: z.string(), hash: z.string() }).optional(),
  next: z.number().int().nonnegative(), attempts: z.number().int().nonnegative(),
  sending: z.boolean().optional(), error: z.enum(['delivery_uncertain', 'delivery_rejected', 'delivery_file_unavailable']).optional() });
const stateSchema = z.object({ version: z.literal(1), scope: z.string(), chats: z.array(z.string()).max(50),
  received: z.array(z.string()).max(200), delivered: z.array(z.string()).max(200), pending: z.array(itemSchema).max(LIMIT) });
type State = z.infer<typeof stateSchema>;
type Item = z.infer<typeof itemSchema>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const parts = (text: string, id: string) => {
  const chars = Array.from(text), result: { id: string; text: string }[] = [];
  for (let offset = 0; offset < chars.length; offset += 3500) result.push({ id: identity(id, String(offset)), text: chars.slice(offset, offset + 3500).join('') });
  return result;
};

/** Only wire delivery data lives here. No agent state, grants, reconstructed history or executable task is stored. */
export class ChannelDeliveryStore {
  private readonly scope: string;
  private readonly key: string;
  private readonly receivedKey: string;
  constructor(private readonly records: Records, channel: ChannelId, accountId: string, ownerId: string, workspace: string) {
    this.receivedKey = `channel-received-${identity(channel, accountId, ownerId)}`;
    this.scope = identity(channel, accountId, ownerId, workspace);
    this.key = `channel-delivery-${this.scope}`;
  }
  private decode(raw: unknown): State {
    if (raw === undefined) return { version: 1, scope: this.scope, chats: [], received: [], delivered: [], pending: [] };
    const result = stateSchema.safeParse(raw);
    if (!result.success || result.data.scope !== this.scope || result.data.pending.some(item =>
      !result.data.chats.includes(item.chatId) || (!!item.file === !!item.parts) || (item.parts && (!item.parts.length || item.next >= item.parts.length)))) {
      throw new ChannelError('invalid_delivery_state');
    }
    return result.data;
  }
  async read(): Promise<State> { return this.decode(await this.records.read(this.key)); }
  async update(change: (state: State) => void): Promise<State> {
    return this.decode(await this.records.modify(this.key, async raw => { const state = this.decode(raw); change(state); return this.decode(state); }));
  }
  async admitChat(chatId: string): Promise<void> {
    await this.update(state => { if (!state.chats.includes(chatId)) { if (state.chats.length >= 50) throw new ChannelError('delivery_queue_full'); state.chats.push(chatId); } });
  }
  private decodeReceived(raw: unknown): string[] {
    if (raw === undefined) return [];
    const parsed = z.array(z.string()).max(200).safeParse(raw);
    if (!parsed.success) throw new ChannelError('invalid_delivery_state');
    return parsed.data;
  }
  async received(): Promise<readonly string[]> { return this.decodeReceived(await this.records.read(this.receivedKey)); }
  async acknowledge(id: string): Promise<void> {
    // Receipt identity does not change when the owner moves the workspace; an old platform event must not run there again.
    await this.records.modify(this.receivedKey, async raw => [...this.decodeReceived(raw).filter(x => x !== id), id].slice(-200));
  }
  async enqueue(item: Item): Promise<void> {
    await this.update(state => {
      if (!state.chats.includes(item.chatId)) throw new ChannelError('invalid_recipient');
      if (state.delivered.includes(item.id) || state.pending.some(x => x.id === item.id)) return;
      if (state.pending.length >= LIMIT || Buffer.byteLength(JSON.stringify([...state.pending, item])) > BYTE_LIMIT) throw new ChannelError('delivery_queue_full');
      state.pending.push(item);
    });
  }
  async sent(id: string): Promise<void> {
    await this.update(state => {
      const item = state.pending.find(x => x.id === id);
      if (!item) return;
      item.next++; item.attempts = 0; delete item.sending; delete item.error;
      if (item.parts && item.next < item.parts.length) return;
      state.pending = state.pending.filter(x => x.id !== id);
      state.delivered = [...state.delivered, id].slice(-200);
    });
  }
}

/** Pairing owns candidate admission and must neither restore old deliveries nor filter to the previous owner. */
export function withDeliveryRecovery(channel: 'feishu' | 'wecom', record: ConnectionRecord, workspace: string, records: Records,
  publish: (state: ConnectionState) => void, make: (state: (state: ConnectionState) => void) => ChannelTransport): ChannelTransport {
  if (channel === 'feishu' && !record.enabled) return make(publish);
  return new DurableChannelTransport(channel, record.ownerId, workspace,
    new ChannelDeliveryStore(records, channel, record.accountId, record.ownerId, workspace), publish, make);
}

/** Durable sending for Feishu/WeCom. WeChat retains its native reply-window and media protocol adapter. */
export class DurableChannelTransport implements ChannelTransport {
  private readonly raw: ChannelTransport;
  private status: ConnectionState = { phase: 'connecting' };
  private stopped = false;
  private ready = false;
  private incoming: Promise<unknown> = Promise.resolve();
  private outgoing?: Promise<void>;
  private wire: Promise<unknown> = Promise.resolve();
  private requested = false;
  private retryTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly channel: 'feishu' | 'wecom', private readonly owner: string, private readonly workspace: string,
    private readonly store: ChannelDeliveryStore, private readonly publish: (state: ConnectionState) => void,
    make: (state: (state: ConnectionState) => void) => ChannelTransport) {
    this.raw = make(state => {
      this.status = { ...this.status, ...state, ...(state.phase === 'connected' ? { error: undefined } : {}) };
      this.publish(this.status);
      if (state.phase === 'connected') this.flush();
    });
  }
  knownChats(): Promise<readonly string[]> { return this.store.read().then(state => state.chats); }
  async start(receive: (message: InboundMessage) => Promise<void>): Promise<void> {
    if (this.stopped) throw new ChannelError('connection_cancelled');
    // A crash after request acceptance but before the receipt cannot be interpreted as a definite failure.
    await this.store.update(state => { for (const item of state.pending) if (item.sending) { delete item.sending; item.error = 'delivery_uncertain'; } });
    if (this.channel === 'wecom') await this.store.admitChat(this.owner);
    this.ready = true;
    await this.health();
    await this.raw.start(message => {
      const admitted = this.incoming.catch(() => {}).then(async () => {
        if (this.stopped || message.senderId !== this.owner || message.chatType !== 'p2p' || (this.channel === 'wecom' && message.chatId !== this.owner)) return;
        const id = identity(message.chatId, message.messageId);
        if ((await this.store.received()).includes(id)) return;
        await this.store.admitChat(message.chatId);
        // Non-idempotent controls are reserved before dispatch; never replay an ambiguous /new or approval after restart.
        const control = !message.attachments?.length && parseCommand(message.text);
        if (control) await this.store.acknowledge(id);
        await receive(message);
        if (!control) await this.store.acknowledge(id);
        this.flush();
      });
      this.incoming = admitted;
      return admitted;
    });
    this.flush();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.raw.stop();
    await Promise.allSettled([this.incoming, this.outgoing, this.wire]);
  }
  private async health(): Promise<void> {
    const state = await this.store.read();
    this.status = { ...this.status, pendingDeliveries: state.pending.length, deliveryError: state.pending.find(x => x.error)?.error };
    if (!this.stopped) this.publish(this.status);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.wire.catch(() => {}).then(operation); this.wire = task; return task;
  }
  private async recipient(chatId: string): Promise<void> {
    if (this.stopped) throw new ChannelError('connection_cancelled');
    if (this.channel === 'wecom' && chatId !== this.owner) throw new ChannelError('invalid_recipient');
    // WeCom's recipient is the configured owner; Feishu chat ids must first be admitted through an owner message.
    if (this.channel === 'wecom' && chatId === this.owner) await this.store.admitChat(chatId);
    if (!(await this.store.read()).chats.includes(chatId)) throw new ChannelError('invalid_recipient');
  }
  async sendText(chatId: string, text: string, deliveryId: string, options?: DeliveryOptions): Promise<void> {
    await this.recipient(chatId);
    if (!text) return;
    if (options?.durable) {
      try { await this.store.enqueue({ id: deliveryId, chatId, parts: parts(text, deliveryId), next: 0, attempts: 0 }); }
      catch (error) { this.publish({ ...this.status, deliveryError: error instanceof ChannelError ? error.code : 'delivery_storage_failed' }); throw error; }
      await this.health(); this.flush(); return;
    }
    // Interactive prompts are never written into the outbox or retried after recovery.
    for (const part of parts(text, deliveryId)) await this.serialize(async () => {
      if (this.stopped) throw new ChannelError('connection_cancelled');
      options?.signal?.throwIfAborted();
      if (this.status.phase !== 'connected') throw new ChannelError('not_connected');
      await this.raw.sendText(chatId, part.text, part.id, options);
    });
  }
  async sendFile(chatId: string, file: OutboundFile, deliveryId: string): Promise<void> {
    await this.recipient(chatId);
    if (!file.path) throw new ChannelError('delivery_file_unavailable');
    const current = await readDelivery(this.workspace, file.path);
    if (hash(current.bytes) !== hash(file.bytes)) throw new ChannelError('delivery_file_unavailable');
    await this.store.enqueue({ id: deliveryId, chatId, file: { name: file.name, path: file.path, hash: hash(file.bytes) }, next: 0, attempts: 0 });
    await this.health(); this.flush();
  }
  async retryPending(): Promise<void> {
    if (this.stopped || this.status.phase !== 'connected') throw new ChannelError('not_connected');
    await this.serialize(async () => { await this.store.update(state => { for (const item of state.pending) { item.attempts = 0; delete item.error; } }); });
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    await this.health(); this.flush();
  }
  private flush(): void {
    if (!this.ready || this.stopped || this.status.phase !== 'connected' || this.retryTimer) return;
    this.requested = true;
    if (this.outgoing) return;
    this.outgoing = this.drain().catch(() => {
      if (!this.stopped) this.publish({ ...this.status, deliveryError: 'delivery_storage_failed' });
    }).finally(() => { this.outgoing = undefined; if (this.requested) this.flush(); });
  }
  private async drain(): Promise<void> {
    while (!this.stopped && this.status.phase === 'connected') {
      this.requested = false;
      const snapshot = await this.store.read();
      const item = snapshot.pending[0];
      if (!item || item.error === 'delivery_uncertain' || item.error === 'delivery_file_unavailable' || item.attempts >= ATTEMPTS) break;
      let sent = false;
      await this.serialize(async () => {
        if (this.stopped || this.status.phase !== 'connected') return;
        let file: OutboundFile | undefined;
        if (item.file) {
          try { file = await readDelivery(this.workspace, item.file.path); if (hash(file.bytes) !== item.file.hash) throw new Error('changed'); }
          catch {
            await this.store.update(state => { const row = state.pending.find(x => x.id === item.id); if (row) {
              delete row.file; delete row.error; delete row.sending;
              row.parts = parts('待发文件已变化、不可读取或离开原工作区，因此没有发送。请在本机会话重新交付正确文件。', row.id);
              row.next = 0; row.attempts = 0;
            } });
            this.requested = true; return;
          }
        }
        await this.store.update(state => { const row = state.pending.find(x => x.id === item.id); if (row) row.sending = true; });
        try {
          if (file) await this.raw.sendFile(item.chatId, { ...file, name: item.file!.name }, item.id);
          else { const part = item.parts![item.next]!; await this.raw.sendText(item.chatId, part.text, part.id); }
          // Never treat an accepted request as a completed user task; this only advances wire progress.
          await this.store.sent(item.id); sent = true;
        } catch (error) {
          const definite = error instanceof ChannelError && (error.code === 'delivery_rejected' || error.code === 'not_connected');
          await this.store.update(state => { const row = state.pending.find(x => x.id === item.id); if (row) {
            delete row.sending; row.attempts++; row.error = definite ? 'delivery_rejected' : 'delivery_uncertain';
          } });
          if (definite && item.attempts + 1 < ATTEMPTS && !this.stopped) {
            this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.flush(); }, Math.min(60_000, 1000 * 2 ** item.attempts));
            this.retryTimer.unref?.();
          }
        }
      });
      await this.health();
      if (!sent) break;
    }
  }
}
