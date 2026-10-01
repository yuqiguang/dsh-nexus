import type { Records } from '../channels/records.js';
import { identity, sessionIdFor } from '../channels/protocol.js';
import { ChannelError } from '../channels/types.js';

export const MAX_DELIVERY_ATTEMPTS = 12;
const MAX_PENDING = 50;
const MAX_PENDING_BYTES = 1024 * 1024;
const RECEIPT_LIMIT = 200;
export interface TextPart { id: string; text: string }
export interface PendingText { id: string; parts: TextPart[]; nextPart: number; attempts: number; error?: string }
/** A presented file waits as a workspace reference, never as bytes inside the credentials file; it is re-read when sent. */
export interface PendingFile { id: string; file: { name: string; path: string }; attempts: number; error?: string }
export type PendingDelivery = PendingText | PendingFile;
export function isFileDelivery(item: PendingDelivery): item is PendingFile { return 'file' in item; }
export interface WechatState {
  version: 1;
  accountId: string;
  ownerId: string;
  cursor: string;
  contextToken?: string;
  /** When the current context token arrived; iLink silently drops sends whose token is too old. */
  contextAt?: number;
  received: string[];
  pending: PendingDelivery[];
  delivered: string[];
}

/** Preserve exact wire parts and client IDs across retries and future chunker changes. */
export function textParts(text: string, deliveryId: string): TextPart[] {
  const characters = Array.from(text);
  const parts: TextPart[] = [];
  for (let offset = 0; offset < characters.length; offset += 800) {
    parts.push({ id: identity(deliveryId, String(offset)), text: characters.slice(offset, offset + 800).join('') });
  }
  return parts;
}

/**
 * The base sessions this person had under earlier bot accounts. Scanning the QR code again can bind a
 * new bot account, a WeChat session id is derived from the account, and so the chat starts a new line of
 * sessions; each earlier account left its delivery record behind, naming the account and the person.
 */
export async function formerWechatBases(records: Records, current: { accountId: string; ownerId: string }): Promise<string[]> {
  const bases = new Set<string>();
  for (const { value } of await records.list?.('wechat-delivery-') ?? []) {
    const state = value as Partial<WechatState> | undefined;
    if (typeof state?.accountId !== 'string' || !state.accountId || state.ownerId !== current.ownerId || state.accountId === current.accountId) continue;
    bases.add(sessionIdFor(state.accountId, state.ownerId, state.ownerId, 'wechat'));
  }
  return [...bases];
}

/** Transport receipts only: no task status, model history, or replay of an agent operation. */
export class WechatStateStore {
  private readonly key: string;
  constructor(private readonly records: Records, private readonly accountId: string, private readonly ownerId: string) {
    this.key = `wechat-delivery-${identity(accountId, ownerId)}`;
  }

  private decode(raw: unknown): WechatState {
    if (raw === undefined) return { version: 1, accountId: this.accountId, ownerId: this.ownerId,
      cursor: '', received: [], pending: [], delivered: [] };
    const state = raw as WechatState;
    if (!state || state.version !== 1 || state.accountId !== this.accountId || state.ownerId !== this.ownerId ||
      typeof state.cursor !== 'string' || (state.contextToken !== undefined && typeof state.contextToken !== 'string') ||
      (state.contextAt !== undefined && !Number.isSafeInteger(state.contextAt)) ||
      !Array.isArray(state.received) || !state.received.every(id => typeof id === 'string') ||
      !Array.isArray(state.delivered) || !state.delivered.every(id => typeof id === 'string') ||
      !Array.isArray(state.pending) || !state.pending.every(item => item && typeof item.id === 'string' &&
        Number.isSafeInteger(item.attempts) && item.attempts >= 0 && (isFileDelivery(item)
          ? item.file && typeof item.file.name === 'string' && typeof item.file.path === 'string'
          : Number.isSafeInteger(item.nextPart) && item.nextPart >= 0 && Array.isArray(item.parts) && item.nextPart < item.parts.length &&
            item.parts.every(part => part && typeof part.id === 'string' && typeof part.text === 'string')))) {
      throw new ChannelError('invalid_delivery_state');
    }
    return structuredClone(state);
  }

