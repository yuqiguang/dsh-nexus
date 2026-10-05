import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { JobEvent } from '@deepseek-ai/dsh-jobs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { baseSessionOf, sameChat } from './protocol.js';
import type { SessionRosterView } from '../sessions/index.js';

/** Delivery provenance only. DSH and the coder store retain all execution/approval state. */
export interface ChannelWorkOrigin {
  taskId: string; ownerSession: string; workspace: string; rootCallId: string;
  remote: boolean; jobId?: string;
}
export interface ChannelJobOrigin { jobId: string; ownerSession: string; rootCallId: string; remote: boolean }
export interface ChannelJobNotice extends ChannelJobOrigin { messageId: string }
export const channelWorkDomain = defineDomain({ name: 'nexus_channel_work', version: 1, layout: 'per-record', tables: {
  tasks: domainTable<string, ChannelWorkOrigin>(z.object({ taskId: z.string(), ownerSession: z.string(), workspace: z.string(), rootCallId: z.string(), remote: z.boolean(), jobId: z.string().optional() })),
  notices: domainTable<string, ChannelJobNotice>(z.object({ messageId: z.string(), jobId: z.string(), ownerSession: z.string(), rootCallId: z.string(), remote: z.boolean() })),
} });
export type ChannelWorkDomain = Domain<typeof channelWorkDomain>;

