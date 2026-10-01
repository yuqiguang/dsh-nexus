import { markUntrusted, redactInstructions } from '../../assistant/untrusted.js';
import type { MailMessage, MailSummary } from './types.js';

export const SNIPPET_CHARS = 160;
export const BODY_CHARS = 6000;

/** Collapse whitespace and cut, for one-line listings. */
export function snippet(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A readable text from HTML mail when there is no text part: scripts and styles dropped, tags to spaces, entities decoded. */
export function htmlToText(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(p|div|tr|li|h[1-6]|table|ul|ol|blockquote|pre|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
      return entities[code.toLowerCase()] ?? match;
    }).split('\n').map(line => line.replace(/[ \t\u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function formatDate(iso: string, timeZone: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : new Date(time).toLocaleString('zh-CN', { timeZone, hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** One line per message, newest first as given: id, when, who, subject, and the start of the body. */
export function renderList(messages: readonly MailSummary[], timeZone: string): string {
  if (!messages.length) return '没有符合条件的邮件。';
  return redactInstructions(messages.map(message => `[${message.uid}] ${formatDate(message.date, timeZone)} ${message.seen ? '' : '未读 '}${message.from}｜${message.subject || '（无主题）'}${message.snippet ? `｜${message.snippet}` : ''}`).join('\n'));
}

export function renderMessage(message: MailMessage, timeZone: string): string {
  const lines = [`邮件 [${message.uid}]`, `发件人：${message.from}${message.fromAddress && !message.from.includes(message.fromAddress) ? ` <${message.fromAddress}>` : ''}`,
    `收件人：${message.to}`, `时间：${formatDate(message.date, timeZone)}`, `主题：${message.subject || '（无主题）'}`];
  if (message.attachments.length) lines.push(`附件：${message.attachments.map(item => `${item.name}（${Math.max(1, Math.round(item.size / 1024))} KB）`).join('、')}`);
  lines.push('', markUntrusted('mail', message.text || '（没有正文）'));
  return redactInstructions(lines.join('\n'));
}

/** One watch rule: any of its keywords in the sender, the subject, or the body text. Empty keywords never match. */
export interface MailWatch { id: string; description: string; keywords: string[]; createdAt: number }

const fold = (value: string) => value.toLowerCase();

export function watchMatches(watch: Pick<MailWatch, 'keywords'>, message: MailSummary): boolean {
  const haystack = fold(`${message.from}\n${message.fromAddress}\n${message.subject}\n${message.snippet}`);
  return watch.keywords.some(keyword => keyword.trim() && haystack.includes(fold(keyword.trim())));
}

/** What the session receives when a watched mail arrives: attributed, and marked as data. */
export function arrivalText(watch: MailWatch, message: MailSummary, timeZone: string): string {
  return [`一封新邮件符合你设定的提醒「${watch.description}」（关键词：${watch.keywords.join('、')}）。`, renderList([message], timeZone),
    '请按这条提醒的要求处理：通常是把发件人、主题和要点告诉用户；需要全文时用 mail_read 读取。'].join('\n');
}
