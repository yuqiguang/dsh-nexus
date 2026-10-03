import { requireWindowsFirewall } from './windows-firewall.js';
import type { CoderKind, TaskRecord } from './types.js';

export function verificationNetwork(requested: TaskRecord['verifyNetwork'], previous: TaskRecord['verifyNetwork'], mode: 'standard' | 'strict' | 'full'): NonNullable<TaskRecord['verifyNetwork']> {
  return requested ?? previous ?? (mode === 'strict' ? 'offline' : 'ask');
}

/** Fail before starting a coder, never downgrade an explicitly offline contract. */
export async function preflightVerification(platform: NodeJS.Platform, coder: CoderKind, network: NonNullable<TaskRecord['verifyNetwork']>,
  firewall: () => Promise<void> = requireWindowsFirewall): Promise<void> {
  if (platform !== 'win32' || network === 'ask') return;
  if (network === 'loopback') throw new Error('Windows 暂不支持隔离回环验证；请使用 Linux / WSL，或为本次验证明确选择 ask 申请授权。');
  if (coder !== 'codex') throw new Error('Windows Claude 独立验证不能强制断网；请使用 Linux / WSL，或为标准模式验证明确选择 ask 申请授权。');
  try { await firewall(); }
  catch { throw new Error('离线验证未就绪，任务尚未派发：Windows 防火墙未全部启用或无法确认状态。请启用防火墙后重试；若没有断网要求，可省略 verify_network 使用标准模式默认的 ask，由 DSH 审核本次验证命令。不会自动取消离线限制。'); }
}
