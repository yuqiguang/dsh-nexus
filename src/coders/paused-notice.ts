import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { TaskRecord } from './types.js';

const READ_TOOLS = new Set(['read', 'glob', 'grep', 'file_find', 'job_list', 'job_output', 'coder_status']);

/** Inspect native provenance only; this does not reconstruct a conversation or alter task/session state. */
export function pausedNoticeTask(owner: string, events: readonly SessionEvent[], tasks: readonly TaskRecord[]): TaskRecord | undefined {
  const start = events.findLastIndex(event => event.type === 'turn/start');
  if (start < 0) return;
  const turn = events.slice(start);
  return tasks.find(task => task.ownerSession === owner && task.stopCause === 'user-wait-timeout' && task.status === 'interrupted'
    && !tasks.some(next => next.ownerSession === owner && (next.resumedFrom === task.id || next.replaces === task.id))
    && turn.some(event => event.type === 'user/message' && (event.data.source as { kind: string }).kind === 'tool-jobs'
      && (event.seq === task.completionNotice?.seq || String((event.data.source as { summary?: string }).summary ?? '').includes(`[${task.id}]`)))
    && !turn.some(event => event.type === 'user/message' && event.data.source.kind === 'user'
      && event.time >= (task.userWaitTimeout?.endedAt ?? task.updatedAt)
      && !String((event.data.source as { rpcId?: unknown }).rpcId ?? '').includes('-hook-')));
}

export function pausedNoticeRead(exec: Pick<ToolExecution, 'name' | 'arguments'>): boolean {
  if (READ_TOOLS.has(exec.name)) return true;
  const args = exec.arguments as { action?: unknown; command?: unknown } | undefined;
  if (exec.name === 'coder_brief') return ['get', 'list', 'delivery', 'recover', 'impact'].includes(String(args?.action));
  if (exec.name === 'str_replace_editor') return args?.command === 'view';
  // run_code subcalls traverse the same public pipeline; the outer container cannot authorize its children.
  return exec.name === 'run_code';
}

export function pausedNoticeReason(task: TaskRecord): string {
  return `任务 ${task.id} 因等待用户超时暂停，本次后台通知只读取状态与现有证据并汇报。未执行本次操作；不能改用主会话命令、修改文件或重新派发来继续待确认工作。等待用户明确续接后，按原任务权限恢复，保留原审批和验收记录。`;
}

export function installPausedNoticeGuard(ctx: Context, tasks: () => TaskRecord[]): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.agent || pausedNoticeRead(exec)) return next();
    const task = pausedNoticeTask(exec.agent.id, exec.agent.session.snapshotEvents(), tasks());
    return task ? { kind: 'deny', reason: pausedNoticeReason(task) } : next();
  });
}
