/** What the assistant sees of a message without opening it. */
export interface MailSummary {
  uid: number;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  /** ISO time of the Date header, or the server's internal date. */
  date: string;
  seen: boolean;
  /** The first lines of the text body, for lists and watch matching. */
  snippet: string;
}

export interface MailMessage extends MailSummary {
  /** Plain text body, or the HTML body reduced to text; already limited in length by the client. */
  text: string;
  messageId?: string;
  attachments: { name: string; size: number }[];
}

export interface OutgoingMail {
  to: string[];
  subject: string;
  text: string;
  /** The message being answered: sets In-Reply-To and References. */
  inReplyTo?: { messageId?: string; uid?: number };
  /** Files read from the session's workspace, sent as they are. */
  attachments?: { filename: string; content: Buffer }[];
}

export interface MailboxInfo { exists: number; unseen?: number; uidNext: number; uidValidity: number }

export interface MailSearch { from?: string; subject?: string; text?: string; sinceDays?: number; unseenOnly?: boolean; limit?: number }

/** The mailbox as the connector needs it; the IMAP/SMTP implementation and the test fake both satisfy this. */
export interface MailClient {
  /** Connect, log in and look at INBOX; the way settings are verified. */
  check(): Promise<MailboxInfo>;
  list(options: { limit: number; unseenOnly: boolean }): Promise<MailSummary[]>;
  search(query: MailSearch): Promise<MailSummary[]>;
  read(uid: number): Promise<MailMessage | undefined>;
  /** Messages whose UID is above `uid`, oldest first, with the mailbox's current UIDVALIDITY and UIDNEXT. */
  newSince(uid: number): Promise<{ messages: MailSummary[]; uidValidity: number; uidNext: number }>;
  send(mail: OutgoingMail): Promise<{ messageId: string }>;
  close(): Promise<void>;
}
