import { randomBytes } from 'node:crypto';
import { UserQuestionError, type AskUserQuestionItem, type AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions';

type Pending = {
  chatId: string; question: AskUserQuestionItem; presented: boolean; last: boolean;
  settle(answer?: AskUserQuestionAnswerItem, error?: UserQuestionError): void;
};
export type QuestionReply = { kind: 'accepted'; last: boolean }
  | { kind: 'missing' | 'ambiguous' | 'sending' | 'invalid' };

export function questionPrompt(question: AskUserQuestionItem, index: number, total: number): string {
  return [
    `需要你补充信息（${index + 1}/${total}）`,
    question.header, question.question, question.detail,
    ...(question.options ?? []).map((option, i) => `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`),
    '',
    question.options?.length ? (question.multiSelect ? '多选请回复“回答 1,2”。' : '选择请回复“回答 1”，也可以填写完整选项。') : undefined,
    '自由填写请回复“回答 文本 你的内容”。停止当前执行：/cancel',
  ].filter(line => line !== undefined).join('\n');
}

function parseAnswer(question: AskUserQuestionItem, input: string): AskUserQuestionAnswerItem | undefined {
  const value = input.trim();
  if (!value) return;
  const custom = /^文本\s+([\s\S]+)$/.exec(value);
  if (custom) return { id: question.id, selected: [], custom: custom[1]!.trim() };
  const options = question.options ?? [];
  if (options.length && /^\d+(?:\s*[,，、]\s*\d+)*$/.test(value)) {
    const indices = [...new Set(value.split(/[,，、]/).map(Number))];
    if ((!question.multiSelect && indices.length !== 1) || indices.some(i => i < 1 || i > options.length)) return;
    return { id: question.id, selected: indices.map(i => options[i - 1]!.label) };
  }
  if (options.some(option => option.label === value)) return { id: question.id, selected: [value] };
  return { id: question.id, selected: [], custom: value };
}

/** Live channel correlation only; the native tool owns the question, answer, and cancellation lifetime. */
export class QuestionReplies {
  private readonly pending = new Map<string, Pending>();

  open(chatId: string, question: AskUserQuestionItem, last: boolean, signal?: AbortSignal) {
    const token = randomBytes(16).toString('hex');
    const outcome = new Promise<AskUserQuestionAnswerItem>((resolve, reject) => {
      const settle = (answer?: AskUserQuestionAnswerItem, error?: UserQuestionError) => {
        if (!this.pending.delete(token)) return;
        signal?.removeEventListener('abort', abort);
        if (answer) resolve(answer);
        else reject(error ?? new UserQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'));
      };
      const abort = () => settle();
      this.pending.set(token, { chatId, question, last, presented: false, settle });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    // Cancellation can arrive while the complete prompt is still being sent.
    void outcome.catch(() => {});
    return { token, outcome, presented: () => {
      const pending = this.pending.get(token);
      if (pending) pending.presented = true;
    }, unavailable: () => this.pending.get(token)?.settle(undefined,
      new UserQuestionError('The channel could not deliver the complete question. Ask again when connected.', 'NO_PROVIDER')) };
  }

  hasPending(chatId: string): boolean { return [...this.pending.values()].some(item => item.chatId === chatId); }

  answer(chatId: string, value: string, token?: string): QuestionReply {
    const matches = [...this.pending.entries()].filter(([id, item]) => item.chatId === chatId && (!token || token === id));
    if (!matches.length) return { kind: 'missing' };
    if (matches.length !== 1) return { kind: 'ambiguous' };
    const pending = matches[0]![1];
    if (!pending.presented) return { kind: 'sending' };
    const answer = parseAnswer(pending.question, value);
    if (!answer) return { kind: 'invalid' };
    pending.settle(answer);
    return { kind: 'accepted', last: pending.last };
  }

  close(): void { for (const pending of this.pending.values()) pending.settle(); }
}
