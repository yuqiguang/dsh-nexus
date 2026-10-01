import { SessionId } from '@deepseek-ai/dsh-session';
import type { ResearchWeb } from './coders/research.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-credentials';
import { registerRpc } from './dsh/rpc.js';
import type {} from './dsh/nexus.js';
export { registerRpc } from './dsh/rpc.js';
export { installDocuments } from './documents/plugin.js';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { DeliveryLedger } from './channels/ledger.js';
import { ChannelManager, type ChannelDependencies } from './channels/manager.js';
import { BridgeRegistry } from './channels/notify.js';
import { ConnectionStore } from './channels/store.js';
import { installCoders } from './coders/index.js';
import { Connectors, type ConnectorsDeps } from './connectors/index.js';
import { FileLedger, installFileFind } from './files/index.js';
import { DEFAULT_ROTATION, SessionRoster } from './sessions/index.js';
import { CoderInstaller, managedLayout, type NpmRunner } from './coders/install.js';
import { CodersManager, type ManagerDeps } from './coders/manager.js';
import { CoderSettingsStore } from './coders/settings.js';
import { Assistant } from './assistant/index.js';
import { DEFAULT_TIME_ZONE } from './assistant/settings.js';
import { installAssistantPrompt } from './assistant/prompt.js';
import { installUntrustedResults } from './assistant/untrusted.js';
import { MemoryService, installMemory } from './memory/index.js';
import { projectScope, sessionMemoryScope } from './memory/scope.js';
import { installBridge, type BridgeExtras } from './dsh/bridge.js';
import { DshRecords } from './dsh/records.js';
import { installHealth, readBuildInfo } from './service/health.js';
import { installDataRoutes } from './data/index.js';
import { createRequire } from 'node:module';
import { startLifecycle } from './service/lifecycle.js';
import { ChannelError, type ChannelId, type ConnectionRecord } from './channels/types.js';
import { identity } from './channels/protocol.js';
import { readFeishuConfig } from './feishu/config.js';
import { LarkTransport } from './feishu/larkTransport.js';
import { WecomTransport } from './wecom/transport.js';
import { WechatTransport } from './wechat/transport.js';
import { WechatClient } from './wechat/client.js';
import { WechatStateStore, formerWechatBases } from './wechat/state.js';

export const name = 'nexus-channels';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'credentials', 'connection', 'tools', 'sandboxPolicy', 'sandbox', 'web', 'agents',
  'jobs', 'userQuestions', 'storageDomain', 'systemPrompt'];

/** Channel names, as the settings page and the workspace groups both spell them. */
const titles: Record<ChannelId, string> = { wechat: '微信', feishu: '飞书', wecom: '企业微信' };

