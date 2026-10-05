import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CoderQueue } from '../src/coders/queue.js';
import { acquireReviewSlot, reviewUntilAborted } from '../src/coders/review.js';

test('queued reviews get their own deadline on admission and remain cancellable while waiting', async () => {
  const queue = new CoderQueue(1), controller = new AbortController();
  const held = await queue.acquire(controller.signal);
  const pending = acquireReviewSlot(queue, controller.signal, 40);
  await delay(70); held();
  const slot = await pending;
  assert.equal(slot.signal.aborted, false, 'queue time must not consume model budget');
  const work = reviewUntilAborted(new Promise(() => {}), slot.signal);
  const rejection = assert.rejects(work, error => (error as Error).name === 'TimeoutError');
  await delay(70); await rejection; slot.release();
  const next = await queue.acquire(controller.signal);
  const cancel = new AbortController();
  const cancelled = assert.rejects(acquireReviewSlot(queue, cancel.signal, 40), /cancelled/);
  cancel.abort(); await cancelled; next();
  const last = await acquireReviewSlot(queue, controller.signal, 1000);
  controller.abort(); assert.equal(last.signal.aborted, true); last.release(); queue.close();
});
