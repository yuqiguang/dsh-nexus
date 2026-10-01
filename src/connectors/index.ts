import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { ChannelNotifier, SessionNotifier } from '../channels/notify.js';
import { ChannelError } from '../channels/types.js';
import { DshRecords } from '../dsh/records.js';
import { AgendaConnector, type AgendaStatus } from './agenda/index.js';
import type { Occurrence, Todo } from './agenda/render.js';
import { ImapSmtpMail, type ImapOptions } from './mail/imap.js';
import { MailConnector, type MailStatus } from './mail/index.js';
import type { MailClient } from './mail/types.js';
import { ConnectorSettingsStore, mailInput, redactConnectors, type ConnectorSettingsRecord, type ConnectorSettingsView, type MailAccountSettings } from './settings.js';

export interface ConnectorsView {
  settings: ConnectorSettingsView;
  mail: MailStatus;
  /** The mailbox as the last "测试连接" saw it. */
  mailTest?: { at: number; exists: number; unseen?: number };
  agenda: AgendaStatus & {
    /** The coming week, for the settings page. */
    upcoming: { id: string; title: string; start: number; end: number; location?: string; repeat?: 'daily' | 'weekly' | 'monthly' }[];
    todos: Todo[];
  };
}

export interface ConnectorsDeps {
  ctx: Context;
  registry: Pick<SessionNotifier, 'bound' | 'inject'>;
  /** Where agenda reminders go: the quiet-hours gate in front of the bridges. */
  notifier: ChannelNotifier;
  timeZone(): string;
  now?: () => number;
  report?: (message: string) => void;
  /** Test seam: a mailbox that is not IMAP. */
  client?(settings: MailAccountSettings): MailClient;
  imap?: ImapOptions;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Personal connectors: settings in native credentials under their own scope, one module per service, tools only while a service is on. */
export class Connectors {
  private settings!: ConnectorSettingsRecord;
  private readonly store: ConnectorSettingsStore;
  private readonly mail: MailConnector;
  private readonly agenda: AgendaConnector;
  private mailTest?: ConnectorsView['mailTest'];
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorsDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new ConnectorSettingsStore(new DshRecords(deps.ctx.credentials, 'nexus-connectors'));
    this.mail = new MailConnector({ ctx: deps.ctx, registry: deps.registry, opener: deps.ctx.storageDomain, timeZone: deps.timeZone, now: deps.now, report: deps.report, sleep: deps.sleep,
      client: settings => deps.client ? deps.client(settings) : new ImapSmtpMail(settings, deps.imap),
      onAllowRecipients: async rules => { await this.saveAllowRecipients(rules); } });
    this.agenda = new AgendaConnector({ ctx: deps.ctx, opener: deps.ctx.storageDomain, notifier: deps.notifier, sessions: () => deps.registry.bound(), timeZone: deps.timeZone,
      now: deps.now, report: deps.report, sleep: deps.sleep });
  }

  async start(): Promise<void> {
    this.settings = await this.store.read();
    await this.mail.start(this.settings.mail);
    await this.agenda.start(this.settings.agenda);
    this.deps.ctx.effect(() => () => { void this.mail.close(); void this.agenda.close(); });
  }

  /** Today's and the coming days' occurrences and the open todos, for the briefing. */
  agendaFor(now: number, days: number): { occurrences: Occurrence[]; todos: Todo[] } {
    return { occurrences: this.agenda.agenda(now, days), todos: this.agenda.listTodos().filter(todo => !todo.doneAt) };
  }

  current(): ConnectorSettingsRecord { return this.settings; }

  view(): ConnectorsView {
    const upcoming = this.agenda.agenda(this.now(), 7).slice(0, 30).map(item => ({ id: item.event.id, title: item.event.title, start: item.start, end: item.end,
      ...(item.event.location ? { location: item.event.location } : {}), ...(item.event.repeat ? { repeat: item.event.repeat } : {}) }));
    return { settings: redactConnectors(this.settings), mail: this.mail.view(), ...(this.mailTest ? { mailTest: this.mailTest } : {}),
      agenda: { ...this.agenda.view(), upcoming, todos: this.agenda.listTodos().slice(0, 100) } };
  }

  private async saveAllowRecipients(rules: string[]): Promise<void> {
    this.settings = await this.store.save(this.settings.revision, { mail: { allowRecipients: rules } });
    await this.mail.apply(this.settings.mail);
  }

  async handle(method: string, payload: unknown): Promise<ConnectorsView> {
    if (method === 'list') return this.view();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    if (method === 'save') {
      this.settings = await this.store.save(input.revision as number, (input.config ?? {}) as Record<string, unknown>);
      await this.mail.apply(this.settings.mail);
      await this.agenda.apply(this.settings.agenda);
    } else if (method === 'clear-secret') {
      this.settings = await this.store.clearSecret(input.revision as number);
      this.mailTest = undefined;
      await this.mail.apply(this.settings.mail);
    } else if (method === 'mail/test') {
      // Test what the page shows, saved or not: the draft's password may be empty to mean "the saved one".
      const draft = input.config && typeof input.config === 'object' ? (input.config as { mail?: unknown }).mail : undefined;
      const candidate = draft === undefined ? this.settings.mail : mailInput(draft, this.settings.mail);
      const info = await this.mail.test({ ...candidate, enabled: true });
      this.mailTest = { at: this.now(), exists: info.exists, ...(info.unseen !== undefined ? { unseen: info.unseen } : {}) };
    } else if (method === 'mail/watch/remove') {
      if (typeof input.id !== 'string' || !await this.mail.removeWatch(input.id)) throw new ChannelError('not_found');
    } else if (method === 'agenda/event/remove') {
      if (typeof input.id !== 'string' || !await this.agenda.removeEvent(input.id)) throw new ChannelError('not_found');
    } else if (method === 'agenda/todo/remove') {
      if (typeof input.id !== 'string' || !await this.agenda.removeTodo(input.id)) throw new ChannelError('not_found');
    } else if (method === 'agenda/todo/done') {
      if (typeof input.id !== 'string') throw new ChannelError('invalid_configuration');
      try { await this.agenda.updateTodo(input.id, { done: input.done !== false }); } catch { throw new ChannelError('not_found'); }
    } else throw new ChannelError('unknown_action');
    return this.view();
  }
}
