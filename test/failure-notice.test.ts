import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureNotice, readableFailure } from '../src/dsh/failure-notice.js';

/** The sentence every unfinished turn used to send, whatever had gone wrong. */
const GENERIC = '本轮执行未完成，详情可在本机 DSH 查看。';

/** The turn/end reason recorded on 2026-10-26, when the account hit its per-minute token ceiling. */
const RATE_LIMITED = {
  kind: 'error',
  error: {
    message: '429 {"error":{"type":"ModelAccountTpmRateLimitExceeded","message":"TPM (Tokens Per Minute) limit of the model deepseek-v4-1-flash is exceeded. Please try again later Request id: 021792979833757bde03ea0489c8e302d576098c64d404eaaeb61 (request id: 202610260157133130071488268d9d6flYv21DT)"},"type":"error"}',
    code: 'RATE_LIMIT',
  },
};

test('a rate-limited turn says so, and leaves the request id out', () => {
  const notice = failureNotice(RATE_LIMITED);
  assert.match(notice, /限流/);
  assert.match(notice, /等一两分钟/);
  assert.doesNotMatch(notice, /Request id/i);
  assert.doesNotMatch(notice, /021792979833757/);
  assert.ok(notice.startsWith('本轮执行未完成：'), 'the sentence keeps the framing the user already knows');
  assert.ok(notice.endsWith('详情可在本机 DSH 查看。'), 'the record stays one line away');
  assert.notEqual(notice, GENERIC);
});

test('the same reason reads as 上一轮 when /status asks about it', () => {
  const notice = failureNotice(RATE_LIMITED, '上一轮');
  assert.ok(notice.startsWith('上一轮执行未完成：'));
  assert.match(notice, /限流/);
});

test('each failure we recognise gets its own advice', () => {
  const cases: [label: string, reason: unknown, expected: RegExp][] = [
    ['timeout', { kind: 'error', error: { message: 'Request timed out.', code: 'TIMEOUT' } }, /超时/],
    ['transport', { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } }, /连不上模型服务/],
    ['auth', { kind: 'error', error: { message: '401 Unauthorized', code: 'AUTH' } }, /凭据/],
    ['context', { kind: 'error', error: { message: 'context length exceeded', code: 'CONTEXT_LENGTH' } }, /上下文太长/],
    ['quota', { kind: 'error', error: { message: 'Insufficient balance', code: 'QUOTA' } }, /额度不足/],
    ['empty', { kind: 'error', error: { message: 'empty response', code: 'EMPTY_RESPONSE' } }, /空内容/],
    ['server', { kind: 'error', error: { message: 'server overloaded', code: 'SERVER' } }, /服务端出错/],
    // The code is absent, but the message still names the failure.
    ['code-less rate limit', { kind: 'error', error: { message: 'TPM limit of the model is exceeded' } }, /限流/],
  ];
  for (const [label, reason, expected] of cases) {
    const notice = failureNotice(reason);
    assert.match(notice, expected, label);
    assert.notEqual(notice, GENERIC, `${label} must not fall back to the generic line`);
  }
});

test('an unrecognised error keeps its code and its words, so it can still be diagnosed', () => {
  const notice = failureNotice({ kind: 'error', error: { message: '500 {"error":{"message":"upstream exploded"}}', code: 'WEIRD_THING' } });
  assert.match(notice, /WEIRD_THING/);
  assert.match(notice, /upstream exploded/);
  assert.doesNotMatch(notice, /\{"error"/, 'the payload is unwrapped rather than echoed');
  assert.notEqual(notice, GENERIC);

  const noCode = failureNotice({ kind: 'error', error: { message: 'something odd happened' } });
  assert.match(noCode, /something odd happened/);

  const nothing = failureNotice({ kind: 'error' });
  assert.match(nothing, /error/, 'an error with no detail still says it was an error');
  assert.notEqual(nothing, GENERIC);
});

test('a turn that was stopped or interrupted is told apart from one that failed', () => {
  const aborted = failureNotice({ kind: 'aborted' });
  assert.match(aborted, /中止/);
  assert.doesNotMatch(aborted, /未完成/);
  assert.match(failureNotice({ kind: 'interrupted' }), /中断/);
  assert.match(failureNotice({ kind: 'max-steps' }), /max-steps/, 'an unknown kind is named rather than swallowed');
});

test('only a turn with no reason at all falls back to the generic sentence', () => {
  assert.equal(failureNotice(undefined), GENERIC);
  assert.equal(failureNotice(null), GENERIC);
  assert.equal(failureNotice({}), GENERIC);
  assert.equal(failureNotice('boom'), GENERIC);
});

test('readableFailure trims what a reader cannot use and keeps what they can', () => {
  assert.equal(readableFailure(RATE_LIMITED.error),
    'TPM (Tokens Per Minute) limit of the model deepseek-v4-1-flash is exceeded. Please try again later');
  assert.equal(readableFailure({ message: '   spaced    out   ' }), 'spaced out');
  assert.equal(readableFailure({}), '');
  assert.equal(readableFailure(undefined), '');
  const long = readableFailure({ message: 'x'.repeat(400) });
  assert.equal(long.length, 161, 'a long message is cut with an ellipsis rather than sent whole');
  assert.ok(long.endsWith('…'));
});
