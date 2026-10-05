import { CODEX_RESULT_SCHEMA, parseTurnResult } from './turn-result.js';
import { coderPrompt } from './brief.js';
import { WINDOWS_CODER_GUIDANCE } from './runtime.js';
import { requireWindowsFirewall } from './windows-firewall.js';
import { LOCAL_CHECK_GUIDANCE, RESEARCH_GUIDANCE, RESEARCH_TOKEN_ENV, type ResearchBridge } from './research.js';
import type { TaskPermissions } from './permissions.js';
import { isInside } from './rules.js';
import { codexFailure, exceptionFailure, failureLabel, safeFailureDetail, RESUME_PROMPT, type CodexError, type CoderRun, type CoderOutcome as JobOutcome, type RetryNotice } from './retry.js';
import { codexCommandRequest, codexFileChangeRequest, codexPermissionRequest, codexQuestionRequest, codexStep, codexTextQuestion, narration, outputTail } from './normalize.js';
import { commandMentionsEnvironment } from './rules.js';
import type { CoderDecision, CoderRequest, TaskRecord } from './types.js';

import { spawnCodexAppServer, type CodexProcess, type CodexLaunch, type CodexSpawn } from './codex-process.js';
export { APP_SERVER_ARGS, WINDOWS_CODEX_ARGS, spawnCodexAppServer, type CodexProcess, type CodexLaunch, type CodexSpawn } from './codex-process.js';
const MAX_QUESTION_ROUNDS = 5;

/** A running Codex task's hooks, plus a way to talk to it mid-turn. */
export interface CodexHooks extends CoderRun {
  /**
   * Put the user's words into the running task. Without `interrupt` they join the current turn (`turn/steer`) and Codex reads them at
   * its next step; a pending approval still waits for its answer. With `interrupt` the turn stops, its pending approvals are withdrawn,
   * and the words start the next turn on the same thread. Rejects when no turn is in progress.
   */
  steer(text: string, interrupt: boolean): Promise<void>;
}

export interface CodexRunDeps {
  instructions?: string;
  continuation?: boolean;
  onRetry?(notice: RetryNotice | undefined): void;
  research?: ResearchBridge;
  spawn?: CodexSpawn;
  launch?: CodexLaunch;
  /** Model override for the thread; only used when settings ask for one. */
  model?: string;
  decide(request: CoderRequest, signal: AbortSignal): Promise<CoderDecision>;
  onSession?(threadId: string): void;
  /** One line per step the coder takes: a command, a file edit, what it says about its work. */
  onActivity?(text: string): void;
  /** Detail for the job's own panel only, never the model or the task record: a command's exit code and the end of its output. */
  onLog?(text: string): void;
  onFailure?(key: string): void;
  onSuccess?(): void;
  /** Fake clock for tests. */
  now?: () => number;
}

type JsonRpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };

/** Names the mismatch when a `thread/start` response reports policies other than the requested ones; undefined when it matches or says nothing. */
export function threadPolicyDrift(response: { approvalPolicy?: unknown; sandbox?: unknown }, expected?: TaskPermissions): string | undefined {
  // The request uses kebab-case (`workspace-write`); the echoed settings use camelCase (`workspaceWrite`). Compare shape-insensitively.
  const same = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase().replace(/[-_]/g, '') === expected.replace(/-/g, '');
  if (expected?.securityMode === 'full') {
    const sandbox = response.sandbox;
    const type = sandbox && typeof sandbox === 'object' ? (sandbox as { type?: unknown }).type : sandbox;
    return same(response.approvalPolicy, 'never') && same(type, 'danger-full-access') ? undefined : '未确认完全权限策略（never / dangerFullAccess）';
  }
  const problems: string[] = [];
  if (response.approvalPolicy !== undefined && response.approvalPolicy !== null && !same(response.approvalPolicy, 'untrusted')) problems.push(`approvalPolicy=${JSON.stringify(response.approvalPolicy)}`);
  const sandbox = response.sandbox;
  const mode = typeof sandbox === 'string' ? sandbox : sandbox && typeof sandbox === 'object' ? (sandbox as { type?: unknown; mode?: unknown }).type ?? (sandbox as { mode?: unknown }).mode : undefined;
  if (sandbox !== undefined && sandbox !== null && !same(mode, 'workspace-write')) problems.push(`sandbox=${JSON.stringify(mode ?? sandbox)}`);
  if (expected) {
    if (!same(response.approvalPolicy, 'untrusted')) problems.push('未确认审批策略');
    const value = sandbox && typeof sandbox === 'object' ? sandbox as Record<string, unknown> : {};
    if (!same(mode, 'workspace-write') || value.networkAccess !== (expected.securityMode === 'standard') || value.excludeTmpdirEnvVar !== true || value.excludeSlashTmp !== true)
      problems.push('未确认网络策略和临时目录写入边界');
    if (!Array.isArray(value.writableRoots) || value.writableRoots.some(root => typeof root !== 'string' || !expected.writableRoots.some(allowed => isInside(allowed, root))))
      problems.push('写入范围未确认或超出任务目录');
  }
  return problems.length ? problems.join('，') : undefined;
}

