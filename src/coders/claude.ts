import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { spawnTaskProcess, closeTaskProcess, taskProcessCleaned } from './process.js';
import { coderPrompt } from './brief.js';
import { WINDOWS_CODER_GUIDANCE } from './runtime.js';
import { LOCAL_CHECK_GUIDANCE, RESEARCH_GUIDANCE, type ResearchBridge } from './research.js';
import { credentialPaths } from './permissions.js';
import { counter, exceptionFailure, failureLabel, providerFailure, safeFailureDetail, RESUME_PROMPT, type CoderRun, type CoderOutcome, type ProviderFailure, type RetryNotice } from './retry.js';
import { pathToFileURL } from 'node:url';
import { claudeStep, claudeToolOutput, narration, normalizeClaudeRequest, outputTail, type ClaudePermissionContext } from './normalize.js';
import { commandMentionsEnvironment, isEnvironmentFile } from './rules.js';
import type { CoderDecision, CoderRequest, TaskRecord } from './types.js';

/** The slice of the Agent SDK message stream this adapter reads. */
export interface ClaudeStreamMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: unknown };
  result?: string;
  is_error?: boolean;
  errors?: string[];
  error?: string;
  parent_tool_use_id?: string | null;
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  rate_limit_info?: { status: string; rateLimitType?: string; resetsAt?: number; overageDisabledReason?: string };
}

export type ClaudePermissionResult = CoderDecision;

export interface ClaudeQueryOptions {
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
  cwd: string;
  permissionMode: 'default' | 'bypassPermissions';
  allowDangerouslySkipPermissions?: boolean;
  sandbox?: { enabled: boolean; failIfUnavailable: boolean; autoAllowBashIfSandboxed: boolean; allowUnsandboxedCommands: boolean;
    network: { allowedDomains: string[]; strictAllowlist: boolean; allowAllUnixSockets: boolean; allowLocalBinding: boolean };
    filesystem: { allowWrite: string[]; denyRead: string[]; denyWrite: string[] };
    credentials?: { envVars: { name: string; mode: 'deny' }[] } };
  hooks?: { PreToolUse: { hooks: ((input: { hook_event_name: string; tool_name: string; tool_input: unknown }, id: string | undefined,
    options: { signal: AbortSignal }) => Promise<{ hookSpecificOutput?: { hookEventName: 'PreToolUse'; permissionDecision: 'allow' | 'deny'; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } }>)[] }[] };
  tools?: string[];
  settingSources?: string[];
  mcpServers?: Record<string, { type: 'http'; url: string; headers: Record<string, string> }>;
  strictMcpConfig?: boolean;
  abortController: AbortController;
  resume?: string;
  /** Replaces the subprocess environment entirely; the caller spreads process.env. */
  env?: Record<string, string | undefined>;
  model?: string;
  /** A Claude Code CLI to drive instead of the SDK's built-in binary. */
  pathToClaudeCodeExecutable?: string;
  canUseTool(toolName: string, input: Record<string, unknown>,
    options: ClaudePermissionContext & { signal: AbortSignal }): Promise<ClaudePermissionResult>;
}

/** Shape of the SDK's `query()`; injected so tests never spawn Claude Code. */
export type ClaudeQuery = (params: { prompt: string; options: ClaudeQueryOptions }) => AsyncIterable<ClaudeStreamMessage>;

export interface ClaudeRunDeps {
  instructions?: string;
  continuation?: boolean;
  onRetry?(notice: RetryNotice | undefined): void;
  research?: ResearchBridge;
  query: ClaudeQuery;
  env?: Record<string, string | undefined>;
  model?: string;
  executable?: string;
  /** Decide one normalized request; the signal aborts with the task. */
  decide(request: CoderRequest, signal: AbortSignal): Promise<CoderDecision>;
  onSession?(coderSessionId: string): void;
  /** One line per step the coder takes: a command, a file edit, what it says about its work. */
  onActivity?(text: string): void;
  /** Detail for the job's own panel only, never the model or the task record: the end of a tool's output. */
  onLog?(text: string): void;
  onFailure?(key: string): void;
  onSuccess?(): void;
}

