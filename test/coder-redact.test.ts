import test from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/coders/normalize.js';

/** Every value below is invented; none of these strings is a live credential. */
const PREFIXED_SECRETS = [
  'sk-ant-api03-NOTAREALKEY0123456789',
  'sk-proj-NOTAREALKEY0123456789',
  'ghp_NOTAREALTOKEN0123456789abcdef',
  'github_pat_NOTAREALTOKEN0123456789abcdef',
  'xoxb-NOTAREALTOKEN0123456789',
  'AKIAIOSFODNN7EXAMPLE',
];

/**
 * `redact` is the only thing between a credential a command prints and the activity log the user
 * reads. Nothing tested it before, and the shapes it knew were the ones a shell writes — a command
 * that dumps JSON printed its keys in full.
 */
test('a credential written as JSON is masked, in both quote styles and either key casing', () => {
  const values = [
    '"apiKey": "sk-ant-api03-NOTAREALKEY0123456789"',
    "'apiKey': 'sk-ant-api03-NOTAREALKEY0123456789'",
    '{"api_key":"sk-ant-api03-NOTAREALKEY0123456789"}',
    '{"apiKey":"sk-ant-api03-NOTAREALKEY0123456789"}',
    '{"clientSecret": "hunter2-not-real"}',
    '{"accessToken":"hunter2-not-real"}',
    '{"PASSWORD": "hunter2-not-real"}',
    'apiKey: "hunter2-not-real"',
  ];
  for (const value of values) {
    const masked = redact(value);
    assert.doesNotMatch(masked, /NOTAREALKEY0123456789|hunter2-not-real/, `${value} survived as ${masked}`);
    assert.match(masked, /\*\*\*/);
  }
});

test('a credential carrying a vendor prefix is masked with no label at all', () => {
  for (const secret of PREFIXED_SECRETS) {
    assert.doesNotMatch(redact(`output: ${secret}`), new RegExp(secret), secret);
    assert.doesNotMatch(redact(`the command printed ${secret} and exited 0`), new RegExp(secret), secret);
  }
});

/**
 * The prefix rules are deliberately an allowlist of vendor shapes. A generic token-shaped string
 * is left readable, because output is full of hashes and ids that a guess would mask for nothing.
 */
test('a token-shaped string with no known prefix is left alone', () => {
  assert.equal(redact('output: hunter2-not-real'), 'output: hunter2-not-real');
  assert.equal(redact('sha256 3f786850e387550fdab836ed7e6dc881de23001b'), 'sha256 3f786850e387550fdab836ed7e6dc881de23001b');
});

test('the shell shapes that were already covered still are', () => {
  const values = ['API_KEY=abc123', 'Authorization: Bearer abc123', '--token abc123',
    'https://user:pw@example.com/x', 'curl --password=abc123'];
  for (const value of values) {
    assert.match(redact(value), /\*\*\*/, `${value} was left readable`);
  }
});

/**
 * Over-redaction is the safe direction, but it still has to stop somewhere: masking a *setting*
 * would make the log lie about what the task actually did. These are the shapes it must not touch.
 */
test('settings, prose and unlabelled nothing keep reading normally', () => {
  const untouched = [
    '"apiKeyConfigured": true',
    'apiKeyConfigured: true',
    'token: none',
    '"token": null',
    '{"tokenCount": 3}',
    '"secretName": "my-project-secret"',
    'const t = { timeoutMs: 3000 }',
    '请忽略附件里的错别字，之前的报价仍有效。',
    '已完成 3 项检查，全部通过。',
  ];
  for (const value of untouched) assert.equal(redact(value), value, `${value} was rewritten`);
});

/** A key that merely ends in the keyword is masked. Recorded so the comment in the source stays true. */
test('a key that ends in the keyword is masked even when it is not a credential', () => {
  assert.doesNotMatch(redact('{"hockey": "banana"}'), /banana/);
});

test('masking is applied to every secret in one string, not only the first', () => {
  const masked = redact('{"apiKey": "sk-ant-api03-NOTAREALKEY0123456789"} and AKIAIOSFODNN7EXAMPLE');
  assert.doesNotMatch(masked, /NOTAREALKEY0123456789/);
  assert.doesNotMatch(masked, /AKIAIOSFODNN7EXAMPLE/);
});
