import { isActive, type TaskRecord } from './types.js';

export const TIMING_PHASES = ['queue', 'execution', 'review', 'user', 'verification', 'retry'] as const;
export type TimingPhase = typeof TIMING_PHASES[number];
/** Mutually exclusive observed wall-clock phases, not provider inference time. */
export interface TaskTiming {
  since: number;
  phase?: TimingPhase;
  ms: Record<TimingPhase, number>;
  reviews: number;
  retries: number;
}
function phase(task: TaskRecord): TimingPhase | undefined {
  if (!isActive(task)) return undefined;
  if (task.status === 'queued') return 'queue';
  if (task.status === 'waiting-user') return 'user';
  if (task.reviewDepth) return 'review';
  if (task.status === 'verifying') return 'verification';
  if (task.retry?.phase === 'waiting') return 'retry';
  return 'execution';
}
export function initialTiming(task: TaskRecord, now = task.createdAt): TaskTiming {
  return { since: now, phase: phase(task), ms: { queue: 0, execution: 0, review: 0, user: 0, verification: 0, retry: 0 }, reviews: 0, retries: 0 };
}
/** Legacy tasks remain unmeasured; never fabricate durations from old activity messages. */
export function advanceTiming(previous: TaskRecord, next: TaskRecord, now: number): TaskTiming | undefined {
  if (!previous.timing) return undefined;
  const timing = { ...previous.timing, ms: { ...previous.timing.ms } };
  if (timing.phase) timing.ms[timing.phase] += Math.max(0, now - timing.since);
  timing.since = Math.max(now, timing.since);
  timing.phase = phase(next);
  if ((next.reviewDepth ?? 0) > (previous.reviewDepth ?? 0)) timing.reviews++;
  if (next.retry?.phase === 'waiting' && (previous.retry?.phase !== 'waiting' || next.retry.source !== previous.retry.source || next.retry.attempt !== previous.retry.attempt)) timing.retries++;
  return timing;
}
export function timingSummary(task: TaskRecord, now = Date.now()): string {
  const timing = advanceTiming(task, task, now);
  if (!timing) return '耗时分项：历史任务未记录。';
  const labels: Record<TimingPhase, string> = { queue: '排队', execution: '执行（含工具）', review: '自动审核（含审核排队）', user: '等待用户（含提问排队）', verification: '验证/收集改动', retry: '重试等待' };
  return `耗时分项：${TIMING_PHASES.map(key => `${labels[key]} ${(timing.ms[key] / 1000).toFixed(1)} 秒`).join('；')}。审核请求 ${timing.reviews} 次，观察到重试 ${timing.retries} 次。各项为互斥阶段耗时，不代表纯模型推理时间。`;
}
