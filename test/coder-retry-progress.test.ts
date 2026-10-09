import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryProgressGuard, type RetryProgressEvent } from '../src/coders/retry-progress.js';

test('one no-progress budget covers separate native waits and resumes, with warning and terminal notification', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const events: RetryProgressEvent[] = [];
  const guard = new RetryProgressGuard(event => events.push(event), { warnAfterMs: 100, stopAfterMs: 200, intervalMs: 25 });
  t.after(() => guard.close());
  guard.setWaiting(true); t.mock.timers.tick(60);
  guard.setWaiting(false); t.mock.timers.tick(10_000);
  assert.equal(guard.waitedMs, 60);
  guard.setWaiting(true); t.mock.timers.tick(40);
  assert.equal(guard.warned, true);
  assert.equal(events.at(-1)?.level, 'warning');
  guard.setWaiting(false); guard.setWaiting(true); t.mock.timers.tick(100);
  assert.equal(guard.stopped, true); assert.equal(events.at(-1)?.level, 'stop');
  assert.equal(guard.waitedMs, 200);
  const count = events.length; guard.progress(); guard.setWaiting(true); t.mock.timers.tick(1000);
  assert.equal(events.length, count, 'a stopped job cannot resurrect its retry timer');
});

test('nested approval waits do not consume the retry guard, and only successful work resets it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const guard = new RetryProgressGuard(() => {}, { warnAfterMs: 100, stopAfterMs: 200 });
  t.after(() => guard.close());
  guard.setWaiting(true); t.mock.timers.tick(90);
  const first = guard.pause(), second = guard.pause();
  t.mock.timers.tick(500); first(); first(); t.mock.timers.tick(500);
  assert.equal(guard.waitedMs, 90); assert.equal(guard.stopped, false);
  second(); t.mock.timers.tick(10); assert.equal(guard.warned, true);
  guard.progress(); assert.equal(guard.waitedMs, 0); assert.equal(guard.warned, false);
  t.mock.timers.tick(90); assert.equal(guard.stopped, false);
  guard.close(); t.mock.timers.tick(1000); assert.equal(guard.waitedMs, 90);
});
