import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_RESUME_DELAYS, codexFailure, exceptionFailure, providerFailure, resumeTransient, retryAfter, safeFailureDetail, type CoderOutcome, type TaskRetry } from '../src/coders/retry.js';

test('provider metadata distinguishes temporary HTTP failures, exhausted quotas and permanent policy errors', () => {
  for (const status of [429, 500, 502, 503, 504, 529, 408]) assert.ok(providerFailure({ status }));
  assert.equal(providerFailure({ code: 'billing_error', status: 429 })?.kind, 'quota');
  assert.equal(providerFailure({ message: '429 You exceeded your current quota' })?.kind, 'quota');
  assert.equal(providerFailure({ code: 'invalid_request', message: '429' })?.kind, 'permanent');
  assert.equal(codexFailure({ codexErrorInfo: 'usageLimitExceeded' })?.kind, 'quota');
  assert.equal(codexFailure({ codexErrorInfo: 'sandboxError' })?.kind, 'permanent');
  assert.equal(codexFailure({ codexErrorInfo: 'rateLimitExceeded' })?.kind, 'rate-limit');
  assert.equal(codexFailure({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 401 } } })?.kind, 'authentication');
  assert.equal(codexFailure({ codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } })?.kind, 'network');
  assert.equal(exceptionFailure(Object.assign(new Error('socket lost'), { cause: { code: 'ECONNRESET' } }))?.kind, 'network');
  assert.deepEqual(exceptionFailure({ status: 429, headers: { get: () => '12' } }), { kind: 'rate-limit', retryAfterMs: 12000 });
  assert.equal(retryAfter('Fri, 02 Oct 2026 00:00:10 GMT', Date.parse('2026-10-02T00:00:00Z')), 10000);
  for (const message of ['tests failed', 'exit code 1', 'missing executable']) assert.equal(providerFailure({ message }), undefined);
});

function setup(outcomes: CoderOutcome[], session: string | undefined = 'native-session') {
  const controller = new AbortController(), states: (TaskRetry | undefined)[] = [], waits: number[] = [], sessions: (string | undefined)[] = [];
  let calls = 0, boundaries = 0;
  const options: Parameters<typeof resumeTransient>[0] = {
    signal: controller.signal, sessionId: () => session,
    checkpoint: async () => {}, beforeResume: async () => { boundaries++; }, state: async state => { states.push(state); },
    wait: async ms => { waits.push(ms); },
    run: native => { calls++; sessions.push(native); return { cancel() {}, done: Promise.resolve(outcomes[Math.min(calls - 1, outcomes.length - 1)]!) }; },
  };
  return { controller, states, waits, sessions, options, calls: () => calls, boundaries: () => boundaries };
}
const network: CoderOutcome = { status: 'failed', providerFailure: { kind: 'network' }, result: 'partial result' };

test('one native job resumes only the original session with bounded backoff and one final success', async () => {
  const f = setup([network, { status: 'completed', result: 'done' }]);
  assert.deepEqual(await resumeTransient(f.options), { status: 'completed', result: 'done' });
  assert.deepEqual(f.sessions, ['native-session', 'native-session']);
  assert.deepEqual(f.waits, [AUTO_RESUME_DELAYS[0]]); assert.equal(f.boundaries(), 1);
  assert.deepEqual(f.states.map(state => state?.phase), ['waiting', 'resuming', 'recovered']);
});

test('recovery exhausts its cap and never resets attempts after more provider failures', async () => {
  const f = setup([network]); await resumeTransient(f.options);
  assert.equal(f.calls(), 3); assert.deepEqual(f.waits, [...AUTO_RESUME_DELAYS]);
  assert.match(f.states.at(-1)!.reason, /上限/);
});

test('quota, auth, absent native session, cancellation and ordinary tool failures never auto-dispatch', async () => {
  for (const outcome of [{ status: 'failed', providerFailure: { kind: 'quota' } }, { status: 'failed', providerFailure: { kind: 'authentication' } },
    { status: 'failed', providerFailure: { kind: 'permanent' } }, { status: 'failed', detail: 'exit code 429' }, { status: 'killed', providerFailure: { kind: 'network' } }] as CoderOutcome[]) {
    const f = setup([outcome]); await resumeTransient(f.options); assert.equal(f.calls(), 1); assert.deepEqual(f.waits, []);
  }
  const f = setup([network]); f.options.sessionId = () => undefined;
  await resumeTransient(f.options); assert.equal(f.calls(), 1); assert.match(f.states.at(-1)!.reason, /未取得/);
});

test('Retry-After delays are honored; long provider cooldowns stop rather than retry too early', async () => {
  const f = setup([{ ...network, providerFailure: { kind: 'rate-limit', retryAfterMs: 20000 } }, { status: 'completed' }]);
  await resumeTransient(f.options); assert.deepEqual(f.waits, [20000]);
  const long = setup([{ ...network, providerFailure: { kind: 'rate-limit', retryAfterMs: 180000 } }]);
  await resumeTransient(long.options); assert.equal(long.calls(), 1); assert.match(long.states.at(-1)!.reason, /超过 2 分钟/);
});

test('cancelling a cooldown or losing a durable checkpoint never starts a second process', async () => {
  const f = setup([network]); f.options.wait = async () => { f.controller.abort(); };
  assert.equal((await resumeTransient(f.options)).status, 'killed'); assert.equal(f.calls(), 1);
  const changed = setup([network]); changed.options.beforeResume = async () => { throw new Error('workspace moved'); };
  assert.equal((await resumeTransient(changed.options)).status, 'failed'); assert.equal(changed.calls(), 1);
  const failedWrite = setup([network]); failedWrite.options.checkpoint = async () => { throw new Error('storage failed'); };
  assert.equal((await resumeTransient(failedWrite.options)).status, 'failed'); assert.equal(failedWrite.calls(), 1);
});

test('native retries remain a single live attempt, and cancellation reaches that attempt', async () => {
  const f = setup([network]); let finish!: (outcome: CoderOutcome) => void, cancelled = false;
  f.options.run = () => ({ done: new Promise(resolve => { finish = resolve; }), cancel() { cancelled = true; finish({ status: 'killed' }); } });
  const done = resumeTransient(f.options);
  await Promise.resolve(); assert.deepEqual(f.waits, []); assert.deepEqual(f.states, []);
  f.controller.abort(); assert.equal((await done).status, 'killed'); assert.equal(cancelled, true);
});


test('retry diagnostics discard authenticated URLs and provider credentials', () => {
  const detail = safeFailureDetail('503 https://name:password@example.com/secret?token=abc Bearer private-token api_key=hidden sk-abcdefghijkl');
  assert.doesNotMatch(detail, /password|example.com|abc|private-token|hidden/);
  assert.match(detail, /503/);
});
