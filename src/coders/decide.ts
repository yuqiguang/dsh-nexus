import { habitRule, type HabitVerdict } from './habits.js';
import { hardRule, isInside } from './rules.js';
import type { CoderRequest, HabitRule } from './types.js';

/** Which layer settled a request, before the user is involved. */
export type LayerVerdict =
  | { layer: 'hard'; reason: string; key?: string }
  | { layer: 'habit'; verdict: HabitVerdict }
  | { layer: 'user'; reason?: string; manualOnly?: boolean }
  | { layer: 'auto' };

/**
 * Writes outside the task's fixed boundary require a scoped decision; this check is not a substitute for a process sandbox.
 */
function outsideTask(request: CoderRequest, cwd: string): string | undefined {
  if (request.kind !== 'file-write') return undefined;
  if (!request.paths.length) return '改动的路径未知';
  const outside = request.paths.find(path => !isInside(cwd, path));
  return outside ? `写入任务目录之外：${outside}` : undefined;
}

/**
 * Hard rules first: a hard deny is final, and a hard escalation can be
 * tightened by a habit deny but never loosened. A write outside the task
 * directory and every question go to the user; a habit rule may answer a
 * question. Anything left is routine and allowed without asking. Allow rules
 * stored before routine requests were allowed by default no longer decide anything.
 */
export function decideLayers(request: CoderRequest, roots: readonly string[], rules: readonly HabitRule[], cwd: string, webResearch = false, standard = false, safeTemplates: readonly string[] = []): LayerVerdict {
  const hard = hardRule(request, roots, webResearch, standard, cwd, safeTemplates);
  if (hard?.verdict === 'deny') return { layer: 'hard', reason: hard.reason, key: hard.key };
  const habit = habitRule(request, rules.filter(rule => rule.decision !== 'allow'), cwd);
  if (habit?.decision === 'deny') return { layer: 'habit', verdict: habit };
  if (hard) return { layer: 'user', reason: hard.reason, ...(hard.manualOnly ? { manualOnly: true } : {}) };
  const outside = outsideTask(request, cwd);
  if (outside) return { layer: 'user', reason: outside };
  // Legacy built-in allow rules are not grants for additional permissions.
  if (habit?.decision === 'answer') return { layer: 'habit', verdict: habit };
  if (request.kind === 'question' || request.kind === 'other') return { layer: 'user' };
  if (request.kind === 'command' && request.raw.kind === 'writeStdin') return { layer: 'user', reason: '向已有进程发送输入，需要确认具体内容' };
  if (request.kind === 'command' && request.tool === 'codex.command' && typeof request.raw.reason === 'string' && request.raw.reason.trim()) return { layer: 'user', reason: '编码工具请求额外确认；批准可能允许整条命令在沙箱外运行' };
  if (request.kind === 'command' && (request.raw.networkApprovalContext || request.raw.additionalPermissions || request.raw.sandboxPermissions === 'require_escalated')) return { layer: 'user', reason: '命令申请沙箱外或网络权限' };
  if (standard && request.kind === 'command') return { layer: 'user', reason: '标准模式：由 DSH 审核本次命令及其实际权限范围' };
  return { layer: 'auto' };
}
