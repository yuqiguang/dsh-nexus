import type { TaskRecord } from './types.js';

export function taskStatusLabel(task: Pick<TaskRecord, 'status' | 'result' | 'retry'>): string {
  if (task.status === 'running' && task.retry?.phase === 'waiting') return task.retry.source === 'tool' ? '编码工具重试中' : '等待自动续接';
  if (task.status === 'running' && task.retry?.phase === 'resuming') return '正在恢复原会话';
  if (task.result?.verification === 'failed' && (task.status === 'completed' || task.status === 'failed')) return '执行结束，验证失败';
  if (task.status === 'completed') return task.result?.verification === 'passed' && task.result.verifyOk === true
    ? '执行结束，验证通过' : '执行结束，尚未独立验证';
  return { queued: '排队中', running: '运行中', 'waiting-user': '等待用户回答', verifying: '验证中',
    failed: '失败', cancelled: '已取消', interrupted: '已中断' }[task.status];
}
