import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { JobEvent } from '@deepseek-ai/dsh-jobs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { canonical } from './permissions.js';
import { CoderQueue } from './queue.js';
import { isInside } from './rules.js';
import { workspaceScope } from './verify.js';

interface DirectLease { owner: string; scopes: readonly string[]; release: () => void; open: boolean; jobs: Set<string> }
const CONFLICT = '该工作区正在执行编码任务或直接操作，未执行本次修改/命令。请先查看 coder_status 或 job_output；需补充编码任务时使用 coder_steer，避免同时修改。';

/** Shared exclusion only; this does not grant permissions or replace native execution/approval. */
export class WorkspaceAccess {
  private readonly queue = new CoderQueue(Number.MAX_SAFE_INTEGER);
  private readonly execution = new AsyncLocalStorage<DirectLease>();
  private readonly jobs = new Map<string, DirectLease>();

  acquire(scope: string, signal: AbortSignal) { return this.queue.acquire(signal, scope); }
  close() { this.queue.close(); }

  jobEvent(event: JobEvent) {
    if (event.type === 'registered') {
      const lease = this.execution.getStore();
      if (lease?.open && event.job.owner === lease.owner) { lease.jobs.add(event.job.id); this.jobs.set(event.job.id, lease); }
    } else if (event.type === 'settled' || event.type === 'removed') {
      const lease = this.jobs.get(event.job.id);
      if (lease) { this.jobs.delete(event.job.id); lease.jobs.delete(event.job.id); this.finish(lease); }
    }
  }
  private finish(lease: DirectLease) { if (!lease.open && lease.jobs.size === 0) lease.release(); }

  /** Known native mutators only. Shell commands are opaque, so every bash/pwsh call participates. */
  async withTool<T>(exec: ToolExecution, run: () => Promise<T>, policyWorkspace?: string): Promise<T> {
    const args = exec.arguments as Record<string, unknown> | undefined;
    const editor = exec.name === 'str_replace_editor' && args?.command !== 'view';
    const file = exec.name === 'write' || exec.name === 'edit' || editor;
    const shell = exec.name === 'bash' || exec.name === 'pwsh';
    if (!file && !shell && exec.name !== 'load_workspace_dependencies') return run();
    if (!exec.agent) return run();
    const cwd = policyWorkspace ?? exec.agent.session.header.cwd;
    if (!cwd) throw new Error('无法确定直接操作的工作区，请先在 DSH 中选择项目目录。');
    const scopesOf = async () => {
      const workspace = await canonical(cwd);
      const paths = [workspace];
      const target = file ? args?.[editor ? 'path' : 'file_path'] : shell ? args?.workdir : undefined;
      if (typeof target === 'string') paths.push(await canonical(resolve(workspace, target)));
      const scopes: string[] = [];
      for (let path of paths) {
        // New files/directories still share the existing ancestor's Git worktree lease.
        while (!await stat(path).then(info => info.isDirectory(), () => false)) {
          const parent = dirname(path); if (parent === path) throw new Error('workspace_scope_unavailable'); path = parent;
        }
        scopes.push(await workspaceScope(path, exec.signal));
      }
      return [...new Set(scopes)].sort();
    };
    const scopes = await scopesOf();
    exec.signal.throwIfAborted();
    const parent = this.execution.getStore();
    if (parent?.open && parent.owner === exec.agent.id && scopes.every(scope => parent.scopes.some(root => isInside(root, scope)))) return run();
    const release = this.queue.tryAcquire(scopes);
    if (!release) throw new Error(CONFLICT);
    const lease: DirectLease = { owner: exec.agent.id, scopes, release, open: true, jobs: new Set() };
    try {
      if (JSON.stringify(await scopesOf()) !== JSON.stringify(scopes)) throw new Error('直接操作的工作区路径已变化，请重新核对。');
      exec.signal.throwIfAborted();
      return await this.execution.run(lease, run);
    } finally { lease.open = false; this.finish(lease); }
  }
}

export function installWorkspaceAccess(ctx: Context) {
  const access = new WorkspaceAccess();
  // Reject existing conflicts before asking for approval, then reacquire/revalidate at actual execution.
  ctx.on('tools/pre-execute', (exec, next) => access.withTool(exec, next,
    exec.agent ? ctx.sandboxPolicy?.resolve({ session: exec.agent.session }).workspaceRoot : undefined), { prepend: true });
  ctx.on('tools/execute', (exec, next) => access.withTool(exec, next,
    exec.agent ? ctx.sandboxPolicy?.resolve({ session: exec.agent.session }).workspaceRoot : undefined), { prepend: true });
  ctx.effect(() => ctx.jobs.events?.subscribe({ owners: 'scope' }, event => access.jobEvent(event)));
  ctx.effect(() => () => access.close());
  return access;
}
