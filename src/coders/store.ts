import { REVIEW_FAILURES } from './review.js';
import { briefSnapshotSchema } from './brief.js';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { randomBytes } from 'node:crypto';
import { z, type ZodType } from 'zod';
import { isActive, type HabitRule, type TaskRecord } from './types.js';

const decisionSchema = z.object({
  at: z.number(),
  kind: z.enum(['command', 'file-write', 'file-read', 'network', 'question', 'other']),
  summary: z.string(),
  layer: z.enum(['hard', 'habit', 'user', 'supervisor']),
  outcome: z.enum(['allow', 'deny', 'answer', 'ask']),
  reason: z.string().optional(),
  blockKey: z.string().optional(),
  remembered: z.array(z.string()).optional(),
});

const resultSchema = z.object({
  execution: z.enum(['completed', 'failed', 'stopped']).optional(),
  verification: z.enum(['passed', 'failed', 'not-run']).optional(),
  summary: z.string(),
  changedFiles: z.array(z.string()),
  commits: z.array(z.string()).optional(),
  outsideRoots: z.array(z.string()),
  verifyOk: z.boolean().optional(),
  verifyOutput: z.string().optional(),
  verifyChecks: z.array(z.object({ command: z.string(), ok: z.boolean(), executed: z.boolean(), output: z.string() })).optional(),
  detail: z.string().optional(),
});

export const taskSchema: ZodType<TaskRecord> = z.object({
  verificationOnly: z.boolean().optional(),
  id: z.string(),
  coder: z.enum(['claude', 'codex']),
  description: z.string(),
  brief: briefSnapshotSchema.optional(),
  planStep: z.string().optional(),
  cwd: z.string(),
  verify: z.string().optional(),
  verifyCommands: z.array(z.string()).max(9).optional(),
  verifyCwd: z.string().optional(),
  verifyNetwork: z.enum(['offline', 'loopback', 'ask']).optional(),
  verificationSkipped: z.object({ at: z.number(), command: z.string() }).optional(),
  stopReason: z.string().optional(),
  retry: z.object({ source: z.enum(['tool', 'nexus']), phase: z.enum(['waiting', 'resuming', 'recovered', 'stopped']), reason: z.string(),
    attempt: z.number().int().nonnegative().optional(), maxAttempts: z.number().int().nonnegative().optional(), retryAt: z.number().optional() }).optional(),
  permissions: z.object({ version: z.literal(1), mode: z.literal('unattended'), securityMode: z.enum(['standard', 'strict']).optional(), writableRoots: z.array(z.string()), network: z.literal('ask'), webResearch: z.boolean().optional(), autoApproveSafe: z.boolean().optional(), reviewRoots: z.array(z.string()).optional(), allowedNetworkDomains: z.array(z.string()).default([]),
    maxDurationMs: z.number().positive(), maxRepeatedDenials: z.number().int().positive(), isolation: z.enum(['codex-workspace', 'claude-sandbox', 'dsh-supervised']) }).optional(),
  status: z.enum(['queued', 'running', 'waiting-user', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted']),
  ownerSession: z.string(),
  jobId: z.string().optional(),
  completionNotice: z.object({ messageId: z.string(), seq: z.number().int().nonnegative(), at: z.number() }).optional(),
  coderSessionId: z.string().optional(),
  resumedFrom: z.string().optional(),
  replaces: z.string().optional(),
  dependsOn: z.array(z.string()).max(10).optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  updatedAt: z.number(),
  escalations: z.number(),
  decisions: z.array(decisionSchema),
  safetyReviews: z.array(z.object({ at: z.number(), id: z.string(), taskId: z.string(), phase: z.enum(['request', 'result']), provider: z.string().optional(), model: z.string().optional(), system: z.string().optional(), input: z.string().optional(), output: z.string().optional(), reason: z.string().optional(),
    attempt: z.number().int().positive().optional(), maxTokens: z.number().int().positive().optional(), finishReason: z.string().optional(), failure: z.enum(REVIEW_FAILURES).optional(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), reasoningTokens: z.number().optional(), totalTokens: z.number().optional() }).optional() })).optional(),
  autoAllowed: z.number().optional(),
  pending: z.object({ at: z.number(), kind: decisionSchema.shape.kind, summary: z.string(), detail: z.string().optional(), reason: z.string().optional() }).optional(),
  result: resultSchema.optional(),
  activity: z.string().optional(),
  trace: z.array(z.object({ at: z.number(), text: z.string() })).optional(),
});

export const ruleSchema: ZodType<HabitRule> = z.object({
  id: z.string(),
  source: z.enum(['user', 'learned', 'project']),
  kind: z.enum(['command', 'file-write', 'file-read', 'question', 'other']),
  pattern: z.string(),
  decision: z.enum(['allow', 'deny', 'answer']),
  answer: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.number(),
});

