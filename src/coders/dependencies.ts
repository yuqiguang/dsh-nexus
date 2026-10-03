import { isActive, type TaskRecord } from './types.js';

export class DependencyError extends Error {}

/** Existing task IDs only: new tasks cannot create cycles or reference another owner's work. */
export function dependencyIds(input: unknown, owner: string, get: (id: string) => TaskRecord | undefined): string[] {
  if (!Array.isArray(input) || input.length > 10 || input.some(id => typeof id !== 'string' || !id)) throw new Error('depends_on 必须是最多 10 个已有任务 ID。');
  const ids = [...new Set(input as string[])];
  for (const id of ids) if (get(id)?.ownerSession !== owner) throw new Error('前置任务不存在或不属于当前会话。');
  return ids;
}

export function dependencyPassed(task: TaskRecord): boolean {
  return task.status === 'completed' && task.result?.execution === 'completed' && task.result.verification === 'passed'
    && task.result.verifyOk === true && (task.permissions?.securityMode === 'full' || task.result.outsideRoots.length === 0);
}

/** Wait before acquiring an execution slot; abort promptly without cancelling the prerequisites. */
export async function waitForDependencies(task: TaskRecord, get: (id: string) => TaskRecord | undefined,
  completion: (id: string) => Promise<unknown> | undefined, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const waits = (task.dependsOn ?? []).map(async id => {
    const before = get(id);
    if (!before || before.ownerSession !== task.ownerSession) throw new DependencyError('前置任务不可用，后续任务未启动。');
    const pending = completion(id);
    if (pending) await pending;
    else if (isActive(before)) throw new DependencyError(`前置任务 ${id} 未能恢复，后续任务未启动。`);
    const result = get(id);
    if (!result || result.ownerSession !== task.ownerSession || !dependencyPassed(result)) {
      throw new DependencyError(`前置任务 ${id} 未满足“执行成功且独立验证通过”，后续任务未启动。修复前置任务后，请用新的任务 ID 重新派发依赖任务。`);
    }
  });
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('dependency_wait_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([Promise.all(waits), cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
