/**
 * Decision logic of `scripts/update.mjs`, kept pure so the script's choices can
 * be tested without git, systemd, or a running service.
 */

/** Persisted in `.nexus/update-state.json` between runs. */
export interface UpdateState {
  lastCheckAt?: number;
  /** One word for the journal: `up-to-date`, `skipped`, `built`, `updated`, `failed`, `rolled-back`. */
  lastResult?: string;
  lastReason?: string;
  lastUpdateAt?: number;
  /** The last commit that was successfully started. */
  updatedTo?: string;
  /** A commit whose build, tests, or start failed is not tried again until HEAD moves. */
  failedCommit?: string;
  lastError?: string;
}

/** The parts of the health snapshot the updater looks at. */
export interface ServiceSnapshot {
  runningTurns?: number;
  idleMs?: number;
  coders?: { active: string[] };
  channels?: { channel: string; pendingDeliveries?: number }[];
  commit?: string;
}

/** A restart is only attempted when nothing happened in any session for this long. */
export const IDLE_MS = 2 * 60_000;
/** How long the new build has to answer the health probe with its own commit before it is rolled back. */
export const START_TIMEOUT_MS = 90_000;
/** A lock older than this belongs to a run that died; the next run takes over. */
export const LOCK_STALE_MS = 30 * 60_000;

export const short = (commit: string | undefined): string => (commit ?? '').slice(0, 7) || '未知版本';

/** Why the service must not be restarted right now; `undefined` when it is quiet. */
export function busyReason(snapshot: ServiceSnapshot): string | undefined {
  if ((snapshot.runningTurns ?? 0) > 0) return `有 ${snapshot.runningTurns} 个回合正在执行`;
  const coders = snapshot.coders?.active.length ?? 0;
  if (coders > 0) return `有 ${coders} 个编码任务进行中`;
  const pending = (snapshot.channels ?? []).reduce((sum, item) => sum + (item.pendingDeliveries ?? 0), 0);
  if (pending > 0) return `有 ${pending} 条消息等待投递`;
  if ((snapshot.idleMs ?? Infinity) < IDLE_MS) return `${Math.round((snapshot.idleMs ?? 0) / 1000)} 秒前还有活动`;
  return undefined;
}

export interface PlanInput {
  /** Committed HEAD; empty when this is not a git checkout. */
  head: string;
  dirty: boolean;
  /** Commit `dist/build-info.json` records; absent when there is no build. */
  built?: string;
  /** Commit the running service reports; absent when the health probe failed. */
  running?: string;
  healthy: boolean;
  /** The unit is loaded and enabled in systemd, so a restart is possible and the health check will keep it up. */
  managed: boolean;
  busy?: string;
  state: UpdateState;
}

export type UpdatePlan = { action: 'none' | 'skip' | 'build' | 'restart'; reason: string };

export function planUpdate(input: PlanInput): UpdatePlan {
  if (!input.head) return { action: 'skip', reason: '不在 git 仓库里' };
  if (input.dirty) return { action: 'skip', reason: '工作树有未提交的改动' };
  if (input.state.failedCommit === input.head) return { action: 'skip', reason: `${short(input.head)} 上次更新失败，等新的提交` };
  if (input.built === input.head && input.running === input.head) return { action: 'none', reason: `已是 ${short(input.head)}` };
  if (!input.managed) return { action: 'skip', reason: '服务不是 systemd 管理的，请手动构建并重启' };
  if (!input.healthy) return { action: 'skip', reason: '服务没有响应健康检查，交给健康检查处理' };
  if (input.busy) return { action: 'skip', reason: input.busy };
  if (input.built !== input.head) return { action: 'build', reason: `${short(input.built)} → ${short(input.head)}` };
  return { action: 'restart', reason: `已构建 ${short(input.head)}，运行中的是 ${short(input.running)}` };
}

export type FailureStage = 'deps' | 'build' | 'test' | 'start';

const stages: Record<FailureStage, string> = { deps: '安装依赖失败', build: '构建失败', test: '单元测试未通过', start: '新版本启动后没有恢复健康' };

/** What the user reads when an update did not happen; the old build keeps running (or was put back). */
export function updateFailureNotice(stage: FailureStage, head: string, subject: string | undefined, runningCommit: string | undefined, detail?: string): string {
  const version = `${short(head)}${subject ? `「${subject}」` : ' '}`;
  const running = runningCommit ? `服务仍在运行 ${short(runningCommit)}` : '服务仍在运行原版本';
  const tail = stage === 'start' ? `已回退到上一版本。` : `${running}。`;
  return `自动更新到 ${version}失败：${stages[stage]}${detail ? `（${detail}）` : ''}。${tail}这个提交不会再自动尝试，修好后提交新版本即可。`;
}

/**
 * What a later pass does with directories a pass that never reached `updated` left behind.
 * `dist.previous` is the build that was serving; `dist.next` is a staged build that was
 * never swapped in. `scripts/update.mjs` applies this before it can import this module.
 */
export function recoverDist(layout: { previous: boolean; next: boolean }): Array<'restore-previous' | 'drop-staged'> {
  const steps: Array<'restore-previous' | 'drop-staged'> = [];
  if (layout.previous) steps.push('restore-previous');
  if (layout.next) steps.push('drop-staged');
  return steps;
}

/** The reason recorded for the restart that puts the previous build back. */
export function rollbackReason(head: string, previous: string | undefined): string {
  return `自动更新到 ${short(head)} 后服务没有在 ${Math.round(START_TIMEOUT_MS / 1000)} 秒内恢复健康，已回退到 ${short(previous)}`;
}

/** The `ℹ fail N` line; npm test pins the spec reporter because node:test defaults to TAP without a terminal. */
export function failedTestCount(output: string): number | undefined {
  const match = /^ℹ fail (\d+)$/m.exec(output);
  return match ? Number(match[1]) : undefined;
}

/** The `ℹ tests N` line. 0 means the glob matched nothing, which node:test still exits 0 for. */
export function reportedTestCount(output: string): number | undefined {
  const match = /^ℹ tests (\d+)$/m.exec(output);
  return match ? Number(match[1]) : undefined;
}
