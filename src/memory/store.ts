import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { rank, type Ranked } from './search.js';

/** One fact about the user that stays true: a preference, a name, a habit. Keyed so a later statement replaces the earlier one. */
export interface ProfileEntry { key: string; value: string; updatedAt: number; source: 'model' | 'user' }

/** One thing that happened or was said, worth finding again later. */
export interface MemoryEvent { id: string; text: string; tags?: string[]; at: number; source: 'model' | 'user' | 'summary'; sessionId?: string }

/** A write the model asked for while the policy is `ask`; nothing is injected until the user accepts it. */
export interface MemoryProposal { id: string; kind: 'profile' | 'event'; key?: string; text: string; tags?: string[]; at: number; sessionId?: string }

/** One injection, so the user can see what the model was shown and why. */
export interface InjectionRecord { id: string; at: number; sessionId: string; query: string; eventIds: string[]; profile: boolean }

export interface MemoryPolicy {
  /** `auto`: the model's remember calls are stored at once. `ask`: they become proposals. `off`: they are refused. */
  remember: 'auto' | 'ask' | 'off';
  /** Whether profile and relevant events are injected into model turns. */
  inject: boolean;
}

const profileSchema = z.object({ key: z.string(), value: z.string(), updatedAt: z.number(), source: z.enum(['model', 'user']) });
const eventSchema = z.object({ id: z.string(), text: z.string(), tags: z.array(z.string()).optional(), at: z.number(),
  source: z.enum(['model', 'user', 'summary']), sessionId: z.string().optional() });
const proposalSchema = z.object({ id: z.string(), kind: z.enum(['profile', 'event']), key: z.string().optional(), text: z.string(),
  tags: z.array(z.string()).optional(), at: z.number(), sessionId: z.string().optional() });
const injectionSchema = z.object({ id: z.string(), at: z.number(), sessionId: z.string(), query: z.string(), eventIds: z.array(z.string()), profile: z.boolean() });
const policySchema = z.object({ remember: z.enum(['auto', 'ask', 'off']), inject: z.boolean() });

export const memoryDomain = defineDomain({
  name: 'nexus_memory',
  version: 1,
  layout: 'per-record',
  global: { schema: policySchema, initial: { remember: 'auto', inject: true } satisfies MemoryPolicy },
  tables: {
    profile: domainTable<string, ProfileEntry>(profileSchema),
    events: domainTable<string, MemoryEvent>(eventSchema),
    proposals: domainTable<string, MemoryProposal>(proposalSchema),
    injections: domainTable<string, InjectionRecord>(injectionSchema),
  },
});

export type MemoryDomain = Domain<typeof memoryDomain>;
export interface MemoryDomainOpener { open(spec: typeof memoryDomain): Promise<MemoryDomain> }

/** Hard budgets. Exceeding one is an error the model must resolve by consolidating, never a silent truncation. */
export const LIMITS = {
  profileKeyChars: 40,
  profileValueChars: 300,
  profileEntries: 60,
  eventChars: 500,
  events: 1000,
  tagsPerEvent: 6,
  proposals: 100,
  injections: 200,
} as const;