function textOf(item: unknown): string {
  return item && typeof item === 'object' && (item as { type?: unknown }).type === 'agentMessage'
    && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : '';
}

/**
 * Run one task in Codex through `codex app-server`. Every approval request and
 * user-input request reaches `deps.decide`; the returned hooks fit a native job.
 */
export function runCodexTask(task: TaskRecord, deps: CodexRunDeps): CodexHooks {
  const controller = new AbortController();
  let cancelReason: string | undefined;
  let process: CodexProcess | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let nextId = 0;
  const requests = new Set<Promise<void>>();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const itemPaths = new Map<string, string[]>();
  const itemDiffs = new Map<string, string>();
  const itemChanges = new Map<string, { path: string; diff: string }[]>();
  let lastAssistant = '';
  let turnText = '';
  let turnItems: unknown[] = [];
  let questionRounds = 0;
  let turnActive = false;
  /** Aborts the requests of the current turn when the user interrupts it; the task's own controller stays live. */
  let turnAbort = new AbortController();
  /** What the user said when interrupting; it starts the next turn once the current one ends. */
  let redirect: string | undefined;
  const errors: CodexError[] = [];
  let nativeRetryAttempt = 0;
  let finish: (outcome: JobOutcome) => void = () => {};
  const finished = new Promise<JobOutcome>(resolve => { finish = resolve; });

  const send = (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const id = ++nextId;
    process!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const notify = (method: string, params: Record<string, unknown> = {}) => {
    process!.write(JSON.stringify({ jsonrpc: '2.0', method, params }));
  };
  const respond = (id: number | string, result: unknown) => {
    process!.write(JSON.stringify({ jsonrpc: '2.0', id, result }));
  };
  const respondError = (id: number | string, message: string) => {
    process!.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message } }));
  };

  async function startTurn(text: string): Promise<void> {
    turnText = '';
    turnItems = [];
    const result = await send('turn/start', { threadId, outputSchema: CODEX_RESULT_SCHEMA, input: [{ type: 'text', text }], ...(task.permissions?.securityMode === 'full' ? { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } : task.permissions ? { approvalPolicy: 'untrusted', sandboxPolicy: { type: 'workspaceWrite', writableRoots: task.permissions.writableRoots, networkAccess: task.permissions.securityMode === 'standard', excludeTmpdirEnvVar: true, excludeSlashTmp: true } } : {}) }) as { turn?: { id?: string } };
    turnId = result?.turn?.id;
    turnAbort = new AbortController();
    turnActive = true;
  }

  async function handleRequest(message: JsonRpc): Promise<void> {
    const id = message.id!;
    const params = message.params ?? {};
    const signal = AbortSignal.any([controller.signal, turnAbort.signal]);
    switch (message.method) {
      case 'item/commandExecution/requestApproval': {
        const decision = await deps.decide(codexCommandRequest(params, task.cwd), signal);
        respond(id, { decision: decision.behavior === 'allow' ? 'accept' : decision.interrupt ? 'cancel' : 'decline' });
        return;
      }
      case 'item/fileChange/requestApproval': {
        const itemId = String(params.itemId ?? '');
        const decision = await deps.decide(codexFileChangeRequest(params, itemPaths.get(itemId) ?? [], itemDiffs.get(itemId) ?? '', task.cwd, itemChanges.get(itemId)), signal);
        respond(id, { decision: decision.behavior === 'allow' ? 'accept' : decision.interrupt ? 'cancel' : 'decline' });
        return;
      }
      case 'item/tool/requestUserInput': {
        const request = codexQuestionRequest(params);
        const decision = await deps.decide(request, signal);
        const answers: Record<string, { answers: string[] }> = {};
        const given = decision.behavior === 'allow' ? (decision.updatedInput?.answers as Record<string, string> | undefined) ?? {} : {};
        for (const [index, question] of (request.questions ?? []).entries()) {
          const questionId = String((request.raw.questionIds as string[] | undefined)?.[index] ?? index);
          const value = given[question.question] ?? '';
          answers[questionId] = { answers: value ? [value] : [] };
        }
        respond(id, { answers });
        return;
      }
      case 'item/permissions/requestApproval': {
        const decision = await deps.decide(codexPermissionRequest(params, task.cwd), signal);
        respond(id, decision.behavior === 'allow' ? { permissions: params.permissions ?? {}, scope: 'turn' } : { permissions: {} });
        return;
      }
      default:
        respondError(id, `unsupported server request ${message.method}`);
    }
  }

  function handleNotification(message: JsonRpc): void {
    if (['item/started', 'item/agentMessage/delta', 'item/completed'].includes(message.method ?? '')) deps.onRetry?.(undefined);
    const params = message.params ?? {};
    switch (message.method) {
      case 'item/started':
      case 'item/completed': {
        const item = params.item as { type?: string; id?: string; changes?: { path?: string; diff?: string }[] } | undefined;
        if (!item?.id) return;
        if (item.type === 'fileChange') {
          itemPaths.set(item.id, (item.changes ?? []).flatMap(change => change.path ? [change.path] : []));
          itemDiffs.set(item.id, (item.changes ?? []).map(change => `--- ${change.path}\n${change.diff ?? ''}`).join('\n'));
          itemChanges.set(item.id, (item.changes ?? []).flatMap(change => typeof change.path === 'string' && typeof change.diff === 'string' ? [{ path: change.path, diff: change.diff }] : []));
        }
        if (message.method === 'item/started') {
          const step = codexStep(item, task.cwd);
          if (step) deps.onActivity?.(step);
        } else {
          turnItems.push(item);
          const text = textOf(item);
          if (text) { turnText = text; lastAssistant = parseTurnResult(text)?.text ?? text; const said = narration(lastAssistant); if (said) deps.onActivity?.(said); }
          if (item.type === 'fileChange' && (item as { status?: unknown }).status === 'completed') deps.onSuccess?.();
          if (item.type === 'commandExecution') {
            const done = item as { command?: unknown; exitCode?: unknown; aggregatedOutput?: unknown };
            if (typeof done.exitCode === 'number' && done.exitCode !== 0 && typeof done.command === 'string') deps.onFailure?.(`command:${done.command}`);
            else if (done.exitCode === 0) deps.onSuccess?.();
            const output = typeof done.aggregatedOutput === 'string' ? done.aggregatedOutput : '';
            deps.onLog?.([typeof done.exitCode === 'number' ? `退出码 ${done.exitCode}` : '', typeof done.command === 'string' && commandMentionsEnvironment(done.command) ? '环境配置内容已隐藏。' : output.trim() ? outputTail(output) : ''].filter(Boolean).join('\n'));
          }
        }
        return;
      }
      case 'error': {
        const error = params.error as CodexError | undefined;
        if (params.willRetry === true) {
          deps.onRetry?.({ failure: codexFailure(error) ?? { kind: 'permanent' }, attempt: ++nativeRetryAttempt });
        } else if (error) errors.push(error);
        return;
      }
      case 'turn/completed': {
        const turn = params.turn as { status?: string; error?: CodexError | null; items?: unknown[] } | undefined;
        void completeTurn(turn);
        return;
      }
      default:
    }
  }

  async function completeTurn(turn: { status?: string; error?: CodexError | null; items?: unknown[] } | undefined): Promise<void> {
    if (controller.signal.aborted) return;
    turnActive = false;
    // The user interrupted to change course: whether the turn stopped or had just finished, their words start the next one.
    if (redirect !== undefined && turn?.status !== 'failed') {
      const text = redirect;
      redirect = undefined;
      try { await startTurn(text); }
      catch (error) { finish({ status: 'failed', detail: safeFailureDetail((error as Error)?.message ?? String(error)), result: lastAssistant }); }
      return;
    }
    const items = turn?.items?.length ? turn.items : turnItems;
    if (turn?.status === 'failed') {
      const error = turn.error ?? errors.at(-1), failure = codexFailure(error);
      return finish({ status: 'failed', detail: failure ? failureLabel(failure) : safeFailureDetail(error?.message ?? 'turn failed'), result: lastAssistant,
        ...(failure ? { providerFailure: failure } : {}) });
    }
    if (turn?.status === 'interrupted') return finish({ status: 'killed', detail: cancelReason ?? 'interrupted', result: lastAssistant });
    const raw = [...(items ?? [])].reverse().map(textOf).find(Boolean) ?? turnText;
    const result = parseTurnResult(raw);
    if (!result) return finish({ status: 'failed', detail: 'Codex 未返回有效的结构化任务结果；未确认完成，请检查编码工具版本或续接。', result: raw });
    const text = result.text;
    lastAssistant = text;
    if (result.status === 'blocked') return finish({ status: 'failed', detail: '编码工具报告任务受阻', result: text });
    if (result.status === 'needs_input') {
      if (questionRounds >= MAX_QUESTION_ROUNDS) return finish({ status: 'failed', detail: '澄清次数达到上限，仍有问题未解决；请核对目标后续接。', result: text });
      questionRounds++;
      try {
        const decision = await deps.decide(codexTextQuestion(text), controller.signal);
        const answer = decision.behavior === 'allow' ? String((decision.updatedInput?.answers as Record<string, string> | undefined)?.[text.trim()] ?? '') : '';
        if (controller.signal.aborted) return;
        if (!answer) return finish({ status: 'failed', detail: 'Codex 的提问没有得到回答', result: text });
        await startTurn(answer);
        return;
      } catch (error) {
        return finish({ status: 'failed', detail: safeFailureDetail((error as Error)?.message ?? String(error)), result: text });
      }
    }
    finish({ status: 'completed', result: text });
  }

  const done = (async (): Promise<JobOutcome> => {
    try {
      const launch = deps.launch ?? { command: 'codex', env: globalThis.process.env };
      process = (deps.spawn ?? spawnCodexAppServer)(task.cwd, { ...launch, fullAccess: task.permissions?.securityMode === 'full', ...(deps.research ? { env: { ...launch.env, [RESEARCH_TOKEN_ENV]: deps.research.token } } : {}) });
    } catch (error) {
      return { status: 'failed', detail: `无法启动 codex app-server：${(error as Error)?.message ?? String(error)}`, result: '' };
    }
    const reading = (async () => {
      for await (const line of process!.lines) {
        if (!line.trim()) continue;
        let message: JsonRpc;
        try { message = JSON.parse(line) as JsonRpc; } catch { continue; }
        if (message.id !== undefined && message.method === undefined) {
          const waiter = pending.get(Number(message.id));
          if (!waiter) continue;
          pending.delete(Number(message.id));
          if (message.error) waiter.reject(new Error(message.error.message ?? 'codex request failed'));
          else waiter.resolve(message.result);
        } else if (message.id !== undefined && message.method) {
          const request = handleRequest(message).catch(error => {
            if (!turnAbort.signal.aborted && !controller.signal.aborted) respondError(message.id!, (error as Error)?.message ?? String(error));
          });
          requests.add(request); void request.then(() => requests.delete(request), () => requests.delete(request));
        } else if (message.method) {
          handleNotification(message);
        }
      }
    })();
    void reading.catch(() => finish({ status: 'failed', detail: 'Codex 输出连接中断，任务已停止。', providerFailure: { kind: 'network' }, result: lastAssistant }));
    const session = (async () => {
      await send('initialize', { clientInfo: { name: 'dsh-nexus', version: '0.1.0' }, capabilities: {} });
      notify('initialized');
      if (globalThis.process.platform === 'win32' && task.permissions?.securityMode !== 'full') {
        if (task.permissions?.securityMode !== 'standard') await requireWindowsFirewall();
        const readiness = await send('windowsSandbox/readiness', {}) as { status?: string };
        if (readiness.status !== 'ready') throw new Error('Windows 增强沙箱未就绪，请先在编码工具设置中配置沙箱。');
      }
      const policy = { cwd: task.cwd, approvalPolicy: task.permissions?.securityMode === 'full' ? 'never' : 'untrusted', sandbox: task.permissions?.securityMode === 'full' ? 'danger-full-access' : 'workspace-write', ...(deps.model ? { model: deps.model } : {}), ...(task.permissions ? { config: { ...(deps.research ? { 'mcp_servers.nexus_web': { url: deps.research.url, bearer_token_env_var: RESEARCH_TOKEN_ENV, enabled: true, startup_timeout_sec: 15, tool_timeout_sec: 130 } } : {}), web_search: task.permissions.webResearch ? 'live' : 'disabled', 'sandbox_workspace_write.network_access': task.permissions.securityMode === 'standard', 'sandbox_workspace_write.writable_roots': task.permissions.writableRoots, 'sandbox_workspace_write.exclude_tmpdir_env_var': true, 'sandbox_workspace_write.exclude_slash_tmp': true, 'shell_environment_policy.exclude': ['*TOKEN*', '*SECRET*', '*PASSWORD*', '*KEY*', '*AUTH*', '*PROXY*', 'DSH_*'] } } : {}) };
      // A task that continues another resumes its thread under the same policies; the history stays on Codex's side.
      const method = task.coderSessionId ? 'thread/resume' : 'thread/start';
      const started = await send(method, task.coderSessionId ? { threadId: task.coderSessionId, excludeTurns: true, ...policy } : policy) as
        { thread?: { id?: string }; approvalPolicy?: unknown; sandbox?: unknown };
      threadId = started?.thread?.id;
      if (!threadId) throw new Error(`codex ${method} 没有返回线程 ID`);
      if (task.coderSessionId && threadId !== task.coderSessionId) throw new Error('Codex 未恢复原线程，任务已停止。');
      // Codex echoes the effective policies; a Codex that ignored the thread parameters must not run unattended.
      const drift = threadPolicyDrift(started, task.permissions);
      if (drift) throw new Error(`Codex 没有采用监工要求的策略：${drift}`);
      deps.onSession?.(threadId);
      await startTurn((deps.continuation ? RESUME_PROMPT : coderPrompt(task)) + (deps.instructions ?? '') + (globalThis.process.platform === 'win32' ? WINDOWS_CODER_GUIDANCE : '') + (deps.research ? (deps.research.webResearch === false ? '' : RESEARCH_GUIDANCE) + (deps.research.localChecks ? LOCAL_CHECK_GUIDANCE : '') : ''));
    })();
    const exitedEarly = process.exited.then(code => ({ ...(codexFailure(errors.at(-1)) ? { providerFailure: codexFailure(errors.at(-1)) } : {}), status: 'failed', detail: `codex app-server 退出（${code ?? 'signal'}）${errors.length ? `：${safeFailureDetail(errors.at(-1)?.message ?? '')}` : ''}`, result: lastAssistant } satisfies JobOutcome));
    let outcome: JobOutcome;
    try {
      outcome = await Promise.race([
        finished,
        exitedEarly,
        session.then(() => finished),
      ]);
    } catch (error) {
      const failure = exceptionFailure(error);
      outcome = controller.signal.aborted ? { status: 'killed', detail: cancelReason ?? 'cancelled', result: lastAssistant }
        : { status: 'failed', detail: failure ? failureLabel(failure) : safeFailureDetail((error as Error)?.message ?? String(error)), result: lastAssistant, ...(failure ? { providerFailure: failure } : {}) };
    }
    if (controller.signal.aborted && outcome.status !== 'killed') outcome = { status: 'killed', detail: cancelReason ?? 'cancelled', result: outcome.result ?? lastAssistant };
    turnAbort.abort(new Error('编码回合已结束'));
    await Promise.allSettled(requests);
    for (const waiter of pending.values()) waiter.reject(new Error('codex session closed'));
    pending.clear();
    process.kill();
    const exit = await Promise.race([process.exited, new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 6000).unref())]);
    await reading.catch(() => {});
    if (exit == null && (outcome.status === 'completed' || outcome.providerFailure)) return { status: 'failed', detail: '无法确认任务进程已完全清理，不能自动续接。', result: outcome.result };
    return outcome;
  })();

  return {
    async steer(text, interrupt) {
      if (controller.signal.aborted || !threadId || !turnId || !turnActive || redirect !== undefined) throw new Error('Codex 当前没有进行中的回合。');
      if (!interrupt) {
        await send('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
        return;
      }
      redirect = text;
      turnAbort.abort(new Error('用户打断了这一回合'));
      try { await send('turn/interrupt', { threadId, turnId }); }
      catch (error) { redirect = undefined; throw error; }
    },
    cancel(reason?: string) {
      if (controller.signal.aborted) return;
      cancelReason = reason;
      controller.abort(new Error(reason ?? 'cancelled'));
      if (process && threadId && turnId) { try { notify('turn/interrupt', { threadId, turnId }); } catch { /* process may be gone */ } }
      finish({ status: 'killed', detail: reason ?? 'cancelled', result: lastAssistant });
    },
    done,
  };
}
