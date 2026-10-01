import { networkDomains, type CoderSecurityMode } from './settings.js';
import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isInside } from './rules.js';
import type { CoderKind } from './types.js';

/** Fixed for a task and its resumes; model input cannot widen the policy. */
export interface TaskPermissions {
  version: 1;
  mode: 'unattended';
  /** Missing on legacy snapshots means strict; never upgrade a resumed task implicitly. */
  securityMode?: CoderSecurityMode;
  writableRoots: string[];
  network: 'ask';
  /** Native research tools only; absent on older tasks, so resuming does not add them. */
  webResearch?: boolean;
  autoApproveSafe?: boolean;
  reviewRoots?: string[];
  allowedNetworkDomains: string[];
  maxDurationMs: number;
  maxRepeatedDenials: number;
  isolation: 'codex-workspace' | 'claude-sandbox' | 'dsh-supervised';
}
export const DEFAULT_DURATION_MS = 60 * 60_000;

/** Resolve existing ancestors too, so a new file through a symlink is not mistaken for an in-project write. */
export async function canonical(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await canonical(parent), basename(absolute));
  }
}
export async function taskPermissions(cwd: string, roots: readonly string[], coder: CoderKind,
  previous?: TaskPermissions, maxTaskMinutes = 60, domains?: string[], autoApproveSafe = true, securityMode: CoderSecurityMode = 'strict'): Promise<TaskPermissions> {
  const directory = await canonical(cwd);
  const allowed = await Promise.all(roots.map(canonical));
  if (!allowed.some(root => isInside(root, directory))) throw new Error('任务目录解析后的真实路径不在允许的根目录内。');
  if (previous) {
    if (previous.writableRoots.length !== 1 || previous.writableRoots[0] !== directory) throw new Error('续接任务的目录边界已经改变，不能扩大权限。');
    return structuredClone(previous);
  }
  return { version: 1, mode: 'unattended', securityMode, writableRoots: [directory], network: 'ask', webResearch: true, autoApproveSafe, reviewRoots: allowed, allowedNetworkDomains: networkDomains(domains), maxDurationMs: maxTaskMinutes * 60_000,
    maxRepeatedDenials: 3, isolation: coder === 'codex' ? 'codex-workspace' : securityMode === 'standard' ? 'dsh-supervised' : 'claude-sandbox' };
}
export function permissionSummary(policy: TaskPermissions): string {
  if (policy.securityMode === 'standard') return `标准模式：文件工具默认仅写入 ${policy.writableRoots.join('、')}；命令可联网，${policy.autoApproveSafe ? '具体命令和额外权限由 DSH 自动审核，不确定时询问用户' : '命令和额外权限询问用户'}；授权仅限本次操作。${policy.isolation === 'codex-workspace' ? 'Codex 保留工作目录写入沙箱，额外权限逐次审核。' : 'Claude 命令由 DSH 审批，不提供操作系统文件或网络隔离。'}审批不能约束任意脚本内部的全部行为；取消后回收任务进程。每次运行最多 ${policy.maxDurationMs / 60_000} 分钟；同一拒绝 ${policy.maxRepeatedDenials} 次后暂停。`;
  return `严格模式，无人值守开发：仅写入 ${policy.writableRoots.join('、')}；原生网页搜索与读取${policy.webResearch ? '已启用' : '未启用'}；命令联网允许域名 ${policy.allowedNetworkDomains.join('、') || '无'}，${policy.autoApproveSafe ? '安全额外操作由 DSH 审核，不确定时询问' : '额外操作需确认'}；每次运行最多 ${policy.maxDurationMs / 60_000} 分钟；同一拒绝 ${policy.maxRepeatedDenials} 次后暂停。`
    + (policy.isolation === 'codex-workspace' ? ' Codex 原生沙箱限制写入；仅有明确域名的网络审批可匹配名单，其他网络操作逐次审核或确认。不提供完整的宿主读取隔离。' : ' Claude 命令必须经过原生沙箱；名单外域名被阻止，需在设置中授权后新建任务。文件工具另经监工检查。');
}
export function credentialPaths(): string[] {
  return ['.ssh', '.aws', '.gnupg', '.dsh', '.codex', '.nexus', '.npmrc', '.netrc', '.config/gh'].map(path => resolve(homedir(), path)).concat('/etc/npmrc', resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh')));
}