/** Thrown for input the model can fix; the message tells it how. */
export class MemoryLimitError extends Error {
  constructor(message: string) { super(message); this.name = 'MemoryLimitError'; }
}

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`;
/** Record keys become file names in the per-record layout, so a Chinese profile key is stored under its hash. */
const profileId = (key: string) => `pf-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`;

/** Profile, events, proposals, and the injection audit in native storage. Validation lives here so every writer, tool or page, meets the same limits. */
export class MemoryStore {
  private constructor(private readonly domain: MemoryDomain) {}

  static async open(opener: MemoryDomainOpener): Promise<MemoryStore> {
    return new MemoryStore(await opener.open(memoryDomain));
  }

  private get profileTable() { return this.domain.table('profile'); }
  private get eventTable() { return this.domain.table('events'); }
  private get proposalTable() { return this.domain.table('proposals'); }
  private get injectionTable() { return this.domain.table('injections'); }

  policy(): MemoryPolicy { return this.domain.global.get(); }

  setPolicy(policy: MemoryPolicy): Promise<void> { return this.domain.global.set(policySchema.parse(policy)); }

  profile(): ProfileEntry[] {
    return [...this.profileTable.entries()].map(([, entry]) => entry).sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'));
  }

  events(): MemoryEvent[] {
    return [...this.eventTable.entries()].map(([, event]) => event).sort((a, b) => b.at - a.at);
  }

  proposals(): MemoryProposal[] {
    return [...this.proposalTable.entries()].map(([, proposal]) => proposal).sort((a, b) => a.at - b.at);
  }

  injections(): InjectionRecord[] {
    return [...this.injectionTable.entries()].map(([, record]) => record).sort((a, b) => b.at - a.at);
  }

  event(id: string): MemoryEvent | undefined { return this.eventTable.get(id); }

  /** Sets one profile fact; an existing key is replaced. */
  async setProfile(key: string, value: string, source: ProfileEntry['source'], now = Date.now()): Promise<ProfileEntry> {
    const cleanKey = clean(key);
    const cleanValue = clean(value);
    if (!cleanKey || !cleanValue) throw new MemoryLimitError('画像条目需要 key 和 value。');
    if (cleanKey.length > LIMITS.profileKeyChars) throw new MemoryLimitError(`画像的 key 不能超过 ${LIMITS.profileKeyChars} 个字符。`);
    if (cleanValue.length > LIMITS.profileValueChars) throw new MemoryLimitError(`画像的 value 不能超过 ${LIMITS.profileValueChars} 个字符，请精简后再记。`);
    if (!this.profileTable.get(profileId(cleanKey)) && this.profileTable.size >= LIMITS.profileEntries) {
      throw new MemoryLimitError(`画像已有 ${LIMITS.profileEntries} 条，先用 memory_forget 删除过时的条目，或把相近的条目合并到一个 key 里。`);
    }
    const entry: ProfileEntry = { key: cleanKey, value: cleanValue, updatedAt: now, source };
    await this.profileTable.put(profileId(cleanKey), entry);
    return entry;
  }

  deleteProfile(key: string): Promise<boolean> { return this.profileTable.delete(profileId(clean(key))); }

  async addEvent(input: { text: string; tags?: string[]; source: MemoryEvent['source']; sessionId?: string }, now = Date.now()): Promise<MemoryEvent> {
    const text = clean(input.text);
    if (!text) throw new MemoryLimitError('事件记忆不能为空。');
    if (text.length > LIMITS.eventChars) throw new MemoryLimitError(`一条事件记忆不能超过 ${LIMITS.eventChars} 个字符，请只记结论，细节留在会话里。`);
    const tags = [...new Set((input.tags ?? []).map(clean).filter(Boolean))].slice(0, LIMITS.tagsPerEvent);
    if (this.eventTable.size >= LIMITS.events) {
      throw new MemoryLimitError(`事件记忆已有 ${LIMITS.events} 条，先用 memory_recall 找出过时的条目并用 memory_forget 删除。`);
    }
    const duplicate = this.events().find(event => event.text === text);
    if (duplicate) return duplicate;
    const event: MemoryEvent = { id: newId('me'), text, ...(tags.length ? { tags } : {}), at: now, source: input.source,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    await this.eventTable.put(event.id, event);
    return event;
  }

  deleteEvent(id: string): Promise<boolean> { return this.eventTable.delete(id); }

  /** Events that share terms with the query, best first. */
  recall(query: string, limit: number, now = Date.now()): Ranked<MemoryEvent>[] {
    return rank(query, this.events(), now).slice(0, limit);
  }

  async propose(input: Omit<MemoryProposal, 'id' | 'at'>, now = Date.now()): Promise<MemoryProposal> {
    const text = clean(input.text);
    if (!text) throw new MemoryLimitError('记忆内容不能为空。');
    if (input.kind === 'profile' && !clean(input.key ?? '')) throw new MemoryLimitError('画像条目需要 key。');
    if (this.proposalTable.size >= LIMITS.proposals) throw new MemoryLimitError(`待确认的记忆已有 ${LIMITS.proposals} 条，请用户先在设置页处理。`);
    const proposal: MemoryProposal = { id: newId('mp'), kind: input.kind, ...(input.key ? { key: clean(input.key) } : {}), text,
      ...(input.tags?.length ? { tags: input.tags } : {}), at: now, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    await this.proposalTable.put(proposal.id, proposal);
    return proposal;
  }

  /** Accepting a proposal writes it as if the user had said it; the proposal itself is removed either way. */
  async settleProposal(id: string, accept: boolean, now = Date.now()): Promise<MemoryProposal | undefined> {
    const proposal = this.proposalTable.get(id);
    if (!proposal) return undefined;
    if (accept) {
      if (proposal.kind === 'profile') await this.setProfile(proposal.key!, proposal.text, 'user', now);
      else await this.addEvent({ text: proposal.text, tags: proposal.tags, source: 'user', sessionId: proposal.sessionId }, now);
    }
    await this.proposalTable.delete(id);
    return proposal;
  }

  async recordInjection(record: Omit<InjectionRecord, 'id'>): Promise<void> {
    const id = newId('mi');
    await this.injectionTable.put(id, { id, ...record });
    const excess = this.injections().slice(LIMITS.injections);
    for (const old of excess) await this.injectionTable.delete(old.id);
  }

  export(): { exportedAt: number; policy: MemoryPolicy; profile: ProfileEntry[]; events: MemoryEvent[]; proposals: MemoryProposal[] } {
    return { exportedAt: Date.now(), policy: this.policy(), profile: this.profile(), events: this.events(), proposals: this.proposals() };
  }

  close(): Promise<void> { return this.domain.close(); }
}
