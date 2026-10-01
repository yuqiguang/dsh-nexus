import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { DEFAULT_TIME_ZONE } from '../assistant/settings.js';
import { formatLocal } from '../assistant/clock.js';
import type {} from '@deepseek-ai/dsh-user-approval';
import { describeToolCall } from './describe.js';

/** What a session was doing when its log stopped inside a turn: the process died before the turn could end. */
export interface InterruptedWork {
  turn: number;
  startedAt: number;
  /** Operations that were waiting for the user's approval, one line each. */
  approvals: string[];
  /** Questions that were waiting for the user's answer. */
  questions: string[];
  /** Tool calls that had started and whose outcome is unknown. */
  inFlight: string[];
}

function questionsOf(args: string): string[] {
  try {
    const parsed = JSON.parse(args) as { questions?: { question?: unknown }[] };
    return (parsed.questions ?? []).flatMap(item => typeof item?.question === 'string' ? [item.question] : []);
  } catch { return []; }
}

/** Result codes crash repair gives the tool calls it closes; such a result is not an outcome. */
const REPAIR_CODES = new Set(['TOOL_OUTCOME_UNKNOWN', 'TOOL_NOT_STARTED']);

/**
 * Read a log the way crash repair does, but for the user: the turn the process
 * died in (still open, or already closed by repair with reason `interrupted`),
 * the approval that never got its decision, the question that never got its
 * answer, and the tool calls that never got a real result. `undefined` when
 * the log ends after a turn that ended on its own.
 */
export function interruptedWork(events: readonly SessionEvent[]): InterruptedWork | undefined {
  const boundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
  if (!boundary || (boundary.type === 'turn/end' && boundary.data.reason.kind !== 'interrupted')) return undefined;
  const turn = boundary.data.turn;
  const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn);
  const opener = events[start];
  if (!opener || opener.type !== 'turn/start') return undefined;
  const calls = new Map<string, { name: string; arguments: string }>();
  const results = new Set<string>();
  const asked = new Map<string, { toolName: string; callId?: string }>();
  for (const event of events.slice(start)) {
    if (event.type === 'assistant/message') {
      for (const block of event.data.message.content) if (block.type === 'tool-call') calls.set(String(block.id), { name: block.name, arguments: block.arguments });
    } else if (event.type === 'tool/call') {
      calls.set(String(event.data.callId), { name: event.data.name, arguments: event.data.arguments });
    } else if (event.type === 'tool/result') {
      if (!REPAIR_CODES.has(event.data.error?.code ?? '')) results.add(String(event.data.message.source.callId));
    } else if (event.type === 'approval/asked') {
      asked.set(event.data.id, { toolName: event.data.toolName, ...(event.data.callId ? { callId: String(event.data.callId) } : {}) });
    } else if (event.type === 'approval/decided') {
      asked.delete(event.data.id);
    }
  }
  const approvals: string[] = [];
  const awaitingApproval = new Set<string>();
  for (const { toolName, callId } of asked.values()) {
    const call = callId ? calls.get(callId) : undefined;
    approvals.push(call ? describeToolCall(call) : toolName);
    if (callId) awaitingApproval.add(callId);
  }
  const questions: string[] = [];
  const inFlight: string[] = [];
  for (const [callId, call] of calls) {
    if (results.has(callId) || awaitingApproval.has(callId)) continue;
    if (call.name === 'ask_user_question') questions.push(...questionsOf(call.arguments));
    else inFlight.push(describeToolCall(call));
  }
  return { turn, startedAt: opener.time, approvals, questions, inFlight };
}

/** The message the user gets after a restart cut a turn short, so they know what was pending and how to go on. */
export function interruptedNotice(work: InterruptedWork, timeZone = DEFAULT_TIME_ZONE): string {
  const lines = [`服务重启打断了上一轮（${formatLocal(work.startedAt, timeZone)} 开始）。`];
  for (const item of work.approvals) lines.push(`当时在等你审批：${item}`);
  for (const item of work.questions) lines.push(`当时在等你回答：${item}`);
  for (const item of work.inFlight) lines.push(`执行中被打断、结果未知：${item}`);
  lines.push(work.approvals.length || work.questions.length || work.inFlight.length
    ? '这些操作都没有完成。回复“继续”让我接着处理，或直接提出新的要求。'
    : '回复“继续”让我接着处理，或直接提出新的要求。');
  return lines.join('\n');
}
