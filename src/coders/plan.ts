import { sameChat } from '../channels/protocol.js';
import { z } from 'zod';
import type { CoderBrief } from './brief.js';
import { isActive, type TaskRecord } from './types.js';
import { isProtectedPath, isProjectEnvironment } from './rules.js';
import { resolve } from 'node:path';
import { acceptanceChecksSchema, resolveAcceptanceChecks } from './acceptance-checks.js';

export const VERIFY_SHELL_SYNTAX = /[|&;<>`'"]|\$\(/;
export const planSchema = z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  description: z.string().trim().min(1).max(2000),
  acceptance_ids: z.array(z.string()).min(1).max(20),
  depends_on: z.array(z.string()).max(10).default([]),
  verify: z.string().trim().min(1).max(500),
  verify_commands: z.array(z.string().trim().min(1).max(1000)).max(9).optional(),
  acceptance_checks: acceptanceChecksSchema.optional(),
  preflight: z.string().trim().min(1).max(500).optional(),
  outputs: z.array(z.string().trim().min(1).max(1000)).max(100).optional(),
})).min(1).max(20);
export type PlanStep = z.infer<typeof planSchema>[number];

/** Validate the whole graph before persisting it. This does not schedule or execute work. */
export function validatePlan(input: unknown, acceptance: readonly { id: string }[]): PlanStep[] {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new Error('计划需要 1 至 20 个步骤，每步包含唯一 id、任务说明、验收项、依赖列表和验证命令。');
  const steps = parsed.data;
  const byId = new Map(steps.map(step => [step.id, step]));
  if (byId.size !== steps.length) throw new Error('计划步骤 ID 不能重复。');
  for (const step of steps) {
    if (step.acceptance_ids.some(id => !acceptance.some(item => item.id === id))) throw new Error(`步骤 ${step.id} 引用了不存在的验收项。`);
    if (step.depends_on.some(id => !byId.has(id))) throw new Error(`步骤 ${step.id} 引用了不存在的前置步骤。`);
    if ([step.verify, ...(step.verify_commands ?? [])].some(command => VERIFY_SHELL_SYNTAX.test(command))) throw new Error(`步骤 ${step.id} 的验证命令不能包含 shell 组合语法，请使用单个脚本。`);
    resolveAcceptanceChecks(step.acceptance_checks, { id: 'plan', revision: 1, objective: 'plan', constraints: '', acceptance: step.acceptance_ids.map(id => ({ id, text: id })) }, [step.verify, ...(step.verify_commands ?? [])]);
    if (step.preflight && VERIFY_SHELL_SYNTAX.test(step.preflight)) throw new Error(`步骤 ${step.id} 的环境预检必须使用单个脚本。`);
    const outputRoot = resolve('/__nexus_plan_outputs__');
    const protectedOutput = [...(step.outputs ?? []), ...(step.acceptance_checks ?? []).flatMap(check => check.files)].find(path => isProtectedPath(resolve(outputRoot, path), [outputRoot], true)
      && !isProjectEnvironment(resolve(outputRoot, path), outputRoot, true));
    if (protectedOutput) throw new Error(`步骤 ${step.id} 的预期文件 ${protectedOutput} 受凭据保护规则限制，请在派发前调整交付文件。`);
  }
  const missing = acceptance.filter(item => !steps.some(step => step.acceptance_ids.includes(item.id)));
  if (missing.length) throw new Error(`计划遗漏验收项：${missing.map(item => item.id).join('、')}。`);
  const visited = new Set<string>(), visiting = new Set<string>(), ordered: PlanStep[] = [];
  const visit = (step: PlanStep) => {
    if (visiting.has(step.id)) throw new Error('计划存在循环依赖，不能派发。');
    if (visited.has(step.id)) return;
    visiting.add(step.id);
    for (const id of step.depends_on) visit(byId.get(id)!);
    visiting.delete(step.id); visited.add(step.id);
    ordered.push({ ...step, acceptance_ids: [...new Set(step.acceptance_ids)], depends_on: [...new Set(step.depends_on)] });
  };
  for (const step of steps) visit(step);
  return ordered;
}

/** Resolve step links from persisted task records, never from selected chat messages. */
export function resolvePlanStep(brief: CoderBrief, stepId: string | undefined, records: TaskRecord[], resumeFrom?: string): { step: PlanStep; dependsOn: string[] } | undefined {
  if (!brief.plan) {
    if (stepId) throw new Error('说明单还没有步骤计划，请先保存计划。');
    return undefined;
  }
  const step = brief.plan.find(step => step.id === stepId);
  if (!step) throw new Error('说明单已启用步骤计划，请指定有效的 plan_step。');
  const tasks = records.filter(task => sameChat(task.ownerSession, brief.ownerSession) && task.brief?.id === brief.id && task.brief.revision === brief.revision);
  const own = tasks.filter(task => task.planStep === step.id);
  if (own.length && !resumeFrom) throw new Error('该计划步骤已经派发；请查看已有任务，需要继续时显式续接或修改计划。');
  if (resumeFrom && own.length && !own.some(task => task.id === resumeFrom)) throw new Error('续接任务不属于当前计划步骤。');
  if (resumeFrom && own.some(task => (task.replaces ?? task.resumedFrom) === resumeFrom)) throw new Error('该步骤已有后续执行，请使用最新任务。');
  if (tasks.some(task => task.planStep === step.id && isActive(task))) throw new Error('该计划步骤已有运行或排队任务。');
  const dependsOn = step.depends_on.map(id => {
    const matches = tasks.filter(task => task.planStep === id);
    const replaced = new Set(matches.map(task => task.replaces ?? task.resumedFrom).filter(Boolean));
    const leaves = matches.filter(task => !replaced.has(task.id));
    if (leaves.length > 1) throw new Error(`前置步骤 ${id} 存在多个执行分支，请明确整理计划后再派发。`);
    const latest = leaves[0];
    if (!latest?.jobId) throw new Error(`前置步骤 ${id} 尚未派发，请按计划顺序派发。`);
    return latest.id;
  });
  return { step, dependsOn };
}
