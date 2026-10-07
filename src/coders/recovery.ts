import type { CoderBrief } from './brief.js';
import { briefTasks } from './delivery.js';
import { dependencyPassed } from './dependencies.js';
import { resolvePlanStep } from './plan.js';
import { isActive, type TaskRecord } from './types.js';

export interface TaskRecoveryView {
  title: string;
  nextStep: string;
  context?: string;
  blockers: string[];
  followingTasks: string[];
}

/** Read-only guidance from persisted records. Dispatch still checks the live native session and permissions. */
export function taskRecovery(task: TaskRecord, records: TaskRecord[], current?: CoderBrief): TaskRecoveryView {
  const own = records.filter(record => record.ownerSession === task.ownerSession);
  const followingTasks = own.filter(record => (record.replaces ?? record.resumedFrom) === task.id).map(record => record.id);
  const view: TaskRecoveryView = { title: '', nextStep: '', blockers: [], followingTasks };
  if (followingTasks.length) {
    return { ...view, title: '此任务已有后续执行', nextStep: '先查看后续任务的结果，在其所属会话中继续；不要重复恢复这条旧记录。' };
  }
  if (task.brief && (!current || current.ownerSession !== task.ownerSession || current.id !== task.brief.id || current.revision !== task.brief.revision)) {
    return { ...view, title: current ? '此任务属于旧目标版本' : '当前目标记录不可用',
      nextStep: '回到所属会话核对当前目标和验收项，再决定需要执行哪些步骤；这条记录不能作为当前版本的恢复依据。' };
  }
  if (isActive(task)) {
    const states = {
      queued: ['任务尚在排队', '尚未开始编码执行，具体原因以当前状态记录为准；需要取消时回到所属会话，不要重复派发。'],
      running: ['任务仍在执行', '可以回到所属会话查看进展或说明调整，不需要重新开始。'],
      'waiting-user': ['任务正在等待你的回答', '回到所属会话处理当前提问或审批；旧消息中的审批回复不能用于新的请求。'],
      verifying: ['独立验证正在进行', '等待检查结果；编码工具结束不代表验证和总体目标已经完成。'],
    } as const;
    const [title, nextStep] = states[task.status as keyof typeof states];
    return { ...view, title, nextStep };
  }
  if (dependencyPassed(task)) return { ...view, title: '指定检查已通过',
    nextStep: '保留本步骤结果，查看目标与验收中尚未完成的项目；需要确认的业务效果仍由你验收。' };
  view.title = task.stopCause === 'user-wait-timeout' ? '等待用户超时，已暂停' : task.status === 'interrupted' ? '任务已中断' : task.status === 'cancelled' ? '任务已取消'
    : task.result?.execution === 'failed' ? '编码执行失败'
    : task.permissions?.securityMode !== 'full' && task.result?.outsideRoots.length ? '检测到工作区外改动'
    : task.result?.verification === 'failed' ? '独立验证未通过'
    : task.result?.verification === 'not-run' || task.status === 'completed' ? '尚未独立验证' : '任务失败，需核对原因';
  if (task.result?.preflightCheck && !task.result.preflightCheck.ok) {
    view.title = '执行前环境预检未通过';
    view.context = '编码工具尚未启动。先核对预检输出并修复运行条件，保留原目标和最终验收，不能通过缩小测试范围让预检变绿。';
  }
  view.context ??= task.coderSessionId
    ? '记录中保留了编码会话标识，可尝试在原上下文续接；实际是否可恢复由编码工具检查。'
    : '没有可续接的编码会话标识。若需重试，将开始新的编码执行，先核对已有文件与任务记录。';
  try { assertRetry(task, own); } catch (error) { view.blockers.push((error as Error).message); }
  let dependencies = task.dependsOn ?? [];
  if (current?.plan) {
    try {
      const planned = resolvePlanStep(current, task.planStep, own, task.id);
      dependencies = [...new Set([...(planned?.dependsOn ?? []), ...dependencies.filter(id => {
        const prior = own.find(record => record.id === id);
        return prior?.brief?.id !== current.id || prior.brief.revision !== current.revision || !planned?.step.depends_on.includes(prior.planStep ?? '');
      })])];
    } catch (error) { view.blockers.push((error as Error).message); }
  }
  const blocked = dependencies.filter(id => { const prior = own.find(record => record.id === id); return !prior || !dependencyPassed(prior); });
  if (blocked.length) view.blockers.push(`前置任务尚未通过或不可用：${blocked.join('、')}。先修复前置步骤，再核对最新任务依赖。`);
  view.nextStep = view.blockers.length ? '先在所属会话处理以下阻塞，再查看恢复清单。'
    : task.stopCause === 'user-wait-timeout' ? '等待用户明确要求继续；先解释未解决的具体审批原因，不自动重复派发，不改用主会话终端、文件修改或其他工具继续待确认操作，不将超时表述为用户拒绝。新请求仍需本次授权；从原任务续接并保留验收记录。'
    : task.result?.execution === 'completed' ? '编码已完成，先核对验证条件；仅复验时使用 verification_only=true，沿用计划中的 verify，无需再次启动编码工具。'
    : '回到所属会话说明继续要求，先核对停止原因、已有改动和验证结果，只恢复需要处理的步骤。';
  return view;
}

export function recoveryReport(brief: CoderBrief, records: TaskRecord[], forDisplay = false): string {
  const tasks = briefTasks(brief, records);
  const lines = [`恢复清单 ${brief.id} v${brief.revision}（不会自动执行）`];
  for (const step of brief.plan ?? []) {
    const task = tasks.find(task => task.planStep === step.id);
    const dependencies = step.depends_on.map(id => tasks.find(task => task.planStep === id));
    const blockers = task ? taskRecovery(task, records, brief).blockers : [];
    const state = task && dependencyPassed(task) ? '保留已通过的结果，无需重做' : task && isActive(task) ? '仍在执行或等待，先查看状态' : dependencies.some(task => !task || !dependencyPassed(task))
      ? '前置步骤尚未通过，暂不重试' : blockers.length ? blockers.join('；')
      : task?.stopCause === 'user-wait-timeout' ? '等待用户明确续接；先处理上次审批原因，不自动重派'
      : task ? forDisplay ? `可在所属会话中恢复（任务 ${task.id}）` : `可重试：retry_task_id=${task.id}${task.result?.execution === 'completed' ? '；仅需复验时 verification_only=true，沿用计划验证' : ''}` : '可首次派发';
    lines.push(`${step.id}：${state}；任务说明：${step.description}${task?.stopReason ? `；停止原因：${task.stopReason}` : task?.result?.detail ? `；执行说明：${task.result.detail}` : ''}`);
  }
  if (!brief.plan) for (const task of tasks) {
    const blockers = taskRecovery(task, records, brief).blockers;
    lines.push(`${task.id}：${dependencyPassed(task) ? '保留已通过结果' : isActive(task) ? '仍在执行或等待' : blockers.length ? blockers.join('；') : '可检查后显式重试'}；${task.stopReason || task.result?.detail || task.result?.summary || ''}`);
  }
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
