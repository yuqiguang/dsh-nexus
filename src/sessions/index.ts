import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { z } from 'zod';
import { formatLocal, localDate } from '../assistant/clock.js';
import { sessionIdAt } from '../channels/protocol.js';
import { pluginInitiated } from '../dsh/schedule.js';

/**
 * Which generation of a chat's session is the active one. A chat keeps one
 * active session; a new day, a context that grew past the limit, the user's
 * `/new`, or the session having been archived starts the next generation, so
 * the model stops replaying weeks of history (and its own earlier reasoning)
 * on every turn.
 */
export interface ChatSessionRecord {
  /** The chat's base session id (generation 0). */
  base: string;
  generation: number;
  /** The active session id, `sessionIdAt(base, generation)`. */
  sessionId: string;
  /** The generation before this one, still routed after a restart so its late turns are delivered. */
  previous?: string;
  rotatedAt: number;
  reason?: RotationReason;
  /** The base of the chat this line of sessions was merged into after the channel was bound again; it is looked at once. */
  supersededBy?: string;
}

const recordSchema = z.object({ base: z.string(), generation: z.number(), sessionId: z.string(), previous: z.string().optional(), rotatedAt: z.number(),
  reason: z.enum(['day', 'context', 'user', 'archived', 'moved']).optional(), supersededBy: z.string().optional() });

export const sessionsDomain = defineDomain({
  name: 'nexus_sessions',
  version: 1,
  layout: 'per-record',
  tables: { chats: domainTable<string, ChatSessionRecord>(recordSchema) },
});

export type SessionsDomain = Domain<typeof sessionsDomain>;
export interface SessionsDomainOpener { open(spec: typeof sessionsDomain): Promise<SessionsDomain> }

export type RotationReason = 'day' | 'context' | 'user' | 'archived' | 'moved';

/** When a chat's session is replaced: at the first message of a new day (days turn over at 04:00 local), and once the conversation grew past `contextTokens` since the session's opening turn (0 disables). */
export interface RotationSettings { daily: boolean; contextTokens: number }
export const DEFAULT_ROTATION: RotationSettings = { daily: true, contextTokens: 60_000 };
export const ROTATION_LIMITS = { maxContextTokens: 1_000_000 };
/** Local hour at which one "day" of conversation ends and the next begins; a chat that runs past midnight is not cut. */
export const DAY_BOUNDARY_HOUR = 4;

export class SessionRoster {
  private constructor(private readonly domain: SessionsDomain) {}

  static async open(opener: SessionsDomainOpener): Promise<SessionRoster> {
    return new SessionRoster(await opener.open(sessionsDomain));
  }

  get(base: string): ChatSessionRecord | undefined { return this.domain.table('chats').get(base); }

  /** The active session id of a chat; the base itself until the first rotation. */
  activeFor(base: string): string { return this.get(base)?.sessionId ?? base; }

  /** Start the next generation and return it. */
  async rotate(base: string, reason: RotationReason, now: number): Promise<ChatSessionRecord> {
    const current = this.get(base);
    const generation = (current?.generation ?? 0) + 1;
    const record: ChatSessionRecord = { base, generation, sessionId: sessionIdAt(base, generation), previous: current?.sessionId ?? base, rotatedAt: now, reason };
    await this.domain.table('chats').put(base, record);
    return record;
  }

  /** Mark a chat's line of sessions as merged into `by`, keeping its generation; a line that never rotated gets its record here. */
  async supersede(base: string, by: string, now: number): Promise<void> {
    const current = this.get(base) ?? { base, generation: 0, sessionId: base, rotatedAt: now };
    await this.domain.table('chats').put(base, { ...current, supersededBy: by });
  }

  close(): Promise<void> { return this.domain.close(); }
}

/** What the bridge needs; tests fake it in memory. */
export type SessionRosterView = Pick<SessionRoster, 'get' | 'activeFor' | 'rotate' | 'supersede'>;

/** The calendar day a moment belongs to for rotation, with the boundary at `DAY_BOUNDARY_HOUR` instead of midnight. */
export function conversationDay(now: number, timeZone: string): string {
  return localDate(now - DAY_BOUNDARY_HOUR * 3_600_000, timeZone);
}

