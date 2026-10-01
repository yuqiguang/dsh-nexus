import { createHash } from 'node:crypto';
import type { CoderBrief } from './brief.js';
import { dependencyPassed } from './dependencies.js';
import { isActive, type TaskRecord } from './types.js';

export interface AcceptanceReview { criterion: string; evidence: string; accepted: boolean; note: string; at: number }

export function briefTasks(brief: CoderBrief, records: TaskRecord[]): TaskRecord[] {
  const tasks = records.filter(task => task.ownerSession === brief.ownerSession && task.brief?.id === brief.id && task.brief.revision === brief.revision);
  const replaced = new Set(tasks.map(task => task.replaces ?? task.resumedFrom).filter(Boolean));
  return tasks.filter(task => !replaced.has(task.id));
}

export function criterionEvidence(brief: CoderBrief, records: TaskRecord[], criterion: string) {
  if (!brief.acceptance.some(item => item.id === criterion)) throw new Error('验收项不存在。');
  const tasks = briefTasks(brief, records).filter(task => task.brief!.acceptance.some(item => item.id === criterion)).sort((a, b) => a.id.localeCompare(b.id));
  const evidence = createHash('sha256').update(JSON.stringify({ revision: brief.revision, criterion, tasks: tasks.map(task => ({ id: task.id,
    status: task.status, updatedAt: task.updatedAt, verify: task.verify, result: task.result })) })).digest('hex');
  return { tasks, evidence, checked: tasks.length > 0 && tasks.every(dependencyPassed), settled: tasks.length > 0 && tasks.every(task => !isActive(task)) };
}

export function deliveryReport(brief: CoderBrief, records: TaskRecord[]): string {
  const tasks = briefTasks(brief, records);
  let accepted = 0, checked = 0;
  const lines = brief.acceptance.map(item => {
    const state = criterionEvidence(brief, records, item.id);
    const review = brief.reviews?.find(review => review.criterion === item.id && review.evidence === state.evidence);
    if (review?.accepted) accepted++;
    if (state.checked) checked++;
    return `- ${item.id} ${item.text}：检查${state.checked ? '通过' : '未全部通过'}；业务验收${review ? review.accepted ? '用户已确认' : '用户未接受' : '待确认'}${review?.note ? `（${review.note}）` : ''}；任务 ${state.tasks.map(task => task.id).join('、') || '未安排'}`;
  });
  const files = [...new Set(tasks.flatMap(task => task.result?.changedFiles ?? []))].sort();
  const commits = [...new Set(tasks.flatMap(task => task.result?.commits ?? []))];
  const active = tasks.some(isActive);
  const complete = accepted === brief.acceptance.length && checked === brief.acceptance.length && !active;
  return [`目标交付 ${brief.id} v${brief.revision}：${complete ? '检查与业务验收均通过' : active ? '仍有任务未结束' : '尚未完成全部验收'}`,
    `目标：${brief.objective}`, `检查通过 ${checked}/${brief.acceptance.length}，用户验收 ${accepted}/${brief.acceptance.length}`, ...lines,
    `改动文件 ${files.length} 个：`, ...files.slice(0, 100).map(file => `- ${file}`), ...(files.length > 100 ? ['其余文件请查看对应任务结果。'] : []),
    `任务期间观察到的 Git 提交 ${commits.length} 个：`, ...commits.slice(0, 50).map(commit => `- ${commit}`),
    '业务验收来自用户对具体验收项的回答；任务验证通过不自动等于业务验收通过。'].join('\n');
}
