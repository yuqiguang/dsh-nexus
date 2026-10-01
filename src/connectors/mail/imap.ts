import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailAccountSettings } from '../settings.js';
import { BODY_CHARS, htmlToText, snippet } from './render.js';
import type { MailClient, MailMessage, MailSearch, MailSummary, MailboxInfo, OutgoingMail } from './types.js';
import { CONNECT_ATTEMPT_TIMEOUT_MS } from '../../wechat/http.js';

/**
 * Socket options for both clients. Mail hosts publish IPv6 and IPv4 addresses; on this network the IPv6 route is dead and an IPv4
 * handshake takes over a second, so Node's default 250 ms per-address attempt fails every address and reports ETIMEDOUT with an
 * empty message (the same failure as the WeChat CDN). imapflow merges `tls` into the connect options for plain and TLS sockets alike.
 */
const SOCKET_OPTIONS = { autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS } as import('node:tls').ConnectionOptions;

export interface ImapOptions {
  /** Loopback fixtures speak plain IMAP and SMTP without certificates. */
  insecure?: boolean;
  timeoutMs?: number;
  /** How many characters of a body the model may see. */
  bodyChars?: number;
}

const addresses = (value: AddressObject | AddressObject[] | undefined): { name: string; address: string }[] =>
  (Array.isArray(value) ? value : value ? [value] : []).flatMap(item => item.value.map(entry => ({ name: entry.name ?? '', address: entry.address ?? '' })));
const display = (list: { name: string; address: string }[]) => list.map(item => item.name && item.address ? `${item.name} <${item.address}>` : item.address || item.name).join(', ');

/** Text for the model from a parsed message: the text part, or the HTML reduced, limited in length. */
export function bodyText(parsed: Pick<ParsedMail, 'text' | 'html'>, max = BODY_CHARS): string {
  const text = (parsed.text?.trim() || (typeof parsed.html === 'string' ? htmlToText(parsed.html) : '')).trim();
  return text.length > max ? `${text.slice(0, max)}\n…（正文已截断，共 ${text.length} 字）` : text;
}

/** Summary and message from one fetched RFC 822 source. */
export async function parseMessage(uid: number, source: Buffer, flags: Set<string> | undefined, internalDate: Date | string | undefined, bodyChars?: number): Promise<MailMessage> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const from = addresses(parsed.from);
  const text = bodyText(parsed, bodyChars);
  const date = parsed.date ?? (internalDate ? new Date(internalDate) : undefined);
  return { uid, from: display(from) || '（未知发件人）', fromAddress: from[0]?.address ?? '', to: display(addresses(parsed.to)),
    subject: (parsed.subject ?? '').replace(/\s+/g, ' ').trim(), date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : '', seen: flags?.has('\\Seen') ?? false,
    snippet: snippet(text), text, ...(parsed.messageId ? { messageId: parsed.messageId } : {}),
    attachments: (parsed.attachments ?? []).map(item => ({ name: item.filename ?? '附件', size: item.size ?? 0 })) };
}

/**
 * How many of the newest messages a non-ASCII search decodes and matches itself. 163 answers IMAP SEARCH against the raw
 * encoded-word header, so CHARSET UTF-8 still misses a Chinese subject (a live search for 验收 returned nothing on 2026-09-22
 * while the decoded list showed the mail). ASCII queries stay on the server, which can see the whole mailbox.
 */
const DECODED_SCAN = 30;

const hasNonAscii = (value: string | undefined): boolean => !!value && [...value].some(char => char.charCodeAt(0) > 127);

const includesFolded = (haystack: string, needle: string): boolean => haystack.toLowerCase().includes(needle.toLowerCase());

/** A non-ASCII from, subject, or text cannot be trusted to the server; date and unread filters still can. */
const needsDecodedSearch = (query: MailSearch): boolean => hasNonAscii(query.from) || hasNonAscii(query.subject) || hasNonAscii(query.text);

