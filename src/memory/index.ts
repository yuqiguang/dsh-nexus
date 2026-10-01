import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-compaction';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import { createUserMessage, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { ChannelError } from '../channels/types.js';
import { formatLocal } from '../assistant/clock.js';
import { rank } from './search.js';
import { LEGACY_SCOPE, LOCAL_PREFERENCES, scopeChoice, scopeId, type MemoryScope, type MemoryScopeChoice } from './scope.js';
import { LIMITS, MemoryLimitError, MemoryStore, type InjectionRecord, type MemoryDomainOpener, type MemoryEvent, type MemoryPolicy, type MemoryProposal, type ProfileEntry } from './store.js';

export const MEMORY_PLUGIN = 'nexus-memory';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Long-term memory recalled ahead of the user's message; DSH 0.1.7 has no shared `plugin` kind, so each producer names its own. */
    'nexus-memory': { kind: 'nexus-memory' } & ContextFormed;
  }
}
const ZONE = 'Asia/Shanghai';

/** What one turn may carry: enough for a profile and a handful of events, small enough not to crowd the user's own message. */
export const INJECT_BUDGET = { profileChars: 1500, events: 5, totalChars: 2600 } as const;

export interface MemoryPage { page: number; pageSize: number; total: number; pages: number }
interface MemoryListQuery { eventPage: number; injectionPage: number; eventQuery: string }

function memoryListQuery(input: Record<string, unknown>): MemoryListQuery {
  const page = (value: unknown): number => {
    if (value === undefined) return 0;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ChannelError('invalid_configuration');
    return value;
  };
  if (input.eventQuery !== undefined && (typeof input.eventQuery !== 'string' || input.eventQuery.length > 200)) throw new ChannelError('invalid_configuration');
  return { eventPage: page(input.eventPage), injectionPage: page(input.injectionPage), eventQuery: ((input.eventQuery as string | undefined) ?? '').trim() };
}

function memoryPage<T>(items: T[], requested: number, pageSize: number): { items: T[]; info: MemoryPage } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize)), page = Math.min(requested, pages - 1);
  return { items: items.slice(page * pageSize, (page + 1) * pageSize), info: { page, pageSize, total: items.length, pages } };
}

export interface MemoryView {
  moduleEnabled?: boolean;
  scope?: MemoryScopeChoice;
  scopes?: MemoryScopeChoice[];
  policy: MemoryPolicy;
  profile: ProfileEntry[];
  events: MemoryEvent[];
  proposals: MemoryProposal[];
  injections: InjectionRecord[];
  counts: { profile: number; events: number; proposals: number };
  limits: typeof LIMITS;
  pagination?: { events: MemoryPage; injections: MemoryPage; eventQuery: string };
  /** Only in the response to `export`. */
  exportJson?: string;
}

interface SessionInjectionState { scopeId: string; profileStamp: string; eventIds: Set<string> }

/** Text the user typed this step; plugin-initiated messages (reminders, job notices, our own recall) never trigger a lookup. */
function userText(messages: readonly UserMessage[]): string {
  return messages.filter(message => message.source.kind === 'user')
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n').trim();
}

export function renderProfile(profile: readonly ProfileEntry[]): string {
  return profile.map(entry => `- ${entry.key}：${entry.value}`).join('\n');
}

export function renderEvents(events: readonly MemoryEvent[]): string {
  return events.map(event => `- [${event.id}] ${formatLocal(event.at, ZONE)} ${event.text}`).join('\n');
}

/**
 * Memory for the assistant: a keyed profile plus dated events in native
 * storage, three thin tools whose write policy is enforced here rather than in
 * the model's hands, and admission-gated injection of the profile and the
 * events relevant to what the user just said. Every injection is audited.
 */
export interface MemoryScopeSource {
  resolveSession(sessionId: string): Promise<MemoryScope | undefined>;
  projects(): Promise<MemoryScope[]>;
}
const unavailableScopes: MemoryScopeSource = { async resolveSession() { return undefined; }, async projects() { return []; } };

export class MemoryService {
  private readonly sessions = new Map<string, SessionInjectionState>();

  private constructor(readonly store: MemoryStore, readonly legacy: MemoryStore, private readonly source: MemoryScopeSource,
    private readonly now: () => number) {}

