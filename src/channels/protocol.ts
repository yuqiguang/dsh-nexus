import { createHash } from 'node:crypto';
import type { ChannelId } from './types.js';

export interface ChannelIdentity { channel: ChannelId; accountId: string; ownerId: string }
/** One picture, document, or voice clip the channel already downloaded and decrypted; voice arrives as 16-bit mono WAV. */
export interface InboundAttachment { kind: 'image' | 'file' | 'voice'; name?: string; bytes: Buffer; /** Voice clip length, when the channel declared it. */ seconds?: number }
/** Something the user sent that could not be handed over; the bridge tells the user instead of silently dropping it. */
export interface DroppedAttachment { kind: 'image' | 'file' | 'voice' | 'video'; reason: 'unsupported' | 'too_large' | 'download_failed' | 'decode_failed' }
export interface InboundMessage {
  messageId: string;
  chatId: string;
  chatType: string;
  senderId: string;
  text: string;
  attachments?: InboundAttachment[];
  dropped?: DroppedAttachment[];
  /** Some or all of `text` came from a speech transcript (the channel's or ours), so homophone errors are possible. */
  transcribed?: boolean;
}

export function identity(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** The chat's base session id (generation 0). Later generations append `-N`; see `sessionIdAt`. */
export function sessionIdFor(accountId: string, owner: string, chatId: string, channel: ChannelId = 'feishu'): string {
  return `nexus-${channel}-${identity(accountId, owner, chatId)}`;
}

/** The session id of one generation of a chat: the base itself for generation 0, `base-N` afterwards. */
export function sessionIdAt(base: string, generation: number): string {
  return generation > 0 ? `${base}-${generation}` : base;
}

/** The base session id a generation belongs to; ids that are not channel sessions come back unchanged. */
export function baseSessionOf(sessionId: string): string {
  return sessionId.replace(/^(nexus-(?:wechat|feishu|wecom)-[a-f0-9]{32})-\d+$/, '$1');
}

/**
 * Whether two session ids are the same conversation. A chat rotates by opening the next generation of itself, and its work
 * belongs to the chat rather than to the generation that happened to start it: a task dispatched before a rotation still
 * reports into the chat, so every generation of that chat may read and continue it (ct-4c671559). `baseSessionOf` leaves ids
 * that are not channel sessions untouched, so two unrelated desktop sessions never match each other.
 */
export function sameChat(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && baseSessionOf(a) === baseSessionOf(b);
}

export type Command = { kind: 'cancel' | 'status' | 'new' } | { kind: 'approve' | 'deny'; token?: string }
  | { kind: 'answer'; token?: string; value: string };
export function parseCommand(text: string): Command | undefined {
  text = text.trim();
  if (text === '/cancel') return { kind: 'cancel' };
  if (text === '状态' || text === '/status') return { kind: 'status' };
  if (text === '/new' || text === '新会话') return { kind: 'new' };
  // Chinese replies often omit the space: 回答1, 回答1,2, 回答文本 xx are answers; 回答这个问题 stays a task.
  const answer = /^(?:回答|\/answer)(?:\s+([\s\S]*)|(\d+(?:\s*[,，、]\s*\d+)*|文本\s+[\s\S]*))?$/.exec(text);
  if (answer) {
    const value = (answer[1] ?? answer[2])?.trim() ?? '';
    const specific = /^([a-f0-9]{32})(?:\s+([\s\S]*))?$/.exec(value);
    return specific ? { kind: 'answer', token: specific[1]!, value: specific[2]?.trim() ?? '' }
      : { kind: 'answer', value };
  }
  const reply = /^(允许|同意|拒绝)(?:\s*([a-f0-9]{32}))?$/.exec(text);
  if (reply) return { kind: reply[1] === '拒绝' ? 'deny' : 'approve', ...(reply[2] ? { token: reply[2] } : {}) };
  const match = /^\/(approve|deny) ([a-f0-9]{32})$/.exec(text);
  return match ? { kind: match[1] as 'approve' | 'deny', token: match[2]! } : undefined;
}

/** `path` is the workspace-relative source so a channel with a durable outbox can re-read the file later instead of storing its bytes. */
export interface OutboundFile { name: string; bytes: Buffer; path?: string }
/** Only already-produced results may survive restart; interactive approval prompts must stay live. */
export interface DeliveryOptions { durable?: boolean; signal?: AbortSignal; /** Only complete, already-produced receipts may be combined within this scope. */ batchKey?: string }
export interface ChannelTransport {
  start(receive: (message: InboundMessage) => Promise<void>): Promise<void>;
  stop(): void | Promise<void>;
  sendText(chatId: string, text: string, deliveryId: string, options?: DeliveryOptions): Promise<void>;
  sendFile(chatId: string, file: OutboundFile, deliveryId: string): Promise<void>;
  retryPending?(): Promise<void>;
}
