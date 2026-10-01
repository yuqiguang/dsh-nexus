import type { Records } from '../channels/records.js';
import { ChannelError } from '../channels/types.js';

/** One mailbox reached over IMAP and SMTP with an app password ("授权码"), the way QQ、163、Gmail、Outlook and iCloud all allow. */
export interface MailAccountSettings {
  enabled: boolean;
  /** The address mail is sent from and replies go to. */
  address: string;
  /** Display name on outgoing mail; empty means the bare address. */
  name?: string;
  imapHost: string;
  imapPort: number;
  /** Implicit TLS (993); false means STARTTLS on a plain port (143). */
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /** Login name; empty means the address. */
  user?: string;
  /** Secret; empty means not configured. */
  password: string;
  /** How often the inbox is checked for new mail, in seconds. */
  pollSeconds: number;
  /** Recipients `mail_send` may reach without asking: full addresses or `@domain` suffixes. */
  allowRecipients: string[];
}

/** The assistant's own calendar and todo list; no account, only how it reminds. */
export interface AgendaSettings {
  enabled: boolean;
  /** Default minutes before an event to remind; 0 turns event reminders off. */
  remindMinutes: number;
  /** Local `HH:MM` at which a todo due "today" (no time of day) is announced. */
  todoReminderTime: string;
}

export interface ConnectorSettingsRecord {
  version: 1;
  revision: number;
  mail: MailAccountSettings;
  agenda: AgendaSettings;
}

export interface MailAccountView extends Omit<MailAccountSettings, 'password'> { passwordConfigured: boolean }
export interface ConnectorSettingsView { revision: number; mail: MailAccountView; agenda: AgendaSettings }

export const SETTINGS_KEY = 'settings';
export const POLL_SECONDS = { min: 30, max: 3600, default: 60 } as const;
export const REMIND_MINUTES = { min: 0, max: 24 * 60, default: 15 } as const;
export const DEFAULT_TODO_REMINDER_TIME = '09:00';

/** On by default: nothing external is touched until the user adds something. */
export function defaultAgendaSettings(): AgendaSettings {
  return { enabled: true, remindMinutes: REMIND_MINUTES.default, todoReminderTime: DEFAULT_TODO_REMINDER_TIME };
}

export function defaultMailSettings(): MailAccountSettings {
  return { enabled: false, address: '', imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true,
    password: '', pollSeconds: POLL_SECONDS.default, allowRecipients: [] };
}

export function defaultConnectorSettings(): ConnectorSettingsRecord {
  return { version: 1, revision: 0, mail: defaultMailSettings(), agenda: defaultAgendaSettings() };
}

const ADDRESS = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;

export function validAddress(value: string): boolean { return ADDRESS.test(value) && value.length <= 254; }

function text(value: unknown, max: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > max) throw new ChannelError('invalid_configuration');
  return value.trim();
}

function port(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(number) || (number as number) < 1 || (number as number) > 65535) throw new ChannelError('invalid_port');
  return number as number;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'false') return value === 'true';
  throw new ChannelError('invalid_configuration');
}

/** Recipients come one per line or as an array: a full address, or `@domain` for everyone at that domain. */
export function recipientsInput(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\n,;，；]/) : value === undefined || value === null ? [] : undefined;
  if (!items) throw new ChannelError('invalid_configuration');
  const rules = [...new Set(items.map(item => text(item, 254).toLowerCase()).filter(Boolean))];
  for (const rule of rules) if (!(validAddress(rule) || /^@[^\s@]+\.[^\s@]+$/.test(rule))) throw new ChannelError('invalid_recipient_rule');
  if (rules.length > 200) throw new ChannelError('invalid_configuration');
  return rules;
}

/** True when the recipient is covered by one of the rules (exact address, or its domain). */
export function recipientAllowed(recipient: string, rules: readonly string[]): boolean {
  const address = recipient.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return rules.some(rule => rule === address || (rule.startsWith('@') && at > 0 && address.slice(at) === rule));
}

