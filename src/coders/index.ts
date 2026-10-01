import { nativeSafetyReviewer, reviewEnvelope, reviewFingerprint, reviewUntilAborted, ReviewCache, REVIEW_TIMEOUT_MS, type SafetyReviewer } from './review.js';
import { installCoderPackaging } from './package.js';
import { hostInstructions } from './instructions.js';
import { localCheck } from './local-check.js';
import { loadCoderRuntime, verificationEnvironment, verificationReviewCommand } from './runtime.js';
import { coderConcurrency } from './settings.js';
import { taskProcessArgv } from './process.js';
import { ActiveBudget } from './budget.js';
import { assertRetry } from './recovery.js';
import { resolvePlanStep, VERIFY_SHELL_SYNTAX } from './plan.js';
import { installBriefs } from './brief.js';
import { DependencyError, dependencyIds, waitForDependencies } from './dependencies.js';
import { taskStatusLabel } from './status.js';
import { CoderQueue } from './queue.js';
import { createResearchBridge, type ResearchBridge, type ResearchWeb } from './research.js';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type { JobHandle, JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-storage-domain';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-questions';
import { createHash, randomBytes } from 'node:crypto';
import { stat, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ChannelNotifier } from '../channels/notify.js';
import { identity } from '../channels/protocol.js';
import { ChannelError } from '../channels/types.js';
import { loadClaudeQuery, runClaudeTask, type ClaudeQuery } from './claude.js';
import { runCodexTask, type CodexHooks, type CodexSpawn } from './codex.js';
import type { CodersManager, EffectiveRuntime } from './manager.js';
import { decideLayers } from './decide.js';
import { escalateToUser } from './escalate.js';
import { DECISION_LABEL, HABIT_KINDS, KIND_LABEL, describeRule, isOpaque, projectRules, tokens } from './habits.js';
import { isInside } from './rules.js';
import { canonical, taskPermissions, permissionSummary } from './permissions.js';
import type {} from '@deepseek-ai/dsh-sandbox';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { CoderStore } from './store.js';
import { CODER_NAMES, isActive, type CoderDecision, type CoderKind, type CoderRequest, type DecisionRecord, type HabitKind, type HabitRule, type TaskRecord, type TaskStep } from './types.js';
import { coderHomes, taskTranscript, type Transcript } from './transcript.js';
import { SnapshotError, snapshotWorkTree, workspaceScope, verifyTask, windowsVerifyWords, type WorkTreeSnapshot } from './verify.js';
import { requireWindowsFirewall } from './windows-firewall.js';
import { windowsSandbox, windowsVerifyArgv, windowsVerifyExecutable } from './windows-sandbox.js';

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap { coder: 'coder' }
}

export interface CodersConfig {
  /** Used by embedded profiles without a settings manager. */
  securityMode?: 'standard' | 'strict';
  /** The public DSH web service; provider selection and credentials remain native. */
  web?: (ownerSession: string) => ResearchWeb;
  /** Directories a task may work in; requests outside them escalate to the user. Overridden by the manager's settings when present. */
  roots: string[];
  /** Test seam; production uses the owner session model through ctx.llm. */
  safetyReviewer?: SafetyReviewer;
  /** Tasks running at once without a settings manager. Defaults to 2. */
  maxConcurrent?: number;
  /** Maximum additional admitted tasks. Defaults to 10. */
  maxQueued?: number;
  /** One user wait (including prompt queue), default 10 minutes. */
  maxUserWaitMs?: number;
  /** Coder used when the model does not choose one. Defaults to codex; overridden by the manager's settings when present. */
  defaultCoder?: CoderKind;
  /** Settings, installs, and per-coder runtime; without it the coders on PATH and in the plugin's node_modules are used as-is. */
  manager?: CodersManager;
  /** Test seam: replaces the Agent SDK's `query`. */
  query?: ClaudeQuery;
  /** Test seam: replaces spawning `codex app-server`. */
  spawnCodex?: CodexSpawn;
  /** Pushes to the chat that dispatched a task without waiting for the user to write first. */
  notifier?: ChannelNotifier;
  /** Registers the `/api/nexus-coder-tasks/*` routes the task panel reads; the plugin passes its authenticated RPC carrier. */
  registerRpc?: (family: string, methods: readonly string[], handle: (method: string, payload: unknown) => Promise<unknown>) => void;
}

/** What the task panel shows: the task record, rendered for reading, and the coder's own log of the same span. */
export interface TaskDetailView {
  id: string;
  coder: CoderKind;
  coderName: string;
  status: TaskRecord['status'];
  statusLabel: string;
  active: boolean;
  description: string;
  brief?: TaskRecord['brief'];
  planStep?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  resumedFrom?: string;
  dependsOn?: string[];
  runningFor?: string;
  activity?: string;
  permissionDescription?: string;
  stopReason?: string;
  pending?: { at: number; summary: string; detail?: string };
  escalations: number;
  autoAllowed: number;
  decisions: string[];
  trace: TaskStep[];
  result?: TaskRecord['result'];
  transcript: Transcript;
}

const OUTPUT_LIMIT_BYTES = 16 * 1024;
const STATUS_LABEL: Record<TaskRecord['status'], string> = {
  queued: '排队中', running: '运行中', 'waiting-user': '等待用户回答', verifying: '验证中',
  completed: '执行结束', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
const LAYER_LABEL: Record<DecisionRecord['layer'], string> = { hard: '硬规则', habit: '习惯规则', user: '用户', supervisor: 'DSH 审核' };
/**
 * Steps kept per task, and how many `coder_status` shows. The kept window is generous on purpose: a long task's early steps
 * (the ones that explain why it is doing whatever it is doing now) are the first to fall off a short window, and a task that
 * cannot be reviewed after the fact is one the user has to take on trust. The shown window stays small, because that text goes
 * to the model and a hundred command lines are not what it needs to answer "is it stuck".
 */
const TRACE_KEEP = 120;
const TRACE_SHOWN = 5;
/** A quiet spell this long gets a "still thinking" note, so a long model turn does not look like a frozen panel. */
const IDLE_NOTE_MS = 90_000;
/** How often the idle note is re-checked; also the floor between two notes, so a stuck turn is not flooded. */
const IDLE_CHECK_MS = 30_000;
/** At most one store write per task in this window; steps arriving inside it are written together at its end. */
const ACTIVITY_INTERVAL_MS = 1000;
/** What a verify command cannot contain: it runs without a shell and is split on spaces, so these would reach the program literally. */
const SHELL_SYNTAX = VERIFY_SHELL_SYNTAX;
/** Rules a user or project can still add: routine requests are allowed by default, so an allow rule would change nothing. */
const RULE_DECISIONS = ['deny', 'answer'] as const;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;
}

