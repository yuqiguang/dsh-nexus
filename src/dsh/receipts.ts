import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions';

/** Receipts identify the interaction, never repeat its arguments or free-text answer. */
const short = (value: string) => {
  const line = value.replace(/\s+/g, ' ').trim();
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
};

export function desktopApprovalReceipt(title: string, outcome: ApprovalOutcome): string | undefined {
  if (outcome !== 'allowed-once' && outcome !== 'rejected') return;
  return `已在电脑端${outcome === 'allowed-once' ? '允许' : '拒绝'}“${short(title)}”${outcome === 'allowed-once' ? '（仅本次）' : ''}。\n当前审批已失效，无需在此重复回复。`;
}

/** Coder approvals are native questions too; report exact selections without inferring a verdict. */
export function desktopQuestionReceipt(request: AskUserQuestionRequest, answer: AskUserQuestionAnswer): string {
  const lines = request.questions.slice(0, 6).map(question => {
    const item = answer.answers.find(item => item.id === question.id);
    const choices = item?.selected.filter(label => question.options?.some(option => option.label === label)) ?? [];
    const result = [...choices.map(short), ...(item?.custom ? ['已填写文字答复（请在电脑查看）'] : [])].join('、') || '已处理';
    return `- ${short(question.header ? `${question.header}：${question.question}` : question.question)}：${short(result)}`;
  });
  return ['已在电脑端完成回答：', ...lines, ...(request.questions.length > 6 ? [`另有 ${request.questions.length - 6} 项，请在电脑查看。`] : []),
    '当前这组提示已失效，无需在此重复回复。'].join('\n');
}
