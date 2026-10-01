import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-credentials';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type { ChannelNotifier, SessionNotifier } from '../channels/notify.js';
import { ChannelError } from '../channels/types.js';
import { DshRecords } from '../dsh/records.js';
import { AgendaData } from './agenda/data.js';
import { AgendaConnector, type AgendaStatus } from './agenda/index.js';
import type { Occurrence, Todo } from './agenda/render.js';
import { ImapSmtpMail, type ImapOptions } from './mail/imap.js';
import { MailConnector, type MailStatus } from './mail/index.js';
import { MailData } from './mail/data.js';
import type { MailClient } from './mail/types.js';
import { ConnectorSettingsStore, mailConfigured, mailInput, redactConnectors, type ConnectorSettingsRecord, type ConnectorSettingsView, type MailAccountSettings } from './settings.js';

export interface ConnectorsView {
  modules?: { mail: boolean; agenda: boolean };
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
  private mail?: MailConnector;
  private mailData!: MailData;
  private agenda?: AgendaConnector;
  private agendaData!: AgendaData;
  private mailTest?: ConnectorsView['mailTest'];
  private mailTestAttempt = 0;
  private clearMailTest(): void { this.mailTestAttempt++; this.mailTest = undefined; }
  private readonly now: () => number;

  constructor(private readonly deps: ConnectorsDeps) {
    this.now = deps.now ?? Date.now;
    this.store = new ConnectorSettingsStore(new DshRecords(deps.ctx.credentials, 'nexus-connectors'));

  }

  async start(): Promise<void> {
    this.settings = await this.store.read();
    this.mailData = await MailData.open(this.deps.ctx.storageDomain, this.now);
    if (mailConfigured(this.settings.mail)) await this.mailData.bindLegacyCursor(this.settings.mail);
    this.agendaData = await AgendaData.open(this.deps.ctx.storageDomain, this.deps.timeZone, this.now);
    this.deps.ctx.effect(() => () => this.close());
  }

  async close(): Promise<void> {
    await this.mail?.close();
    await this.agenda?.close();
    await this.agendaData.close();
    await this.mailData.close();
  }

  /** DSH owns this activation; core settings and data survive its disposal. */
  async enableMail(ctx: Context): Promise<void> {
    if (this.mail) throw new Error('mail runtime already active');
    const deps = this.deps;
    const runtime = new MailConnector({ ctx, data: this.mailData, opener: deps.ctx.storageDomain,
      registry: deps.registry, timeZone: deps.timeZone, now: deps.now, report: deps.report, sleep: deps.sleep,
      client: settings => deps.client ? deps.client(settings) : new ImapSmtpMail(settings, deps.imap),
      onAllowRecipients: (rules, assertCurrent) => this.saveAllowRecipients(rules, assertCurrent) });
    this.mail = runtime;
    ctx.effect(() => async () => {
      if (this.mail === runtime) { this.mail = undefined; this.clearMailTest(); }
      await runtime.close();
    });
    try { await runtime.start(this.settings.mail); }
    catch (error) {
      if (this.mail === runtime) this.mail = undefined;
      await runtime.close();
      throw error;
    }
  }

  /** Optional native agenda runtime; its data store belongs to the core. */
  async enableAgenda(ctx: Context): Promise<void> {
    if (this.agenda) throw new Error('agenda runtime already active');
    const deps = this.deps;
    const runtime = new AgendaConnector({ ctx, data: this.agendaData, opener: deps.ctx.storageDomain,
      notifier: deps.notifier, sessions: () => deps.registry.bound(), timeZone: deps.timeZone, now: deps.now, report: deps.report, sleep: deps.sleep });
    this.agenda = runtime;
    ctx.effect(() => async () => {
      if (this.agenda === runtime) this.agenda = undefined;
      await runtime.close();
    });
    try { await runtime.start(this.settings.agenda); }
    catch (error) {
      if (this.agenda === runtime) this.agenda = undefined;
      await runtime.close();
      throw error;
    }
  }