function matchesDecoded(message: MailMessage, query: MailSearch): boolean {
  if (query.from && !includesFolded(`${message.from} ${message.fromAddress}`, query.from)) return false;
  if (query.subject && !includesFolded(message.subject, query.subject)) return false;
  // `text` is “正文或任何字段”: the decoded body, and also the subject and sender the list shows.
  if (query.text && !includesFolded(`${message.text}\n${message.subject}\n${message.from} ${message.fromAddress}`, query.text)) return false;
  return true;
}

/** IMAP for reading and SMTP for sending, one connection per operation so a dropped socket never lingers. */
export class ImapSmtpMail implements MailClient {
  private transporter?: Transporter;

  constructor(private readonly settings: MailAccountSettings, private readonly options: ImapOptions = {}) {}

  private get user(): string { return this.settings.user || this.settings.address; }

  private async withInbox<T>(run: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow({ host: this.settings.imapHost, port: this.settings.imapPort, secure: this.settings.imapSecure && !this.options.insecure,
      ...(this.options.insecure ? { doSTARTTLS: false } : {}), auth: { user: this.user, pass: this.settings.password }, logger: false, tls: SOCKET_OPTIONS,
      clientInfo: { name: 'nexus-next', version: '0.1.0' }, disableCompression: true, disableAutoEnable: true,
      connectionTimeout: this.options.timeoutMs ?? 20_000, greetingTimeout: this.options.timeoutMs ?? 20_000, socketTimeout: 5 * 60_000 } as ConstructorParameters<typeof ImapFlow>[0]);
    // Once connected, imapflow reports a dying socket (reset, timeout) as an 'error' event. Unheard, Node throws it out of the event
    // loop: five dropped connections exited the service that way on 2026-09-23. The event names the cause; one after the call settled
    // (a LOGOUT on a dead socket, a session start that outlived a failed connect) has nothing left to report.
    let dropped: unknown;
    client.on('error', error => { dropped ??= error; });
    try {
      await client.connect();
      await client.mailboxOpen('INBOX');
      const result = await run(client);
      // search answers a lost connection with `false`, and a command sent after the close returns nothing; either would read as
      // "no mail" or "no such message". The code is the one imapflow gives a command the close rejects.
      if (!client.usable) throw dropped ?? Object.assign(new Error('IMAP connection closed mid-command'), { code: 'NoConnection' });
      return result;
    } catch (error) {
      throw dropped ?? error;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * What SELECT said about the inbox. UIDNEXT is optional in IMAP and 163 omits it; then the highest UID (`UID SEARCH *`) plus one
   * stands in, which is what the poller needs to mark where it is. An empty mailbox has no highest UID and starts at 1.
   */
  private async info(client: ImapFlow): Promise<MailboxInfo> {
    const mailbox = client.mailbox;
    if (!mailbox || typeof mailbox === 'boolean') return { exists: 0, uidNext: 1, uidValidity: 0 };
    let uidNext = Number(mailbox.uidNext);
    if (!Number.isInteger(uidNext) || uidNext < 1) {
      const last = mailbox.exists > 0 ? await client.search({ uid: '*' }, { uid: true }) : [];
      uidNext = Math.max(0, ...(Array.isArray(last) ? last : [])) + 1;
    }
    return { exists: mailbox.exists, uidNext, uidValidity: Number(mailbox.uidValidity) || 0 };
  }

  async check(): Promise<MailboxInfo> {
    return this.withInbox(async client => {
      const info = await this.info(client);
      const unseen = await client.search({ seen: false }, { uid: true });
      return { ...info, unseen: Array.isArray(unseen) ? unseen.length : 0 };
    });
  }

  private async fetchMessages(client: ImapFlow, uids: number[]): Promise<MailMessage[]> {
    if (!uids.length) return [];
    const messages: MailMessage[] = [];
    for await (const item of client.fetch(uids.join(','), { uid: true, flags: true, internalDate: true, source: { maxLength: 64 * 1024 } }, { uid: true })) {
      messages.push(await this.summarize(item));
    }
    return messages.sort((a, b) => b.uid - a.uid);
  }

  private async fetchSummaries(client: ImapFlow, uids: number[]): Promise<MailSummary[]> {
    return (await this.fetchMessages(client, uids)).map(({ text: _text, messageId: _id, attachments: _files, ...summary }) => summary);
  }

  private summarize(item: FetchMessageObject): Promise<MailMessage> {
    return parseMessage(item.uid, item.source ?? Buffer.alloc(0), item.flags, item.internalDate, this.options.bodyChars);
  }

  list(options: { limit: number; unseenOnly: boolean }): Promise<MailSummary[]> {
    return this.withInbox(async client => {
      const found = await client.search(options.unseenOnly ? { seen: false } : { all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, options.limit);
      return this.fetchSummaries(client, uids);
    });
  }

  search(query: MailSearch): Promise<MailSummary[]> {
    return this.withInbox(async client => {
      const limit = query.limit ?? 20;
      const criteria: Record<string, unknown> = {};
      const decoded = needsDecodedSearch(query);
      if (!decoded) {
        if (query.from) criteria.from = query.from;
        if (query.subject) criteria.subject = query.subject;
        if (query.text) criteria.text = query.text;
      }
      if (query.unseenOnly) criteria.seen = false;
      if (query.sinceDays) criteria.since = new Date(Date.now() - query.sinceDays * 86_400_000);
      if (!Object.keys(criteria).length) criteria.all = true;
      const found = await client.search(criteria, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a).slice(0, decoded ? DECODED_SCAN : limit);
      if (!decoded) return this.fetchSummaries(client, uids);
      const messages = await this.fetchMessages(client, uids);
      return messages.filter(message => matchesDecoded(message, query)).slice(0, limit)
        .map(({ text: _text, messageId: _id, attachments: _files, ...summary }) => summary);
    });
  }

  read(uid: number): Promise<MailMessage | undefined> {
    return this.withInbox(async client => {
      const item = await client.fetchOne(String(uid), { uid: true, flags: true, internalDate: true, source: { maxLength: 2 * 1024 * 1024 } }, { uid: true });
      return item && item.uid === uid ? this.summarize(item) : undefined;
    });
  }

  newSince(uid: number): Promise<{ messages: MailSummary[]; uidValidity: number; uidNext: number }> {
    return this.withInbox(async client => {
      const info = await this.info(client);
      if (info.uidNext <= uid + 1) return { messages: [], uidValidity: info.uidValidity, uidNext: info.uidNext };
      // `n:*` also returns the last message when n exceeds every UID, so the result is filtered.
      const found = await client.search({ uid: `${uid + 1}:*` }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).filter(item => item > uid).sort((a, b) => a - b).slice(0, 50);
      const messages = (await this.fetchSummaries(client, uids)).sort((a, b) => a.uid - b.uid);
      return { messages, uidValidity: info.uidValidity, uidNext: info.uidNext };
    });
  }

  async send(mail: OutgoingMail): Promise<{ messageId: string }> {
    this.transporter ??= createTransport({ host: this.settings.smtpHost, port: this.settings.smtpPort, secure: this.settings.smtpSecure && !this.options.insecure,
      ...(this.options.insecure ? { ignoreTLS: true } : {}), auth: { user: this.user, pass: this.settings.password }, tls: SOCKET_OPTIONS,
      connectionTimeout: this.options.timeoutMs ?? 20_000, greetingTimeout: this.options.timeoutMs ?? 20_000, socketTimeout: 60_000 });
    const from = this.settings.name ? { name: this.settings.name, address: this.settings.address } : this.settings.address;
    const reply = mail.inReplyTo?.messageId;
    const info = await this.transporter.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text,
      ...(reply ? { inReplyTo: reply, references: reply } : {}),
      ...(mail.attachments?.length ? { attachments: mail.attachments.map(({ filename, content }) => ({ filename, content })) } : {}) }) as { messageId?: string };
    return { messageId: info.messageId ?? '' };
  }

  async close(): Promise<void> { this.transporter?.close(); this.transporter = undefined; }
}