  async read(): Promise<WechatState> { return this.decode(await this.records.read(this.key)); }

  private async update(change: (state: WechatState) => void): Promise<WechatState> {
    return this.decode(await this.records.modify(this.key, async raw => {
      const state = this.decode(raw);
      change(state);
      return state;
    }));
  }

  /** Every inbound message refreshes the token's age; a new token also gives paused deliveries another chance. */
  async rememberContext(token: string, at = Date.now()): Promise<void> {
    await this.update(state => {
      state.contextAt = at;
      if (state.contextToken !== token) {
        state.contextToken = token;
        for (const item of state.pending) { item.attempts = 0; delete item.error; }
      }
    });
  }

  async acknowledge(messageId: string): Promise<void> {
    await this.update(state => { state.received = [...state.received.filter(id => id !== messageId), messageId].slice(-RECEIPT_LIMIT); });
  }

  async advanceCursor(cursor: string): Promise<void> {
    await this.update(state => { state.cursor = cursor; });
  }

  private static queued(state: WechatState): number {
    return state.pending.reduce((sum, item) => sum + (isFileDelivery(item) ? Buffer.byteLength(item.file.path)
      : item.parts.reduce((n, part) => n + Buffer.byteLength(part.text), 0)), 0);
  }

  async enqueue(id: string, text: string): Promise<void> {
    if (!text) return;
    await this.update(state => {
      if (state.delivered.includes(id) || state.pending.some(item => item.id === id)) return;
      if (state.pending.length >= MAX_PENDING || WechatStateStore.queued(state) + Buffer.byteLength(text) > MAX_PENDING_BYTES) throw new ChannelError('delivery_queue_full');
      state.pending.push({ id, parts: textParts(text, id), nextPart: 0, attempts: 0 });
    });
  }

  async enqueueFile(id: string, file: { name: string; path: string }): Promise<void> {
    await this.update(state => {
      if (state.delivered.includes(id) || state.pending.some(item => item.id === id)) return;
      if (state.pending.length >= MAX_PENDING || WechatStateStore.queued(state) + Buffer.byteLength(file.path) > MAX_PENDING_BYTES) throw new ChannelError('delivery_queue_full');
      state.pending.push({ id, file: { name: file.name, path: file.path }, attempts: 0 });
    });
  }

  async sent(id: string, partId: string): Promise<void> {
    await this.update(state => {
      const item = state.pending.find(item => item.id === id);
      if (!item) return;
      if (isFileDelivery(item)) {
        if (partId !== id) return;
      } else {
        if (item.parts[item.nextPart]?.id !== partId) return;
        item.nextPart++;
        item.attempts = 0;
        delete item.error;
        if (item.nextPart < item.parts.length) return;
      }
      state.pending = state.pending.filter(item => item.id !== id);
      state.delivered = [...state.delivered, id].slice(-RECEIPT_LIMIT);
    });
  }

  /** A file that can no longer be sent becomes the notice the user sees in its place, under the same delivery id. */
  async replaceWithText(id: string, text: string): Promise<void> {
    await this.update(state => {
      const index = state.pending.findIndex(item => item.id === id);
      if (index === -1) return;
      state.pending[index] = { id, parts: textParts(text, id), nextPart: 0, attempts: 0 };
    });
  }

  async failed(id: string, code: string, retryable: boolean): Promise<void> {
    await this.update(state => {
      const item = state.pending.find(item => item.id === id);
      if (item) { item.attempts = retryable ? item.attempts + 1 : MAX_DELIVERY_ATTEMPTS; item.error = code; }
    });
  }

  async retry(): Promise<void> {
    await this.update(state => { for (const item of state.pending) { item.attempts = 0; delete item.error; } });
  }
}
