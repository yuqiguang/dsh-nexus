/**
 * What a channel says when a turn did not complete.
 *
 * Every unfinished turn used to reach WeChat as one sentence — "本轮执行未完成" — whether the model was
 * rate limited, the connection dropped, or the user stopped it. The turn/end event already carries the
 * reason, so the bridge can name the cause and say what to do about it.
 */

/** The advice for a failure we recognise, matched case-insensitively against the error code and then its message. */
const ADVICE: [pattern: RegExp, advice: string][] = [
  [/RATE.?LIMIT|TPM|TOO.?MANY.?REQUESTS/, '模型服务限流了（每分钟 token 额度已用满），等一两分钟再发一次就行'],
  [/QUOTA|INSUFFICIENT|BILLING|BALANCE/, '账户额度不足，检查额度或换一个模型再试'],
  [/AUTH|API.?KEY|UNAUTHORIZED|FORBIDDEN|CREDENTIAL/, '模型凭据无效或过期了，在设置里重新登录或填一次密钥'],
  [/CONTEXT|TOO.?LONG|MAX.?(OUTPUT.?)?TOKENS/, '上下文太长了，发 /new 开个新会话再问'],
  [/TIMEOUT|TIMED.?OUT|DEADLINE/, '模型请求超时了，稍后重发一次'],
  [/TRANSPORT|CONNECTION|NETWORK|ECONN|DNS|PROXY|SOCKET/, '连不上模型服务（网络或代理出了问题），检查网络后重发'],
  [/EMPTY.?RESPONSE/, '模型返回了空内容，重发一次通常就好'],
  [/SERVER|OVERLOAD|UNAVAILABLE|INTERNAL|\b5\d\d\b/, '模型服务端出错了，稍后重发一次'],
  [/CANCEL|ABORT|STOP/, '执行被中止了'],
];

/** Where the full record is, appended to every notice so the sentence is not the only trace. */
const WHERE = '详情可在本机 DSH 查看。';

const STOPPED = new Set(['aborted', 'cancelled', 'canceled', 'stopped']);

type Failure = { message?: unknown; code?: unknown };

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * The readable part of an error: the inner message when the text is really a JSON payload
 * (`429 {"error":{"message":"..."}}`), without the request id the reader cannot use.
 */
export function readableFailure(error: unknown): string {
  const raw = field(error, 'message');
  if (typeof raw !== 'string' || !raw) return '';
  const nested = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const text = (nested?.[1] ?? raw).replace(/\\"/g, '"')
    .replace(/Request id:\s*\S+/gi, '')
    .replace(/\s+/g, ' ')
    // Trimming the request id leaves its punctuation behind: "…later (".
    .replace(/[\s(:,\-–—]+$/, '')
    .trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

/**
 * One sentence naming why a turn did not complete, plus where the record is.
 * `subject` is 本轮 for a reply and 上一轮 for the /status answer.
 */
export function failureNotice(reason: unknown, subject = '本轮'): string {
  const kind = field(reason, 'kind');
  if (typeof kind !== 'string' || !kind) return `${subject}执行未完成，${WHERE}`;
  if (kind === 'interrupted') return `${subject}执行被中断了（DSH 重启或连接断开），${WHERE}`;
  if (STOPPED.has(kind)) return `${subject}执行被中止了，${WHERE}`;
  if (kind !== 'error') return `${subject}执行未完成（原因：${kind}），${WHERE}`;

  const error = field(reason, 'error') as Failure | undefined;
  const code = field(error, 'code');
  const codeText = typeof code === 'string' ? code.trim() : '';
  const detail = readableFailure(error);
  const probe = `${codeText} ${detail}`.toUpperCase();
  const matched = ADVICE.find(([pattern]) => pattern.test(probe));
  if (matched) return `${subject}执行未完成：${matched[1]}\n${WHERE}`;
  if (codeText && detail) return `${subject}执行未完成（${codeText}：${detail}）\n${WHERE}`;
  if (detail) return `${subject}执行未完成（${detail}）\n${WHERE}`;
  return `${subject}执行未完成（${codeText || 'error'}）\n${WHERE}`;
}