  /** Today's and the coming days' occurrences and the open todos, for the briefing. */
  agendaFor(now: number, days: number): { occurrences: Occurrence[]; todos: Todo[] } | undefined {
    if (!this.agendaEnabled()) return undefined;
    return { occurrences: this.agendaData.agenda(now, days), todos: this.agendaData.listTodos().filter(todo => !todo.doneAt) };
  }

  current(): ConnectorSettingsRecord { return this.settings; }
  agendaEnabled(): boolean { return this.agenda?.enabled === true; }

  view(): ConnectorsView {
    const upcoming = this.agendaData.agenda(this.now(), 7).slice(0, 30).map(item => ({ id: item.event.id, title: item.event.title, start: item.start, end: item.end,
      ...(item.event.location ? { location: item.event.location } : {}), ...(item.event.repeat ? { repeat: item.event.repeat } : {}) }));
    return { modules: { agenda: !!this.agenda, mail: !!this.mail }, settings: redactConnectors(this.settings), mail: this.mail?.view() ?? { phase: 'disabled', toolsRegistered: false, watches: this.mailData.listWatches(), lastUid: this.mailData.cursor.get('inbox')?.lastUid }, ...(this.mailTest ? { mailTest: this.mailTest } : {}),
      agenda: { ...(this.agenda?.view() ?? { toolsRegistered: false, events: this.agendaData.listEvents().length, openTodos: this.agendaData.listTodos().filter(todo => !todo.doneAt).length }), upcoming, todos: this.agendaData.listTodos().slice(0, 100) } };
  }

  private async saveAllowRecipients(rules: string[], assertCurrent: () => void): Promise<void> {
    this.settings = await this.store.save(this.settings.revision, { mail: { allowRecipients: rules } }, assertCurrent);
    this.mail?.updateAllowRecipients(rules);
  }

  async handle(method: string, payload: unknown): Promise<ConnectorsView> {
    if (method === 'list') return this.view();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    if (method === 'save') {
      this.settings = await this.store.save(input.revision as number, (input.config ?? {}) as Record<string, unknown>);
      this.clearMailTest();
      await this.mail?.apply(this.settings.mail);
      await this.agenda?.apply(this.settings.agenda);
    } else if (method === 'clear-secret') {
      this.settings = await this.store.clearSecret(input.revision as number);
      this.clearMailTest();
      await this.mail?.apply(this.settings.mail);
    } else if (method === 'mail/test') {
      const runtime = this.mail;
      const revision = this.settings.revision;
      if (!runtime) throw new ChannelError('module_disabled');
      this.clearMailTest();
      const attempt = this.mailTestAttempt;
      // Test what the page shows, saved or not: the draft's password may be empty to mean "the saved one".
      const draft = input.config && typeof input.config === 'object' ? (input.config as { mail?: unknown }).mail : undefined;
      const candidate = draft === undefined ? this.settings.mail : mailInput(draft, this.settings.mail);
      const info = await runtime.test({ ...candidate, enabled: true });
      if (this.mail !== runtime || revision !== this.settings.revision || attempt !== this.mailTestAttempt) throw new ChannelError('configuration_changed');
      this.mailTest = { at: this.now(), exists: info.exists, ...(info.unseen !== undefined ? { unseen: info.unseen } : {}) };
    } else if (method === 'mail/watch/remove') {
      if (typeof input.id !== 'string' || !await this.mailData.removeWatch(input.id)) throw new ChannelError('not_found');
    } else if (method === 'agenda/event/remove') {
      if (typeof input.id !== 'string' || !await this.agendaData.removeEvent(input.id)) throw new ChannelError('not_found');
    } else if (method === 'agenda/todo/remove') {
      if (typeof input.id !== 'string' || !await this.agendaData.removeTodo(input.id)) throw new ChannelError('not_found');
    } else if (method === 'agenda/todo/done') {
      if (typeof input.id !== 'string') throw new ChannelError('invalid_configuration');
      try { await this.agendaData.updateTodo(input.id, { done: input.done !== false }); } catch { throw new ChannelError('not_found'); }
    } else throw new ChannelError('unknown_action');
    return this.view();
  }
}
