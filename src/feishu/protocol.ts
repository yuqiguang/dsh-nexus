import type { InboundMessage } from '../channels/protocol.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function normalizeInbound(raw: unknown): InboundMessage | undefined {
  const data = record(raw);
  const message = record(data?.message);
  const sender = record(data?.sender);
  const senderId = record(sender?.sender_id);
  if (sender?.sender_type !== 'user' || message?.message_type !== 'text' ||
      typeof message.content !== 'string') return undefined;
  let content;
  try { content = record(JSON.parse(message.content)); } catch { return undefined; }
  const values = [message.message_id, message.chat_id, message.chat_type, senderId?.open_id, content?.text];
  if (!values.every(value => typeof value === 'string' && value.trim().length > 0)) return undefined;
  return {
    messageId: message.message_id as string,
    chatId: message.chat_id as string,
    chatType: message.chat_type as string,
    senderId: senderId!.open_id as string,
    text: (content!.text as string).trim(),
  };
}
