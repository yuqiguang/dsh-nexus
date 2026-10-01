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

export interface MemoryView {
  policy: MemoryPolicy;
  profile: ProfileEntry[];
  events: MemoryEvent[];
  proposals: MemoryProposal[];
  injections: InjectionRecord[];
  counts: { profile: number; events: number; proposals: number };
  limits: typeof LIMITS;
  /** Only in the response to `export`. */
  exportJson?: string;
}

interface SessionInjectionState { profileStamp: string; eventIds: Set<string> }

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
export class MemoryService {
  private readonly sessions = new Map<string, SessionInjectionState>();

  constructor(readonly store: MemoryStore, private readonly now: () => number = Date.now) {}

  static async open(opener: MemoryDomainOpener, now?: () => number): Promise<MemoryService> {
    return new MemoryService(await MemoryStore.open(opener), now);
  }

  /** The recall message for this step, or nothing when there is nothing new to say. */
  async inject(sessionId: string, messages: readonly UserMessage[]): Promise<UserMessage | undefined> {
    if (!this.store.policy().inject) return undefined;
    const query = userText(messages);
    if (!query) return undefined;
    const state = this.sessions.get(sessionId) ?? { profileStamp: '', eventIds: new Set<string>() };
    const profile = this.store.profile();
    let profileText = renderProfile(profile);
    if (profileText.length > INJECT_BUDGET.profileChars) profileText = `${profileText.slice(0, INJECT_BUDGET.profileChars)}…（画像过长，已截断；请整理画像）`;
    const stamp = profile.map(entry => `${entry.key}=${entry.updatedAt}`).join('|');
    const includeProfile = profile.length > 0 && stamp !== state.profileStamp;
    const events: MemoryEvent[] = [];
    let used = includeProfile ? profileText.length : 0;
    for (const { item } of this.store.recall(query, INJECT_BUDGET.events * 3, this.now())) {
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
    await this.store.recordInjection({ at: this.now(), sessionId, query: query.slice(0, 120), eventIds: events.map(event => event.id), profile: includeProfile });
    const parts = ['[记忆] 以下是关于用户的长期记忆，供你参考；与用户当前的话冲突时以用户为准，不要向用户复述这段内容。'];
    if (includeProfile) parts.push(`用户画像：\n${profileText}`);
    if (events.length) parts.push(`相关事件：\n${renderEvents(events)}`);
    return createUserMessage({ content: [{ type: 'text', text: parts.join('\n\n') }], source: { kind: MEMORY_PLUGIN, form: 'recall' } });
  }

  /** After compaction the earlier injection is gone from the model's view, so the next user message gets it again. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'compaction/end') this.sessions.delete(session.id);
  }

  forgetSession(sessionId: string): void { this.sessions.delete(sessionId); }

  /**
   * A digest of a conversation that was just replaced, kept as an event with
   * source `summary`. Follows the user's policy for writes (off means nothing
   * is kept; ask still stores it, since nothing was invented); when the event
   * table is full the oldest digest makes room, never a memory the model or the
   * user wrote.
   */
  async summarize(text: string, sessionId: string): Promise<MemoryEvent | undefined> {
    if (this.store.policy().remember === 'off') return undefined;
    if (this.store.events().length >= LIMITS.events) {
      const oldest = this.store.events().filter(event => event.source === 'summary').sort((a, b) => a.at - b.at)[0];
      if (!oldest) return undefined;
      await this.store.deleteEvent(oldest.id);
    }
    return this.store.addEvent({ text, source: 'summary', sessionId }, this.now());
  }

  /** The model's `remember`: stored, proposed, or refused according to the policy the user set. */
  async remember(input: { kind: 'profile' | 'event'; key?: string; text: string; tags?: string[]; sessionId?: string }): Promise<string> {
    const policy = this.store.policy().remember;
    if (policy === 'off') throw new Error('用户已关闭记忆写入，这条内容不会被记住；如果用户明确要求记住，请让用户在设置页打开记忆。');
    if (policy === 'ask') {
      const proposal = await this.store.propose({ kind: input.kind, key: input.key, text: input.text, tags: input.tags, sessionId: input.sessionId }, this.now());
      return `已记为待确认（${proposal.id}），用户在设置页确认后才会生效。`;
    }
    if (input.kind === 'profile') {
      if (!input.key) throw new MemoryLimitError('画像条目需要 key。');
      const entry = await this.store.setProfile(input.key, input.text, 'model', this.now());
      return `已记住画像：${entry.key}：${entry.value}`;
    }
    const event = await this.store.addEvent({ text: input.text, tags: input.tags, source: 'model', sessionId: input.sessionId }, this.now());
    return `已记住事件 ${event.id}：${event.text}`;
  }

  recall(query: string, limit: number): string {
    const ranked = this.store.recall(query, Math.min(Math.max(limit, 1), 20), this.now());
    const profile = this.store.profile();
    const lines: string[] = [];
    if (profile.length) lines.push(`用户画像（${profile.length} 条）：\n${renderProfile(profile)}`);
    lines.push(ranked.length ? `相关事件（${ranked.length} 条）：\n${renderEvents(ranked.map(item => item.item))}` : '没有与此相关的事件记忆。');
    return lines.join('\n\n');
  }

  async forget(input: { id?: string; key?: string }): Promise<string> {
    if (input.id) {
      const event = this.store.event(input.id);
      if (!event || !await this.store.deleteEvent(input.id)) throw new Error(`没有事件记忆 ${input.id}。`);
      for (const state of this.sessions.values()) state.eventIds.delete(input.id);
      return `已删除事件记忆：${event.text}`;
    }
    if (input.key) {
      if (!await this.store.deleteProfile(input.key)) throw new Error(`画像里没有 ${input.key}。`);
      return `已删除画像条目：${input.key}`;
    }
    throw new Error('memory_forget 需要 id 或 key。');
  }

  view(extra: Partial<MemoryView> = {}): MemoryView {
    const profile = this.store.profile();
    const events = this.store.events();
    const proposals = this.store.proposals();
    return { policy: this.store.policy(), profile, events: events.slice(0, 200), proposals, injections: this.store.injections().slice(0, 20),
      counts: { profile: profile.length, events: events.length, proposals: proposals.length }, limits: LIMITS, ...extra };
  }

  /** Settings-page routes. Page writes are the user's word: they never go through the proposal queue. */
  async handle(method: string, payload: unknown): Promise<MemoryView> {
    if (method === 'list') return this.view();
    if (method === 'export') return this.view({ exportJson: JSON.stringify(this.store.export(), null, 2) });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    try {
      if (method === 'policy') {
        const remember = input.remember;
        if (remember !== 'auto' && remember !== 'ask' && remember !== 'off' || typeof input.inject !== 'boolean') throw new ChannelError('invalid_configuration');
        await this.store.setPolicy({ remember, inject: input.inject });
      } else if (method === 'profile/set') {
        await this.store.setProfile(text(input.key), text(input.value), 'user', this.now());
      } else if (method === 'profile/delete') {
        if (!await this.store.deleteProfile(text(input.key))) throw new ChannelError('not_found');
      } else if (method === 'event/add') {
        await this.store.addEvent({ text: text(input.text), tags: Array.isArray(input.tags) ? input.tags.map(text) : [], source: 'user' }, this.now());
      } else if (method === 'event/delete') {
        if (!await this.store.deleteEvent(text(input.id))) throw new ChannelError('not_found');
        for (const state of this.sessions.values()) state.eventIds.delete(text(input.id));
      } else if (method === 'proposal/settle') {
        if (!await this.store.settleProposal(text(input.id), input.accept === true, this.now())) throw new ChannelError('not_found');
      } else throw new ChannelError('unknown_action');
    } catch (error) {
      if (error instanceof MemoryLimitError) throw new ChannelError('memory_limit');
      throw error;
    }
    return this.view();
  }

  close(): Promise<void> { return this.store.close(); }
}

/** Registers the tools, the prompt section, the injection listener, and the compaction hook. */
export function installMemory(ctx: Context, service: MemoryService): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '把值得长期记住的信息写入跨会话记忆。kind=profile 记稳定事实（称呼、偏好、习惯、家人、工作），用简短的 key 标识，同一 key 会被新值覆盖；kind=event 记发生过的事或用户说过的决定（何时、什么、结论），一句话说清。只记用户明确表达或明显重要的内容，不记工具用法、临时状态和你自己的推测。用户说"记住…"时必须调用。',
    parameters: {
      kind: { type: 'string', enum: ['profile', 'event'], required: true, description: 'profile 画像条目；event 事件记忆。' },
      key: { type: 'string', description: 'profile 必填：条目名，如"称呼"、"饮食偏好"、"公司"。' },
      text: { type: 'string', required: true, description: '要记住的内容。profile 是该条目的值；event 是一句完整的话。' },
      tags: { type: 'array', items: { type: 'string' }, description: 'event 可选：便于以后检索的关键词，最多 6 个。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      return { text: await service.remember({ kind: args.kind as 'profile' | 'event', key: args.key, text: args.text, tags: args.tags as string[] | undefined, sessionId: exec.agent?.id }) };
    },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '按关键词检索跨会话记忆，返回用户画像和相关事件。用户问"上次…是什么时候"、"我之前说过…"，或你需要了解用户背景时调用。每轮开始时系统已自动注入最相关的记忆，只有需要更多或更具体的内容时才调用。',
    parameters: {
      query: { type: 'string', required: true, description: '要查找的关键词或一句话。' },
      limit: { type: 'number', description: '最多返回的事件数，默认 8，最多 20。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) { return { text: service.recall(args.query, args.limit ?? 8) }; },
  })));
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: '删除一条记忆。用户说"别记那个了"、"那条不对"时调用：事件用 id（me-xxxx，来自记忆注入或 memory_recall），画像用 key。',
    parameters: {
      id: { type: 'string', description: '要删除的事件记忆 id。' },
      key: { type: 'string', description: '要删除的画像条目 key。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args) { return { text: await service.forget({ id: args.id, key: args.key }) }; },
  })));
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'nexus:memory',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS') + 3,
    text: '记忆：你有跨会话的长期记忆。每轮用户发言前，系统会以"[记忆]"开头的消息注入用户画像和相关事件，直接据此行事，不必向用户复述或确认"我记得"。用户说出稳定的偏好、称呼、家人、工作等事实，或明确说"记住"时，用 memory_remember 记下（画像用 profile，经历和决定用 event）；用户问起过去的事而注入里没有时用 memory_recall；用户要求忘记或纠正时用 memory_forget。不要记录工具用法、临时状态或你的推测；代码项目的结构和约定写进项目目录的 AGENTS.md 之类的文件，不进记忆；记忆写满时按工具返回的提示整理，不要硬塞。',
  }));
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    try {
      const recall = await service.inject(payload.agent.id, decision.messages);
      return recall ? { ...decision, messages: [recall, ...decision.messages] } : decision;
    } catch (error) {
      console.error(`[nexus-memory] inject failed: ${(error as Error)?.message ?? error}`);
      return decision;
    }
  });
  ctx.on('session/event', (session, event) => service.onSessionEvent(session, event));
  ctx.on('session/disposed', session => service.forgetSession(session.id));
  ctx.effect(() => () => service.close());
}
