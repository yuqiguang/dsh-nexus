import type { Records } from '../channels/records.js';
import { identity, sessionIdFor } from '../channels/protocol.js';
import { ChannelError, type WechatDiagnostic } from '../channels/types.js';
import { safeDiagnostic } from './errors.js';

export const MAX_DELIVERY_ATTEMPTS = 12;
const MAX_PENDING = 50;
const MAX_PENDING_BYTES = 1024 * 1024;
const RECEIPT_LIMIT = 200;
export interface TextPart { id: string; text: string }
export interface PendingText { id: string; parts: TextPart[]; nextPart: number; attempts: number; error?: string; diagnostic?: WechatDiagnostic; batchKey?: string; sourceIds?: string[]; sealed?: boolean }
/** A presented file waits as a workspace reference, never as bytes inside the credentials file; it is re-read when sent. */
export interface PendingFile { id: string; file: { name: string; path: string }; attempts: number; error?: string; diagnostic?: WechatDiagnostic }
export type PendingDelivery = PendingText | PendingFile;
export function isFileDelivery(item: PendingDelivery): item is PendingFile { return 'file' in item; }
export interface WechatState {
  version: 1;
  accountId: string;
  ownerId: string;
  cursor: string;
  contextToken?: string;
  /** When the current context token arrived; retained for diagnostics, not an inferred expiry limit. */
  contextAt?: number;
  contextRevision?: number;
  contextMessageId?: string;
  replyWait?: { contextRevision: number; diagnostic?: WechatDiagnostic };
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
      (state.contextRevision !== undefined && (!Number.isSafeInteger(state.contextRevision) || state.contextRevision < 0)) ||
      (state.contextMessageId !== undefined && typeof state.contextMessageId !== 'string') ||
      (state.replyWait !== undefined && (!Number.isSafeInteger(state.replyWait.contextRevision) || state.replyWait.contextRevision < 0)) ||
      !Array.isArray(state.received) || !state.received.every(id => typeof id === 'string') ||
      !Array.isArray(state.delivered) || !state.delivered.every(id => typeof id === 'string') ||
      !Array.isArray(state.pending) || !state.pending.every(item => item && typeof item.id === 'string' &&
        Number.isSafeInteger(item.attempts) && item.attempts >= 0 && (isFileDelivery(item)
          ? item.file && typeof item.file.name === 'string' && typeof item.file.path === 'string'
          : Number.isSafeInteger(item.nextPart) && item.nextPart >= 0 && Array.isArray(item.parts) && item.nextPart < item.parts.length &&
            item.parts.every(part => part && typeof part.id === 'string' && typeof part.text === 'string') &&
            (item.batchKey === undefined || typeof item.batchKey === 'string') && (item.sealed === undefined || typeof item.sealed === 'boolean') &&
            (item.sourceIds === undefined || Array.isArray(item.sourceIds) && item.sourceIds.length <= 8 && item.sourceIds.every(id => typeof id === 'string'))))) {
      throw new ChannelError('invalid_delivery_state');
    }
    const result = structuredClone(state);
    for (const item of [...result.pending, ...(result.replyWait ? [result.replyWait] : [])]) {
      const diagnostic = safeDiagnostic(item.diagnostic);
      if (diagnostic) item.diagnostic = diagnostic;
      else delete item.diagnostic;
    }
    return result;
  }

  async read(): Promise<WechatState> { return this.decode(await this.records.read(this.key)); }

  private async update(change: (state: WechatState) => void): Promise<WechatState> {
    return this.decode(await this.records.modify(this.key, async raw => {
      const state = this.decode(raw);
      change(state);
      return state;
    }));
  }

  /** A new admitted owner message refreshes reply allowance even if its token is unchanged. */
  async rememberContext(token: string, at = Date.now(), messageId?: string): Promise<void> {
    await this.update(state => {
      if (messageId && (state.contextMessageId === messageId || state.received.includes(messageId))) return;
      state.contextAt = at;
      state.contextToken = token;
      state.contextRevision = (state.contextRevision ?? 0) + 1;
      if (messageId) state.contextMessageId = messageId;
      delete state.replyWait;
      for (const item of state.pending) { item.attempts = 0; delete item.error; delete item.diagnostic; }
    });
  }

  async waitForReply(revision: number, diagnostic?: WechatDiagnostic): Promise<void> {
    await this.update(state => {
      // A late rejection from an older request must not consume a newer reply allowance.
      const safe = safeDiagnostic(diagnostic);
      if ((state.contextRevision ?? 0) === revision) state.replyWait = { contextRevision: revision, ...(safe ? { diagnostic: safe } : {}) };
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

  async enqueue(id: string, text: string, batchKey?: string): Promise<void> {
    if (!text) return;
    await this.update(state => {
      if (state.delivered.includes(id) || state.pending.some(item => item.id === id || !isFileDelivery(item) && item.sourceIds?.includes(id))) return;
      const tail = state.pending.at(-1);
      if (batchKey && tail && !isFileDelivery(tail) && tail.batchKey === batchKey && !tail.sealed && !tail.attempts && !tail.nextPart &&
        (tail.sourceIds?.length ?? 1) < 8 && tail.parts.length === 1 && Array.from(tail.parts[0]!.text + '\n\n' + text).length <= 800) {
        if (WechatStateStore.queued(state) + Buffer.byteLength(text) + 2 > MAX_PENDING_BYTES) throw new ChannelError('delivery_queue_full');
        tail.sourceIds = [...(tail.sourceIds ?? [tail.id]), id];
        tail.parts = textParts(tail.parts[0]!.text + '\n\n' + text, tail.id);
        return;
      }
      if (state.pending.length >= MAX_PENDING || WechatStateStore.queued(state) + Buffer.byteLength(text) > MAX_PENDING_BYTES) throw new ChannelError('delivery_queue_full');
      state.pending.push({ id, parts: textParts(text, id), nextPart: 0, attempts: 0, ...(batchKey ? { batchKey, sourceIds: [id] } : {}) });
    });
  }

  /** Freeze wire content before any request; failed or partially sent messages are never rewritten. */
  async seal(id: string): Promise<PendingDelivery | undefined> {
    const state = await this.update(state => {
      const item = state.pending.find(item => item.id === id);
      if (item && !isFileDelivery(item)) item.sealed = true;
    });
    return state.pending.find(item => item.id === id);
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
        delete item.diagnostic;
        if (item.nextPart < item.parts.length) return;
      }
      state.pending = state.pending.filter(item => item.id !== id);
      state.delivered = [...state.delivered, ...(!isFileDelivery(item) && item.sourceIds ? item.sourceIds : [id])].slice(-RECEIPT_LIMIT);
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

  async failed(id: string, code: string, retryable: boolean, diagnostic?: WechatDiagnostic, revision?: number): Promise<void> {
    await this.update(state => {
      if (revision !== undefined && revision !== (state.contextRevision ?? 0)) return;
      const item = state.pending.find(item => item.id === id);
      if (item) {
        item.attempts = retryable ? item.attempts + 1 : MAX_DELIVERY_ATTEMPTS; item.error = code;
        const safe = safeDiagnostic(diagnostic);
        if (safe) item.diagnostic = safe;
        else delete item.diagnostic;
      }
    });
  }

  async retry(): Promise<void> {
    await this.update(state => {
      if (state.replyWait) throw new ChannelError('wechat_send_rejected');
      for (const item of state.pending) { item.attempts = 0; delete item.error; delete item.diagnostic; }
    });
  }
}
