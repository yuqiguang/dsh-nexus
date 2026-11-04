import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Context } from '@deepseek-ai/cordis';
import type { JobEvent } from '@deepseek-ai/dsh-jobs';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { canonical } from './permissions.js';
import { CODER_RUNTIME_CALL } from './runtime.js';
import { CoderQueue } from './queue.js';
import { isInside } from './rules.js';
import { workspaceScope } from './verify.js';

interface DirectLease { owner: string; agents: Set<string>; scopes: readonly string[]; release: () => void; open: boolean; shares: number; jobs: Set<string> }
const CODER_CONFLICT = '该工作区正在执行编码任务，未执行本次修改/命令。请先查看 coder_status；需补充编码任务时使用 coder_steer，避免同时修改。';
const DIRECT_CONFLICT = '另一个会话正在该工作区执行命令或修改，未执行本次修改/命令。请等待其完成，或在该会话用 job_output/job_kill 处理后台任务。';
const OWN_PARTIAL = '本会话的后台任务正在使用该工作区，本次操作还涉及另一个工作区，未执行。请把命令限定在同一工作区，或等后台任务结束后再执行。';
/** Subagent links seen on tool calls; the delegating call itself records each child's parent before the child runs. */
const PARENT_LIMIT = 2000;
const overlaps = (a: readonly string[], b: readonly string[]) => a.some(left => b.some(right => isInside(left, right) || isInside(right, left)));

/** Shared exclusion only; this does not grant permissions or replace native execution/approval. */
export class WorkspaceAccess {
  private readonly queue = new CoderQueue(Number.MAX_SAFE_INTEGER);
  private readonly execution = new AsyncLocalStorage<DirectLease>();
  private readonly jobs = new Map<string, DirectLease>();
  private readonly direct = new Set<DirectLease>();
  private readonly coders = new Set<readonly string[]>();
  private readonly parents = new Map<string, string>();

  /** Subagents act for their root session, so they share its leases. */
  private rootOf(agent: NonNullable<ToolExecution['agent']>): string {
    const parent = agent.session.header.parentSession;
    if (parent && !this.parents.has(agent.id)) {
      if (this.parents.size >= PARENT_LIMIT) this.parents.delete(this.parents.keys().next().value!);
      this.parents.set(agent.id, parent);
    }
    let id: string = agent.id;
    for (let hops = 0; hops < 16 && this.parents.has(id); hops++) id = this.parents.get(id)!;
    return id;
  }

  async acquire(scope: string, signal: AbortSignal) {
    const release = await this.queue.acquire(signal, scope);
    const scopes = [scope]; this.coders.add(scopes);
    return () => { this.coders.delete(scopes); release(); };
  }
  close() { this.queue.close(); }

  jobEvent(event: JobEvent) {
    if (event.type === 'registered') {
      const lease = this.execution.getStore();
      if (lease && (lease.open || lease.shares > 0) && (event.job.owner === lease.owner || lease.agents.has(event.job.owner ?? ''))) { lease.jobs.add(event.job.id); this.jobs.set(event.job.id, lease); }
    } else if (event.type === 'settled' || event.type === 'removed') {
      const lease = this.jobs.get(event.job.id);
      if (lease) { this.jobs.delete(event.job.id); lease.jobs.delete(event.job.id); this.finish(lease); }
    }
  }
  private finish(lease: DirectLease) { if (!lease.open && lease.shares === 0 && lease.jobs.size === 0) { this.direct.delete(lease); lease.release(); } }

  /** Known native mutators only. Shell commands are opaque, so every bash/pwsh call participates. */
  async withTool<T>(exec: ToolExecution, run: () => Promise<T>, policyWorkspace?: string): Promise<T> {
    const args = exec.arguments as Record<string, unknown> | undefined;
    const editor = exec.name === 'str_replace_editor' && args?.command !== 'view';
    const file = exec.name === 'write' || exec.name === 'edit' || editor;
    const shell = exec.name === 'bash' || exec.name === 'pwsh';
    if (exec.agent) this.rootOf(exec.agent);
    if (!file && !shell && exec.name !== 'load_workspace_dependencies') return run();
    if (exec.name === 'load_workspace_dependencies' && String(exec.callId ?? '').endsWith(CODER_RUNTIME_CALL)) return run();
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
    const owner = this.rootOf(exec.agent);
    const parent = this.execution.getStore();
    if (parent?.open && parent.owner === owner && scopes.every(scope => parent.scopes.some(root => isInside(root, scope)))) return run();
    const release = this.queue.tryAcquire(scopes);
    if (!release) {
      // The same session (or its subagents) may keep working beside its own background jobs; coders and other sessions stay excluded.
      if ([...this.coders].some(active => overlaps(active, scopes))) throw new Error(CODER_CONFLICT);
      const held = [...this.direct].filter(lease => overlaps(lease.scopes, scopes));
      if (!held.length) throw new Error(CODER_CONFLICT);
      if (held.some(lease => lease.owner !== owner)) throw new Error(DIRECT_CONFLICT);
      // Pin the shared lease so it outlives this call and adopts any background job it starts.
      const shared = held.find(lease => scopes.every(scope => lease.scopes.some(root => isInside(root, scope))));
      if (!shared) throw new Error(OWN_PARTIAL);
      shared.shares++; shared.agents.add(exec.agent.id);
      try { return await this.execution.run(shared, run); } finally { shared.shares--; this.finish(shared); }
    }
    const lease: DirectLease = { owner, agents: new Set([exec.agent.id]), scopes, release, open: true, shares: 0, jobs: new Set() };
    this.direct.add(lease);
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