  static async open(opener: MemoryDomainOpener, now: () => number = Date.now, source: MemoryScopeSource = unavailableScopes): Promise<MemoryService> {
    const legacy = await MemoryStore.open(opener);
    try {
      const store = await MemoryStore.openScoped(opener);
      try {
        if (store.policy().scopeVersion !== 1) {
          const previous = legacy.policy();
          await store.setPolicy({ remember: previous.remember === 'off' ? 'off' : 'ask', inject: previous.inject });
        }
        return new MemoryService(store, legacy, source, now);
      } catch (error) { await store.close(); throw error; }
    }
    catch (error) { await legacy.close(); throw error; }
  }

  private async resolve(sessionId: string | undefined): Promise<MemoryScope> {
    const scope = sessionId ? await this.source.resolveSession(sessionId) : undefined;
    if (!scope || scope.kind !== 'project') throw new ChannelError('memory_scope_unavailable');
    return scope;
  }

  private visible(scope: MemoryScope) {
    const project = this.store.forScope(scope);
    const personal = this.store.forScope({ kind: 'global', owner: scope.owner });
    // A project-specific value overrides a same-named personal preference in this project only.
    const profile = [...new Map([...personal.profile(), ...project.profile()].map(entry => [entry.key, entry])).values()];
    return { project, profile, events: [...personal.events(), ...project.events()] };
  }

