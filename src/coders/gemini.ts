import { coderPrompt } from './brief.js';
import { narration, codexTextQuestion, redact } from './normalize.js';
import { WINDOWS_CODER_GUIDANCE } from './runtime.js';
import { LOCAL_CHECK_GUIDANCE, RESEARCH_GUIDANCE, type ResearchBridge } from './research.js';
import { parseTurnResult, type CodexTurnResult } from './turn-result.js';
import { exceptionFailure, failureLabel, safeFailureDetail, RESUME_PROMPT, type CoderRun, type CoderOutcome, type RetryNotice } from './retry.js';
import { createGeminiToolsBridge, type GeminiToolsDeps } from './gemini-tools.js';
import { GEMINI_MCP_NAMES, GEMINI_STRICT_PROBLEM, prepareGeminiLaunch, type GeminiLaunch } from './gemini-config.js';
import { spawnGeminiAcp, type GeminiProcess, type GeminiSpawn } from './gemini-process.js';
import type { TaskRecord } from './types.js';

export interface GeminiRunDeps extends Omit<GeminiToolsDeps, 'env' | 'onResult'> {
  launch: GeminiLaunch;
  spawn?: GeminiSpawn;
  instructions?: string;
  continuation?: boolean;
  research?: ResearchBridge;
  onSession?(sessionId: string): void;
  onRetry?(notice: RetryNotice | undefined): void;
}

type Rpc = { id?: number | string; method?: string; params?: Record<string, any>; result?: any; error?: { code?: number; message?: string } };
const RESULT_GUIDANCE = '\n[Gemini 任务接口]\n使用 nexus_coder 的 read_file、write_file、replace_text、command 执行项目工作；它们将完整请求交给 DSH 监工审核。需要用户决定时调用 ask_question 并等待原用户回答。结束时必须以 report_result 作为最后一个工具调用，提供 completed、needs_input 或 blocked 状态与明确结果，然后结束回合。未完成目标不能报告 completed；不要把可选建议当作阻塞问题。任务的最终验收仍由宿主独立运行。';

