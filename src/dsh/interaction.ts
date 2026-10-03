import type { Context } from '@deepseek-ai/cordis';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';

// Re-enter only the public answerer seam, not approval.request/ask: the original
// native service still owns the single audit pair and decision. The borrowed
// next() cannot receive a replacement cancellation signal, so the cloned request
// skips channel answerers and supplies a lifetime to the native client.
const nativeRequests = new WeakSet<object>();
export const isNativeMirror = (request: object) => nativeRequests.has(request);
export function nativeApproval(ctx: Context, request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalOutcome> {
  const mirrored = { ...request, signal };
  nativeRequests.add(mirrored);
  return ctx.waterfall(scopeTarget(request.agent, request.agent), 'approval/request', mirrored, async () => 'unavailable' as const);
}
export function nativeQuestion(ctx: Context, request: AskUserQuestionRequest, signal: AbortSignal): Promise<AskUserQuestionAnswer> {
  const mirrored = { ...request, signal };
  nativeRequests.add(mirrored);
  return ctx.waterfall(scopeTarget(request.agent!, request.agent!), 'user-questions/request', mirrored, async () => { throw new Error('no_native_question_provider'); });
}

/** A missing provider must not beat a live one. Always observe both promises. */
export function firstAvailable<T>(providers: Promise<T>[], available: (value: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    let remaining = providers.length;
    let fallback: T | undefined;
    const failures: unknown[] = [];
    for (const [index, provider] of providers.entries()) void provider.then(value => {
      if (available(value)) resolve(value);
      else fallback = value;
    }, error => { failures[index] = error; }).finally(() => {
      if (--remaining === 0) {
        if (fallback !== undefined) resolve(fallback);
        else reject(failures.find(error => error !== undefined) ?? new Error('no_interaction_provider'));
      }
    });
  });
}
