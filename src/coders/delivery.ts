import { createHash } from 'node:crypto';
import { sameChat } from '../channels/protocol.js';
import type { CoderBrief } from './brief.js';
import { dependencyPassed } from './dependencies.js';
import { isActive, type TaskRecord } from './types.js';
import { changeSummary } from './change-summary.js';
import { acceptanceCheck } from './acceptance-checks.js';
import { resolve } from 'node:path';
import { expectedArtifacts } from './artifacts.js';

export interface AcceptanceReview { criterion: string; evidence: string; accepted: boolean; note: string; at: number }

export function acceptanceDeferralKey(criterion: string, evidence: string): string {
  return `acceptance-deferred:${criterion}:${evidence}`;
}

export function reviewDeferred(brief: CoderBrief, criterion: string, evidence: string): boolean {
  return brief.answers?.some(item => item.key === acceptanceDeferralKey(criterion, evidence) && item.answers.accept === '暂时无法判断') ?? false;
}

export function briefTasks(brief: CoderBrief, records: TaskRecord[]): TaskRecord[] {
  const tasks = records.filter(task => sameChat(task.ownerSession, brief.ownerSession) && task.brief?.id === brief.id && task.brief.revision === brief.revision);
  const replaced = new Set(tasks.map(task => task.replaces ?? task.resumedFrom).filter(Boolean));
  return tasks.filter(task => !replaced.has(task.id));
}

export function criterionEvidence(brief: CoderBrief, records: TaskRecord[], criterion: string) {
  if (!brief.acceptance.some(item => item.id === criterion)) throw new Error('验收项不存在。');
  const tasks = briefTasks(brief, records).filter(task => task.brief!.acceptance.some(item => item.id === criterion)).sort((a, b) => a.id.localeCompare(b.id));
  const evidence = createHash('sha256').update(JSON.stringify({ revision: brief.revision, criterion, tasks: tasks.map(task => ({ id: task.id,
    status: task.status, updatedAt: task.updatedAt, verify: task.verify, verifyCommands: task.verifyCommands, acceptanceChecks: task.acceptanceChecks, outputs: task.outputs, result: task.result })) })).digest('hex');
  const gaps: string[] = [];
  const checked = tasks.length > 0 && tasks.map(task => {
    const contract = acceptanceCheck(task, criterion);
    if (!contract) { gaps.push(`${task.id} 未登记本项对应的独立检查（acceptance_checks）`); return false; }
    const commandFailures = contract.commands.filter(command => !task.result?.verifyChecks?.some(check => check.command === command && check.ok && check.executed));
    const fileFailures = contract.files.filter(path => !task.result?.artifactChecks?.some(check => check.path === resolve(task.cwd, path) && check.ok));
    if (commandFailures.length) gaps.push(`${task.id} 检查未通过或未执行：${commandFailures.join('；')}`);
    for (const path of fileFailures) gaps.push(`${task.id} 文件 ${path}：${task.result?.artifactChecks?.find(check => check.path === resolve(task.cwd, path))?.detail ?? '未核验'}`);
    // A failed check for another criterion does not erase this one's observed result. Overall delivery still requires all tasks to pass.
    return ['completed', 'failed'].includes(task.status) && task.result?.execution === 'completed'
      && (task.permissions?.securityMode === 'full' || task.result.outsideRoots.length === 0) && !commandFailures.length && !fileFailures.length;
  }).every(Boolean);
  return { tasks, evidence, checked, gaps, settled: tasks.length > 0 && tasks.every(task => !isActive(task)) };
}

export function deliveryReport(brief: CoderBrief, records: TaskRecord[]): string {
  const tasks = briefTasks(brief, records);
  let accepted = 0, checked = 0, rejected = 0;
  const lines = brief.acceptance.map(item => {
    const state = criterionEvidence(brief, records, item.id);
    const review = brief.reviews?.find(review => review.criterion === item.id && review.evidence === state.evidence);
    if (review?.accepted) accepted++;
    if (review && !review.accepted) rejected++;
    if (state.checked) checked++;
    const deferred = reviewDeferred(brief, item.id, state.evidence);
    const feedback = review ? review.accepted ? '用户已确认已满足' : `用户反馈未满足${deferred ? '；本次暂时无法判断，待确认' : ''}`
      : deferred ? '暂时无法判断，待确认' : brief.requireUserReview ? '待确认（用户要求）' : '可选，未要求';
    return `- ${item.id} ${item.text}：自动检查${state.checked ? '通过' : '未全部通过'}；人工验收${feedback}${review?.note ? `（${review.note}）` : ''}；任务 ${state.tasks.map(task => task.id).join('、') || '未安排'}${state.gaps.length ? `；缺口：${state.gaps.join('；')}` : ''}`;
  });
  const files = [...new Set(tasks.flatMap(task => task.result?.changedFiles ?? []))].sort();
  const changes = changeSummary(files, tasks.flatMap(expectedArtifacts));
  const commits = [...new Set(tasks.flatMap(task => task.result?.commits ?? []))];
  const artifacts = [...new Set(tasks.flatMap(task => task.result?.artifactChecks?.filter(check => check.ok).map(check => check.path) ?? []))];
  const active = tasks.some(isActive);
  const checksPassed = checked === brief.acceptance.length;
  const executionPassed = !active && tasks.every(dependencyPassed);
  const complete = checksPassed && executionPassed && rejected === 0 && (!brief.requireUserReview || accepted === brief.acceptance.length);
  const status = complete ? accepted === brief.acceptance.length ? '自动检查与人工验收均通过，可以交付' : '自动检查通过，可以交付'
    : active ? '仍有任务未结束' : rejected ? '用户反馈未满足，需继续处理' : !checksPassed ? '尚未完成全部检查'
      : !executionPassed ? '任务执行或依赖尚未全部通过' : '自动检查通过，等待用户要求的人工验收';
  return [`目标交付 ${brief.id} v${brief.revision}：${status}`,
    `目标：${brief.objective}`, `自动检查通过 ${checked}/${brief.acceptance.length}，人工验收${brief.requireUserReview ? '必需' : '可选'}，用户已确认 ${accepted}/${brief.acceptance.length}`, ...lines,
    ...tasks.flatMap(task => (task.result?.artifactChecks ?? []).filter(check => !check.ok).map(check => `声明文件未通过：${check.path}；${check.detail}`)),
    ...(artifacts.length ? [`已核验声明文件 ${artifacts.length} 个（存在性与内容身份；语义见对应检查）：`, ...artifacts.slice(0, 100).map(path => `- ${path}`)] : []),
    `改动文件共 ${files.length} 个：项目文件 ${changes.project.length}，依赖 ${changes.dependencies.length}，测试/缓存产物 ${changes.generated.length}；审计路径完整保留。`, ...changes.project.slice(0, 100).map(file => `- ${file}`), ...(changes.project.length > 100 ? ['其余项目文件请查看对应任务结果。'] : []),
    `任务期间观察到的 Git 提交 ${commits.length} 个：`, ...commits.slice(0, 50).map(commit => `- ${commit}`),
    brief.requireUserReview ? '用户明确要求人工验收：自动检查通过后，还需用户确认全部验收项；暂时无法判断保留待确认。'
      : '默认按已登记的自动检查和交付文件核验结果交付，主助手仍需核对完整用户要求。人工验收仅按用户明确要求询问；用户的未满足反馈仍须处理。'].join('\n');
}
