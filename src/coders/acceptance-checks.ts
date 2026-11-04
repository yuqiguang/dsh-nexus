import { z } from 'zod';
import type { TaskRecord } from './types.js';

export const acceptanceChecksSchema = z.array(z.object({
  criterion: z.string().min(1),
  commands: z.array(z.string().trim().min(1).max(1000)).max(10).default([]),
  files: z.array(z.string().trim().min(1).max(1000)).max(100).default([]),
}).refine(value => value.commands.length + value.files.length > 0)).max(20);
export type AcceptanceCheck = z.infer<typeof acceptanceChecksSchema>[number];
export interface ArtifactCheck { path: string; ok: boolean; detail: string; sha256?: string; size?: number }

export const acceptanceChecksParameter = { type: 'array', description: '逐项独立检查：criterion 为验收项 ID，commands 引用已登记的验证命令，files 列需实际存在并记录内容摘要的文件。多验收项任务须明确对应关系；文档内容、引用文件、复现分支和业务效果用实际检查脚本覆盖，文件存在不代表这些语义通过。',
  // Open items: a model's extra note must not fail the whole dispatch; zod strips undeclared fields.
  items: { type: 'object', additionalProperties: true, properties: { criterion: { type: 'string', required: true }, commands: { type: 'array', items: { type: 'string' } }, files: { type: 'array', items: { type: 'string' } } } } } as const;

/** A task/criterion association is not proof that every criterion was tested. A one-criterion command contract is unambiguous. */
export function acceptanceCheck(task: Pick<TaskRecord, 'brief' | 'acceptanceChecks' | 'verify' | 'verifyCommands' | 'outputs'>, criterion: string): AcceptanceCheck | undefined {
  const declared = task.acceptanceChecks?.find(check => check.criterion === criterion);
  if (declared) return declared;
  if (task.brief?.acceptance.length === 1 && task.brief.acceptance[0]?.id === criterion && task.verify) {
    return { criterion, commands: [task.verify, ...(task.verifyCommands ?? [])], files: task.outputs ?? [] };
  }
}

export function resolveAcceptanceChecks(input: unknown, brief: TaskRecord['brief'], commands: string[], previous?: AcceptanceCheck[]): AcceptanceCheck[] | undefined {
  if (input === undefined && !previous?.length) return;
  if (!brief) throw new Error('acceptance_checks 必须关联任务说明单。');
  const parsed = acceptanceChecksSchema.safeParse(input ?? previous);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`acceptance_checks 需要验收项 criterion 及至少一条已登记 commands 或一个 files 路径。问题：${issue?.path.join('.') || 'acceptance_checks'}：${issue?.message ?? ''}`);
  }
  const checks = parsed.data;
  if (new Set(checks.map(check => check.criterion)).size !== checks.length) throw new Error('验收项检查不能重复，请合并同一项的命令与文件。');
  for (const check of checks) {
    if (!brief.acceptance.some(item => item.id === check.criterion)) throw new Error(`检查引用了本任务未负责的验收项 ${check.criterion}。`);
    if (check.commands.some(command => !commands.includes(command))) throw new Error(`验收项 ${check.criterion} 的命令未列入 verify_commands 或 verify。`);
  }
  for (const prior of previous ?? []) {
    const check = checks.find(check => check.criterion === prior.criterion);
    if (!check || prior.commands.some(command => !check.commands.includes(command)) || prior.files.some(path => !check.files.includes(path))) {
      throw new Error('续接必须保留本版本已登记的逐项检查；要求变化请先修改说明单。');
    }
  }
  return checks;
}

/** Commands named by per-criterion checks but missing from the suite; callers register them instead of bouncing the call. */
export function unlistedCheckCommands(input: unknown, commands: readonly string[]): string[] {
  const parsed = acceptanceChecksSchema.safeParse(input);
  return parsed.success ? [...new Set(parsed.data.flatMap(check => check.commands))].filter(command => !commands.includes(command)) : [];
}