/** Load the SDK lazily: the managed copy when a path is given, else the one resolvable from the plugin. A missing SDK fails one task, not the plugin. */
export async function loadClaudeQuery(sdkPath?: string): Promise<ClaudeQuery> {
  let module: { query: unknown };
  try { module = await import(sdkPath ? pathToFileURL(sdkPath).href : '@anthropic-ai/claude-agent-sdk') as { query: unknown }; }
  catch (error) {
    throw new Error('未安装 @anthropic-ai/claude-agent-sdk，无法启动 Claude Code。请在设置页的“编码工具”里安装。', { cause: error });
  }
  return module.query as ClaudeQuery;
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
    && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []).join('\n');
}

/**
 * Run one task in Claude Code through the Agent SDK. Every permission request
 * and AskUserQuestion reaches `deps.decide`; the returned hooks fit a native job.
 */
export function runClaudeTask(task: TaskRecord, deps: ClaudeRunDeps): CoderRun {
  const controller = new AbortController();
  let cancelReason: string | undefined;
  let transportFailed = false;
  let lastFailure: ProviderFailure | undefined;
  let quota: ProviderFailure | undefined;
  const interrupted = (result: string): CoderOutcome => transportFailed
    ? { status: 'failed', detail: 'Claude 输出连接中断', providerFailure: { kind: 'network' }, result }
    : { status: 'killed', detail: cancelReason ?? 'cancelled', result };
  const failed = (detail: string, result: string, failure = providerFailure({ message: detail }) ?? lastFailure ?? quota): CoderOutcome =>
    ({ status: 'failed', detail: failure ? failureLabel(failure) : safeFailureDetail(detail), result, ...(failure ? { providerFailure: failure } : {}) });
  const calls = new Map<string, string>();
  const privateCalls = new Set<string>();
  // AskUserQuestion may reach both the hook and canUseTool. Only dedupe that exact question;
  // a later command permission callback can carry a newly discovered blocked path and must be checked again.
  const decisions = new Set<Promise<CoderDecision>>();
  const questionAnswers = new Map<string, Promise<CoderDecision>>();
  const decide = (name: string, input: Record<string, unknown>, context: ClaudePermissionContext, id: string | undefined, signal: AbortSignal) => {
    const key = name === 'AskUserQuestion' && id ? `${id}:${JSON.stringify(input.questions)}` : undefined;
    const prior = key ? questionAnswers.get(key) : undefined;
    if (prior) return prior;
    const answer = deps.decide(normalizeClaudeRequest(name, input, context, task.cwd), signal);
    decisions.add(answer); void answer.then(() => decisions.delete(answer), () => decisions.delete(answer));
    if (key) questionAnswers.set(key, answer);
    return answer;
  };
  // The annotation makes TypeScript check each returned literal against JobOutcome; inferred, a renamed field slips through.
  const children = new Set<ReturnType<typeof spawnTaskProcess>>();
  const execution = (async (): Promise<CoderOutcome> => {
    let lastAssistant = '';
    try {
      if (process.platform === 'win32' && (task.permissions?.securityMode ?? 'strict') === 'strict') throw new Error('Claude Code 严格模式需要 Linux / WSL2 或 macOS 命令沙箱。');
      const stream = deps.query({ prompt: (deps.continuation ? RESUME_PROMPT : coderPrompt(task)) + (deps.instructions ?? '') + (process.platform === 'win32' ? WINDOWS_CODER_GUIDANCE : '') + (deps.research ? (deps.research.webResearch === false ? '' : RESEARCH_GUIDANCE) + (deps.research.localChecks ? LOCAL_CHECK_GUIDANCE : '') : ''), options: {
        ...((process.platform === 'linux' || process.platform === 'win32') && task.permissions ? { spawnClaudeCodeProcess: (options: SpawnOptions) => {
          const child = spawnTaskProcess(options.command, options.args, options.cwd, options.env);
          // The SDK's custom spawn interface owns stdio but does not drain stderr.
          child.stderr.resume();
          child.stderr.on('error', () => { transportFailed = true; controller.abort(new Error('Claude stderr interrupted')); });
          child.stdout.on('error', () => { transportFailed = true; controller.abort(new Error('Claude stdout interrupted')); });
          child.stdin.on('error', () => { transportFailed = true; controller.abort(new Error('Claude stdin interrupted')); });
          children.add(child);
          const abort = () => { void closeTaskProcess(child); };
          options.signal.addEventListener('abort', abort, { once: true });
          child.once('exit', () => options.signal.removeEventListener('abort', abort));
          if (options.signal.aborted) abort();
          return child;
        } } : {}),
        cwd: task.cwd, permissionMode: task.permissions?.securityMode === 'full' ? 'bypassPermissions' : 'default',
        ...(task.permissions?.securityMode === 'full' ? { allowDangerouslySkipPermissions: true } : {}), abortController: controller,
        ...(deps.research ? { strictMcpConfig: true, mcpServers: { nexus_web: { type: 'http' as const, url: deps.research.url, headers: { Authorization: `Bearer ${deps.research.token}` } } } } : {}),
        ...(task.permissions ? {
          settingSources: [],
          tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'AskUserQuestion', ...(task.permissions.webResearch ? ['WebSearch', 'WebFetch'] : [])],
          sandbox: { enabled: (task.permissions.securityMode ?? 'strict') === 'strict', failIfUnavailable: (task.permissions.securityMode ?? 'strict') === 'strict', autoAllowBashIfSandboxed: false, allowUnsandboxedCommands: task.permissions.securityMode === 'standard' || task.permissions.securityMode === 'full',
            network: { allowedDomains: task.permissions.allowedNetworkDomains, strictAllowlist: true, allowAllUnixSockets: false, allowLocalBinding: false },
            filesystem: { allowWrite: task.permissions.writableRoots, denyRead: credentialPaths(), denyWrite: credentialPaths() },
            credentials: { envVars: Object.keys(deps.env ?? process.env).filter(key => /TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(key)).map(name => ({ name, mode: 'deny' as const })) } },
          hooks: { PreToolUse: [{ hooks: [async (input, _id, options) => {
            if (input.hook_event_name !== 'PreToolUse') return {};
            const decision = await decide(input.tool_name, input.tool_input as Record<string, unknown>, {}, _id,
              AbortSignal.any([options.signal, controller.signal]));
            return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const,
              permissionDecision: decision.behavior === 'allow' ? 'allow' as const : 'deny' as const,
              ...(decision.behavior === 'deny' ? { permissionDecisionReason: decision.message } : decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) } };
          }] }] },
        } : {}),
        ...(task.coderSessionId ? { resume: task.coderSessionId } : {}),
        ...(deps.env ? { env: deps.env } : {}), ...(deps.model ? { model: deps.model } : {}),
        ...(deps.executable ? { pathToClaudeCodeExecutable: deps.executable } : {}),
        canUseTool: async (toolName, input, options) => {
          const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
          return decide(toolName, input, options, options.toolUseID, signal);
        },
      } });
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init' && message.session_id) {
          if (deps.continuation && task.coderSessionId && message.session_id !== task.coderSessionId) throw new Error('Claude 未恢复原会话，任务已停止。');
          deps.onSession?.(message.session_id);
        }
        else if (message.type === 'system' && message.subtype === 'api_retry') {
          const failure = providerFailure({ code: message.error, status: message.error_status,
            retryAfterMs: message.retry_delay_ms }) ?? (message.error_status === null ? { kind: 'network' as const } : { kind: 'permanent' as const });
          lastFailure = failure;
          deps.onRetry?.({ failure, attempt: counter(message.attempt), maxAttempts: counter(message.max_retries), delayMs: counter(message.retry_delay_ms) });
        } else if (message.type === 'rate_limit_event') {
          if (message.rate_limit_info?.status === 'rejected') {
            quota = { kind: 'quota' };
            deps.onRetry?.({ failure: quota, retrying: false });
          } else { quota = undefined; }
        } else if (message.type === 'assistant') {
          if (!message.parent_tool_use_id && message.error) {
            lastFailure = quota ?? providerFailure({ code: message.error, message: textOf(message.message?.content) }) ?? { kind: 'permanent' };
            deps.onActivity?.(failureLabel(lastFailure));
            continue;
          } else if (!message.parent_tool_use_id) { lastFailure = undefined; deps.onRetry?.(undefined); }

          const content = message.message?.content;
          const text = textOf(content);
          if (text) { lastAssistant = text; const said = narration(text); if (said) deps.onActivity?.(said); }
          if (Array.isArray(content)) for (const block of content) {
            if (block && typeof block === 'object' && block.type === 'tool_use' && typeof block.id === 'string') {
              calls.set(block.id, JSON.stringify([block.name, block.input]));
              const input = block.input as Record<string, unknown> | undefined;
              if (input && (typeof input.file_path === 'string' && isEnvironmentFile(input.file_path) || typeof input.path === 'string' && isEnvironmentFile(input.path) || block.name === 'Bash' && typeof input.command === 'string' && commandMentionsEnvironment(input.command))) privateCalls.add(block.id);
            }
            const step = claudeStep(block, task.cwd); if (step) deps.onActivity?.(step); }
        }
        else if (message.type === 'user' && Array.isArray(message.message?.content)) {
          for (const block of message.message.content as unknown[]) {
            let environment = false;
            if (block && typeof block === 'object' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
              environment = privateCalls.delete(block.tool_use_id);
              const key = calls.get(block.tool_use_id);
              if (key) { if ('is_error' in block && block.is_error === true) deps.onFailure?.(key); else deps.onSuccess?.(); }
              calls.delete(block.tool_use_id);
            }
            const output = claudeToolOutput(block); if (output?.trim()) deps.onLog?.(environment ? '环境配置内容已隐藏。' : outputTail(output)); }
        }
        else if (message.type === 'result') {
          if (controller.signal.aborted) return interrupted(lastAssistant);
          const output = typeof message.result === 'string' && message.result ? message.result : lastAssistant;
          if (message.is_error || (message.subtype && message.subtype !== 'success')) {
            return failed([message.subtype, ...(message.errors ?? [])].filter(Boolean).join(': ') || 'error', lastAssistant, quota ?? providerFailure({ message: (message.errors ?? []).join(': ') }) ?? lastFailure);
          }
          if (lastFailure || quota) return failed('模型请求失败', lastAssistant, quota ?? lastFailure);
          return { status: 'completed', result: output };
        }
      }
      if (controller.signal.aborted) return interrupted(lastAssistant);
      return failed('Claude Code 没有返回结果', lastAssistant);
    } catch (error) {
      if (controller.signal.aborted) return interrupted(lastAssistant);
      return failed((error as Error)?.message ?? String(error), lastAssistant, exceptionFailure(error) ?? quota ?? lastFailure);
    } finally { controller.abort(); await Promise.allSettled(decisions); await Promise.all([...children].map(closeTaskProcess)); }
  })();
  const done = execution.then((outcome): CoderOutcome => process.platform === 'win32' && (outcome.status === 'completed' || outcome.providerFailure) && (!children.size || [...children].some(child => !taskProcessCleaned(child)))
    ? { status: 'failed', detail: '无法确认 Windows Claude 任务进程已完全清理。', result: outcome.result } : outcome);
  return {
    cancel(reason?: string) {
      if (controller.signal.aborted) return;
      cancelReason = reason;
      controller.abort(new Error(reason ?? 'cancelled'));
    },
    done,
  };
}