export const coderDomain = defineDomain({
  name: 'nexus_coders',
  version: 1,
  layout: 'per-record',
  tables: { tasks: domainTable<string, TaskRecord>(taskSchema), rules: domainTable<string, HabitRule>(ruleSchema) },
});

export type CoderDomain = Domain<typeof coderDomain>;

/** Opens the domain; narrowed to what tests must fake. */
export interface DomainOpener {
  open(spec: typeof coderDomain): Promise<CoderDomain>;
}

const KEEP_DECISIONS = 50;

export type RuleInput = Pick<HabitRule, 'kind' | 'pattern' | 'decision' | 'answer' | 'note'> & { source?: HabitRule['source'] };

/** Task records and habit rules live in native storage so a restart can report what was interrupted and keep what was learned. */
export class CoderStore {
  private constructor(private readonly domain: CoderDomain) {}

  static async open(facility: DomainOpener): Promise<CoderStore> {
    return new CoderStore(await facility.open(coderDomain));
  }

  private get tasks() { return this.domain.table('tasks'); }
  private get ruleTable() { return this.domain.table('rules'); }

  get(id: string): TaskRecord | undefined { return this.tasks.get(id); }

  list(): TaskRecord[] {
    return [...this.tasks.entries()].map(([, task]) => task).sort((a, b) => b.createdAt - a.createdAt);
  }

  active(): TaskRecord[] { return this.list().filter(isActive); }

  put(task: TaskRecord): Promise<void> { return this.tasks.put(task.id, task); }

  /** Linking UI placement must not change the task's last execution timestamp. */
  async linkNotice(id: string, notice: NonNullable<TaskRecord['completionNotice']>): Promise<void> {
    await this.tasks.update(id, current => current.completionNotice ? current : { ...current, completionNotice: notice });
  }

  async auditReview(record: import('./review.js').ReviewAudit): Promise<void> {
    await this.update(record.taskId, current => ({ safetyReviews: [...(current.safetyReviews ?? []), { ...record, at: Date.now() }].slice(-100) }));
  }

  update(id: string, change: (task: TaskRecord) => Partial<TaskRecord>): Promise<TaskRecord> {
    return this.tasks.update(id, current => {
      const next = change(current);
      const decisions = next.decisions ?? current.decisions;
      return { ...current, ...next, decisions: decisions.slice(-KEEP_DECISIONS), updatedAt: Date.now() };
    });
  }

  /** Jobs do not survive the process: anything still active at startup was interrupted. */
  async markInterrupted(): Promise<string[]> {
    const interrupted = this.active();
    for (const task of interrupted) {
      await this.update(task.id, () => ({ status: 'interrupted', pending: undefined, ...(task.retry ? { retry: { ...task.retry, phase: 'stopped' as const, retryAt: undefined, reason: 'DSH 已重启，自动续接已停止；请在所属会话检查后继续' } } : {}), result: {
        summary: task.status === 'queued' ? '进程重启，排队任务未自动启动；请确认后重新派发。' : '进程重启，任务中断；编码工具的会话 ID 已保留，可以续接。', changedFiles: [], outsideRoots: [],
        ...(task.result ?? {}),
      } }));
    }
    return interrupted.map(task => task.id);
  }

  /** Stored rules, oldest first: user-set rules before learned ones, so the user's own word matches first. */
  rules(): HabitRule[] {
    const order = { user: 0, learned: 1, project: 2 };
    return [...this.ruleTable.entries()].map(([, rule]) => rule)
      .sort((a, b) => order[a.source] - order[b.source] || a.createdAt - b.createdAt);
  }

  /** Adds a rule, or returns the identical rule that already exists. */
  async addRule(input: RuleInput): Promise<{ rule: HabitRule; existed: boolean }> {
    const existing = this.rules().find(rule => rule.kind === input.kind && rule.pattern === input.pattern
      && rule.decision === input.decision && (rule.answer ?? '') === (input.answer ?? ''));
    if (existing) return { rule: existing, existed: true };
    const rule: HabitRule = { id: `cr-${randomBytes(4).toString('hex')}`, source: input.source ?? 'user', kind: input.kind,
      pattern: input.pattern, decision: input.decision, ...(input.answer ? { answer: input.answer } : {}),
      ...(input.note ? { note: input.note } : {}), createdAt: Date.now() };
    await this.ruleTable.put(rule.id, rule);
    return { rule, existed: false };
  }

  removeRule(id: string): Promise<boolean> { return this.ruleTable.delete(id); }

  close(): Promise<void> { return this.domain.close(); }
}
