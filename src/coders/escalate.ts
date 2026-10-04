import type { Agent } from '@deepseek-ai/dsh-agent';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import { CODER_NAMES, type CoderDecision, type CoderRequest, type DecisionRecord, type TaskRecord } from './types.js';

/** The two native services an escalation needs; narrowed so tests can fake them. */
export interface EscalationHost {
  resolveAgent(sessionId: SessionId): Promise<{ readonly agent: Agent } | { readonly error: unknown }>;
  ask(request: { questions: AskUserQuestionItem[]; agent?: Agent; signal?: AbortSignal }): Promise<AskUserQuestionAnswer>;
}

export interface EscalationOutcome {
  decision: CoderDecision;
  record: DecisionRecord;
  /** The owner session has no live agent: the task cannot reach the user. */
  unreachable?: true;
}

const DETAIL_LIMIT = 1500;

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;
}

function approvalQuestion(task: TaskRecord, request: CoderRequest, reason: string | undefined): AskUserQuestionItem {
  const detail = [`任务：${clip(task.description, 200)}`, reason ? `原因：${reason}` : undefined,
    request.detail ? `详情：\n${clip(request.detail, DETAIL_LIMIT)}` : undefined].filter(Boolean).join('\n');
  return { id: 'approve', header: `编码任务 ${task.id}`, question: `${CODER_NAMES[task.coder]} 请求：${request.summary}`, detail,
    options: [{ label: '允许', description: request.tool === 'codex.permissions' ? '仅当前回合的上述权限，不延续到续接任务' : '仅本次' }, { label: '拒绝' }] };
}

function coderQuestions(task: TaskRecord, request: CoderRequest): AskUserQuestionItem[] {
  return (request.questions ?? []).map((question, index) => ({
    id: String(index), header: question.header ?? `编码任务 ${task.id} 提问`, question: question.question,
    ...(question.options.length ? { options: question.options } : {}),
    ...(question.multiSelect ? { multiSelect: true } : {}),
  }));
}

/**
 * Last decision layer: ask the human through the native user-questions
 * service. The channel bridge turns it into the same "回答 1" prompt used for
 * native questions, so the user answers from WeChat.
 */
export async function escalateToUser(host: EscalationHost, task: TaskRecord, request: CoderRequest,
  signal: AbortSignal, reason?: string): Promise<EscalationOutcome> {
  const base = { at: Date.now(), kind: request.kind, summary: request.summary, layer: 'user' as const };
  const found = await host.resolveAgent(task.ownerSession as SessionId).catch(error => ({ error }));
  if ('error' in found) {
    return { unreachable: true, decision: { behavior: 'deny', message: '无法联系用户，任务中断。', interrupt: true },
      record: { ...base, outcome: 'deny', reason: '派发任务的会话不可用' } };
  }
  const questions = request.kind === 'question' ? coderQuestions(task, request) : [approvalQuestion(task, request, reason)];
  if (questions.length === 0) return { decision: { behavior: 'deny', message: '提问内容为空。' }, record: { ...base, outcome: 'deny', reason: '提问内容为空' } };
  let answer: AskUserQuestionAnswer;
  try {
    signal.throwIfAborted();
    answer = await host.ask({ questions, agent: found.agent, signal });
  }
  catch (error) {
    const aborted = signal.aborted;
    return { decision: { behavior: 'deny', message: aborted ? '任务已取消。' : '用户未能回答，本次操作未执行。', interrupt: aborted },
      record: { ...base, outcome: 'deny', reason: aborted ? '任务取消' : `提问失败：${(error as Error)?.message ?? String(error)}` } };
  }
  if (request.kind !== 'question') {
    const choice = answer.answers.find(item => item.id === 'approve');
    const custom = choice?.custom?.trim() ?? '';
    const allowed = choice?.selected.includes('允许') || /^(允许|同意|是|yes|y)$/i.test(custom);
    if (!allowed) return { decision: { behavior: 'deny', message: '用户拒绝了这次操作。' }, record: { ...base, outcome: 'deny', reason: '用户拒绝' } };
    return { decision: { behavior: 'allow' }, record: { ...base, outcome: 'allow', ...(reason ? { reason } : {}) } };
  }
  const answers: Record<string, string> = {};
  for (const [index, question] of (request.questions ?? []).entries()) {
    const item = answer.answers.find(entry => entry.id === String(index));
    const value = item ? [...item.selected, ...(item.custom ? [item.custom] : [])].join(', ') : '';
    answers[question.question] = value;
  }
  return { decision: { behavior: 'allow', updatedInput: { ...request.raw, answers } },
    record: { ...base, outcome: 'answer', reason: Object.values(answers).join(' | ').slice(0, 200) } };
}