/** Validate a mail account from the settings page; an empty password keeps the saved one. */
export function mailInput(raw: unknown, previous: MailAccountSettings): MailAccountSettings {
  if (raw === undefined || raw === null) return previous;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ChannelError('invalid_configuration');
  const input = raw as Record<string, unknown>;
  const address = input.address === undefined ? previous.address : text(input.address, 254);
  if (address && !validAddress(address)) throw new ChannelError('invalid_address');
  const host = (value: unknown, fallback: string) => {
    if (value === undefined) return fallback;
    const name = text(value, 253);
    if (name && !/^[A-Za-z0-9.-]+$/.test(name)) throw new ChannelError('invalid_host');
    return name.toLowerCase();
  };
  const poll = input.pollSeconds === undefined || input.pollSeconds === '' ? previous.pollSeconds : Number(input.pollSeconds);
  if (!Number.isInteger(poll) || poll < POLL_SECONDS.min || poll > POLL_SECONDS.max) throw new ChannelError('invalid_poll_interval');
  const password = input.password === undefined ? previous.password : text(input.password, 1024) || previous.password;
  const name = input.name === undefined ? previous.name : text(input.name, 80);
  const user = input.user === undefined ? previous.user : text(input.user, 254);
  const enabled = flag(input.enabled, previous.enabled);
  const next: MailAccountSettings = { enabled, address, imapHost: host(input.imapHost, previous.imapHost), imapPort: port(input.imapPort, previous.imapPort),
    imapSecure: flag(input.imapSecure, previous.imapSecure), smtpHost: host(input.smtpHost, previous.smtpHost), smtpPort: port(input.smtpPort, previous.smtpPort),
    smtpSecure: flag(input.smtpSecure, previous.smtpSecure), password, pollSeconds: poll,
    allowRecipients: input.allowRecipients === undefined ? previous.allowRecipients : recipientsInput(input.allowRecipients),
    ...(name ? { name } : {}), ...(user ? { user } : {}) };
  if (next.enabled && !mailConfigured(next)) throw new ChannelError('missing_mail_settings');
  return next;
}

export function agendaInput(raw: unknown, previous: AgendaSettings): AgendaSettings {
  if (raw === undefined || raw === null) return previous;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ChannelError('invalid_configuration');
  const input = raw as Record<string, unknown>;
  const remind = input.remindMinutes === undefined || input.remindMinutes === '' ? previous.remindMinutes : Number(input.remindMinutes);
  if (!Number.isInteger(remind) || remind < REMIND_MINUTES.min || remind > REMIND_MINUTES.max) throw new ChannelError('invalid_remind_minutes');
  const time = input.todoReminderTime === undefined ? previous.todoReminderTime : text(input.todoReminderTime, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new ChannelError('invalid_clock_time');
  return { enabled: flag(input.enabled, previous.enabled), remindMinutes: remind, todoReminderTime: time };
}

export function mailConfigured(mail: MailAccountSettings): boolean {
  return !!(mail.address && mail.imapHost && mail.smtpHost && mail.password);
}

function decode(raw: unknown): ConnectorSettingsRecord | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new ChannelError('invalid_saved_record');
  const value = raw as ConnectorSettingsRecord;
  const mail = value.mail;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !mail || typeof mail !== 'object'
    || typeof mail.enabled !== 'boolean' || typeof mail.address !== 'string' || typeof mail.password !== 'string'
    || typeof mail.imapHost !== 'string' || typeof mail.smtpHost !== 'string' || !Number.isInteger(mail.imapPort) || !Number.isInteger(mail.smtpPort)
    || typeof mail.imapSecure !== 'boolean' || typeof mail.smtpSecure !== 'boolean' || !Number.isInteger(mail.pollSeconds)
    || !Array.isArray(mail.allowRecipients) || !mail.allowRecipients.every(item => typeof item === 'string')) throw new ChannelError('invalid_saved_record');
  // Records written before the agenda existed carry no `agenda`; they get the defaults.
  const agenda = value.agenda === undefined ? defaultAgendaSettings() : value.agenda;
  if (!agenda || typeof agenda !== 'object' || typeof agenda.enabled !== 'boolean' || !Number.isInteger(agenda.remindMinutes) || typeof agenda.todoReminderTime !== 'string') throw new ChannelError('invalid_saved_record');
  return structuredClone({ ...value, agenda });
}

export function redactConnectors(settings: ConnectorSettingsRecord): ConnectorSettingsView {
  const { password, ...mail } = settings.mail;
  return { revision: settings.revision, mail: { ...mail, passwordConfigured: password.length > 0 }, agenda: { ...settings.agenda } };
}

export class ConnectorSettingsStore {
  constructor(private readonly records: Records) {}

  async read(): Promise<ConnectorSettingsRecord> {
    return decode(await this.records.read(SETTINGS_KEY)) ?? defaultConnectorSettings();
  }

  private async modify(expectedRevision: number, change: (previous: ConnectorSettingsRecord) => ConnectorSettingsRecord): Promise<ConnectorSettingsRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ChannelError('invalid_revision');
    const result = await this.records.modify(SETTINGS_KEY, async current => {
      const previous = decode(current) ?? defaultConnectorSettings();
      if (previous.revision !== expectedRevision) throw new ChannelError('configuration_changed');
      return change(previous);
    });
    return decode(result)!;
  }

  save(expectedRevision: number, input: Record<string, unknown>): Promise<ConnectorSettingsRecord> {
    return this.modify(expectedRevision, previous => ({ version: 1, revision: previous.revision + 1, mail: mailInput(input.mail, previous.mail), agenda: agendaInput(input.agenda, previous.agenda) }));
  }

  /** Forget the password and stop using the account: the tools go away with it. */
  clearSecret(expectedRevision: number): Promise<ConnectorSettingsRecord> {
    return this.modify(expectedRevision, previous => ({ ...previous, revision: previous.revision + 1, mail: { ...previous.mail, password: '', enabled: false } }));
  }
}
