import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelNotifier } from '../channels/notify.js';
import { identity } from '../channels/protocol.js';
import { formatLocal } from '../assistant/clock.js';
import { DEFAULT_TIME_ZONE } from '../assistant/settings.js';

/** Written at start and completed at a clean stop; a start that finds the previous record incomplete knows the last run died. */
export interface ServiceRun { startedAt: number; pid: number; stoppedAt?: number; clean?: boolean }
/** Left by the health check or the updater right before it restarts the unit, so the next start can say why. */
export interface RestartReason { at: number; reason: string; kind?: 'health' | 'update' | 'rollback' | 'import'; version?: string; subject?: string }

export const RUN_FILE = 'service-run.json';
export const RESTART_REASON_FILE = 'restart-reason.json';

function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

function writeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
}

/** Record this start; returns the previous run's record when it exists. */
export function recordStart(home: string, now = Date.now(), pid = process.pid): ServiceRun | undefined {
  const previous = readJson<ServiceRun>(join(home, RUN_FILE));
  writeJson(join(home, RUN_FILE), { startedAt: now, pid } satisfies ServiceRun);
  return previous && typeof previous.startedAt === 'number' ? previous : undefined;
}

/** Mark the current run as stopped on purpose. Synchronous: it runs inside the disposer during the shutdown grace. */
export function recordStop(home: string, now = Date.now()): void {
  const current = readJson<ServiceRun>(join(home, RUN_FILE));
  if (!current || current.pid !== process.pid) return;
  writeJson(join(home, RUN_FILE), { ...current, stoppedAt: now, clean: true } satisfies ServiceRun);
}

/** Read and remove the health check's note; absent when the start was not its doing. */
export function takeRestartReason(home: string): RestartReason | undefined {
  const path = join(home, RESTART_REASON_FILE);
  const reason = readJson<RestartReason>(path);
  try { unlinkSync(path); } catch { /* already gone */ }
  return reason && typeof reason.reason === 'string' ? reason : undefined;
}

/**
 * Why the user is being told about this start: the health check restarted the
 * service, or the last run never stopped cleanly. A deploy restart is neither
 * and stays silent. `undefined` when there is nothing to say.
 */
export function restartNotice(now: number, previous: ServiceRun | undefined, reason: RestartReason | undefined, timeZone = DEFAULT_TIME_ZONE): string | undefined {
  if (reason?.kind === 'update') {
    return `Nexus 已在 ${formatLocal(now, timeZone)} 自动更新到 ${reason.version ?? '新版本'}${reason.subject ? `「${reason.subject}」` : ''}并重新启动。更新时没有进行中的任务。`;
  }
  if (reason?.kind === 'import') return `Nexus 已在 ${formatLocal(now, timeZone)} ${reason.reason}，并重新启动。导入前进行中的任务和等待中的审批不会继续。`;
  if (reason?.kind === 'rollback') return `${reason.reason}。服务已在 ${formatLocal(now, timeZone)} 重新启动，重启前未完成的任务和等待中的审批会另行通知。`;
  if (reason) return `服务在 ${formatLocal(now, timeZone)} 由健康检查重新启动：${reason.reason}。重启前未完成的任务和等待中的审批会另行通知。`;
  if (previous && !previous.clean) {
    return `服务在 ${formatLocal(now, timeZone)} 重新启动。上一次运行（${formatLocal(previous.startedAt, timeZone)} 开始）没有正常停止的记录，可能是断电、崩溃或被强制结束。重启前未完成的任务和等待中的审批会另行通知。`;
  }
  return undefined;
}

export interface LifecycleDeps {
  home: string;
  notifier: ChannelNotifier;
  sessions(): string[];
  now?: () => number;
  timeZone?: string;
  report?: (message: string) => void;
}

/** Record the start, tell the bound chats when the start is worth telling, and arrange the clean-stop mark; returns the notice sent, if any. */
export async function startLifecycle(deps: LifecycleDeps, onDispose: (dispose: () => void) => void): Promise<string | undefined> {
  const now = deps.now ?? Date.now;
  const previous = recordStart(deps.home, now());
  const reason = takeRestartReason(deps.home);
  onDispose(() => recordStop(deps.home, now()));
  const notice = restartNotice(now(), previous, reason, deps.timeZone);
  if (!notice) return undefined;
  for (const sessionId of deps.sessions()) {
    try { await deps.notifier.notify(sessionId, notice, identity('service-restart', sessionId, String(now()))); }
    catch (error) { deps.report?.(`restart notice failed for ${sessionId}: ${(error as Error)?.message ?? error}`); }
  }
  return notice;
}
