/**
 * A scripted IMAP and SMTP server on loopback for the real imapflow and nodemailer clients: enough of the protocol for
 * LOGIN, SELECT INBOX, UID SEARCH, UID FETCH (flags, internal date, a byte range of the source) and LOGOUT on the IMAP side,
 * and EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT on the SMTP side. Messages are plain RFC 822 sources.
 */
import { createServer, type Server, type Socket } from 'node:net';

export interface FixtureMessage { uid: number; flags: string[]; internalDate: Date; source: Buffer }

export interface MailFixture {
  imapPort: number;
  smtpPort: number;
  messages: FixtureMessage[];
  uidValidity: number;
  /** Everything SMTP accepted: envelope and the raw DATA. */
  sent: { from: string; to: string[]; data: string }[];
  /** Login attempts, so a test can see the credentials the client presented. */
  logins: { user: string; pass: string }[];
  imapCommands: string[];
  /** A message as text (UTF-8) or as exact bytes (for other charsets); line endings become CRLF. */
  add(source: string | Buffer, flags?: string[]): FixtureMessage;
  close(): Promise<void>;
}

const CRLF = '\r\n';

function parseCommand(line: string): { tag: string; name: string; rest: string } {
  const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(line);
  return { tag: match?.[1] ?? '*', name: (match?.[2] ?? '').toUpperCase(), rest: match?.[3] ?? '' };
}