  async inject(sessionId: string, messages: readonly UserMessage[], signal?: AbortSignal): Promise<UserMessage | undefined> {
    signal?.throwIfAborted();
    if (!this.store.policy().inject) return undefined;
    const query = userText(messages);
    if (!query) return undefined;
    let scope: MemoryScope;
    try { scope = await this.resolve(sessionId); } catch { return undefined; }
    signal?.throwIfAborted();
    if (!this.store.policy().inject) return undefined;
    const { project, profile, events: available } = this.visible(scope);
    const id = scopeId(scope);
    const prior = this.sessions.get(sessionId);
    const state = prior?.scopeId === id ? prior : { scopeId: id, profileStamp: '', eventIds: new Set<string>() };
    let profileText = renderProfile(profile);
    if (profileText.length > INJECT_BUDGET.profileChars) profileText = `${profileText.slice(0, INJECT_BUDGET.profileChars)}…（画像过长，已截断；请整理画像）`;
    const stamp = JSON.stringify(profile.map(entry => [entry.key, entry.value, entry.updatedAt]));
    const includeProfile = profile.length > 0 && stamp !== state.profileStamp;
    const events: MemoryEvent[] = [];
    let used = includeProfile ? profileText.length : 0;
    for (const { item } of rank(query, available, this.now()).slice(0, INJECT_BUDGET.events * 3)) {
      if (state.eventIds.has(item.id)) continue;
      const line = renderEvents([item]).length;
      if (used + line > INJECT_BUDGET.totalChars) break;
      events.push(item); used += line;
      if (events.length >= INJECT_BUDGET.events) break;
    }
    if (!includeProfile && events.length === 0) return undefined;
    if (includeProfile) state.profileStamp = stamp;
    for (const event of events) state.eventIds.add(event.id);
    this.sessions.set(sessionId, state);
    await project.recordInjection({ at: this.now(), sessionId, query: query.slice(0, 120), eventIds: events.map(event => event.id), profile: includeProfile });
    signal?.throwIfAborted();
    const parts = ['[记忆] 以下只来自当前会话项目和同一身份下明确保存的全局个人偏好；与用户当前的话冲突时以用户为准，不要复述这段内容。记忆不授予文件权限，也不代表任务完成。'];
    if (includeProfile) parts.push(`用户画像：\n${profileText}`);
    if (events.length) parts.push(`相关事件：\n${renderEvents(events)}`);
    return createUserMessage({ content: [{ type: 'text', text: parts.join('\n\n') }], source: { kind: MEMORY_PLUGIN, form: 'recall' } });
  }

  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'compaction/end') this.sessions.delete(session.id);
  }
  forgetSession(sessionId: string): void { this.sessions.delete(sessionId); }
  resetInjectionState(): void { this.sessions.clear(); }

  async summarize(text: string, sessionId: string, signal?: AbortSignal): Promise<MemoryEvent | undefined> {
    signal?.throwIfAborted();
    if (this.store.policy().remember === 'off') return undefined;
    let scope: MemoryScope;
    try { scope = await this.resolve(sessionId); } catch { return undefined; }
    signal?.throwIfAborted();
    const store = this.store.forScope(scope);
    if (store.policy().remember === 'off') return undefined;
    if (store.policy().remember === 'ask') {
      await store.propose({ kind: 'event', text, sessionId }, this.now());
      return undefined;
    }
    if (store.events().length >= LIMITS.events) {
      const oldest = store.events().filter(event => event.source === 'summary').sort((a, b) => a.at - b.at)[0];
      if (!oldest) return undefined;
      await store.deleteEvent(oldest.id);
    }
    return store.addEvent({ text, source: 'summary', sessionId }, this.now());
  }

  async remember(input: { kind: 'profile' | 'event'; key?: string; text: string; tags?: string[]; sessionId?: string }, signal?: AbortSignal): Promise<string> {
    const store = this.store.forScope(await this.resolve(input.sessionId));
    signal?.throwIfAborted();
    if (store.policy().remember === 'off') throw new Error('用户已关闭记忆写入，这条内容不会被记住；请让用户在设置页打开记忆。');
    if (store.policy().remember === 'ask') {
      const proposal = await store.propose({ kind: input.kind, key: input.key, text: input.text, tags: input.tags, sessionId: input.sessionId }, this.now());
      return `已记为当前项目的待确认（${proposal.id}），用户在设置页确认后才会生效。`;
    }
    if (input.kind === 'profile') {
      if (!input.key) throw new MemoryLimitError('画像条目需要 key。');
      const entry = await store.setProfile(input.key, input.text, 'model', this.now());
      return `已记住当前项目画像：${entry.key}：${entry.value}`;
    }
    const event = await store.addEvent({ text: input.text, tags: input.tags, source: 'model', sessionId: input.sessionId }, this.now());
    return `已记住当前项目事件 ${event.id}：${event.text}`;
  }

  async recall(query: string, limit: number, sessionId?: string, signal?: AbortSignal): Promise<string> {
    const { profile, events } = this.visible(await this.resolve(sessionId));
    signal?.throwIfAborted();
    const ranked = rank(query, events, this.now()).slice(0, Math.min(Math.max(limit, 1), 20));
    const lines = ['范围：当前会话项目及同一身份的全局个人偏好。'];
    if (profile.length) lines.push(`用户画像（${profile.length} 条）：\n${renderProfile(profile)}`);
    lines.push(ranked.length ? `相关事件（${ranked.length} 条）：\n${renderEvents(ranked.map(item => item.item))}` : '没有与此相关的事件记忆。');
    return lines.join('\n\n');
  }

  async forget(input: { id?: string; key?: string }, sessionId?: string, signal?: AbortSignal): Promise<string> {
    const store = this.store.forScope(await this.resolve(sessionId));
    signal?.throwIfAborted();
    if (input.id) {
      const event = store.event(input.id);
      if (!event || !await store.deleteEvent(input.id)) throw new ChannelError('not_found');
      for (const state of this.sessions.values()) state.eventIds.delete(input.id);
      return `已删除当前项目事件记忆：${event.text}`;
    }
    if (input.key) {
      if (!await store.deleteProfile(input.key)) throw new Error('当前项目没有该画像条目；全局个人偏好请在记忆设置中删除。');
      return `已删除当前项目画像条目：${input.key}`;
    }
    throw new Error('memory_forget 需要 id 或 key。');
  }

  private async catalog(): Promise<Map<string, MemoryScope>> {
    const scopes = [LOCAL_PREFERENCES, ...this.store.scopes(), ...await this.source.projects()];
    const all = scopes.flatMap(scope => [scope, { kind: 'global', owner: scope.owner } as MemoryScope]);
    return new Map(all.map(scope => [scopeId(scope), scope]));
  }

  private view(store: MemoryStore, choice: MemoryScopeChoice, catalog: Map<string, MemoryScope>, query: MemoryListQuery, extra: Partial<MemoryView> = {}): MemoryView {
    const profile = store.profile(), events = store.events(), proposals = store.proposals();
    const needle = query.eventQuery.toLowerCase();
    const matching = needle ? events.filter(event => event.text.toLowerCase().includes(needle) || event.tags?.some(tag => tag.toLowerCase().includes(needle))) : events;
    const eventPage = memoryPage(matching, query.eventPage, 20), injectionPage = memoryPage(store.injections(), query.injectionPage, 10);
    return { scope: choice, scopes: [{ id: LEGACY_SCOPE, kind: 'legacy', label: '旧版未归类记忆（不注入）' }, ...[...catalog.values()].map(scopeChoice)],
      policy: { remember: this.store.policy().remember, inject: this.store.policy().inject }, profile, events: eventPage.items, proposals, injections: injectionPage.items,
      pagination: { events: eventPage.info, injections: injectionPage.info, eventQuery: query.eventQuery },
      counts: { profile: profile.length, events: events.length, proposals: proposals.length }, limits: LIMITS, ...extra };
  }

  /** Authenticated local settings select only scopes enumerated by the server. Model tools never call these routes. */
  async handle(method: string, payload: unknown = {}): Promise<MemoryView> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    const query = memoryListQuery(input);
    const catalog = await this.catalog();
    const selected = input.scopeId ?? scopeId(LOCAL_PREFERENCES);
    if (typeof selected !== 'string' || (selected !== LEGACY_SCOPE && !catalog.has(selected))) throw new ChannelError('memory_scope_unavailable');
    const isLegacy = selected === LEGACY_SCOPE;
    const choice: MemoryScopeChoice = isLegacy ? { id: LEGACY_SCOPE, kind: 'legacy', label: '旧版未归类记忆（不注入）' } : scopeChoice(catalog.get(selected)!);
    const store = isLegacy ? this.legacy : this.store.forScope(catalog.get(selected)!);
    const view = (extra: Partial<MemoryView> = {}) => this.view(store, choice, catalog, query, extra);
    if (method === 'list') return view();
    if (method === 'export') return view({ exportJson: JSON.stringify({ ...store.export(), scope: choice }, null, 2) });
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    try {
      if (method === 'legacy/copy') {
        if (!isLegacy || typeof input.targetScopeId !== 'string' || !catalog.has(input.targetScopeId)) throw new ChannelError('memory_scope_unavailable');
        const target = this.store.forScope(catalog.get(input.targetScopeId)!);
        const record = input.kind === 'profile' ? store.profile().find(entry => entry.key === input.key)
          : input.kind === 'event' ? store.event(text(input.id)) : input.kind === 'proposal' ? store.proposals().find(item => item.id === input.id) : undefined;
        if (!record) throw new ChannelError('not_found');
        const value = 'value' in record ? record.value : record.text;
        if (input.expectedText !== value) throw new ChannelError('configuration_changed');
        const key = 'key' in record && record.key;
        if (key) {
          if (target.profile().some(entry => entry.key === key)) throw new ChannelError('memory_profile_exists');
          await target.setProfile(key, value, 'user', this.now());
        } else await target.addEvent({ text: value, source: 'user', ...('tags' in record ? { tags: record.tags } : {}) }, this.now());
      } else if (method === 'policy') {
        if (isLegacy) throw new ChannelError('memory_legacy_readonly');
        const remember = input.remember;
        if (remember !== 'auto' && remember !== 'ask' && remember !== 'off' || typeof input.inject !== 'boolean') throw new ChannelError('invalid_configuration');
        await this.store.setPolicy({ remember, inject: input.inject });
      } else if (method === 'profile/set') {
        if (isLegacy) throw new ChannelError('memory_legacy_readonly');
        await store.setProfile(text(input.key), text(input.value), 'user', this.now());
      } else if (method === 'profile/delete') {
        if (!await store.deleteProfile(text(input.key))) throw new ChannelError('not_found');
      } else if (method === 'event/add') {
        if (isLegacy) throw new ChannelError('memory_legacy_readonly');
        await store.addEvent({ text: text(input.text), tags: Array.isArray(input.tags) ? input.tags.map(text) : [], source: 'user' }, this.now());
      } else if (method === 'event/delete') {
        if (!await store.deleteEvent(text(input.id))) throw new ChannelError('not_found');
        for (const state of this.sessions.values()) state.eventIds.delete(text(input.id));
      } else if (method === 'proposal/settle') {
        if (isLegacy && input.accept === true) throw new ChannelError('memory_legacy_readonly');
        if (!await store.settleProposal(text(input.id), input.accept === true, this.now())) throw new ChannelError('not_found');
      } else throw new ChannelError('unknown_action');
    } catch (error) {
      if (error instanceof MemoryLimitError) throw new ChannelError('memory_limit');
      throw error;
    }
    return view();
  }

  async close(): Promise<void> { await this.store.close(); await this.legacy.close(); }
}

