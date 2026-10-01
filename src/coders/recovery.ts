import type { CoderBrief } from './brief.js';
import { briefTasks } from './delivery.js';
import { dependencyPassed } from './dependencies.js';
import { isActive, type TaskRecord } from './types.js';

export function recoveryReport(brief: CoderBrief, records: TaskRecord[]): string {
  const tasks = briefTasks(brief, records);
  const lines = [`恢复清单 ${brief.id} v${brief.revision}（不会自动执行）`];
  for (const step of brief.plan ?? []) {
    const task = tasks.find(task => task.planStep === step.id);
    const dependencies = step.depends_on.map(id => tasks.find(task => task.planStep === id));
    const state = task && dependencyPassed(task) ? '保留已通过的结果，无需重做' : task && isActive(task) ? '仍在执行或等待，先查看状态' : dependencies.some(task => !task || !dependencyPassed(task))
      ? '前置步骤尚未通过，暂不重试' : task ? `可重试：retry_task_id=${task.id}` : '可首次派发';
    lines.push(`${step.id}：${state}；任务说明：${step.description}${task?.stopReason ? `；停止原因：${task.stopReason}` : task?.result?.detail ? `；执行说明：${task.result.detail}` : ''}`);
  }
  if (!brief.plan) for (const task of tasks) lines.push(`${task.id}：${dependencyPassed(task) ? '保留已通过结果' : isActive(task) ? '仍在执行或等待' : '可检查后显式重试'}；${task.result?.detail || task.stopReason || task.result?.summary || ''}`);
  lines.push('重试保留原任务与审批历史，不继承一次性授权；下游步骤须显式重新派发并绑定最新执行。');
  return lines.join('\n');
}

export function assertRetry(previous: TaskRecord, records: TaskRecord[]): void {
  if (isActive(previous)) throw new Error('任务尚未停止，不能重试。');
  if (dependencyPassed(previous)) throw new Error('任务已验证通过，请保留结果；需求变化时修改计划。');
  if (records.some(task => task.ownerSession === previous.ownerSession && (task.replaces ?? task.resumedFrom) === previous.id)) throw new Error('该任务已有后续执行，请读取最新任务后再恢复。');
  const affected = new Set([previous.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of records) if (task.ownerSession === previous.ownerSession && !affected.has(task.id) && task.dependsOn?.some(id => affected.has(id))) { affected.add(task.id); changed = true; }
  }
  if (records.some(task => task.id !== previous.id && affected.has(task.id) && isActive(task))) throw new Error('仍有下游任务活动，请先停止受影响任务再重试。');
}
