import { setTimeout as delay } from 'node:timers/promises';
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs';

export type ProviderFailureKind = 'network' | 'rate-limit' | 'overloaded' | 'quota' | 'authentication' | 'permanent';
export interface ProviderFailure { kind: ProviderFailureKind; retryAfterMs?: number }
export interface CoderOutcome extends JobOutcome { providerFailure?: ProviderFailure }
export interface CoderRun extends JobHooks { done: Promise<CoderOutcome> }
export interface RetryNotice { retrying?: boolean; failure: ProviderFailure; attempt?: number; maxAttempts?: number; delayMs?: number }
export interface TaskRetry {
  source: 'tool' | 'nexus'; phase: 'waiting' | 'resuming' | 'recovered' | 'stopped';
  reason: string; attempt?: number; maxAttempts?: number; retryAt?: number;
}

export const RESUME_PROMPT = '上一次模型请求因短暂故障停止。请在本会话核对已完成的操作和当前文件，继续尚未完成的工作。不要重复已成功的命令、提交或其他副作用；不能确认操作是否完成时先检查结果。原任务目标、验收要求和权限不变。';

export const AUTO_RESUME_DELAYS = [5_000, 15_000] as const;
export const MAX_RETRY_WAIT_MS = 120_000;
const labels: Record<ProviderFailureKind, string> = {
  network: '模型请求连接中断或超时', 'rate-limit': '模型服务暂时限流', overloaded: '模型服务暂时不可用',
  quota: '模型额度或预算已用尽', authentication: '模型认证或账号不可用', permanent: '模型请求无法自动恢复',
};
export const failureLabel = (failure: ProviderFailure) => labels[failure.kind];
export const transient = (failure: ProviderFailure) => ['network', 'rate-limit', 'overloaded'].includes(failure.kind);
export const counter = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Diagnostic details never retain authenticated endpoints or common credential forms. */
export function safeFailureDetail(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, '[地址已隐藏]')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 ***')
    .replace(/\b((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1***')
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{8,}/g, '***').slice(-4096);
}

/** Only call with provider error metadata, never tool output, narration, or a task description. */
export function providerFailure(value: { code?: unknown; status?: unknown; message?: unknown; retryAfterMs?: unknown }): ProviderFailure | undefined {
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message.slice(0, 8192) : '';
  const status = value.status;
  let kind: ProviderFailureKind | undefined;
  if (['usageLimitExceeded', 'sessionBudgetExceeded', 'billing_error', 'insufficient_quota', 'credits_required', 'quota_exceeded'].includes(code)
    || /insufficient[_ ]quota|\b(?:quota|credits?|budget)\b.{0,35}\b(?:exhausted|exceeded|depleted)\b|\bout of credits\b|\bcredit balance\b|\b(?:billing|usage) limit\b|exceeded.{0,30}quota/i.test(message)) kind = 'quota';
  else if (['unauthorized', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'cloud_credential_error'].includes(code)
    || status === 401 || status === 403 || /\b(?:invalid api key|authentication failed|unauthorized)\b/i.test(message)) kind = 'authentication';
  else if (['badRequest', 'contextWindowExceeded', 'cyberPolicy', 'misalignmentPolicyViolation', 'threadRollbackFailed', 'sandboxError', 'activeTurnNotSteerable',
    'invalid_request', 'model_not_found', 'max_output_tokens'].includes(code) || status === 400 || status === 404 || status === 422) kind = 'permanent';
  else if (['rateLimitExceeded', 'rate_limit'].includes(code) || status === 429 || /\b429\b|rate[ _-]?limit|too many requests/i.test(message)) kind = 'rate-limit';
  else if (['serverOverloaded', 'internalServerError', 'overloaded', 'server_error'].includes(code) || [500, 502, 503, 504, 529].includes(status as number)) kind = 'overloaded';
  else if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
    'APIConnectionError', 'APIConnectionTimeoutError', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'httpConnectionFailed', 'responseTooManyFailedAttempts'].includes(code)
    || status === 408 || /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|fetch failed|connection (?:reset|closed|error|terminated)|request timed out|stream disconnected|network error)\b/i.test(message)) kind = 'network';
  if (!kind) return undefined;
  const retryAfterMs = counter(value.retryAfterMs);
  return { kind, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/** Retry-After is honored, including HTTP dates; a long wait is stopped, never shortened. */
export function retryAfter(value: unknown, now = Date.now()): number | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return counter(Math.ceil(Number(value) * 1000));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function exceptionFailure(error: unknown): ProviderFailure | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown; message?: unknown; headers?: { get?(name: string): unknown; 'retry-after'?: unknown }; cause?: unknown };
  const after = retryAfter(value.headers?.get?.('retry-after') ?? value.headers?.['retry-after']);
  return providerFailure({ code: value.code ?? value.name, status: value.status ?? value.statusCode, message: value.message, retryAfterMs: after })
    ?? (value.cause && value.cause !== error ? providerFailure(value.cause as { code?: unknown; message?: unknown }) : undefined);
}