/** IMAP quoted strings and literals are not needed for what imapflow sends here beyond LOGIN; LOGIN comes quoted. */
function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\(["\\])/g, '$1') : value;
}

function imapDate(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** The UID set of `1:*`, `5:*`, `3,4`, `*` against the fixture's messages. */
function uidsOf(set: string, messages: FixtureMessage[]): number[] {
  const uids = messages.map(message => message.uid);
  const max = Math.max(0, ...uids);
  const chosen = new Set<number>();
  for (const part of set.split(',')) {
    const [startText, endText] = part.split(':');
    const start = startText === '*' ? max : Number(startText);
    const end = endText === undefined ? start : endText === '*' ? max : Number(endText);
    for (const uid of uids) if (uid >= Math.min(start, end) && uid <= Math.max(start, end)) chosen.add(uid);
    // RFC 3501: a range whose start exceeds every UID still matches the highest UID when it ends in `*`.
    if (endText === '*' && start > max && max > 0) chosen.add(max);
  }
  return [...chosen].sort((a, b) => a - b);
}

function searchUids(criteria: string, messages: FixtureMessage[]): number[] {
  const tokens = criteria.match(/"[^"]*"|\S+/g) ?? [];
  let candidates = messages;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!.toUpperCase();
    const arg = () => unquote(tokens[++index] ?? '');
    if (token === 'ALL') continue;
    else if (token === 'UNSEEN') candidates = candidates.filter(message => !message.flags.includes('\\Seen'));
    else if (token === 'SEEN') candidates = candidates.filter(message => message.flags.includes('\\Seen'));
    else if (token === 'UID') { const set = tokens[++index]!; const uids = uidsOf(set, messages); candidates = candidates.filter(message => uids.includes(message.uid)); }
    else if (token === 'FROM' || token === 'SUBJECT' || token === 'TEXT' || token === 'BODY') {
      const needle = arg().toLowerCase();
      candidates = candidates.filter(message => {
        const text = message.source.toString('utf8');
        if (token === 'TEXT' || token === 'BODY') return text.toLowerCase().includes(needle);
        const header = new RegExp(`^${token === 'FROM' ? 'from' : 'subject'}:\\s*(.*)$`, 'im').exec(text)?.[1] ?? '';
        return header.toLowerCase().includes(needle);
      });
    } else if (token === 'SINCE') { const since = Date.parse(arg().replace(/-/g, ' ')); candidates = candidates.filter(message => message.internalDate.getTime() >= since); }
    else if (token === 'CHARSET') index++;
  }
  return candidates.map(message => message.uid).sort((a, b) => a - b);
}

export async function mailFixture(options: { user: string; pass: string; uidValidity?: number; /** Like 163: SELECT without a UIDNEXT line. */ omitUidNext?: boolean;
  /** Reset the connection (TCP RST) when this command arrives, as a dropped network does mid-command; `UID` covers UID SEARCH and UID FETCH. */ resetOn?: string;
  /** Hang up (FIN) when this command arrives, as a server ending the session does. */ closeOn?: string } = { user: 'user@example.com', pass: 'app-password' }): Promise<MailFixture> {
  const fixture: MailFixture = { imapPort: 0, smtpPort: 0, messages: [], uidValidity: options.uidValidity ?? 1001, sent: [], logins: [], imapCommands: [],
    add(source, flags = []) {
      const uid = fixture.messages.length ? Math.max(...fixture.messages.map(message => message.uid)) + 1 : 1;
      const bytes = Buffer.isBuffer(source) ? source : Buffer.from(source.replace(/\r?\n/g, CRLF), 'utf8');
      const message = { uid, flags, internalDate: new Date(), source: bytes };
      fixture.messages.push(message);
      return message;
    },
    async close() { for (const socket of sockets) socket.destroy(); for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve())); },
  };
  const sockets = new Set<Socket>();
  const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));

  const imap = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let authenticated = false;
    let selected = false;
    let buffer = '';
    /** A command whose line ended in `{n}`: the client sends n raw bytes after our continuation, then the rest of the line. */
    let literal: { prefix: string; remaining: number } | undefined;
    /** An `AUTHENTICATE PLAIN` without an initial response waits for the base64 credentials on the next line. */
    let saslTag: string | undefined;
    const write = (text: string) => socket.write(text + CRLF);
    const login = (tag: string, user: string, pass: string) => {
      fixture.logins.push({ user, pass });
      if (user === options.user && pass === options.pass) { authenticated = true; write(`${tag} OK [CAPABILITY IMAP4rev1] logged in`); }
      else write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`);
    };
    const plain = (tag: string, encoded: string) => { const [, user, pass] = Buffer.from(encoded, 'base64').toString('utf8').split('\0'); login(tag, user ?? '', pass ?? ''); };
    write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR] nexus fixture ready');
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (literal) {
          if (buffer.length < literal.remaining) return;
          // The literal's bytes become a quoted string in the reassembled line; the rest of the line follows.
          literal.prefix += `"${Buffer.from(buffer.slice(0, literal.remaining), 'latin1').toString('utf8').replace(/"/g, '')}"`;
          buffer = buffer.slice(literal.remaining);
          const { prefix } = literal;
          literal = undefined;
          buffer = prefix + buffer;
        }
        const end = buffer.indexOf(CRLF);
        if (end < 0) return;
        let line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const open = /\{(\d+)\}$/.exec(line);
        if (open) { literal = { prefix: line.slice(0, -open[0].length), remaining: Number(open[1]) }; write('+ go ahead'); continue; }
        if (saslTag) { const tag = saslTag; saslTag = undefined; plain(tag, line); continue; }
        const { tag, name, rest } = parseCommand(line);
        fixture.imapCommands.push(`${name} ${rest}`.trim());
        if (name === options.resetOn) { socket.resetAndDestroy(); return; }
        if (name === options.closeOn) { socket.end(); return; }
        if (name === 'CAPABILITY') { write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR'); write(`${tag} OK done`); }
        else if (name === 'LOGIN') {
          const [user, pass] = rest.match(/"[^"]*"|\S+/g)?.map(unquote) ?? [];
          login(tag, user ?? '', pass ?? '');
        } else if (name === 'AUTHENTICATE') {
          const [mechanism, initial] = rest.split(/\s+/);
          if (mechanism?.toUpperCase() !== 'PLAIN') write(`${tag} NO unsupported mechanism`);
          else if (initial) plain(tag, initial);
          else { saslTag = tag; write('+ '); }
        } else if (name === 'NAMESPACE') { write(`${tag} BAD unknown command`); }
        else if (name === 'LIST') { write(rest.includes('INBOX') ? '* LIST (\\HasNoChildren) "/" "INBOX"' : '* LIST (\\Noselect) "/" ""'); write(`${tag} OK done`); }
        else if (name === 'LSUB') { write('* LSUB () "/" "INBOX"'); write(`${tag} OK done`); }
        else if (name === 'SELECT' || name === 'EXAMINE') {
          if (!authenticated) { write(`${tag} NO not logged in`); continue; }
          selected = true;
          const max = Math.max(0, ...fixture.messages.map(message => message.uid));
          write(`* ${fixture.messages.length} EXISTS`); write('* 0 RECENT'); write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
          write(`* OK [UIDVALIDITY ${fixture.uidValidity}] UIDs valid`); if (!options.omitUidNext) write(`* OK [UIDNEXT ${max + 1}] predicted next UID`);
          write(`${tag} OK [READ-WRITE] SELECT completed`);
        } else if (name === 'UID' || name === 'SEARCH' || name === 'FETCH') {
          if (!selected) { write(`${tag} NO not selected`); continue; }
          const sub = name === 'UID' ? parseCommand(`${tag} ${rest}`) : { name, rest };
          if (sub.name === 'SEARCH') {
            const uids = searchUids(sub.rest, fixture.messages);
            write(`* SEARCH${uids.length ? ' ' + uids.join(' ') : ''}`); write(`${tag} OK SEARCH completed`);
          } else if (sub.name === 'FETCH') {
            const [set, ...items] = sub.rest.split(/\s+(.*)/s);
            const query = items.join(' ').toUpperCase();
            const partial = /<(\d+)\.(\d+)>/.exec(query);
            for (const message of uidsOf(set!, fixture.messages).map(uid => fixture.messages.find(item => item.uid === uid)!)) {
              const seq = fixture.messages.indexOf(message) + 1;
              const parts = [`UID ${message.uid}`];
              if (query.includes('FLAGS')) parts.push(`FLAGS (${message.flags.join(' ')})`);
              if (query.includes('INTERNALDATE')) parts.push(`INTERNALDATE "${imapDate(message.internalDate)}"`);
              if (/BODY(?:\.PEEK)?\[\]/.test(query)) {
                const bytes = message.source;
                const start = partial ? Number(partial[1]) : 0;
                const slice = partial ? bytes.subarray(start, start + Number(partial[2])) : bytes;
                socket.write(`* ${seq} FETCH (${parts.join(' ')} BODY[]${partial ? `<${start}>` : ''} {${slice.length}}${CRLF}`);
                socket.write(slice);
                write(')');
              } else write(`* ${seq} FETCH (${parts.join(' ')})`);
            }
            write(`${tag} OK FETCH completed`);
          } else write(`${tag} BAD unknown`);
        } else if (name === 'NOOP') write(`${tag} OK NOOP`);
        else if (name === 'LOGOUT') { write('* BYE logging out'); write(`${tag} OK LOGOUT completed`); socket.end(); }
        else if (name === 'ID' || name === 'ENABLE' || name === 'COMPRESS' || name === 'STARTTLS') write(`${tag} BAD unsupported`);
        else write(`${tag} BAD unknown command ${name}`);
      }
    });
    socket.on('error', () => {});
  });

  const smtp = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let authenticated = false;
    let envelope = { from: '', to: [] as string[] };
    let data = '';
    const write = (text: string) => socket.write(text + CRLF);
    write('220 nexus smtp fixture');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf(CRLF)) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') { inData = false; fixture.sent.push({ ...envelope, data }); data = ''; envelope = { from: '', to: [] }; write('250 OK queued as nexus-1'); }
          else data += (line.startsWith('..') ? line.slice(1) : line) + '\n';
          continue;
        }
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) { write('250-nexus'); write('250-AUTH PLAIN LOGIN'); write('250-8BITMIME'); write('250 SIZE 10485760'); }
        else if (upper.startsWith('AUTH PLAIN')) {
          const [, , pass] = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\0');
          authenticated = pass === options.pass;
          write(authenticated ? '235 Authentication successful' : '535 Authentication failed');
        } else if (upper.startsWith('MAIL FROM:')) { if (!authenticated) { write('530 Authentication required'); continue; } envelope.from = /<([^>]*)>/.exec(line)?.[1] ?? ''; write('250 OK'); }
        else if (upper.startsWith('RCPT TO:')) { envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? ''); write('250 OK'); }
        else if (upper === 'DATA') { inData = true; write('354 End data with <CR><LF>.<CR><LF>'); }
        else if (upper === 'QUIT') { write('221 Bye'); socket.end(); }
        else if (upper === 'RSET' || upper === 'NOOP') write('250 OK');
        else write('502 Command not implemented');
      }
    });
    socket.on('error', () => {});
  });
  const servers = [imap, smtp];
  fixture.imapPort = await listen(imap);
  fixture.smtpPort = await listen(smtp);
  return fixture;
}

/** One RFC 822 message; headers may be given already encoded. */
export function rfc822(fields: { from: string; to?: string; subject: string; date?: string; messageId?: string; body: string; html?: boolean }): string {
  return [`From: ${fields.from}`, `To: ${fields.to ?? 'user@example.com'}`, `Subject: ${fields.subject}`, `Date: ${fields.date ?? 'Sun, 20 Sep 2026 10:00:00 +0800'}`,
    `Message-ID: ${fields.messageId ?? `<${Math.random().toString(36).slice(2)}@example.com>`}`, 'MIME-Version: 1.0',
    `Content-Type: ${fields.html ? 'text/html' : 'text/plain'}; charset=utf-8`, 'Content-Transfer-Encoding: 8bit', '', fields.body].join('\n');
}
