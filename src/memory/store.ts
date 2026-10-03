import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { rank, type Ranked } from './search.js';
import { sameScope, scopeId, type MemoryScope } from './scope.js';

/** One fact about the user that stays true: a preference, a name, a habit. Keyed so a later statement replaces the earlier one. */
export interface ProfileEntry { scope?: MemoryScope; key: string; value: string; updatedAt: number; source: 'model' | 'user' }

/** One thing that happened or was said, worth finding again later. */
export interface MemoryEvent { scope?: MemoryScope; id: string; text: string; tags?: string[]; at: number; source: 'model' | 'user' | 'summary'; sessionId?: string }

/** A write the model asked for while the policy is `ask`; nothing is injected until the user accepts it. */
export interface MemoryProposal { scope?: MemoryScope; id: string; kind: 'profile' | 'event'; key?: string; text: string; tags?: string[]; at: number; sessionId?: string }

/** One injection, so the user can see what the model was shown and why. */
export interface InjectionRecord { scope?: MemoryScope; id: string; at: number; sessionId: string; query: string; eventIds: string[]; profile: boolean; content?: string }

export interface MemoryPolicy {
  /** Scoped-domain initialization marker; never changes the legacy policy. */
  scopeVersion?: 1;
  /** `auto`: the model's remember calls are stored at once. `ask`: they become proposals. `off`: they are refused. */
  remember: 'auto' | 'ask' | 'off';
  /** Whether profile and relevant events are injected into model turns. */
  inject: boolean;
  /** Absent in older settings: follow remember. */
  summary?: 'auto' | 'ask' | 'off';
  overrides?: { scope: MemoryScope; remember: MemoryPolicy['remember']; inject: boolean; summary?: MemoryPolicy['remember'] }[];
}

const scopeSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('global'), owner: z.string() }),
  z.object({ kind: z.literal('project'), owner: z.string(), project: z.string() })]);
const profileSchema = z.object({ scope: scopeSchema.optional(), key: z.string(), value: z.string(), updatedAt: z.number(), source: z.enum(['model', 'user']) });
const eventSchema = z.object({ scope: scopeSchema.optional(), id: z.string(), text: z.string(), tags: z.array(z.string()).optional(), at: z.number(),
  source: z.enum(['model', 'user', 'summary']), sessionId: z.string().optional() });
const proposalSchema = z.object({ scope: scopeSchema.optional(), id: z.string(), kind: z.enum(['profile', 'event']), key: z.string().optional(), text: z.string(),
  tags: z.array(z.string()).optional(), at: z.number(), sessionId: z.string().optional() });
const injectionSchema = z.object({ scope: scopeSchema.optional(), id: z.string(), at: z.number(), sessionId: z.string(), query: z.string(), eventIds: z.array(z.string()), profile: z.boolean(), content: z.string().optional() });
const writePolicy = z.enum(['auto', 'ask', 'off']);
const policySchema = z.object({ remember: writePolicy, inject: z.boolean(), summary: writePolicy.optional(), scopeVersion: z.literal(1).optional(),
  overrides: z.array(z.object({ scope: scopeSchema, remember: writePolicy, inject: z.boolean(), summary: writePolicy.optional() })).optional() });

export const memoryDomain = defineDomain({
  name: 'nexus_memory',
  version: 1,
  layout: 'per-record',
  global: { schema: policySchema, initial: { remember: 'auto', inject: true } as MemoryPolicy },
  tables: {
    profile: domainTable<string, ProfileEntry>(profileSchema),
    events: domainTable<string, MemoryEvent>(eventSchema),
    proposals: domainTable<string, MemoryProposal>(proposalSchema),
    injections: domainTable<string, InjectionRecord>(injectionSchema),
  },
});

// New scoped records live separately: an older plugin cannot accidentally read them as global memory.
export const scopedMemoryDomain = defineDomain({ ...memoryDomain, name: 'nexus_memory_scoped',
  global: { schema: policySchema, initial: { remember: 'ask', inject: true } as MemoryPolicy } });

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

export function validateMemory(kind: 'profile' | 'event', text: string, key?: string): { text: string; key?: string } {
  const value = clean(text), name = clean(key ?? '');
  if (!value) throw new MemoryLimitError('记忆内容不能为空。');
  if (kind === 'profile') {
    if (!name || name.length > LIMITS.profileKeyChars) throw new MemoryLimitError(`画像的 key 需要 1–${LIMITS.profileKeyChars} 个字符。`);
    if (value.length > LIMITS.profileValueChars) throw new MemoryLimitError(`画像的 value 不能超过 ${LIMITS.profileValueChars} 个字符，请精简后再记。`);
  } else if (value.length > LIMITS.eventChars) throw new MemoryLimitError(`一条事件记忆不能超过 ${LIMITS.eventChars} 个字符，请只记结论，细节留在会话里。`);
  return { text: value, ...(kind === 'profile' ? { key: name } : {}) };
}