/** Unknown old dispatches stay local; session names or task prose cannot establish provenance. */
export class ChannelWork {
  private readonly calls = new Map<string, boolean>();
  private readonly questions = new WeakMap<object, string>();
  private readonly execution = new AsyncLocalStorage<{ owner: string; rootCallId: string; remote: boolean; open: boolean }>();
  private readonly jobs = new Map<string, ChannelJobOrigin>();
  private readonly notices = new Map<string, ChannelJobNotice>();
  private readonly saves = new Set<Promise<void>>();
  constructor(private readonly domain: ChannelWorkDomain, private readonly sessions?: Pick<SessionRosterView, 'activeFor'>) {}
  static async open(opener: { open(spec: typeof channelWorkDomain): Promise<ChannelWorkDomain> }, sessions?: Pick<SessionRosterView, 'activeFor'>) {
    return new ChannelWork(await opener.open(channelWorkDomain), sessions);
  }
  get(taskId: string) { return this.domain.table('tasks').get(taskId); }
  isRemote(taskId: string, owner: string) { const row = this.get(taskId); return row?.ownerSession === owner && row.remote; }
  async record(taskId: string, session: Session, rootCallId: string, workspace: string) {
    await this.domain.table('tasks').put(taskId, { taskId, ownerSession: session.id, workspace, rootCallId,
      remote: this.remoteCall(session.id, session.snapshotEvents(), rootCallId) });
  }
  async bindJob(taskId: string, jobId: string) {
    const row = this.get(taskId); if (row) await this.domain.table('tasks').put(taskId, { ...row, jobId });
  }
  visibleHistory(taskId: string, viewer: string, workspace: string) {
    const row = this.get(taskId);
    return !!row?.remote && row.ownerSession !== viewer && sameChat(row.ownerSession, viewer) && row.workspace === workspace
      && (!this.sessions || this.sessions.activeFor(baseSessionOf(viewer)) === viewer);
  }
  async withQuestions<T>(taskId: string, questions: object, run: () => Promise<T>): Promise<T> {
    this.questions.set(questions, taskId);
    try { return await run(); } finally { this.questions.delete(questions); }
  }
  questionOrigin(questions: object, owner: string): boolean | undefined {
    const id = this.questions.get(questions);
    return id === undefined ? undefined : this.isRemote(id, owner);
  }
  /** Native registration is synchronous in the exact tool's async context; never infer origin from the latest turn. */
  jobEvent(event: JobEvent) {
    if (event.type === 'removed') { this.jobs.delete(event.job.id); return; }
    if (event.type !== 'registered') return;
    const call = this.execution.getStore();
    if (!call?.open || event.job.owner !== call.owner) { this.jobs.delete(event.job.id); return; }
    this.jobs.set(event.job.id, { jobId: event.job.id, ownerSession: call.owner, rootCallId: call.rootCallId, remote: call.remote });
  }
  /** Bind at native inbox admission: job counters restart, but message IDs survive reloads and queued delivery. */
  noticeMessage(owner: string, message: UserMessage, report: (code: string) => void = () => {}) {
    const id = this.noticeJobId(message);
    const origin = id && this.jobs.get(id);
    if (!message.id || !origin || origin.ownerSession !== owner || this.notices.has(message.id) || this.domain.table('notices').get(message.id)) return;
    const row = { ...origin, messageId: message.id };
    this.notices.set(message.id, row);
    const save = this.domain.table('notices').put(message.id, row).then(() => { this.notices.delete(message.id); }, () => {
      // Execution already happened: never surface a retryable tool failure for delivery bookkeeping.
      report('channel_job_origin_save_failed');
    }).finally(() => this.saves.delete(save));
    this.saves.add(save);
  }
  private noticeJobId(message: UserMessage) {
    const source = message.source as { kind: string; form?: string };
    if (source.kind !== 'tool-jobs' || source.form !== 'notice') return;
    return /^background job (\S+)(?: \(|\n)/.exec(message.content.map(part => part.type === 'text' ? part.text : '').join('\n'))?.[1];
  }
  async withCall<T>(exec: Pick<ToolExecution, 'agent' | 'rootCallId' | 'callId'>, run: () => Promise<T>): Promise<T> {
    if (!exec.agent) return run();
    const key = `${exec.agent.id}:${exec.callId}`, previous = this.calls.get(key);
    const remote = this.remoteCall(exec.agent.id, exec.agent.session.snapshotEvents(), exec.rootCallId);
    this.calls.set(key, remote);
    const call = { owner: exec.agent.id, rootCallId: exec.rootCallId, remote, open: true };
    try { return await this.execution.run(call, run); } finally {
      call.open = false;
      if (previous === undefined) this.calls.delete(key); else this.calls.set(key, previous);
    }
  }
  remoteMessage(owner: string, message: UserMessage, priorEvents: readonly SessionEvent[] = []): boolean {
    const channel = /^nexus-(wechat|feishu|wecom)-[a-f0-9]{32}(?:-\d+)?$/.exec(owner)?.[1];
    if (!channel) return false;
    const source = message.source as { kind: string; form?: string; rpcId?: unknown; callId?: string };
    // A late answer is a native message, but inherits its original question's scope.
    if (source.kind === 'user-question-reply') return this.remoteCall(owner, priorEvents, source.callId);
    if (source.kind === 'tool-jobs') {
      if ((message.source as { form?: string }).form !== 'notice') return false;
      const body = message.content.map(part => part.type === 'text' ? part.text : '').join('\n');
      const job = message.id && (this.notices.get(message.id) ?? this.domain.table('notices').get(message.id));
      if (job) return job.ownerSession === owner && job.jobId === this.noticeJobId(message) && job.remote;
      // Compatibility with coder origins saved before generic native jobs were tracked.
      const match = /^background job (\S+) \(coder: (?:Codex|Claude Code) \[(ct-[0-9a-f]{8})\]: /.exec(body);
      const row = match && this.get(match[2]!);
      return !!row?.remote && row.ownerSession === owner && row.jobId === match![1];
    }
    // Other native plugin notifications (including schedule) retain their explicit delivery semantics.
    if (message.source.kind !== 'user') return true;
    const rpcId = String((message.source as { rpcId?: unknown }).rpcId ?? '');
    return rpcId.startsWith(`${channel}-`);
  }
  remoteTurn(owner: string, events: readonly SessionEvent[], turn: number, before = events.length): boolean {
    const start = events.findLastIndex((event, index) => index < before && event.type === 'turn/start' && event.data.turn === turn);
    if (start < 0) return false;
    const next = events.findIndex((event, index) => index > start && event.type === 'turn/start');
    const messages = events.slice(start, Math.min(before, next < 0 ? events.length : next));
    let found = false;
    for (const [offset, event] of messages.entries()) {
      if (event.type !== 'user/message') continue;
      found = true;
      if (!this.remoteMessage(owner, event.data, event.data.source.kind === 'user-question-reply' ? events.slice(0, start + offset) : [])) return false;
    }
    return found;
  }
  remoteCall(owner: string, events: readonly SessionEvent[], callId?: string): boolean {
    if (!callId) return false;
    const captured = this.calls.get(`${owner}:${callId}`);
    if (captured !== undefined) return captured;
    const index = events.findLastIndex(event => event.type === 'tool/call' && event.data.callId === callId);
    const call = events[index];
    return call?.type === 'tool/call' && this.remoteTurn(owner, events, call.data.turn, index + 1);
  }
  async close() { await Promise.all(this.saves); return this.domain.close(); }
}