export async function installChannels(ctx: Context, workspace: string, legacyFeishu?: ConnectionRecord,
  fixtures?: Pick<ChannelDependencies, 'transport' | 'wechatClient'>, registry?: BridgeRegistry, extras: BridgeExtras = {}): Promise<ChannelManager> {
  const report = (code: string) => console.error(`[nexus-channels] ${code}`);
  const records = new DshRecords(ctx.credentials);
  const manager = new ChannelManager(new ConnectionStore(records, legacyFeishu), {
    defaultWorkspace: resolve(workspace),
    transport: fixtures?.transport ?? ((channel, record, state) => {
      if (channel === 'feishu') return new LarkTransport({ appId: record.accountId, appSecret: record.secret, ownerOpenId: record.ownerId }, report, state);
      if (channel === 'wecom') return new WecomTransport(record, state, report);
      // WeChat hands a delivered file over as a workspace path and re-reads it when it can be sent, so the
      // outbox must name the same directory the session wrote it in.
      const channelWorkspace = resolve(record.workspaceRoot ?? workspace);
      return new WechatTransport(record, state, new WechatStateStore(records, record.accountId, record.ownerId), fetch, undefined, { workspace: channelWorkspace });
    }),
    wechatClient: fixtures?.wechatClient ?? (() => new WechatClient()),
    async mount(transport, identity, record) {
      let bridge: ReturnType<typeof installBridge>;
      // Each channel works in its own directory when the record names one, and they all share the
      // profile's workspace when it does not. This is what a session is created with as its cwd, so it
      // is also what the sandbox fences and where attachments and delivered files are read.
      const channelWorkspace = resolve(record.workspaceRoot ?? workspace);
      await mkdir(channelWorkspace, { recursive: true }).catch(() => { report('channel_workspace_create_failed'); });
      const fiber = ctx.plugin({ inject: ['sessionController', 'sessions', 'sessionPersistence', 'workspaceRegistry'],
        apply(owner: Context) {
          // A new bot account after a QR scan starts the chat's sessions over; the earlier accounts' lines are merged once.
          const formerBases = identity.channel === 'wechat' ? () => formerWechatBases(records, identity) : undefined;
          bridge = installBridge(owner, transport, identity, channelWorkspace, report, undefined, formerBases ? { ...extras, formerBases } : extras); registry?.add(bridge);
          // A session lands in 未分组 unless it is attached to a workspace, and DSH attaches only what
          // `sessionController.create` was asked to create inside one — by workspaceId, which these
          // sessions never name, because they are created with a cwd. So the directory is registered
          // here (idempotent for a path already known) and the bridge attaches the sessions itself:
          // without a group there is no file tree next to the chat and no way to open a session there.
          owner.workspaceRegistry.create(channelWorkspace, record.workspaceRoot ? `${titles[identity.channel]}工作区` : '助理工作区')
            .then(registered => bridge!.adoptWorkspace(registered))
            .catch(() => { report('channel_workspace_group_failed'); });
        } });
      await fiber;
      // Off the mount path: a resumed session lets native reminders fire after a restart without a first message.
      void bridge!.resumeBound().catch(() => { report('channel_session_resume_failed'); });
      return { receive: message => bridge.receive(message), close: () => { registry?.remove(bridge); return fiber.dispose(); },
        ...(transport.retryPending ? { retryPending: () => transport.retryPending!() } : {}) };
    },
  });
  ctx.effect(() => () => manager.close());
  // Exact routes inherit the shared /api carrier's authentication and body limit.
  registerRpc(ctx, 'nexus-channels', ['list', 'save', 'save-workspace', 'connect', 'disconnect', 'qr/start', 'qr/cancel', 'retry-delivery', 'feishu/pair/start', 'feishu/pair/cancel', 'feishu/pair/confirm'], (method, payload) => manager.handle(method, payload));
  await manager.restore();
  return manager;
}

/** Coder settings, managed installs, and their `/api/nexus-coders/*` routes; the settings live in native credentials under their own scope. */
export async function installCoderSettings(ctx: Context, profileRoots: string[], managedRoot = dshHomePath('nexus-coders'),
  seams: Pick<ManagerDeps, 'env' | 'detect' | 'loginStatus'> & { npm?: NpmRunner } = {}): Promise<CodersManager> {
  const layout = managedLayout(resolve(managedRoot));
  let manager: CodersManager;
  const installer = new CoderInstaller(layout, seams.npm, coder => manager.afterInstall(coder));
  const { npm: _npm, ...managerSeams } = seams;
  manager = new CodersManager({ store: new CoderSettingsStore(new DshRecords(ctx.credentials, 'nexus-coders')), layout, profileRoots, installer,
    workspaces: () => ctx.get('workspaceRegistry')?.list().map(({ id, title, path }) => ({ id, title, path })) ?? [], ...managerSeams });
  await manager.load();
  registerRpc(ctx, 'nexus-coders', ['list', 'refresh', 'project/select', 'save', 'clear-secret', 'install', 'windows-sandbox/setup', 'rules/remove'], (method, payload) => manager.handle(method, payload));
  return manager;
}

