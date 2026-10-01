import { randomBytes } from 'node:crypto';
export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

type Pending = { chatId: string; presented: boolean; settle(outcome: ApprovalDecision): void };
export type CurrentApprovalReply = 'accepted' | 'missing' | 'ambiguous' | 'sending';

/** Temporary channel waiters; DSH remains the sole durable approval authority. */
export class ApprovalReplies {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly timeoutMs = 10 * 60_000) {}

  open(chatId: string, signal?: AbortSignal): { token: string; outcome: Promise<ApprovalDecision>; presented(): void } {
    const token = randomBytes(16).toString('hex');
    const outcome = new Promise<ApprovalDecision>(resolve => {
      const settle = (result: ApprovalDecision) => {
        if (!this.pending.delete(token)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      const abort = () => settle('cancelled');
      const timer = setTimeout(() => settle('cancelled'), this.timeoutMs);
      timer.unref();
      this.pending.set(token, { chatId, presented: false, settle });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    return { token, outcome, presented: () => {
      const request = this.pending.get(token);
      if (request) request.presented = true;
    } };
  }

  answer(chatId: string, token: string, outcome: ApprovalDecision): boolean {
    const request = this.pending.get(token);
    if (!request || request.chatId !== chatId) return false;
    request.settle(outcome);
    return true;
  }

  hasPending(chatId: string): boolean { return [...this.pending.values()].some(request => request.chatId === chatId); }

  answerCurrent(chatId: string, outcome: ApprovalDecision): CurrentApprovalReply {
    const requests = [...this.pending.values()].filter(request => request.chatId === chatId);
    if (!requests.length) return 'missing';
    if (requests.length !== 1) return 'ambiguous';
    // A plain reply cannot approve an operation before its full prompt has arrived.
    if (!requests[0]!.presented) return 'sending';
    requests[0]!.settle(outcome);
    return 'accepted';
  }

  close(): void {
    for (const request of this.pending.values()) request.settle('cancelled');
  }
}