/** Prompt size of one model call as the adapter reported it: uncached input plus cache reads and writes. */
function promptTokens(event: Extract<SessionEvent, { type: 'assistant/message' }>): number | undefined {
  const usage = event.data.usage;
  if (!usage) return undefined;
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/** Prompt size of the last model call in the log. */
function lastPromptTokens(events: readonly SessionEvent[]): number | undefined {
  const last = events.findLast(event => event.type === 'assistant/message');
  return last?.type === 'assistant/message' ? promptTokens(last) : undefined;
}

/** Prompt size of the first model call in the log: what this session's fixed overhead cost on its opening turn. */
function firstPromptTokens(events: readonly SessionEvent[]): number | undefined {
  const first = events.find(event => event.type === 'assistant/message');
  return first?.type === 'assistant/message' ? promptTokens(first) : undefined;
}

/**
 * How much the prompt grew since this session's opening turn: the last prompt minus the first.
 *
 * The opening turn is what the fixed overhead costs — the system prompt plus every tool schema,
 * re-sent whole on each turn and never smaller — so subtracting it leaves what the conversation
 * itself added. Measured 2026-09-22: a fresh session's first turn already reports ~16k, so 27% of a
 * 60k budget is spent before anyone types, and six short turns reached 64k of which 80% was
 * cache-replayed prefix and replayed reasoning rather than the user's words. Measured against the
 * total those six turns look like a long conversation; against growth they read ~48k, and a day of
 * one-line chat no longer rotates after a handful of turns.
 */
export function contextGrowthTokens(events: readonly SessionEvent[]): number | undefined {
  const first = firstPromptTokens(events);
  const last = lastPromptTokens(events);
  if (first === undefined || last === undefined) return undefined;
  // Native compaction can bring the prompt back under the opening turn's size; that is not growth.
  return Math.max(0, last - first);
}

/** A message the user typed: not a reminder or job notice (plugin-sourced) and not an external event the hook injected under the user role. */
export function userAuthored(event: SessionEvent): event is Extract<SessionEvent, { type: 'user/message' }> {
  return event.type === 'user/message' && !pluginInitiated(event.data) && !String((event.data.source as { rpcId?: unknown }).rpcId ?? '').includes('-hook-');
}

/** When the user last wrote in this session, from the log. */
export function lastUserMessageAt(events: readonly SessionEvent[]): number | undefined {
  return events.findLast(userAuthored)?.time;
}

/**
 * Whether the next user message should open a new generation instead of
 * joining this one: the session is from an earlier conversation day, or its
 * conversation grew past the limit. A session with no user turn yet is kept.
 */
export function rotationDue(events: readonly SessionEvent[], now: number, timeZone: string, settings: RotationSettings): RotationReason | undefined {
  const lastAt = lastUserMessageAt(events);
  if (lastAt === undefined) return undefined;
  if (settings.daily && conversationDay(lastAt, timeZone) !== conversationDay(now, timeZone)) return 'day';
  const tokens = contextGrowthTokens(events);
  if (settings.contextTokens > 0 && tokens !== undefined && tokens >= settings.contextTokens) return 'context';
  return undefined;
}

/** How many turns the user started in the log. */
export function userTurns(events: readonly SessionEvent[]): number {
  return events.filter(userAuthored).length;
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** Text blocks of a message, without the attachment lines the bridge appends. */
function requestText(event: Extract<SessionEvent, { type: 'user/message' }>): string {
  return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    .split('\n').filter(line => !line.startsWith('[附件]')).join(' ');
}

export const DIGEST_LIMITS = { chars: 480, requestChars: 40, replyChars: 30 };

/**
 * A mechanical digest of a session for long-term memory: the day, how many
 * things the user asked, and each request with the start of the reply, newest
 * kept when the budget runs out. No model call, so it never invents anything;
 * recall finds it by the words the user actually used.
 */
export function sessionDigest(events: readonly SessionEvent[], timeZone: string, channel = '微信'): string | undefined {
  const lines: string[] = [];
  let firstAt: number | undefined;
  for (const [index, event] of events.entries()) {
    if (!userAuthored(event)) continue;
    firstAt ??= event.time;
    const request = clip(requestText(event), DIGEST_LIMITS.requestChars);
    if (!request) continue;
    // The reply is the last text the model produced in the turn this message opened; plugin context (time, memory) sits between them in the log.
    const opened = events.slice(0, index + 1).findLast(item => item.type === 'turn/start');
    const turn = opened?.type === 'turn/start' ? opened.data.turn : undefined;
    const replyText = turn === undefined ? '' : events.slice(index + 1)
      .flatMap(item => item.type === 'assistant/message' && item.data.turn === turn ? [item.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim()] : [])
      .filter(Boolean).at(-1) ?? '';
    lines.push(replyText ? `${request}→${clip(replyText, DIGEST_LIMITS.replyChars)}` : request);
  }
  if (!lines.length || firstAt === undefined) return undefined;
  const head = `${formatLocal(firstAt, timeZone).split(' ')[0]} ${channel}对话（${lines.length} 件事）：`;
  const kept = [...lines];
  while (kept.length > 1 && head.length + kept.join('；').length > DIGEST_LIMITS.chars) kept.shift();
  const body = kept.join('；');
  const dropped = lines.length - kept.length;
  return `${head}${dropped ? `（更早的 ${dropped} 件略）` : ''}${body}`.slice(0, DIGEST_LIMITS.chars + 40);
}

export const ROTATION_NOTICES: Record<RotationReason, string> = {
  day: '新的一天，开了新会话。之前聊的事记了摘要，需要时能想起来；原会话的提醒和监控仍会送到这里。',
  context: '前面聊得太长了，开了新会话继续。之前的事记了摘要，需要时能想起来；原会话的提醒和监控仍会送到这里。',
  user: '已开新会话。之前的事记了摘要，需要时能想起来；原会话的提醒和监控仍会送到这里。',
  archived: '上一段对话已归档，开了新会话继续。之前的事记了摘要，需要时能想起来；归档时停止的提醒不会再触发。',
  moved: '工作目录换了，在新目录里开了新会话。之前的事记了摘要，需要时能想起来；原会话的提醒和监控仍会送到这里。',
};

/** Sent once after native reminders under an earlier binding become deliverable; `lines` come from `describeReminders`. */
export function adoptionNotice(lines: readonly string[]): string {
  return `重新扫码连接后换了一个会话，旧会话的 ${lines.length} 条提醒仍在原会话执行，结果会发送到这里；可在 DSH 任务页管理：\n${lines.join('\n')}`;
}