/** Public Codex TurnError shape from the installed 0.155.1 app-server protocol. */
export interface CodexError { message?: string; codexErrorInfo?: unknown; additionalDetails?: string | null }
export function codexFailure(error?: CodexError | null): ProviderFailure | undefined {
  if (!error) return undefined;
  const info = error.codexErrorInfo;
  const variant = info && typeof info === 'object' ? Object.entries(info)[0] : undefined;
  const code = typeof info === 'string' ? info : variant?.[0];
  const status = variant?.[1] && typeof variant[1] === 'object' ? (variant[1] as { httpStatusCode?: unknown }).httpStatusCode : undefined;
  return providerFailure({ code, status, message: error.message });
}

export { retryText } from './retry-view.js';

export const waitForRetry = (ms: number, signal: AbortSignal): Promise<void> => delay(ms, undefined, { signal });

/** Bounded transport recovery inside ONE native DSH job. No new jobs, task replay, or restart scheduler. */
export async function resumeTransient(options: {
  signal: AbortSignal;
  run(sessionId: string | undefined, attempt: number): CoderRun;
  sessionId(): string | undefined;
  checkpoint(): Promise<void>;
  beforeResume(): Promise<void>;
  state(value: TaskRetry | undefined): Promise<void>;
  wait?: typeof waitForRetry;
}): Promise<CoderOutcome> {
  let outcome: CoderOutcome = { status: 'killed' };
  try {
    for (let attempt = 0; ; attempt++) {
      options.signal.throwIfAborted();
      const runner = options.run(options.sessionId(), attempt);
      const cancel = () => runner.cancel('编码任务已停止');
      options.signal.addEventListener('abort', cancel, { once: true });
      if (options.signal.aborted) cancel();
      try { outcome = await runner.done; }
      finally { options.signal.removeEventListener('abort', cancel); }
      await options.checkpoint();
      options.signal.throwIfAborted();
      const failure = outcome.providerFailure;
      if (outcome.status !== 'failed' || !failure) {
        await options.state(attempt && outcome.status === 'completed'
          ? { source: 'nexus', phase: 'recovered', attempt, maxAttempts: AUTO_RESUME_DELAYS.length, reason: '连接已恢复，原会话执行结束' } : undefined);
        return outcome;
      }
      const baseDelay = AUTO_RESUME_DELAYS[attempt];
      const wait = Math.max(baseDelay ?? 0, failure.retryAfterMs ?? 0);
      const stop = !transient(failure) ? '请处理后再继续'
        : !options.sessionId() ? '未取得原编码会话，需检查已有改动后手动重试'
        : baseDelay === undefined ? '已达到自动续接上限，请稍后在所属会话继续'
        : wait > MAX_RETRY_WAIT_MS ? '服务要求等待超过 2 分钟，请稍后在所属会话继续' : undefined;
      if (stop) {
        await options.state({ source: 'nexus', phase: 'stopped', attempt, maxAttempts: AUTO_RESUME_DELAYS.length, reason: `${failureLabel(failure)}；${stop}` });
        return outcome;
      }
      await options.state({ source: 'nexus', phase: 'waiting', attempt: attempt + 1, maxAttempts: AUTO_RESUME_DELAYS.length,
        reason: `${failureLabel(failure)}；等待后恢复原会话`, retryAt: Date.now() + wait });
      await (options.wait ?? waitForRetry)(wait, options.signal);
      options.signal.throwIfAborted();
      await options.beforeResume();
      options.signal.throwIfAborted();
      await options.state({ source: 'nexus', phase: 'resuming', attempt: attempt + 1, maxAttempts: AUTO_RESUME_DELAYS.length, reason: '正在恢复原编码会话' });
    }
  } catch (error) {
    if (options.signal.aborted) {
      await options.state({ source: 'nexus', phase: 'stopped', reason: '任务已停止，不再自动续接' });
      return { status: 'killed', result: outcome.result, detail: '任务已停止' };
    }
    await options.state({ source: 'nexus', phase: 'stopped', reason: '无法确认原会话、工作区或权限边界，已停止自动续接' });
    return { status: 'failed', result: outcome.result, detail: '无法确认原会话、工作区或权限边界，已停止自动续接' };
  }
}