export const memoryTags = (tags: string[] = []) => [...new Set(tags.map(clean).filter(Boolean))].slice(0, LIMITS.tagsPerEvent);

/** Profile, events, proposals, and the injection audit in native storage. Validation lives here so every writer, tool or page, meets the same limits. */
export class MemoryStore {
  private constructor(private readonly domain: MemoryDomain, private readonly scope?: MemoryScope) {}

  static async open(opener: MemoryDomainOpener): Promise<MemoryStore> {
    return new MemoryStore(await opener.open(memoryDomain));
  }

  static async openScoped(opener: MemoryDomainOpener): Promise<MemoryStore> {
    return new MemoryStore(await opener.open(scopedMemoryDomain));
  }

  forScope(scope: MemoryScope): MemoryStore { return new MemoryStore(this.domain, structuredClone(scope)); }
  private get metadata() { return this.scope ? { scope: this.scope } : {}; }
  private profileKey(key: string) { return profileId(this.scope ? JSON.stringify([scopeId(this.scope), key]) : key); }
  scopes(): MemoryScope[] {
    const all = [...this.profileTable.entries(), ...this.eventTable.entries(), ...this.proposalTable.entries(), ...this.injectionTable.entries()];
    return [...new Map([...all.flatMap(([, record]) => record.scope ? [[scopeId(record.scope), record.scope] as const] : []),
      ...(this.domain.global.get().overrides ?? []).map(item => [scopeId(item.scope), item.scope] as const)]).values()];
  }

  private get profileTable() { return this.domain.table('profile'); }
  private get eventTable() { return this.domain.table('events'); }
  private get proposalTable() { return this.domain.table('proposals'); }
  private get injectionTable() { return this.domain.table('injections'); }

  policy(): MemoryPolicy {
    const global = this.domain.global.get();
    if (!this.scope) return global;
    const { overrides, ...defaults } = global;
    const override = overrides?.find(item => sameScope(item.scope, this.scope));
    return override ? { remember: override.remember, inject: override.inject, summary: override.summary ?? override.remember } : defaults;
  }

  hasPolicyOverride(): boolean { return !!this.domain.global.get().overrides?.some(item => sameScope(item.scope, this.scope)); }

  async setScopePolicy(policy?: MemoryPolicy): Promise<void> {
    if (!this.scope) throw new Error('memory_scope_unavailable');
    const global = this.domain.global.get();
    const overrides = (global.overrides ?? []).filter(item => !sameScope(item.scope, this.scope));
    if (policy) overrides.push({ scope: this.scope, remember: policy.remember, inject: policy.inject, summary: policy.summary ?? policy.remember });
    await this.setPolicy({ ...global, overrides });
  }

  setPolicy(policy: MemoryPolicy): Promise<void> {
    return this.domain.global.set(policySchema.parse({ ...policy, ...(this.domain.name === scopedMemoryDomain.name ? { scopeVersion: 1 } : {}) }));
  }

  profile(): ProfileEntry[] {
    return [...this.profileTable.entries()].map(([, entry]) => entry).filter(entry => sameScope(entry.scope, this.scope)).sort((a, b) => a.key.localeCompare(b.key, 'zh-Hans-CN'));
  }

  events(): MemoryEvent[] {
    return [...this.eventTable.entries()].map(([, event]) => event).filter(event => sameScope(event.scope, this.scope)).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }

  proposals(): MemoryProposal[] {
    return [...this.proposalTable.entries()].map(([, proposal]) => proposal).filter(proposal => sameScope(proposal.scope, this.scope)).sort((a, b) => a.at - b.at);
  }

  injections(): InjectionRecord[] {
    return [...this.injectionTable.entries()].map(([, record]) => record).filter(record => sameScope(record.scope, this.scope)).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
  }

  event(id: string): MemoryEvent | undefined { const event = this.eventTable.get(id); return event && sameScope(event.scope, this.scope) ? event : undefined; }