/** One activation's admission boundary. Data storage outlives this runtime.
 * Pending scope lookups cannot start writes after disable; already admitted
 * storage writes drain before DSH finishes unloading the component. */
export class MemoryRuntime {
  private readonly lifetime = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly service: MemoryService) { service.resetInjectionState(); }
  get enabled(): boolean { return !this.lifetime.signal.aborted; }

  async use<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.enabled) throw new ChannelError('module_disabled');
    const task = Promise.resolve().then(() => {
      this.lifetime.signal.throwIfAborted();
      return operation(this.lifetime.signal);
    });
    this.pending.add(task);
    try { return await task; } finally { this.pending.delete(task); }
  }

  async summarize(text: string, sessionId: string): Promise<MemoryEvent | undefined> {
    try { return await this.use(signal => this.service.summarize(text, sessionId, signal)); }
    catch (error) { if (!this.enabled) return undefined; throw error; }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.pending]);
    this.service.resetInjectionState();
  }
}

/** Registers the tools, the prompt section, the injection listener, and the compaction hook. */
export function installMemory(ctx: Context, service: MemoryService, options: { closeService?: boolean } = {}): MemoryRuntime {
  const runtime = new MemoryRuntime(service);
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '把值得长期记住的信息写入当前会话项目的跨会话记忆，作用域由原生会话决定，不能指定其他项目或全局。kind=profile 记稳定事实（称呼、偏好、习惯、家人、工作），用简短的 key 标识，同一 key 会被新值覆盖；kind=event 记发生过的事或用户说过的决定（何时、什么、结论），一句话说清。只记用户明确表达或明显重要的内容，不记工具用法、临时状态和你自己的推测。用户说"记住…"时必须调用。',
    parameters: {
      kind: { type: 'string', enum: ['profile', 'event'], required: true, description: 'profile 画像条目；event 事件记忆。' },
      key: { type: 'string', description: 'profile 必填：条目名，如"称呼"、"饮食偏好"、"公司"。' },
      text: { type: 'string', required: true, description: '要记住的内容。profile 是该条目的值；event 是一句完整的话。' },
      tags: { type: 'array', items: { type: 'string' }, description: 'event 可选：便于以后检索的关键词，最多 6 个。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      return { text: await runtime.use(signal => service.remember({ kind: args.kind as 'profile' | 'event', key: args.key, text: args.text, tags: args.tags as string[] | undefined, sessionId: exec.agent?.id }, signal)) };
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '按关键词检索当前会话项目及同一身份的全局个人偏好，返回画像和相关事件；无法访问其他项目或旧版未归类记忆。用户问"上次…是什么时候"、"我之前说过…"，或你需要了解用户背景时调用。每轮开始时系统已自动注入最相关的记忆，只有需要更多或更具体的内容时才调用。',
    parameters: {
      query: { type: 'string', required: true, description: '要查找的关键词或一句话。' },
      limit: { type: 'number', description: '最多返回的事件数，默认 8，最多 20。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) { return { text: await runtime.use(signal => service.recall(args.query, args.limit ?? 8, exec.agent?.id, signal)) }; },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除当前会话项目的一条记忆。全局个人偏好只能由用户在设置页删除。用户说"别记那个了"、"那条不对"时调用：事件用 id（me-xxxx，来自记忆注入或 memory_recall），画像用 key。',
    parameters: {
      id: { type: 'string', description: '要删除的事件记忆 id。' },
      key: { type: 'string', description: '要删除的画像条目 key。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) { return { text: await runtime.use(signal => service.forget({ id: args.id, key: args.key }, exec.agent?.id, signal)) }; },
  })));
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'nexus:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS') + 3,
    text: context => !ctx.tools.get('memory_recall', context.scope) ? '' : '记忆：你有按会话项目和身份隔离的长期记忆。只能写入或删除当前项目记忆，读取还包括用户明确保存的同一身份全局个人偏好；旧版未归类记忆不供模型使用。缺少有效工作目录或在子任务会话中时不可用。默认写入先待用户确认，全局共享需用户在设置页明确操作。每轮用户发言前，系统会以"[记忆]"开头的消息注入用户画像和相关事件，直接据此行事，不必向用户复述或确认"我记得"。用户说出稳定的偏好、称呼、家人、工作等事实，或明确说"记住"时，用 memory_remember 记下（画像用 profile，经历和决定用 event）；用户问起过去的事而注入里没有时用 memory_recall；用户要求忘记或纠正时用 memory_forget。不要记录工具用法、临时状态或你的推测；代码项目的结构和约定写进项目目录的 AGENTS.md 之类的文件，不进记忆；记忆写满时按工具返回的提示整理，不要硬塞。',
  }));
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || !runtime.enabled || !ctx.tools.get('memory_recall', payload.agent)) return decision;
    try {
      const recall = await runtime.use(signal => service.inject(payload.agent.id, decision.messages, signal));
      return recall && runtime.enabled ? { ...decision, messages: [recall, ...decision.messages] } : decision;
    } catch (error) {
      if (runtime.enabled) console.error('[nexus-memory] inject_failed');
      return decision;
    }
  });
  ctx.on('session/event', (session, event) => service.onSessionEvent(session, event));
  ctx.on('session/disposed', session => service.forgetSession(session.id));
  ctx.effect(() => async () => { await runtime.close(); if (options.closeService !== false) await service.close(); });
  return runtime;
}