export async function apply(ctx: Context, config: { workspaceRoot?: string; configFile?: string; coderRoots?: string[] } = {}): Promise<void> {
  let fileConfig: NodeJS.ProcessEnv = {};
  if (config.configFile) {
    try { fileConfig = parseEnv(await readFile(config.configFile, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not read channel configuration.'); }
  }
  const feishu = readFeishuConfig({ ...fileConfig, ...process.env });
  const legacy: ConnectionRecord | undefined = feishu ? { version: 1, revision: 0, enabled: true,
    accountId: feishu.appId, ownerId: feishu.ownerOpenId, secret: feishu.appSecret } : undefined;
  // Installed bundles receive an isolated workspace; the development profile supplies its existing path.
  const workspace = resolve(config.workspaceRoot ?? dshHomePath('nexus-workspace'));
  await mkdir(workspace, { recursive: true });
  const registry = new BridgeRegistry();
  const startedAt = Date.now();
  const report = (message: string) => console.error(`[nexus-service] ${message}`);
  // Which completed turns each chat has seen; the bridges read it when they mount to deliver what ended while they were gone.
  const ledger = await DeliveryLedger.open(ctx.storageDomain);
  ctx.effect(() => () => { void ledger.close(); });
  let assistant: Assistant | undefined;
  const timeZone = () => assistant?.timeZone() ?? DEFAULT_TIME_ZONE;
  // Which files went in and out of each chat, with the request they belonged to; `file_find` searches it for the model.
  const files = await FileLedger.open(ctx.storageDomain, Date.now, timeZone);
  ctx.effect(() => () => { void files.close(); });
  // Which generation of each chat's session is active; a new day or an oversized context opens the next one.
  const sessions = await SessionRoster.open(ctx.storageDomain);
  ctx.effect(() => () => { void sessions.close(); });
  const channels = await installChannels(ctx, workspace, legacy, undefined, registry, { ledger, timeZone, files, sessions,
    rotation: () => assistant?.rotation() ?? DEFAULT_ROTATION,
    memory: { remember: (text, sessionId) => ctx.get('nexusMemoryRuntime')?.summarize(text, sessionId) ?? Promise.resolve(undefined) },
    transcribe: (wav, signal) => assistant ? assistant.transcribe(wav, signal) : Promise.reject(new ChannelError('speech_not_configured')) });
  installUntrustedResults(ctx);
  assistant = await installAssistant(ctx, registry);
  const memorySettings = await installMemorySettings(ctx, {
    enabled: false, moduleEnabled: () => ctx.get('nexusMemoryRuntime')?.enabled === true,
  });
  ctx.provide('nexusMemoryData', memorySettings);
  // Coding tasks default to the channel workspace; the development profile widens this to the projects directory.
  // Every channel directory is a root too, so a task the chat asks for can run where the chat works.
  const profileRoots = [...new Set([...(config.coderRoots?.length ? config.coderRoots : [workspace]), ...await channels.workspaces()])].map(root => resolve(root));
  const manager = await installCoderSettings(ctx, profileRoots);
  const webForOwner = (ownerSession: string): ResearchWeb => {
    const run = <T>(operation: () => Promise<T>): Promise<T> => {
      const agent = ctx.agents.get(ownerSession as SessionId);
      if (!agent) throw new Error('research_owner_unavailable');
      return ctx.agents.withInitiator(agent, operation);
    };
    return { search: (request, signal) => run(() => ctx.web.search(request, signal)), fetch: (request, signal) => run(() => ctx.web.fetch(request, signal)) };
  };
  const coders = await installCoders(ctx, { web: webForOwner, roots: profileRoots, notifier: registry, manager,
    registerRpc: (family, methods, handle) => registerRpc(ctx, family, methods, handle) });
  const connectors = await installConnectors(ctx, registry, { notifier: assistant.notifier(), timeZone });
  ctx.provide('nexusConnectors', connectors);
  assistant.attachAgenda((now, days) => connectors.agendaFor(now, days));
  ctx.provide('nexusWorkspace', { root: workspace });
  installAssistantPrompt(ctx);
  installFileFind({ ctx, workspace, ledger: files, timeZone });
  // The updater restarts only a quiet service: no open turn, and nothing happened in any session for a while.
  let lastActivityAt = startedAt;
  ctx.on('session/event', () => { lastActivityAt = Date.now(); });
  const runningTurns = () => ctx.sessions.list().filter(session => session.snapshotEvents().findLast(event => event.type === 'turn/start' || event.type === 'turn/end')?.type === 'turn/start').length;
  const build = readBuildInfo(new URL('../build-info.json', import.meta.url));
  // Export and import of the user's data. Under systemd a SIGTERM stops DSH cleanly and the unit starts it again,
  // and the start script swaps a staged import in before DSH opens anything; run by hand, the user restarts it.
  const dshVersion = hostVersion();
  installDataRoutes({ ctx, home: dshHomePath(), importEnabled: process.env.NEXUS_IMPORT_HOME === dshHomePath(), ...(dshVersion ? { dshVersion } : {}), ...(build?.commit ? { commit: build.commit } : {}), report,
    restart: () => {
      if (!process.env.INVOCATION_ID) return false;
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1000).unref();
      return true;
    } });
  installHealth(ctx, { startedAt, heldPushes: () => assistant?.heldPushes() ?? 0, coders: () => coders.active().map(task => task.id), runningTurns, lastActivityAt: () => lastActivityAt,
    ...(build?.commit ? { commit: build.commit } : {}),
    async notify(text, id) {
      let delivered = false;
      for (const sessionId of registry.bound()) if (await assistant!.notifier().notify(sessionId, text, identity('service-notice', id, sessionId))) delivered = true;
      return delivered;
    },
    channels: async () => (await channels.view()).connections.map(item => ({ channel: item.channel, enabled: item.enabled, phase: item.phase,
      ...(item.error ? { error: item.error } : {}), ...(item.pendingDeliveries !== undefined ? { pendingDeliveries: item.pendingDeliveries } : {}) })) });
  // Off the startup path: the transports may still be connecting, and WeChat holds texts until they can go.
  void (async () => {
    await startLifecycle({ home: dshHomePath(), notifier: registry, sessions: () => registry.bound(), timeZone: assistant.timeZone(), report },
      dispose => ctx.effect(() => dispose));
    await registry.catchUp();
  })().catch(error => report(`startup notices failed: ${(error as Error)?.message ?? error}`));
}

/** Personal connectors (the mailbox, the assistant's own agenda) and their `/api/nexus-connectors/*` routes. */
export async function installConnectors(ctx: Context, registry: BridgeRegistry, seams: Omit<ConnectorsDeps, 'ctx' | 'registry'>): Promise<Connectors> {
  const connectors = new Connectors({ ctx, registry, ...seams });
  await connectors.start();
  registerRpc(ctx, 'nexus-connectors', ['list', 'save', 'clear-secret', 'mail/test', 'mail/watch/remove', 'agenda/event/remove', 'agenda/todo/remove', 'agenda/todo/done'],
    (method, payload) => connectors.handle(method, payload));
  return connectors;
}

/** Long-term memory: tools, injection, and the `/api/nexus-memory/*` routes for the settings page. */
export async function installMemorySettings(ctx: Context, seams: { now?: () => number; enabled?: boolean; moduleEnabled?: () => boolean } = {}): Promise<MemoryService> {
  const service = await MemoryService.open(ctx.storageDomain, seams.now, {
    resolveSession: async id => sessionMemoryScope(ctx.sessions.get(SessionId(id))?.header),
    projects: async () => {
      const projects = await Promise.all((ctx.get('workspaceRegistry')?.list() ?? []).map(workspace => projectScope(workspace.path).catch(() => undefined)));
      return projects.filter(project => project !== undefined);
    },
  });
  if (seams.enabled !== false) installMemory(ctx, service);
  else ctx.effect(() => () => service.close());
  registerRpc(ctx, 'nexus-memory', ['list', 'export', 'policy', 'profile/set', 'profile/delete', 'event/add', 'event/delete', 'proposal/settle', 'legacy/copy'],
    async (method, payload) => ({ ...await service.handle(method, payload), moduleEnabled: seams.moduleEnabled?.() ?? seams.enabled !== false }));
  return service;
}

/** Quiet hours, the daily briefing, and the inbound hook, with their settings routes. */
export async function installAssistant(ctx: Context, registry: BridgeRegistry, seams: { now?: () => number; report?: (message: string) => void } = {}): Promise<Assistant> {
  const assistant = new Assistant({ ctx, registry, ...seams });
  await assistant.start();
  registerRpc(ctx, 'nexus-assistant', ['list', 'save', 'hook/rotate', 'speech/clear', 'briefing/send', 'flush'], (method, payload) => assistant.handle(method, payload));
  return assistant;
}

/** The DSH version this build runs under, for the data archive's manifest; absent where DSH's package is not resolvable from here. */
function hostVersion(): string | undefined {
  try { return (createRequire(import.meta.url)('@deepseek-ai/dsh/package.json') as { version?: string }).version; }
  catch { return undefined; }
}