/** ACP owns the Gemini conversation; the private MCP bridges own every project operation and native question. */
export function runGeminiTask(task: TaskRecord, deps: GeminiRunDeps): CoderRun {
  const controller = new AbortController();
  let process: GeminiProcess | undefined, sessionId = task.coderSessionId, nextId = 0;
  let lastText = '', reported: CodexTurnResult | undefined, prompting = false, closing = false;
  let cancelled: string | undefined;
  const currentResult = () => reported;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let finish: (outcome: CoderOutcome) => void = () => {};
  const finished = new Promise<CoderOutcome>(resolve => { finish = resolve; });
  const send = (method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<any> => {
    controller.signal.throwIfAborted();
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { pending.delete(id); reject(new Error(`Gemini ${method} 响应超时。`)); }, timeoutMs) : undefined;
      timer?.unref();
      pending.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      try { process!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
      catch (error) { pending.get(id)?.reject(error as Error); pending.delete(id); }
    });
  };
  const fail = (error: unknown): CoderOutcome => {
    const failure = exceptionFailure(error);
    let detail = (error as Error)?.message ?? String(error);
    for (const [name, value] of Object.entries(deps.launch.env)) if (value && /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(name)) detail = detail.split(value).join('***');
    return { status: 'failed', result: reported?.text ?? lastText,
      detail: failure ? failureLabel(failure) : safeFailureDetail(redact(detail)), ...(failure ? { providerFailure: failure } : {}) };
  };
  function incoming(message: Rpc): void {
    if (closing) return;
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(Number(message.id));
      if (!waiter) return;
      pending.delete(Number(message.id));
      if (message.error) {
        const error = new Error(message.error.message ?? 'Gemini ACP 请求失败。');
        // Gemini reports HTTP failures as ACP error codes. JSON-RPC's negative
        // protocol codes must not become provider statuses or trigger recovery.
        if (Number.isInteger(message.error.code) && message.error.code! >= 400 && message.error.code! <= 599) Object.assign(error, { status: message.error.code });
        waiter.reject(error);
      } else waiter.resolve(message.result);
      return;
    }
    const params = message.params ?? {};
    if (message.method === 'session/update') {
      if (sessionId && params.sessionId !== sessionId) {
        finish({ status: 'failed', detail: 'Gemini 返回了不同会话的消息，任务已停止。', result: lastText });
        return;
      }
      if (!prompting) return; // session/load streams historical messages before the new work starts.
      const update = params.update ?? {};
      if (update._meta?.retry === true) {
        reported = undefined;
        if (update._meta.reset === true) { lastText = ''; deps.onRetry?.(undefined); }
        else deps.onRetry?.({ failure: { kind: 'network' } });
      }
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
        deps.onRetry?.(undefined);
        lastText = (lastText + update.content.text).slice(-48_000);
      } else if (update.sessionUpdate === 'tool_call') {
        reported = undefined; deps.onRetry?.(undefined);
        const said = narration(lastText); if (said) deps.onActivity?.(said);
        lastText = '';
      } else if (update.sessionUpdate === 'tool_call_update' && update.status === 'failed') {
        reported = undefined;
      }
      return;
    }
    if (message.id === undefined || !message.method) return;
    if (message.method === 'session/request_permission') {
      const mcp = params.toolCall?._meta?.['gemini-cli']?.mcp;
      // This authorizes access to our bridge, whose complete request still passes deps.decide. Never approve a native tool by its title.
      const allowed = params.sessionId === sessionId && GEMINI_MCP_NAMES.includes(mcp?.server_name);
      const once = allowed && Array.isArray(params.options) ? params.options.find((option: any) => option.kind === 'allow_once' && typeof option.optionId === 'string') : undefined;
      process!.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: once ? { outcome: 'selected', optionId: once.optionId } : { outcome: 'cancelled' } } }));
      if (!once) finish({ status: 'failed', detail: 'Gemini 请求了未接入监工的原生工具，任务已停止。', result: lastText });
      return;
    }
    process!.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unsupported Gemini request: ${message.method}` } }));
    finish({ status: 'failed', detail: 'Gemini 请求了不支持的客户端能力，任务已停止。', result: lastText });
  }
  const done = (async (): Promise<CoderOutcome> => {
    if (task.permissions?.securityMode === 'strict') return { status: 'failed', detail: GEMINI_STRICT_PROBLEM, result: '' };
    if (sessionId && !/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return { status: 'failed', detail: 'Gemini 原会话 ID 无效，不能续接。', result: '' };
    let prepared: Awaited<ReturnType<typeof prepareGeminiLaunch>> | undefined;
    let tools: ResearchBridge | undefined;
    let reading: Promise<void> | undefined, session: Promise<CoderOutcome> | undefined;
    let outcome: CoderOutcome;
    try {
      prepared = await prepareGeminiLaunch(deps.launch, task.cwd);
      controller.signal.throwIfAborted();
      tools = await createGeminiToolsBridge(task, { ...deps, env: deps.launch.env, onResult: result => { reported = result; } }, controller.signal);
      process = (deps.spawn ?? spawnGeminiAcp)(prepared.cwd, prepared.launch);
      reading = (async () => {
        for await (const line of process!.lines) {
          let message: Rpc;
          try { message = JSON.parse(line) as Rpc; } catch { continue; }
          incoming(message);
        }
      })();
      void reading.catch(() => finish({ status: 'failed', providerFailure: { kind: 'network' }, detail: 'Gemini ACP 输出连接中断。', result: lastText }));
      session = (async (): Promise<CoderOutcome> => {
        const initialized = await send('initialize', { protocolVersion: 1, clientInfo: { name: 'dsh-nexus', version: '0.2.72' }, clientCapabilities: {} }, 60_000);
        if (initialized?.protocolVersion !== 1) throw new Error('Gemini 未确认支持 ACP 协议版本 1。');
        if (task.coderSessionId && initialized.agentCapabilities?.loadSession !== true) throw new Error('此 Gemini 版本不支持原会话恢复。');
        const mcpServers = [{ name: 'nexus_coder', type: 'http', url: tools!.url, headers: [{ name: 'Authorization', value: `Bearer ${tools!.token}` }] },
          ...(deps.research ? [{ name: 'nexus_web', type: 'http', url: deps.research.url, headers: [{ name: 'Authorization', value: `Bearer ${deps.research.token}` }] }] : [])];
        const loaded = task.coderSessionId
          ? await send('session/load', { sessionId: task.coderSessionId, cwd: prepared!.workspace, mcpServers }, 60_000)
          : await send('session/new', { cwd: prepared!.workspace, mcpServers }, 60_000);
        if (!loaded || typeof loaded !== 'object') throw new Error('Gemini 未返回有效会话。');
        if (task.coderSessionId) {
          if (loaded.sessionId !== undefined && loaded.sessionId !== task.coderSessionId) throw new Error('Gemini 未恢复原会话，任务已停止。');
          sessionId = task.coderSessionId; // ACP load returns modes/models, rather than a replacement session identifier.
        } else {
          if (typeof loaded.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(loaded.sessionId)) throw new Error('Gemini 没有返回有效会话 ID。');
          sessionId = loaded.sessionId;
        }
        controller.signal.throwIfAborted();
        deps.onSession?.(sessionId!);
        let prompt = (deps.continuation ? RESUME_PROMPT : coderPrompt(task)) + (deps.instructions ?? '') + RESULT_GUIDANCE
          + `\n项目实际目录：${task.cwd}。Gemini 当前目录仅用于会话存储；项目调查、读写和命令全部使用 nexus_coder 工具，相对路径从项目实际目录计算。`
          + (globalThis.process.platform === 'win32' ? WINDOWS_CODER_GUIDANCE : '')
          + (deps.research?.webResearch ? RESEARCH_GUIDANCE : '') + (deps.research?.localChecks ? LOCAL_CHECK_GUIDANCE : '');
        for (let questions = 0; ; questions++) {
          lastText = ''; reported = undefined; prompting = true;
          const response = await send('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
          prompting = false;
          controller.signal.throwIfAborted();
          if (response?.stopReason === 'cancelled') return { status: 'killed', detail: cancelled ?? 'Gemini 回合已取消。', result: currentResult()?.text ?? lastText };
          if (response?.stopReason !== 'end_turn') return { status: 'failed', detail: `Gemini 回合未正常结束：${String(response?.stopReason ?? 'unknown')}`, result: currentResult()?.text ?? lastText };
          const result = currentResult() ?? parseTurnResult(lastText);
          if (!result) return { status: 'failed', detail: 'Gemini 未提供有效结构化任务结果，未确认完成；请检查工具版本或续接。', result: lastText };
          const said = narration(result.text); if (said) deps.onActivity?.(said);
          if (result.status === 'completed') return { status: 'completed', result: result.text };
          if (result.status === 'blocked') return { status: 'failed', detail: 'Gemini 报告任务受阻。', result: result.text };
          if (questions >= 5) return { status: 'failed', detail: 'Gemini 澄清次数达到上限，请核对目标后续接。', result: result.text };
          const request = { ...codexTextQuestion(result.text), tool: 'gemini.message' };
          const decision = await deps.decide(request, controller.signal);
          prompt = decision.behavior === 'allow' ? String((decision.updatedInput?.answers as Record<string, string> | undefined)?.[result.text.trim()] ?? '') : '';
          if (!prompt) return { status: 'failed', detail: 'Gemini 的提问没有得到回答。', result: result.text };
        }
      })().catch(fail);
      outcome = await Promise.race([session, finished, process.exited.then((): CoderOutcome => fail(new Error(`Gemini ACP 进程提前退出。${process?.diagnostic?.trim() ? `\n${process.diagnostic.trim()}` : ''}`)))]);
    } catch (error) { outcome = fail(error); }
    if (cancelled !== undefined) outcome = { status: 'killed', detail: cancelled, result: outcome.result };
    closing = true; controller.abort(new Error('Gemini 任务已结束。'));
    for (const waiter of pending.values()) waiter.reject(new Error('Gemini ACP 会话已关闭。'));
    pending.clear();
    process?.kill();
    const exit = process ? await Promise.race([process.exited, new Promise<null>(resolve => { setTimeout(() => resolve(null), 6000).unref(); })]) : 0;
    await Promise.allSettled([reading, session, tools?.close()]);
    try { await prepared?.close(); } catch (error) { return fail(error); }
    if (exit === null && (outcome.status === 'completed' || outcome.providerFailure)) return { status: 'failed', detail: '无法确认 Gemini 进程已完全清理，不能自动续接。', result: outcome.result };
    return outcome;
  })();
  return { done, cancel(reason = 'user cancelled') {
    if (closing || controller.signal.aborted) return;
    cancelled = reason; controller.abort(new Error(reason));
    if (process && sessionId) {
      try { process.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })); } catch { /* already disconnected */ }
    }
    finish({ status: 'killed', detail: reason, result: reported?.text ?? lastText });
  } };
}
