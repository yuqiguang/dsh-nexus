import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonical } from './permissions.js';
import { isInside } from './rules.js';
import type { ArtifactCheck } from './acceptance-checks.js';
import type { TaskRecord } from './types.js';

export function expectedArtifacts(task: Pick<TaskRecord, 'cwd' | 'outputs' | 'acceptanceChecks'>): string[] {
  return [...new Set([...(task.outputs ?? []), ...(task.acceptanceChecks ?? []).flatMap(check => check.files)].map(path => resolve(task.cwd, path)))];
}

/** File presence and content identity are host observations, not a semantic or business acceptance. */
export async function inspectArtifact(path: string, cwd: string, signal?: AbortSignal): Promise<ArtifactCheck> {
  try {
    signal?.throwIfAborted();
    if (!isInside(cwd, path)) return { path, ok: false, detail: '声明文件超出任务目录，未读取' };
    const real = await canonical(path), root = await canonical(cwd);
    const same = process.platform === 'win32' ? real.toLowerCase() === path.toLowerCase() : real === path;
    if (!same || !isInside(root, real)) return { path, ok: false, detail: '声明文件经过链接重定向或越界，未读取' };
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink > 1) return { path, ok: false, detail: '声明交付物不是独立的普通文件' };
    const hash = createHash('sha256');
    for await (const part of createReadStream(real, { signal })) hash.update(part);
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.size !== after.size
      || await canonical(path) !== real) return { path, ok: false, detail: '检查期间文件发生变化，需要重新验证' };
    return { path, ok: true, detail: '声明文件存在；内容身份已记录，语义以对应检查命令为准', sha256: hash.digest('hex'), size: after.size };
  } catch (error) {
    return { path, ok: false, detail: signal?.aborted ? '文件检查已取消' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '声明文件不存在' : '无法完整核验声明文件' };
  }
}

/** Read-only delivery view. Main-session edits do not rewrite a finished task or inherit its old verification. */
export async function currentArtifactEvidence(records: TaskRecord[], signal?: AbortSignal): Promise<TaskRecord[]> {
  const result: TaskRecord[] = [];
  for (const task of records) {
    if (!task.result?.artifactChecks?.some(check => check.ok)) { result.push(task); continue; }
    const checks: ArtifactCheck[] = [];
    for (const check of task.result.artifactChecks) {
      if (!check.ok) { checks.push(check); continue; }
      const current = await inspectArtifact(check.path, task.cwd, signal);
      checks.push(current.ok && current.sha256 === check.sha256 ? check : { ...current, ok: false,
        detail: current.ok ? '文件在独立验证后已变化，需要沿原任务重新验证' : current.detail });
    }
    result.push(checks.every(check => check.ok) ? task : { ...task, result: { ...task.result, artifactChecks: checks, verifyOk: false } });
  }
  return result;
}