/** One line for a step: whitespace folded, cut with an ellipsis. */
function oneLine(value: string, max = 120): string {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** What the user reads after a restart cut a task short. */
export function interruptedNotice(task: TaskRecord): string {
  return [`编码任务 ${task.id} 因服务重启而中断（${CODER_NAMES[task.coder]}）。`, `任务：${clip(task.description, 200)}`,
    `目录：${task.cwd}`,
    ...(task.permissions ? [permissionSummary(task.permissions)] : []), ...(task.pending ? [`中断时正在等待你回答：${task.pending.summary}`] : []),
    ...(task.coderSessionId ? [`${CODER_NAMES[task.coder]} 会话 ${task.coderSessionId} 已保留。`] : []),
    task.coderSessionId ? '任务不会自动重跑；需要继续时告诉我，可以接着原来的会话做下去。' : '任务不会自动重跑；需要继续时告诉我重新派发。'].join('\n');
}

function describeDecision(decision: DecisionRecord): string {
  const outcome = { allow: '允许', deny: '拒绝', answer: '回答', ask: '转交用户' }[decision.outcome];
  const notes = [decision.reason, ...(decision.remembered?.length ? [`已记住：${decision.remembered.join('、')}`] : [])].filter(Boolean);
  return `[${LAYER_LABEL[decision.layer]}·${outcome}] ${decision.summary}${notes.length ? ` — ${notes.join('；')}` : ''}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

/** How long an active task has run and how long ago its last step was; with no step yet, that the coder has done nothing visible. */
function runningFor(task: TaskRecord, now = Date.now()): string {
  if (task.status === 'queued') return `已排队 ${duration(now - task.createdAt)}；尚未启动编码工具`;
  const last = task.trace?.at(-1);
  return `已运行 ${duration(now - (task.startedAt ?? task.createdAt))}；${last ? `最近一步在 ${duration(now - last.at)}前` : '还没有记录到任何动作，暂时无法判断执行进展'}`;
}

/** "当前" only while the coder is running: waiting for the user, verifying, or finished, it is doing nothing. */
function currentActivity(task: TaskRecord, now = Date.now()): string | undefined {
  if (task.status !== 'running') return;
  const last = task.trace?.at(-1);
  const quiet = now - (last?.at ?? task.startedAt ?? task.createdAt);
  if (quiet >= IDLE_NOTE_MS) return `尚未收到新动作：已 ${duration(quiet)}；无法判断正在思考或阻塞。${last ? `最后记录（历史）：${oneLine(last.text, 160)}` : '还没有记录到动作。'}`;
  return task.activity;
}

export function taskReport(task: TaskRecord, outcome: JobOutcome, verify: Awaited<ReturnType<typeof verifyTask>>): string {
  const count = (layer: DecisionRecord['layer']) => task.decisions.filter(decision => decision.layer === layer).length;
  const lines = [
    `编码任务 ${task.id} ${outcome.status === 'completed' ? (verify.verifyExecuted === false ? '执行结束，独立验证未执行' : verify.verifyOk === false ? '执行结束，但验证失败' : verify.outsideRoots.length ? '已完成，但有改动越出根目录' : verify.verifyOk === undefined ? '执行结束，尚未独立验证' : '执行结束，验证通过') : outcome.status === 'killed' ? '已取消' : '失败'}${outcome.detail ? `（${outcome.detail}）` : ''}`,
    `任务：${task.description}`,
    ...(task.resumedFrom ? [`续接：${task.resumedFrom}`] : []),
    `目录：${task.cwd}`,
    ...(task.permissions ? [permissionSummary(task.permissions)] : []),
    '',
    `DSH 独立验证范围：${task.verify ? [task.verify, ...(task.verifyCommands ?? [])].join('；') : '未指定'}。编码工具自述的其他测试不代表 DSH 已独立运行。`,
    `${CODER_NAMES[task.coder]} 的结果（编码工具自述）：`,
    clip(outcome.result?.trim() || '（没有文本结果）', 4000),
    '',
    `改动文件（${verify.changedFiles.length}）：`,
    ...verify.changedFiles.slice(0, 40).map(file => `- ${file}`),
    ...(verify.changedFiles.length > 40 ? [`- …另有 ${verify.changedFiles.length - 40} 个`] : []),
    ...(verify.outsideRoots.length ? ['', `根目录之外的改动（需要人工检查）：`, ...verify.outsideRoots.map(file => `- ${file}`)] : []),
    '',
    task.verify ? `验证命令 ${task.verify}：${verify.verifyOk === undefined || verify.verifyExecuted === false ? '未执行' : verify.verifyOk ? '通过' : '失败'}` : '验证命令：未指定',
    ...(task.verify && verify.verifyOutput ? [clip(verify.verifyOutput, 2000)] : []),
    '',
    `升级给用户 ${count('user')} 次，硬规则自动拒绝 ${count('hard')} 次，习惯规则自动决定 ${count('habit')} 次，DSH 自动审核 ${count('supervisor')} 次，常规操作自动放行 ${task.autoAllowed ?? 0} 次。`,
    ...task.decisions.map(describeDecision),
  ];
  return lines.join('\n');
}

/** Register the dispatch, status, and rule tools and wire native jobs, storage, and user questions. */
export async function installCoders(ctx: Context, config: CodersConfig): Promise<CoderStore> {
  const fallbackRoots = config.roots.map(root => resolve(root));
  if (fallbackRoots.length === 0) throw new Error('coderRoots must list at least one directory.');
  let maxConcurrent = coderConcurrency(config.manager ? (await config.manager.load()).maxConcurrent : config.maxConcurrent);
  const maxQueued = config.maxQueued ?? 10;
  if (config.maxUserWaitMs !== undefined && (!Number.isSafeInteger(config.maxUserWaitMs) || config.maxUserWaitMs <= 0)) throw new Error('Invalid user wait timeout');
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new Error('Invalid coder queue limit');
  const queue = new CoderQueue(maxConcurrent);
  if (config.manager) ctx.effect(() => config.manager!.onConcurrencyChange(limit => {
    maxConcurrent = limit;
    queue.setConcurrency(limit);
  }));
  const shutdown = new AbortController();
  ctx.effect(() => () => { shutdown.abort(); queue.close(); });
  const completions = new Map<string, Promise<JobOutcome>>();
  const admitting = new Set<string>();
  const resuming = new Set<string>();
  const planning = new Set<string>();
  const store = await CoderStore.open(ctx.storageDomain);
  ctx.effect(() => () => { void store.close(); });
  config.manager?.attach(store);
  const briefs = await installBriefs(ctx, () => store.list(), async tasks => {
    for (const task of tasks) {
      if (!task.jobId) throw new Error('任务尚在受理，请稍后应用变更。');
      ctx.jobs.kill(task.jobId as Parameters<typeof ctx.jobs.kill>[0], task.ownerSession as SessionId, '用户修改目标，停止旧版本任务');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all(tasks.map(task => completions.get(task.id))), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('旧任务尚未停止，未应用新目标。')), 30_000); })]); }
    finally { clearTimeout(timer); }
    if (tasks.some(task => { const current = store.get(task.id); return current && isActive(current); })) throw new Error('旧任务尚未停止。');
  }, async request => {
    if (!request.agent) throw new Error('提问需要所属会话。');
    const signal = AbortSignal.any([request.signal ?? shutdown.signal, shutdown.signal, AbortSignal.timeout(config.maxUserWaitMs ?? 10 * 60_000)]);
    const queue = questionQueues.get(request.agent.id) ?? new CoderQueue(1);
    questionQueues.set(request.agent.id, queue);
    const release = await queue.acquire(signal);
    try { return await ctx.userQuestions.ask({ ...request, signal }); } finally { release(); }
  });
  /** Roots and default coder as configured right now; settings from the page win over the profile. */
  const runtime = async (mode?: 'standard' | 'strict'): Promise<EffectiveRuntime> => config.manager ? config.manager.runtime(mode)
    : { securityMode: mode ?? config.securityMode ?? 'standard', roots: fallbackRoots, defaultCoder: config.defaultCoder ?? 'codex', codex: { command: 'codex', env: process.env, source: 'system' }, claude: { env: process.env, source: 'system' } };
  const currentRoots = (): string[] => {
    const settings = config.manager?.current();
    return settings?.roots?.length ? settings.roots : fallbackRoots;
  };
  const currentDefault = (): CoderKind => config.manager?.current()?.defaultCoder ?? config.defaultCoder ?? 'codex';
  const before = new Map(store.active().map(task => [task.id, task]));
  const interrupted = await store.markInterrupted();
  if (interrupted.length) console.error(`[nexus-coders] interrupted tasks after restart: ${interrupted.join(', ')}`);
  for (const id of interrupted) {
    const task = before.get(id);
    if (!task || !config.notifier) continue;
    // Best effort and off the startup path: the transport may still be connecting, and WeChat holds the text until it can send.
    void config.notifier.notify(task.ownerSession, interruptedNotice(task), identity('coder-interrupted', task.id))
      .then(routed => { if (!routed) console.error(`[nexus-coders] no channel route for interrupted task ${task.id}`); })
      .catch(error => { console.error(`[nexus-coders] could not notify about interrupted task ${task.id}: ${(error as Error)?.message ?? error}`); });
  }
  const host = {
    resolveAgent: (sessionId: SessionId) => ctx.sessionController.resolveAgent(sessionId),
    ask: (request: Parameters<typeof ctx.userQuestions.ask>[0]) => ctx.userQuestions.ask(request),
  };
  /** Project-file rules read when each task was dispatched; a coder cannot grant itself rules mid-task. */
  const projectRulesOf = new Map<string, HabitRule[]>();

  /** Roots as they were when each task was dispatched, so a settings change mid-task cannot widen it. */
  const rootsOf = new Map<string, string[]>();
  const reviewEnvs = new Map<string, NodeJS.ProcessEnv>();
  /** The work tree at execution start, so the report lists what this task changed and not what was already dirty. */
  const baselineOf = new Map<string, WorkTreeSnapshot>();
  /** Running tasks: where their steps go, and for Codex a way to talk to it mid-turn. */
  const liveOf = new Map<string, { record(text: string): void; steer?: CodexHooks['steer'] }>();
  const safetyReviewer = config.safetyReviewer ?? nativeSafetyReviewer(ctx, record => store.auditReview(record));
  const reviewQueue = new CoderQueue(1);
  const reviewCache = new ReviewCache();
  ctx.effect(() => () => reviewCache.clear());
  ctx.effect(() => () => reviewQueue.close());
  const budgets = new Map<string, ActiveBudget>();
  const questionQueues = new Map<string, CoderQueue>();
  ctx.effect(() => () => { for (const queue of questionQueues.values()) queue.close(); });
  const stopOf = new Map<string, (reason: string) => void>();
  const rejectionCounts = new Map<string, Map<string, number>>();

  function repeated(task: TaskRecord, key: string, reason: string): boolean {
    const counts = rejectionCounts.get(task.id) ?? new Map<string, number>();
    rejectionCounts.set(task.id, counts);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const stop = count >= (task.permissions?.maxRepeatedDenials ?? 3);
    if (stop) stopOf.get(task.id)?.(`同一原因被拒绝或失败 ${count} 次：${reason}。已暂停，请调整要求后续接。`);
    return stop;
  }

  async function decide(taskId: string, request: CoderRequest, signal: AbortSignal): Promise<CoderDecision> {
    const task = store.get(taskId);
    if (!task) return { behavior: 'deny', message: '任务记录不存在。', interrupt: true };
    const roots = task.permissions?.writableRoots ?? rootsOf.get(taskId) ?? [task.cwd];
    if (task.stopReason || !isActive(task)) return { behavior: 'deny', message: task.stopReason ?? '任务已停止。', interrupt: true };
    try { request = { ...request, paths: await Promise.all(request.paths.map(canonical)) }; }
    catch { const stop = repeated(task, 'path-unresolved', '无法确认请求路径的真实边界'); return { behavior: 'deny', message: '无法确认请求路径的真实边界。', ...(stop ? { interrupt: true } : {}) }; }
    const verdict = decideLayers(request, roots, [...store.rules(), ...(projectRulesOf.get(taskId) ?? [])], task.cwd, task.permissions?.webResearch === true, task.permissions?.securityMode === 'standard');
    const at = Date.now();
    const step = liveOf.get(taskId)?.record ?? (() => {});
    if (verdict.layer === 'auto') {
      await store.update(taskId, current => ({ autoAllowed: (current.autoAllowed ?? 0) + 1 }));
      return { behavior: 'allow' };
    }
    if (verdict.layer === 'hard') {
      const record: DecisionRecord = { at, kind: request.kind, summary: request.summary, layer: 'hard', outcome: 'deny',
        reason: verdict.reason, ...(verdict.key ? { blockKey: verdict.key } : {}) };
      // No retry of a denied operation grants new authority. Stop the native job after the fixed limit.
      const stop = repeated(task, verdict.key ?? verdict.reason, verdict.reason);
      await store.update(taskId, current => ({ decisions: [...current.decisions, record] }));
      step(`监工拒绝：${oneLine(request.summary, 80)}（${oneLine(verdict.reason, 60)}）`);
      return { behavior: 'deny', message: `监工拒绝：${verdict.reason}`, ...(stop ? { interrupt: true } : {}) };
    }
    if (verdict.layer === 'habit') {
      const { decision, rule, answers } = verdict.verdict;
      const record: DecisionRecord = { at, kind: request.kind, summary: request.summary, layer: 'habit', outcome: decision, reason: describeRule(rule) };
      await store.update(taskId, current => ({ decisions: [...current.decisions, record] }));
      step(`${decision === 'deny' ? '按规则拒绝' : '按规则代答'}：${oneLine(request.summary, 100)}`);
      if (decision === 'deny') {
        const stop = repeated(task, `habit:${rule.id}`, describeRule(rule));
        return { behavior: 'deny', message: `监工按规则拒绝：${describeRule(rule)}`, ...(stop ? { interrupt: true } : {}) };
      }
      if (decision === 'answer') return { behavior: 'allow', updatedInput: { ...request.raw, answers: answers ?? {} } };
      return { behavior: 'allow' };
    }
    const network = request.raw.networkApprovalContext as { host?: unknown } | undefined;
    if (request.kind === 'command' && typeof network?.host === 'string' && task.permissions?.allowedNetworkDomains.includes(network.host.toLowerCase()) && !request.command && request.paths.length === 0 && !request.raw.additionalPermissions) {
      await store.update(taskId, current => ({ autoAllowed: (current.autoAllowed ?? 0) + 1 }));
      return { behavior: 'allow' };
    }
    if (!verdict.manualOnly && task.permissions?.autoApproveSafe && request.kind !== 'question' && config.manager?.current()?.autoApproveSafe !== false) {
      let release: (() => void) | undefined;
      try {
        const reviewSignal = AbortSignal.any([signal, shutdown.signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
        release = await reviewQueue.acquire(reviewSignal);
        for (let attempt = 0; attempt < 2; attempt++) {
          const envelope = await reviewEnvelope(task, request, reviewEnvs.get(taskId));
          if (!envelope) break;
          const cached = reviewCache.get(task, envelope);
          step(`${cached ? 'DSH 正在核验已有安全结论' : 'DSH 正在审核'}：${oneLine(request.summary, 100)}`);
          const result = cached ?? await reviewUntilAborted(safetyReviewer(task, envelope, reviewSignal), reviewSignal);
          reviewSignal.throwIfAborted();
          const after = await reviewEnvelope(task, request, reviewEnvs.get(taskId));
          const current = store.get(taskId);
          const latest = decideLayers(request, roots, [...store.rules(), ...(projectRulesOf.get(taskId) ?? [])], task.cwd, task.permissions?.webResearch === true, task.permissions?.securityMode === 'standard');
          // A newly added deny must still win, even if the reviewer was already in flight.
          if (latest.layer === 'hard' || (latest.layer === 'habit' && latest.verdict.decision === 'deny')) return decide(taskId, request, signal);
          if (attempt === 0 && task.permissions?.securityMode === 'standard' && request.kind === 'command' && result.safe && after && current && isActive(current) && !current.stopReason && reviewFingerprint(after) !== reviewFingerprint(envelope)) {
            step('审核证据发生变化，正在根据最新内容重新审核一次。');
            continue;
          }
          const allowed = result.safe && !!after && reviewFingerprint(after) === reviewFingerprint(envelope)
            && !!current && isActive(current) && !current.stopReason && config.manager?.current()?.autoApproveSafe !== false;
          const reason = result.safe && !allowed ? '审核期间操作内容、目标路径或任务状态已变化' : cached ? `复用本任务 60 秒内的安全审核（命令、权限和文件证据未变）：${result.reason}` : result.reason;
          await store.update(taskId, current => ({ decisions: [...current.decisions, { at: Date.now(), kind: request.kind, summary: request.summary, layer: 'supervisor', outcome: allowed ? 'allow' : 'ask', reason }] }));
          reviewSignal.throwIfAborted();
          if (allowed) { if (!cached) reviewCache.set(task, envelope, result); step(`DSH 自动授权：${oneLine(request.summary, 100)}（${oneLine(reason, 100)}）`); return { behavior: 'allow' }; }
          step(`DSH 转交用户确认：${oneLine(reason, 100)}`);
          break;
        }
      } catch { step('DSH 自动审核未完成，转交用户确认。'); }
      finally { release?.(); }
      if (signal.aborted || shutdown.signal.aborted) return { behavior: 'deny', message: '任务已取消。', interrupt: true };
    }
    const key = task.brief && request.kind === 'question' && !task.verify ? createHash('sha256').update(JSON.stringify(request.questions ?? [])).digest('hex') : undefined;
    const cached = key && task.brief ? briefs.answer(task.brief.id, task.ownerSession, task.brief.revision, key) : undefined;
    if (cached) {
      step(`沿用用户已确认回答：${oneLine(request.summary, 100)}`);
      await store.update(taskId, current => ({ decisions: [...current.decisions, { at, kind: request.kind, summary: request.summary, layer: 'user', outcome: 'answer', reason: '同一目标版本下相同澄清问题，沿用已有回答' }] }));
      return { behavior: 'allow', updatedInput: { ...request.raw, answers: cached } };
    }
    await store.update(taskId, () => ({ status: 'waiting-user', pending: { at, kind: request.kind, summary: request.summary,
      ...(request.detail ? { detail: clip(request.detail, 500) } : {}) } }));
    step(`等待用户：${oneLine(request.summary, 100)}`);
    const resumeBudget = budgets.get(taskId)?.pause();
    const waitSignal = AbortSignal.any([signal, AbortSignal.timeout(config.maxUserWaitMs ?? 10 * 60_000)]);
    const queue = questionQueues.get(task.ownerSession) ?? new CoderQueue(1);
    questionQueues.set(task.ownerSession, queue);
    let releaseQuestion: (() => void) | undefined;
    let didAsk = true;
    let outcome: Awaited<ReturnType<typeof escalateToUser>>;
    try {
      releaseQuestion = await queue.acquire(waitSignal);
      const reused = key && task.brief ? briefs.answer(task.brief.id, task.ownerSession, task.brief.revision, key) : undefined;
      didAsk = !reused;
      outcome = reused ? { decision: { behavior: 'allow', updatedInput: { ...request.raw, answers: reused } }, record: { at, kind: request.kind, summary: request.summary, layer: 'user', outcome: 'answer', reason: '沿用同一目标版本的已有回答' } }
        : await escalateToUser(host, task, request, waitSignal, verdict.reason);
      if (!waitSignal.aborted && key && task.brief && outcome.record.outcome === 'answer' && outcome.decision.behavior === 'allow') {
        const answers = outcome.decision.updatedInput?.answers as Record<string, string> | undefined;
        if (answers && Object.values(answers).every(value => typeof value === 'string' && value.trim())) await briefs.rememberAnswer(task.brief.id, task.ownerSession, task.brief.revision, key, answers);
      }
    } catch {
      outcome = { decision: { behavior: 'deny', message: '等待用户已取消或超时。', interrupt: true }, record: { at, kind: request.kind, summary: request.summary, layer: 'user', outcome: 'deny', reason: '等待用户已取消或超时' } };
    } finally { releaseQuestion?.(); resumeBudget?.(); }
    if (waitSignal.aborted && !signal.aborted) stopOf.get(taskId)?.('等待用户超过时限，任务已暂停；请回答或调整后显式续接。');
    step(`${{ allow: '用户允许', deny: '拒绝', answer: '用户回答', ask: '转交用户' }[outcome.record.outcome]}：${oneLine(request.summary, 100)}`);
    await store.update(taskId, current => ({
      // An aborted question leaves a final status alone: a cancelled task gets it from runJob, an interrupted turn goes on running.
      status: outcome.unreachable ? 'interrupted' : current.status === 'waiting-user' ? 'running' : current.status,
      escalations: current.escalations + (didAsk ? 1 : 0), decisions: [...current.decisions, outcome.record], pending: undefined,
      ...(outcome.verificationSkipped ? { verificationSkipped: outcome.verificationSkipped } : {}),
    }));
    if (outcome.decision.behavior === 'deny') {
      const stop = repeated(task, `user:${request.kind}:${request.command ?? (request.paths.join('|') || request.tool)}`, '用户未授权这项操作');
      if (outcome.unreachable) stopOf.get(taskId)?.('派发会话不可用，无法取得授权；已暂停。');
      if (stop) return { ...outcome.decision, interrupt: true };
    }
    return outcome.decision;
  }

  /**
   * Records the coder's steps on the task, throttled: the first step of a quiet spell is written at once, later ones wait for the
   * window to close and are written together, so none is lost. `close` returns the steps not yet written, for the final update.
   * Each step also goes to the job's own panel at once, as a timed line on the observer-only `log` channel and as its progress
   * line; `log` adds detail only that panel shows (a command's output). Neither reaches the model.
   */
  function activityRecorder(taskId: string, job?: JobHandle) {
    let unwritten: TaskStep[] = [];
    let lastWrite = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastStepAt = Date.now();
    let closed = false;
    const write = () => {
      timer = undefined;
      if (closed || !unwritten.length) return;
      const steps = unwritten;
      unwritten = [];
      lastWrite = Date.now();
      void store.update(taskId, current => ({ activity: steps.at(-1)!.text, trace: [...(current.trace ?? []), ...steps].slice(-TRACE_KEEP) }))
        .catch(error => { console.error(`[nexus-coders] could not record a step of ${taskId}: ${(error as Error)?.message ?? error}`); });
    };
    // A quiet spell says only that no new action was observed. Keep the elapsed idle time visible without
    // guessing whether the coder is thinking or blocked. This
    // only touches the progress line and `activity`, never `trace`: these are liveness pings, not steps, and must not push real
    // work out of the review window or be counted as one.
    const beat = setInterval(() => {
      if (closed) return;
      const quiet = Date.now() - lastStepAt;
      if (quiet < IDLE_NOTE_MS) return;
      const text = `尚未收到新动作：已 ${duration(quiet)}；任务仍未结束，无法据此判断正在思考或阻塞`;
      job?.append(`${clock(Date.now())} ${text}\n`, { channel: 'log' });
      job?.updateProgress(text);
      void store.update(taskId, () => ({ activity: text })).catch(() => {});
    }, IDLE_CHECK_MS);
    beat.unref?.();
    return {
      record(text: string) {
        if (closed) return;
        const at = Date.now();
        lastStepAt = at;
        job?.append(`${clock(at)} ${text}\n`, { channel: 'log' });
        job?.updateProgress(text);
        unwritten.push({ at, text });
        if (timer) return;
        const wait = lastWrite + ACTIVITY_INTERVAL_MS - Date.now();
        if (wait <= 0) write();
        else { timer = setTimeout(write, wait); timer.unref?.(); }
      },
      log(text: string) {
        if (closed || !text.trim()) return;
        job?.append(`${text.split('\n').map(line => `    ${line}`).join('\n')}\n`, { channel: 'log' });
      },
      close(): TaskStep[] {
        closed = true;
        if (timer) clearTimeout(timer);
        clearInterval(beat);
        timer = undefined;
        const rest = unwritten;
        unwritten = [];
        return rest;
      },
    };
  }

  function runJob(task: TaskRecord, query: ClaudeQuery | undefined, effective: EffectiveRuntime, roots: string[], job?: JobHandle): JobHooks {
    const activity = activityRecorder(task.id, job);
    const cancellation = new AbortController();
    let stopped: string | undefined;
    job?.append(`${CODER_NAMES[task.coder]} 编码任务 ${task.id}${task.resumedFrom ? `（续接 ${task.resumedFrom}）` : ''}，目录 ${task.cwd}\n`
      + `任务：${oneLine(task.description, 300)}\n`, { channel: 'log' });
    let failure: { key: string; count: number } | undefined;
    const shared = {
      decide: (request: CoderRequest, signal: AbortSignal) => decide(task.id, request, signal),
      onSession: (coderSessionId: string) => { void store.update(task.id, () => ({ coderSessionId })); },
      onActivity: (text: string) => activity.record(text),
      onLog: (text: string) => activity.log(text),
      onFailure: (key: string) => {
        failure = { key, count: failure?.key === key ? failure.count + 1 : 1 };
        if (failure.count >= (task.permissions?.maxRepeatedDenials ?? 3)) stopOf.get(task.id)?.('同一工具操作连续失败三次且没有成功操作，已暂停；请调整后续接。');
      },
      onSuccess: () => { failure = undefined; },
    };
    /** The coder stopped: keep its last steps, drop what it was doing. */
    const settle = (current: TaskRecord): Partial<TaskRecord> => {
      const rest = activity.close();
      return { activity: undefined, ...(rest.length ? { trace: [...(current.trace ?? []), ...rest].slice(-TRACE_KEEP) } : {}) };
    };
    const codex = 'error' in effective.codex ? undefined : effective.codex;
    const claude = 'error' in effective.claude ? undefined : effective.claude;
    const executionEnv = (task.coder === 'codex' ? codex : claude)?.env ?? process.env;
    let runner: JobHooks | undefined;
    let research: ResearchBridge | undefined;
    const hooks: JobHooks = {
      done: (async (): Promise<JobOutcome> => {
        try {
          if (task.permissions?.webResearch && config.web || process.platform === 'linux' && task.permissions && ctx.sandbox) research = await createResearchBridge(task.permissions?.webResearch ? config.web?.(task.ownerSession) : undefined, shared.decide, task.cwd, cancellation.signal, shared.onActivity,
            process.platform === 'linux' && task.permissions && ctx.sandbox ? (command, directory, signal) => localCheck(ctx, task.cwd, task.ownerSession, command, directory, signal) : undefined);
          const instructions = await hostInstructions(task.cwd);
          cancellation.signal.throwIfAborted();
          const codexHooks = task.coder === 'codex' ? runCodexTask(task, { instructions, ...shared, research,
            ...(config.spawnCodex ? { spawn: config.spawnCodex } : {}),
            ...(codex ? { launch: { command: codex.command, env: codex.env }, ...(codex.model ? { model: codex.model } : {}) } : {}) }) : undefined;
          runner = codexHooks ?? runClaudeTask(task, { instructions, ...shared, research, query: query!, ...(claude ? { env: claude.env,
            ...(claude.model ? { model: claude.model } : {}), ...(claude.executable ? { executable: claude.executable } : {}) } : {}) });
          liveOf.set(task.id, { record: text => activity.record(text), ...(codexHooks ? { steer: codexHooks.steer } : {}) });
          return await runner.done;
        } catch {
          return { status: cancellation.signal.aborted ? 'killed' : 'failed', detail: '编码任务启动已取消或 DSH 网页服务连接失败。' };
        } finally { await research?.close(); }
      })(),
      cancel(reason) { cancellation.abort(); runner?.cancel(reason); },
    };
    const stop = (reason: string) => {
      if (stopped) return;
      stopped = reason;
      void store.update(task.id, () => ({ stopReason: reason })).catch(() => {});
      activity.record(reason);
      cancellation.abort(new Error(reason));
      hooks.cancel(reason);
    };
    stopOf.set(task.id, stop);
    const budget = new ActiveBudget(task.permissions?.maxDurationMs ?? 60 * 60_000, () => stop('达到本次运行时间预算，已暂停；进度和编码会话保留，确认后可续接。'));
    budgets.set(task.id, budget);
    const done = hooks.done.then(async outcome => {
      if (outcome.status === 'failed' && /rate[ _-]?limit|too many requests|\b429\b/i.test(outcome.detail ?? '')) {
        stopped = '模型服务限流，任务已暂停；已保留文件和编码会话，额度恢复后显式重试当前步骤，无需重做已通过步骤。';
        await store.update(task.id, () => ({ stopReason: stopped }));
      }
      await store.update(task.id, current => ({ activity: undefined, ...(outcome.status !== 'killed' ? { status: 'verifying' as const } : {}) }));
      const settledTask = store.get(task.id) ?? task;
      if (outcome.status !== 'killed') job?.updateProgress(settledTask.verificationSkipped ? '收集改动（按用户要求不运行验证）' : '验证中');
      const verify = await verifyTask({ ...settledTask, ...(outcome.status !== 'completed' || stopped || settledTask.verificationSkipped ? { verify: undefined } : {}) },
        task.permissions?.writableRoots ?? [task.cwd], baselineOf.get(task.id), stopped || outcome.status === 'killed' ? undefined : cancellation.signal,
        async (argv, command) => {
          const windows = process.platform === 'win32';
          const standard = task.permissions?.securityMode === 'standard';
          const supervised = standard && task.verifyNetwork === 'ask';
          const nativeCodex = windows && task.coder === 'codex';
          if (nativeCodex) {
            if (!codex || await windowsSandbox(codex, task.cwd) !== 'ready') throw new Error('Windows 增强沙箱未就绪，验证未执行。');
            if (task.verifyNetwork !== 'ask') await requireWindowsFirewall();
          }
          if (windows && !nativeCodex && !supervised) throw new Error('Windows Claude 独立验证不能强制断网；请为标准模式验证显式申请联网，或使用 Linux / WSL2。');
          if (task.verifyNetwork === 'ask') {
            const reviewCommand = await verificationReviewCommand(command, argv, effective.runtimeExecutables);
            const decision = await decide(task.id, { kind: 'command', tool: 'verify.command', command: reviewCommand,
              summary: `审核独立验证命令：${command}`, detail: `仅这次验证命令可访问任意网络目标：${reviewCommand}。${supervised && !nativeCodex ? '以当前用户权限运行，不提供操作系统文件隔离。' : '文件写入限制在任务目录。'}不传入密钥环境变量。拒绝后不执行本次验证。`, paths: [],
              raw: { cwd: task.verifyCwd ?? task.cwd, additionalPermissions: { network: true }, ...(reviewCommand !== command ? { hostRuntimeExecutable: argv[0], runtimeSource: 'load_workspace_dependencies', executionCommand: command } : {}) } }, cancellation.signal);
            if (decision.behavior !== 'allow') throw new Error(decision.message || '本次验证未获授权。');
            cancellation.signal.throwIfAborted();
            await store.update(task.id, () => ({ status: 'verifying', pending: undefined }));
            job?.updateProgress('验证中（DSH 已授权本次命令）');
          }
          if (nativeCodex) return windowsVerifyArgv(codex!.command, await windowsVerifyExecutable(argv, task.verifyCwd ?? task.cwd, codex!.env), task.cwd, task.verifyCwd ?? task.cwd, task.verifyNetwork);
          if (supervised) return windows ? windowsVerifyExecutable(argv, task.verifyCwd ?? task.cwd, executionEnv) : argv;
          if (!ctx.sandbox) throw new Error('严格验证需要 DSH 沙箱服务。');
          const confined = await ctx.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: task.cwd, sessionId: task.ownerSession as SessionId }, cancellation.signal);
          if (confined.enforcement !== 'full') throw new Error('独立验证需要完整的文件写入隔离。');
          if (task.verifyNetwork === 'ask') return confined.argv;
          if (process.platform !== 'linux') throw new Error('当前平台尚未提供独立验证的网络隔离，验证未执行。');
          return task.verifyNetwork === 'loopback' ? taskProcessArgv(confined.argv, true) : ['unshare', '--user', '--map-root-user', '--net', '--', ...confined.argv];
        }, verificationEnvironment(executionEnv));
      if (settledTask.verificationSkipped) Object.assign(verify, { verifyOk: false, verifyExecuted: false,
        verifyOutput: '用户明确选择本次仅交付文件，独立验证未执行；原验证要求保留，未标记为验收通过。' });
      const current = store.get(task.id) ?? task;
      const report = taskReport(current, outcome, verify);
      const failed = outcome.status === 'failed' || verify.verifyOk === false || verify.outsideRoots.length > 0;
      const status: TaskRecord['status'] = stopped ? 'interrupted' : outcome.status === 'killed' ? 'cancelled' : failed ? 'failed' : 'completed';
      await store.update(task.id, current => ({ ...settle(current), status, result: { summary: outcome.result?.trim() ?? '',
        execution: outcome.status === 'completed' ? 'completed' : outcome.status === 'failed' ? 'failed' : 'stopped',
        verification: verify.verifyOk === undefined || verify.verifyExecuted === false ? 'not-run' : verify.verifyOk ? 'passed' : 'failed',
        changedFiles: verify.changedFiles, ...(verify.commits ? { commits: verify.commits } : {}), outsideRoots: verify.outsideRoots,
        ...(verify.verifyOk !== undefined ? { verifyOk: verify.verifyOk } : {}),
        ...(verify.verifyOutput !== undefined ? { verifyOutput: verify.verifyOutput } : {}),
        ...(verify.verifyChecks ? { verifyChecks: verify.verifyChecks } : {}),
        ...(outcome.detail ? { detail: outcome.detail } : {}) } }));
      const detail = status === 'failed' && outcome.status === 'completed'
        ? (verify.verifyOk === false ? (verify.verifyExecuted === false ? '验证未执行' : '验证命令失败') : '改动越出根目录') : outcome.detail;
      job?.append(`${clock(Date.now())} 结束：${STATUS_LABEL[status]}${detail ? `（${oneLine(detail, 100)}）` : ''}，改动文件 ${verify.changedFiles.length} 个`
        + `${task.verify ? `，验证${verify.verifyExecuted === false || verify.verifyOk === undefined ? '未执行' : verify.verifyOk ? '通过' : '失败'}` : ''}\n`, { channel: 'log' });
      return { status: status === 'cancelled' || status === 'interrupted' ? 'killed' : status === 'failed' ? 'failed' : 'completed',
        ...(stopped || detail ? { detail: stopped ?? detail } : {}), result: stopped ? `${stopped}\n${report}` : report } satisfies JobOutcome;
    }).catch(async (error: unknown): Promise<JobOutcome> => {
      const message = (error as Error)?.message ?? String(error);
      await store.update(task.id, current => ({ ...settle(current), status: 'failed', result: { summary: '', changedFiles: [], outsideRoots: [], detail: message } })).catch(() => {});
      return { status: 'failed', detail: message, result: `编码任务 ${task.id} 失败：${message}` };
    }).finally(() => { budget.close(); budgets.delete(task.id); stopOf.delete(task.id); rejectionCounts.delete(task.id); projectRulesOf.delete(task.id); rootsOf.delete(task.id); reviewEnvs.delete(task.id); baselineOf.delete(task.id); liveOf.delete(task.id);
 });
    return { cancel: reason => { cancellation.abort(); hooks.cancel(reason); }, done };
  }

  function queuedJob(task: TaskRecord, query: ClaudeQuery | undefined, effective: EffectiveRuntime, roots: string[], job: JobHandle): JobHooks {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, shutdown.signal]);
    let runner: JobHooks | undefined;
    job.updateProgress(task.dependsOn?.length ? `等待前置任务验证通过：${task.dependsOn.join('、')}` : '排队中，尚未启动编码工具');
    const done = (async (): Promise<JobOutcome> => {
      let release: (() => void) | undefined;
      try {
        if (task.dependsOn?.length) await waitForDependencies(task, id => store.get(id), id => completions.get(id), signal);
        job.updateProgress('排队中，尚未启动编码工具');
        let scope = await workspaceScope(task.cwd, signal);
        while (true) {
          release = await queue.acquire(signal, scope);
          // A repository may have been initialized or moved while this job waited.
          const currentScope = await workspaceScope(task.cwd, signal);
          if (currentScope === scope) break;
          release(); release = undefined; scope = currentScope;
        }
        signal.throwIfAborted();
        if (task.brief && (briefs.isChanging(task.brief.id) || briefs.get(task.brief.id, task.ownerSession).revision !== task.brief.revision)) throw new DependencyError('任务说明单已更新，本任务未启动；请读取新版本后重新派发。');
        // Waiting must not count toward runtime or include the preceding task's edits.
        const cwd = await canonical(task.cwd);
        if (cwd !== task.cwd || !(await stat(cwd)).isDirectory() || !currentRoots().some(root => isInside(root, cwd))) throw new Error('queued_workspace_changed');
        const baseline = await snapshotWorkTree(cwd, signal);
        signal.throwIfAborted();
        if (baseline) baselineOf.set(task.id, baseline);
        const running = await store.update(task.id, () => ({ status: 'running', startedAt: Date.now() }));
        signal.throwIfAborted();
        runner = runJob(running, query, effective, roots, job);
        return await runner.done;
      } catch (error) {
        const status = signal.aborted ? 'cancelled' : 'failed';
        const detail = status === 'cancelled' ? '任务在编码工具启动前已取消。' : error instanceof DependencyError || error instanceof SnapshotError ? error.message : '排队任务未启动：工作目录或服务状态已变化，请检查后重新派发。';
        await store.update(task.id, () => ({ status, activity: undefined, pending: undefined,
          result: { summary: detail, execution: 'stopped', verification: 'not-run', changedFiles: [], outsideRoots: [] } })).catch(() => {});
        return { status: status === 'cancelled' ? 'killed' : 'failed', detail, result: detail };
      } finally {
        projectRulesOf.delete(task.id); rootsOf.delete(task.id); reviewEnvs.delete(task.id); baselineOf.delete(task.id);
        release?.();
        completions.delete(task.id);
      }
    })();
    completions.set(task.id, done);
    return { done, cancel(reason) { controller.abort(); runner?.cancel(reason); } };
  }

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_task',
    description: '任务使用派发时固定的权限和时间预算，三次重复拒绝或失败会暂停；续接不扩大权限。把一个编码任务交给本机的编码工具（Codex 或 Claude Code）在后台执行。监工替用户把关：凭据和硬规则禁止的破坏性操作直接拒绝；标准模式命令可联网，命令与额外权限按具体内容安全审核，不确定时询问用户；严格模式保留文件和网络沙箱。文件工具默认限任务目录，提问发给任务所属用户。你不需要参与审批。任务结束后你会收到 background job 完成通知，用 job_output 读取汇报后向用户总结。运行期间用户问进展时，用 coder_status 看它当前在做什么和最近几步再回答。要调整一个已经停下或结束的任务时，带 resume_task_id 续接它：编码工具接着原来的会话，记得之前做过什么。默认最多同时运行两个独立工作区的任务，可在编码工具设置中调整为 1–4 个，Codex 和 Claude Code 共用上限；同一目录、包含关系的目录或同一 Git 工作树串行，其他可执行任务按入队顺序调度（另有最多 10 个等待名额）；排队期间可以用 job_kill 取消。有前置任务时用 depends_on，只有前置任务执行成功且独立验证通过才启动。重启后任务标记中断，不自动重放。',
    parameters: {
      coder: { type: 'string', enum: ['codex', 'claude'], description: '执行任务的工具：codex 或 claude（Claude Code）。省略时用设置里的默认工具；续接时沿用原任务的工具。' },
      description: { type: 'string', required: true, description: '交给编码工具的完整任务说明，包括目标、约束和完成标准。续接时只写要调整或继续的内容，编码工具记得原来的任务。' },
      cwd: { type: 'string', required: true, description: '实际项目目录的绝对路径，必须位于配置的根目录之内；不存在时会创建。独立项目用项目本身目录，不用其父工作区。续接时必须与原任务相同。' },
      plan_step: { type: 'string', description: '说明单已保存步骤计划时必填。任务说明须与计划一致，验收项、验证命令及前置任务自动从计划取得；不能省略计划依赖。' },
      brief_id: { type: 'string', description: '关联 coder_brief 任务说明单；复杂或分阶段任务应关联同一说明单。续接默认沿用原说明单。' },
      brief_revision: { type: 'integer', description: '说明单当前版本，关联时必填，防止按过期目标执行。' },
      acceptance_ids: { type: 'array', items: { type: 'string' }, description: '本任务负责的说明单验收项 ID，例如 a1、a2，关联时必填。' },
      depends_on: { type: 'array', items: { type: 'string' }, description: '前置任务 ID 列表（最多 10 个，必须已派发且属于当前会话）。全部执行成功且独立验证通过才启动；失败、取消、中断或未验证都会阻止本任务。等待依赖不占执行名额。续接默认沿用原依赖；修复前置任务后须填新的任务 ID。' },
      retry_task_id: { type: 'string', description: '失败、取消或中断后的最新任务 ID；显式重试同一步骤。保留权限边界，有原生会话则续接，没有则重新启动。与 resume_task_id 互斥；不能重做已验证通过的步骤。' },
      resume_task_id: { type: 'string', description: '要续接的任务 ID（ct-xxxx），它必须已经停下、结束或因重启中断。用于用户叫停后要调整方向，或结束后要接着改：在原任务的编码工具会话里继续，而不是从头开始。' },
      verify_commands: { type: 'array', items: { type: 'string' }, description: '完整的独立验证命令列表（1 到 10 条），按顺序执行，每条单独审核，任一失败则停止；与 verify 二选一。覆盖验收所需的语法、逻辑和集成测试。' },
      verify_cwd: { type: 'string', description: '独立验证的项目子目录，相对 cwd 或绝对路径，必须仍在任务目录内。默认 cwd；多项目工作区必须明确绑定，不能依赖编码工具临时 cd。' },
      verify_network: { type: 'string', enum: ['offline', 'loopback', 'ask'], description: '标准模式独立验证默认 ask，严格模式默认 offline（断网）。Windows 仅支持 offline / ask，不支持隔离 loopback。本地服务与浏览器自检在 Linux 选 loopback：脚本须在同一次调用内启动服务和客户端，运行在独立回环网络中，不能访问宿主端口和外网，不需要联网审批。测试确实需要联网时选 ask，执行前向任务所属会话请求一次性批准。批准只对这条验证命令有效，可访问任意网络目标；仍限制文件写入，不继承密钥环境变量。拒绝则不执行验证，不回退到无隔离。' },
      verify: { type: 'string', description: '可选的验证命令，任务结束后由监工在工作目录独立执行，例如 "npm test"。任务的完成标准里写了要跑测试、构建、检查或跑通某条命令时，都要填上：监工自己跑一遍才算数，不填就只有编码工具自己说做完了。不经过 shell：只能是一条命令，第一个词是程序，其余按空格分成参数；不能用 &&、|、;、>、引号或 $()，要检查多件事就写一个脚本或 npm script。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        task_id: { type: 'string', required: true }, job_id: { type: 'string', required: true }, status: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `已派发编码任务 ${value.task_id}，后台 job ${value.job_id}，状态：${value.status}。排队中只表示受理时尚未启动，不能推断有其他任务占用；可能立即开始。任务结束时会收到 job 完成通知；当前动作和最近几步可用 coder_status 查看。` }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('coder_task 只能在会话中调用。');
      let effective = await runtime();
      const roots = effective.roots;
      const cwd = await canonical(args.cwd);
      if (ctx.sandboxPolicy?.resolve({ session: exec.agent.session }).mode === 'read-only') throw new Error('只读会话不能派发可写的编码任务。');
      if (!roots.some(root => isInside(root, cwd))) throw new Error(`工作目录必须位于以下根目录之内：${roots.join('、')}`);
      await mkdir(cwd, { recursive: true });
      if (!(await stat(cwd).catch(() => undefined))?.isDirectory()) throw new Error(`工作目录不存在：${cwd}`);
      const active = store.active();
      if (active.length + [...admitting].filter(id => !store.get(id)).length >= maxConcurrent + maxQueued) throw new Error('编码任务容量已满（含等待队列），请等待已有任务结束后重试；只能在所属会话中查看或停止自己的任务。');
      const taskId = `ct-${randomBytes(4).toString('hex')}`;
      admitting.add(taskId);
      let resumeKey: string | undefined;
      let planKey: string | undefined;
      try {
        if (args.resume_task_id && args.retry_task_id) throw new Error('resume_task_id 和 retry_task_id 不能同时填写。');
        const previousId = args.resume_task_id ?? args.retry_task_id;
        const previous = previousId ? store.get(previousId) : undefined;
        if (previousId) {
          if (!previous || previous.ownerSession !== exec.agent.id) throw new Error(`没有编码任务 ${previousId}。`);
          if (isActive(previous) || store.active().some(item => item.coder === previous.coder && item.coderSessionId && item.coderSessionId === previous.coderSessionId)) throw new Error('该编码会话已有运行或排队任务，请等待它结束。');
          if (args.retry_task_id) assertRetry(previous, store.list());
          if (!previous.coderSessionId && !args.retry_task_id) throw new Error(`任务 ${previous.id} 没有留下 ${CODER_NAMES[previous.coder]} 的会话，不能续接，请重新派发。`);
          if (resolve(previous.cwd) !== cwd) throw new Error(`续接必须在原任务的目录里：${previous.cwd}`);
          if (args.coder && args.coder !== previous.coder) throw new Error(`任务 ${previous.id} 用的是 ${CODER_NAMES[previous.coder]}，续接不能换工具。`);
          const key = `${previous.coder}:${previous.coderSessionId ?? previous.id}`;
          if (resuming.has(key)) throw new Error('该编码会话已有运行或排队任务，请等待它结束。');
          resuming.add(key);
          resumeKey = key;
        }
        const briefId = args.brief_id ?? previous?.brief?.id;
        if (!briefId && (args.brief_revision !== undefined || args.acceptance_ids !== undefined)) throw new Error('验收项和版本必须与 brief_id 一起填写。');
        if (previous?.brief && briefId !== previous.brief.id) throw new Error('续接不能切换任务说明单；新目标请重新派发。');
        if (previous?.planStep && args.plan_step && args.plan_step !== previous.planStep) throw new Error('续接不能切换计划步骤；下一步骤请重新派发。');
        if (args.plan_step && !briefId) throw new Error('plan_step 需要关联说明单。');
        const planned = briefId ? resolvePlanStep(briefs.get(briefId, exec.agent.id), args.plan_step ?? previous?.planStep, store.list(), previous?.id) : undefined;
        if (planned) {
          const key = `${briefId}:${briefs.get(briefId!, exec.agent.id).revision}:${planned.step.id}`;
          if (planning.has(key)) throw new Error('该计划步骤正在受理，请稍后查询。');
          planning.add(key); planKey = key;
          if (args.description !== planned.step.description) throw new Error('任务说明与计划不一致，请先修改计划或使用计划中的步骤说明。');
          if (args.verify !== undefined && args.verify !== planned.step.verify) throw new Error('不能覆盖计划的验证命令。');
          if (args.acceptance_ids && JSON.stringify([...new Set(args.acceptance_ids)].sort()) !== JSON.stringify([...planned.step.acceptance_ids].sort())) throw new Error('不能覆盖计划的验收项。');
        }
        const brief = briefId ? briefs.snapshot(briefId, exec.agent.id, args.brief_revision ?? previous?.brief?.revision,
          planned?.step.acceptance_ids ?? args.acceptance_ids ?? previous?.brief?.acceptance.map(item => item.id)) : undefined;
        const dependsOn = dependencyIds(planned ? [...planned.dependsOn, ...(args.depends_on ?? previous?.dependsOn?.filter(id => { const prior = store.get(id); return !args.retry_task_id || prior?.brief?.id !== briefId || prior?.brief?.revision !== brief?.revision || !planned.step.depends_on.includes(prior?.planStep ?? ''); }) ?? [])] : args.depends_on ?? previous?.dependsOn ?? [], exec.agent.id, id => store.get(id));
        if (dependsOn.some(id => isActive(store.get(id)!) && !completions.has(id))) throw new Error('前置任务尚未受理完成，请稍后重试。');
        const coder: CoderKind = previous ? previous.coder : args.coder === 'claude' || args.coder === 'codex' ? args.coder : effective.defaultCoder;
        if (previous && (previous.permissions?.securityMode ?? 'strict') !== effective.securityMode) effective = await runtime(previous.permissions?.securityMode ?? 'strict');
        const chosen = effective[coder];
        if ('error' in chosen) throw new Error(chosen.error);
        const prepared = await loadCoderRuntime(ctx, exec, chosen.env);
        effective = { ...effective, runtimeExecutables: prepared.executables, [coder]: { ...chosen, env: prepared.env } };
        reviewEnvs.set(taskId, prepared.env);
        const query = coder === 'claude' ? config.query ?? await loadClaudeQuery('sdkPath' in chosen ? chosen.sdkPath : undefined) : undefined;
        const permissions = await taskPermissions(cwd, roots, coder, previous?.permissions, effective.maxTaskMinutes, effective.allowedNetworkDomains, effective.autoApproveSafe, previous ? previous.permissions?.securityMode ?? 'strict' : effective.securityMode ?? 'standard');
        const now = Date.now();
        if (args.verify_commands && (args.verify !== undefined || planned)) throw new Error('verify_commands 与 verify 或计划步骤的验证不能同时填写；计划请使用统一验收脚本。');
        const suite = args.verify_commands;
        if (suite && (suite.length < 1 || suite.length > 10 || suite.some(command => !command.trim()))) throw new Error('独立验证列表需要 1 到 10 条非空命令。');
        const verify = suite?.[0] ?? planned?.step.verify ?? args.verify ?? previous?.verify;
        const verifyCommands = suite ? suite.slice(1) : args.verify !== undefined ? undefined : previous?.verifyCommands;
        const verifyCwd = await canonical(resolve(cwd, args.verify_cwd ?? previous?.verifyCwd ?? '.'));
        if (!isInside(cwd, verifyCwd)) throw new Error('验证目录必须位于任务目录内。');
        for (const command of verify ? [verify, ...(verifyCommands ?? [])] : []) {
          if (process.platform === 'win32') {
            windowsVerifyWords(command);
            if ((args.verify_network ?? previous?.verifyNetwork) === 'loopback') throw new Error('Windows 暂不支持与宿主隔离的回环验证；请选择 offline，或明确使用 ask 申请本次联网验证。');
          } else if (SHELL_SYNTAX.test(command)) throw new Error(`验证命令不经过 shell，只能是一条命令加空格分开的参数（如 npm test），不能用 &&、|、;、>、引号或 $()：${command}`);
        }
        const task: TaskRecord = { id: taskId, ...(planned ? { planStep: planned.step.id } : {}), ...(brief ? { brief } : {}), ...(dependsOn.length ? { dependsOn } : {}), coder, description: args.description, cwd, permissions,
          ...(verify ? { verify, ...(verifyCommands?.length ? { verifyCommands } : {}), verifyCwd, verifyNetwork: args.verify_network ?? previous?.verifyNetwork ?? (permissions.securityMode === 'standard' ? 'ask' : 'offline') } : {}), status: 'queued', ownerSession: exec.agent.id, createdAt: now, updatedAt: now,
          ...(previous ? { ...(previous.coderSessionId ? { coderSessionId: previous.coderSessionId, resumedFrom: previous.id } : {}), ...(args.retry_task_id ? { replaces: previous.id } : {}) } : {}), escalations: 0, decisions: [] };
        projectRulesOf.set(task.id, await projectRules(cwd, roots));
        rootsOf.set(task.id, permissions.writableRoots);
        await store.put(task);
        let jobId: string;
        try {
          jobId = ctx.jobs.start({ kind: 'coder', label: `${CODER_NAMES[coder]}: ${previous ? `续接 ${previous.id}：` : ''}${clip(args.description, 80)}`, owner: exec.agent.id,
            outputLimitBytes: OUTPUT_LIMIT_BYTES, run: job => queuedJob(task, query, effective, roots, job) });
        } catch (error) {
          projectRulesOf.delete(task.id);
          rootsOf.delete(task.id); reviewEnvs.delete(task.id);
          baselineOf.delete(task.id);
          await store.update(task.id, () => ({ status: 'failed', result: { summary: '', changedFiles: [], outsideRoots: [], detail: (error as Error).message } }));
          throw error;
        }
        const running = await store.update(task.id, () => ({ jobId }));
        return { task_id: task.id, job_id: jobId, status: taskStatusLabel(running) };
      } finally { if (!store.get(taskId)) reviewEnvs.delete(taskId); admitting.delete(taskId); if (resumeKey) resuming.delete(resumeKey); if (planKey) planning.delete(planKey); }
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_status',
    description: '查看编码任务的状态、当前动作、最近几步、升级次数、最近的决定和结果。不带 task_id 时列出最近的任务。',
    parameters: { task_id: { type: 'string', description: '任务 ID；省略时返回最近 5 个任务。' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('coder_status 只能在会话中调用。');
      if (args.task_id) {
        const task = store.get(args.task_id);
        if (!task || task.ownerSession !== exec.agent.id) throw new Error(`没有编码任务 ${args.task_id}。`);
        const lines = [`编码任务 ${task.id}：${taskStatusLabel(task)}（${CODER_NAMES[task.coder]}）`,
          ...(isActive(task) ? [runningFor(task)] : []),
          ...(currentActivity(task) ? [`当前：${currentActivity(task)}`] : []),
          `任务：${task.description}`,
          ...(task.planStep ? [`计划步骤：${task.planStep}`] : []),
          ...(task.brief ? [`任务说明单：${task.brief.id} v${task.brief.revision}；验收项：${task.brief.acceptance.map(item => item.id).join('、')}`] : []),
          ...(task.resumedFrom ? [`续接：${task.resumedFrom}`] : []), ...(task.dependsOn?.length ? [`前置任务（均需独立验证通过）：${task.dependsOn.join('、')}`] : []), `目录：${task.cwd}`,
          ...(task.jobId ? [`job：${task.jobId}`] : []), ...(task.coderSessionId ? [`${CODER_NAMES[task.coder]} 会话：${task.coderSessionId}`] : []),
          ...(task.status === 'waiting-user' && task.pending ? [`正在等待用户回答：${task.pending.summary}（${clock(task.pending.at)} 提出，用户在聊天渠道回复"允许/拒绝"或"回答 N"；等回答不是卡住，不要自行用 job_kill 中止，只有用户明确要停下整个任务时才用）`,
            ...(task.pending.detail ? [clip(task.pending.detail, 300)] : [])] : []),
          ...(task.trace?.length ? ['最近几步：', ...task.trace.slice(-TRACE_SHOWN).map(item => `- ${clock(item.at)} ${item.text}`)] : []),
          `升级给用户 ${task.escalations} 次，常规操作自动放行 ${task.autoAllowed ?? 0} 次`, ...task.decisions.slice(-10).map(describeDecision),
          ...(task.result ? ['', `结果：${task.result.summary || ''}`, ...(task.result.detail ? [`执行说明：${task.result.detail}`] : []), ...(task.stopReason ? [`停止原因：${task.stopReason}`] : []),
            `改动文件 ${task.result.changedFiles.length} 个${task.result.verification === 'not-run' || task.result.verifyOk === undefined ? '，尚未独立验证' : task.result.verifyOk ? '，验证通过' : '，验证失败'}`] : [])];
        return { text: lines.join('\n') };
      }
      const tasks = store.list().filter(task => task.ownerSession === exec.agent!.id).slice(0, 5);
      return { text: tasks.length ? tasks.map(task => `${task.id} ${taskStatusLabel(task)} [${CODER_NAMES[task.coder]}] — ${clip(task.description, 80)}${task.status === 'waiting-user' && task.pending ? `\n  等待用户回答：${task.pending.summary}` : ''}${currentActivity(task) ? `\n  当前：${currentActivity(task)}` : ''}`).join('\n') : '还没有编码任务。' };
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_steer',
    description: '在 Codex 任务运行中把用户的调整转给它，不停下任务：默认并入当前这一回合，Codex 下一步就会看到；interrupt 为 true 时先打断正在做的事（包括正在跑的命令），再以这段话开始下一回合，上下文都保留。用户在任务运行中说“改成……”“别做……了”“先做……”时用。Claude Code 任务不支持，改用 job_kill 停下再用 coder_task 带 resume_task_id 续接。',
    parameters: {
      message: { type: 'string', required: true, description: '转给编码工具的话，写清楚要改什么，按用户原意，不要扩大。' },
      task_id: { type: 'string', description: '任务 ID；省略时用正在运行的那个任务。' },
      interrupt: { type: 'boolean', description: '是否先打断正在做的事。用户说“停一下”“马上改”，或者它正在做的事本身就要作废时为 true；只是补充要求时省略。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('coder_steer 只能在会话中调用。');
      if (ctx.sandboxPolicy?.resolve({ session: exec.agent.session }).mode === 'read-only') throw new Error('只读会话不能调整编码任务。');
      const message = args.message.trim();
      if (!message) throw new Error('message 不能为空。');
      const task = args.task_id ? store.get(args.task_id) : store.active().find(task => task.ownerSession === exec.agent!.id && task.status !== 'queued');
      if (!task || task.ownerSession !== exec.agent.id) throw new Error(args.task_id ? `没有编码任务 ${args.task_id}。` : '现在没有运行中的编码任务。');
      if (task.status === 'queued') throw new Error('任务仍在排队；要修改任务说明，请先用 job_kill 取消，再重新派发。');
      if (task.coder === 'claude') throw new Error('Claude Code 任务不支持运行中插话。用 job_kill 停下，再用 coder_task 带 resume_task_id 续接，Claude Code 会接着原来的会话。');
      const live = liveOf.get(task.id);
      if (!live?.steer || task.status === 'verifying' || !isActive(task)) throw new Error(`任务 ${task.id} 现在是“${STATUS_LABEL[task.status]}”，编码工具已经停下。要接着改，用 coder_task 带 resume_task_id 续接。`);
      const interrupt = args.interrupt === true;
      if (interrupt && task.status === 'waiting-user') {
        throw new Error(`任务 ${task.id} 正在等用户回答：${task.pending?.summary ?? ''}。先让用户回答（或拒绝）这条请求再打断；不打断的调整现在就能发，Codex 会在这条请求答完后看到。`);
      }
      await live.steer(message, interrupt);
      live.record(`${interrupt ? '用户打断' : '用户补充'}：${oneLine(message, 100)}`);
      return { text: interrupt ? `已打断 Codex 正在做的事，这段话会作为下一回合的开始（任务 ${task.id}）。`
        : task.status === 'waiting-user' ? `已转给 Codex（任务 ${task.id}）。它正在等用户回答“${task.pending?.summary ?? ''}”，答完之后会看到这段话。`
          : `已转给 Codex（任务 ${task.id}），它下一步就会看到。` };
    },
  })));

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_rules',
    description: '查看、添加或删除编码监工的习惯规则。常规操作本来就自动放行，规则用来收紧或代答：deny 直接拒绝某类操作，answer 用固定答案回答提问。规则只在硬规则之后生效，放不开 git push、sudo、写任务目录之外、凭据文件等硬规则升级或拒绝的操作。用户说"不许 X"时添加 deny 规则，"问到 X 就回答 Y"时添加 answer 规则；用户问有哪些规则时用 list。',
    parameters: {
      action: { type: 'string', enum: ['list', 'add', 'remove'], required: true, description: 'list 列出全部规则；add 添加；remove 按 id 删除。' },
      decision: { type: 'string', enum: [...RULE_DECISIONS], description: 'add 时必填。deny 拒绝，answer 只用于 question。' },
      kind: { type: 'string', enum: [...HABIT_KINDS], description: 'add 时必填：command 命令、file-write 写文件、file-read 读文件、question 提问、other 其他工具。' },
      pattern: { type: 'string', description: 'add 时必填。command：命令开头的词，如 "npm test"、"git commit"，匹配以这些词开头的命令；file-write/file-read：相对任务目录的路径 glob，如 "src/**"、"docs/*.md"；question：问题里出现的关键字；other：工具名。' },
      answer: { type: 'string', description: 'answer 规则的固定答案。' },
      note: { type: 'string', description: '用户的原话或理由，便于以后查看。' },
      id: { type: 'string', description: 'remove 时必填，规则 id（cr-xxxx）。' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('coder_rules 只能在会话中调用。');
      if (args.action !== 'list' && ctx.sandboxPolicy?.resolve({ session: exec.agent.session }).mode === 'read-only') throw new Error('只读会话不能修改编码规则。');
      if (args.action === 'list') {
        const rules = store.rules();
        return { text: rules.length ? ['当前习惯规则（按匹配顺序）：', ...rules.map(rule => `- ${describeRule(rule)}`),
          '项目 AGENTS.md 或 CLAUDE.md 里 ```coder-rules 块中的规则在任务派发时读取，不在此列出。'].join('\n') : '还没有习惯规则。项目 AGENTS.md 或 CLAUDE.md 里 ```coder-rules 块中的规则在任务派发时读取。' };
      }
      if (args.action === 'remove') {
        if (!args.id) throw new Error('remove 需要规则 id。');
        const rule = store.rules().find(item => item.id === args.id);
        if (!rule || !(await store.removeRule(args.id))) throw new Error(`没有规则 ${args.id}。`);
        return { text: `已删除规则：${describeRule(rule)}` };
      }
      const kind = args.kind as HabitKind | undefined;
      const decision = RULE_DECISIONS.find(item => item === args.decision);
      const pattern = args.pattern?.trim() ?? '';
      if (!kind || !HABIT_KINDS.includes(kind) || !decision || !pattern) throw new Error('add 需要 kind、decision 和 pattern。');
      if ((decision === 'answer') !== (kind === 'question')) throw new Error('question 只能用 answer 规则，其他类型只能用 deny。');
      const answer = args.answer?.trim();
      if (decision === 'answer' && !answer) throw new Error('answer 规则需要 answer。');
      if (kind === 'command' && (tokens(pattern).length === 0 || isOpaque(pattern))) throw new Error('命令规则要写命令开头的词，不能包含 shell 转发、eval、$() 这类无法判断内容的写法。');
      const { rule, existed } = await store.addRule({ kind, pattern, decision, ...(answer ? { answer } : {}), ...(args.note?.trim() ? { note: args.note.trim() } : {}) });
      return { text: `${existed ? '已有相同规则' : '已添加规则'}：${describeRule(rule)}` };
    },
  })));

  config.registerRpc?.('nexus-coder-tasks', ['get'], async (_method, payload) => {
    const { id, brief } = (payload && typeof payload === 'object' ? payload : {}) as { id?: unknown; brief?: unknown };
    const task = typeof id === 'string' ? store.get(id) : undefined;
    if (!task) throw new ChannelError('task_not_found');
    const effective = brief === true ? undefined : await runtime();
    const homes = !effective ? { codex: [], claude: [] } : coderHomes({ ...('error' in effective.codex ? {} : { codex: effective.codex.env }), ...('error' in effective.claude ? {} : { claude: effective.claude.env }) });
    return {
      id: task.id, coder: task.coder, coderName: CODER_NAMES[task.coder], status: task.status, statusLabel: taskStatusLabel(task), active: isActive(task),
      description: task.description, ...(task.brief ? { brief: task.brief } : {}), ...(task.planStep ? { planStep: task.planStep } : {}), cwd: task.cwd, ...(task.permissions ? { permissionDescription: permissionSummary(task.permissions) } : {}), ...(task.stopReason ? { stopReason: task.stopReason } : {}), createdAt: task.createdAt, updatedAt: task.updatedAt,
      ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}),
      ...(task.resumedFrom ? { resumedFrom: task.resumedFrom } : {}), ...(isActive(task) ? { runningFor: runningFor(task) } : {}),
      ...(currentActivity(task) ? { activity: currentActivity(task)! } : {}),
      ...(task.status === 'waiting-user' && task.pending ? { pending: { at: task.pending.at, summary: task.pending.summary, ...(task.pending.detail ? { detail: task.pending.detail } : {}) } } : {}),
      escalations: task.escalations, autoAllowed: task.autoAllowed ?? 0, decisions: task.decisions.map(describeDecision), trace: task.trace ?? [],
      ...(task.result ? { result: task.result } : {}),
      // The task card polls for status only; the panel asks for the coder's own log too.
      transcript: brief === true ? { entries: [] } : await taskTranscript(task, homes),
    } satisfies TaskDetailView;
  });

  installCoderPackaging(ctx, () => store.list(), currentRoots);

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'nexus:coders',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS') + 1,
    text: () => `当用户要求实现、修改或修复一个代码项目，而不是让你直接回答时，用 coder_task 把任务派给本机的编码工具（默认 ${CODER_NAMES[currentDefault()]}，用户指名时用 coder 参数选择），工作目录只能在这些根目录之内：${currentRoots().join('、')}。当前实例最多同时执行 ${maxConcurrent} 个编码任务，Codex 与 Claude Code 共用名额；独立工作区可并行，同一目录或同一 Git 工作树仍需排队。排队原因未被工具确认时，不要说正在等待其他任务；状态出现无新动作时，先如实报告无动作时长，再注明最后记录，不能把历史动作说成当前正在做的事。复杂或分阶段需求先用 coder_brief 记录用户目标、已明确的约束和可核验的验收项；能从项目查清的信息自己调查，仅关键歧义才问用户，不要求每次确认。已有原生 goal 时保持其目标一致，不另建目标生命周期或自动改变原生 goal 状态。拆分后先用 coder_brief plan 保存完整步骤，每步声明负责的验收项、前置步骤和验证命令，修正工具报告的遗漏或循环。按返回的依赖顺序，用 plan_step 派发步骤；程序会从持久任务记录解析前置任务 ID。结构检查不能代替语义判断，不要把未声明的真实依赖当作不存在。派发关联 brief_id、brief_revision 和本任务负责的 acceptance_ids，把共同约束传给编码工具。用户问整体进度、或收到关联任务完成通知后，用 coder_brief get 汇总全部验收项；未覆盖、失败和未验证的项必须明确报告，不把单个任务完成当作整个需求完成。派发后立即按工具返回的状态告知用户：排队中表示尚未启动，运行中才表示已经开跑，不要等待任务结束。多个任务存在前后依赖时，显式填写 depends_on，只能引用本会话已派发的任务；前置任务必须执行成功且独立验证通过，否则后续任务不会启动。不要因依赖失败而自动去掉依赖重新派发。任务说明里的完成标准要求跑测试、构建、检查或跑通某条命令时，派发时将完整验收写进 verify_commands（多条命令）或 verify（统一验收脚本）；不要仅检查某一个文件的语法就代替完整项目验收；标准模式验证默认申请联网，由 DSH 审核具体命令；严格模式验证默认断网，需要联网时设置 verify_network=ask。不能把标准模式描述成操作系统强隔离。监工会在任务结束后自己跑一遍；Windows 命令无输出且退出码为 3221225794 / 0xC0000142 时，应报告原生进程初始化失败，不要靠更换解释器反复重试或声称测试已执行；验证通过只代表指定命令通过，不代表所有业务需求已验收；不写 verify 的任务只有编码工具自己说做完了，你也只能这样转述。多文件交付用 coder_package 明确选择入口及其全部资源并生成 zip，再 present 此 zip；不能只发送 HTML 后声称可独立运行。编码工具需要确认的操作由监工处理，你不参与：凭据和硬规则禁止的破坏性命令直接拒绝；额外权限先核验具体范围，未获安全授权的请求和编码工具提问升级给用户，其余常规操作自动放行并记录。启用安全操作自动审核时，DSH 会对具体命令和额外请求调用本会话模型审核，安全且非破坏性的请求直接授权；理由留在任务记录，审核失败或不确定仍询问用户。主助手不要冒充用户回答审批。任务运行期间用户问进展，用 coder_status 查看当前动作和最近几步再回答，只转述记录到的内容，不要推测它进行到了哪个阶段，也不要说还没记录到的事已经发生（比如文件已写好）。用户在任务运行中要调整方向时：Codex 任务用 coder_steer 把用户的话转过去，不用停下；Claude Code 任务或用户要整个停下时用 job_kill（"拒绝"只否决眼前这一步，编码工具会继续）；任务只是在等用户回答时不要自行停下。停下后用 coder_task 带 resume_task_id 续接原任务，description 只写用户要调整的内容，编码工具接着原来的会话、记得之前做过什么；已经结束或因重启中断的任务要接着改，也这样续接。用户明确要换个思路从头来时才不带 resume_task_id。用户说禁止某类操作、或问到某事就固定回答时，用 coder_rules 添加规则（${Object.entries(KIND_LABEL).map(([kind, label]) => `${kind} 是${label}`).join('，')}；${RULE_DECISIONS.map(decision => `${decision} 是${DECISION_LABEL[decision]}`).join('，')}；常规操作本来就放行，不需要 allow 规则），用户问有哪些规则时用 coder_rules list。相同目标版本下已回答的相同澄清问题会复用，权限审批仍逐次进行。同一会话的提问顺序显示；等待回答不消耗执行预算，超过等待时限会暂停任务，避免无限占用队列。用户在执行中修改目标时，先用 coder_brief impact 说明受影响步骤，再用 amend 停止旧版活动任务并保存新版本；两种编码工具使用同一入口。修改后再按新版本派发，不能让旧版继续执行。工作目录必须用实际项目目录，新项目可直接指定尚不存在的子目录，系统会创建。验证默认在该目录执行；多项目时用 verify_cwd 绑定子目录，不依赖编码工具临时 cd。本地浏览器验证应写成自带服务启动和关闭的脚本；Linux 通过 nexus_web.local_check 运行，或 verify_network=loopback 作最终验证。Windows 不支持隔离 loopback，需要本机服务时显式用 verify_network=ask 申请本次联网验证。不要逐条申请运行宿主开发服务器、浏览器和测试连接。步骤失败时先用 coder_brief recover 查看恢复清单，保留已验证通过的独立步骤；只对需要恢复的最新任务用 retry_task_id，不从头重跑整套计划。整体交付时用 coder_brief delivery 查看逐项检查、业务验收和文件提交清单；业务效果需要用户确认时用 review 对具体验收项提问，不能把模型自述登记为用户验收。收到 coder job 的完成通知后，用 job_output 读取汇报，再用两三句话向用户总结：做了什么、改了哪些文件、验证是否通过、替用户决定或被拒绝了什么。`,
  }));

  return store;
}