  /** Sets one profile fact; an existing key is replaced. */
  async setProfile(key: string, value: string, source: ProfileEntry['source'], now = Date.now()): Promise<ProfileEntry> {
    const validated = validateMemory('profile', value, key);
    const cleanKey = validated.key!, cleanValue = validated.text;
    if (!this.profileTable.get(this.profileKey(cleanKey)) && this.profile().length >= LIMITS.profileEntries) {
      throw new MemoryLimitError(`画像已有 ${LIMITS.profileEntries} 条，先用 memory_forget 删除过时的条目，或把相近的条目合并到一个 key 里。`);
    }
    const entry: ProfileEntry = { ...this.metadata, key: cleanKey, value: cleanValue, updatedAt: now, source };
    await this.profileTable.put(this.profileKey(cleanKey), entry);
    return entry;
  }

  deleteProfile(key: string): Promise<boolean> { return this.profileTable.delete(this.profileKey(clean(key))); }

  async addEvent(input: { text: string; tags?: string[]; source: MemoryEvent['source']; sessionId?: string }, now = Date.now()): Promise<MemoryEvent> {
    const { text } = validateMemory('event', input.text);
    const tags = memoryTags(input.tags);
    const duplicate = this.events().find(event => event.text === text);
    if (duplicate) return duplicate;
    if (this.events().length >= LIMITS.events) {
      throw new MemoryLimitError(`事件记忆已有 ${LIMITS.events} 条，先用 memory_recall 找出过时的条目并用 memory_forget 删除。`);
    }
    const event: MemoryEvent = { ...this.metadata, id: newId('me'), text, ...(tags.length ? { tags } : {}), at: now, source: input.source,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    await this.eventTable.put(event.id, event);
    return event;
  }

  async deleteEvent(id: string): Promise<boolean> { return this.event(id) ? this.eventTable.delete(id) : false; }

  async editEvent(id: string, text: string, tags?: string[]): Promise<MemoryEvent | undefined> {
    const previous = this.event(id);
    if (!previous) return undefined;
    const event = { ...previous, text: validateMemory('event', text).text, tags: memoryTags(tags ?? previous.tags), source: 'user' as const };
    await this.eventTable.put(id, event);
    return event;
  }

  /** Events that share terms with the query, best first. */
  recall(query: string, limit: number, now = Date.now()): Ranked<MemoryEvent>[] {
    return rank(query, this.events(), now).slice(0, limit);
  }

  async propose(input: Omit<MemoryProposal, 'id' | 'at'>, now = Date.now()): Promise<MemoryProposal> {
    const { text, key } = validateMemory(input.kind, input.text, input.key);
    if (this.proposals().length >= LIMITS.proposals) throw new MemoryLimitError(`待确认的记忆已有 ${LIMITS.proposals} 条，请用户先在设置页处理。`);
    const proposal: MemoryProposal = { ...this.metadata, id: newId('mp'), kind: input.kind, ...(key ? { key } : {}), text,
      ...(input.tags?.length ? { tags: memoryTags(input.tags) } : {}), at: now, ...(input.sessionId ? { sessionId: input.sessionId } : {}) };
    await this.proposalTable.put(proposal.id, proposal);
    return proposal;
  }

  /** Accepting a proposal writes it as if the user had said it; the proposal itself is removed either way. */
  async settleProposal(id: string, accept: boolean, now = Date.now(), edit?: { text: string; key?: string }): Promise<MemoryProposal | undefined> {
    const previous = this.proposalTable.get(id);
    if (!previous || !sameScope(previous.scope, this.scope)) return undefined;
    const proposal = edit ? { ...previous, ...validateMemory(previous.kind, edit.text, edit.key ?? previous.key) } : previous;
    if (accept) {
      if (proposal.kind === 'profile') await this.setProfile(proposal.key!, proposal.text, 'user', now);
      else await this.addEvent({ text: proposal.text, tags: proposal.tags, source: 'user', sessionId: proposal.sessionId }, now);
    }
    await this.proposalTable.delete(id);
    return proposal;
  }

  async recordInjection(record: Omit<InjectionRecord, 'id'>): Promise<void> {
    const id = newId('mi');
    await this.injectionTable.put(id, { ...record, ...this.metadata, id });
    const excess = this.injections().slice(LIMITS.injections);
    for (const old of excess) await this.injectionTable.delete(old.id);
  }

  export(): { exportedAt: number; policy: MemoryPolicy; profile: ProfileEntry[]; events: MemoryEvent[]; proposals: MemoryProposal[] } {
    return { exportedAt: Date.now(), policy: this.policy(), profile: this.profile(), events: this.events(), proposals: this.proposals() };
  }

  close(): Promise<void> { return this.domain.close(); }
}
