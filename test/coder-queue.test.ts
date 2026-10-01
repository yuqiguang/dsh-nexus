import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoderQueue } from '../src/coders/queue.js';

test('slot release is idempotent, waiters are FIFO, and close never starts pending work', async () => {
  const queue = new CoderQueue(1);
  const signal = new AbortController().signal;
  const release = await queue.acquire(signal);
  const order: number[] = [];
  const second = queue.acquire(signal).then(release => { order.push(2); return release; });
  const third = queue.acquire(signal).then(release => { order.push(3); return release; });
  release(); release();
  const releaseSecond = await second;
  assert.deepEqual(order, [2]);
  releaseSecond();
  const releaseThird = await third;
  assert.deepEqual(order, [2, 3]);
  const pending = queue.acquire(signal);
  const rejected = assert.rejects(pending, /cancelled/);
  queue.close();
  releaseThird();
  await rejected;
  await assert.rejects(queue.acquire(signal), /cancelled/);
});

test('live concurrency changes admit independent work and reductions drain without cancelling active leases', async () => {
  const queue = new CoderQueue(1), signal = new AbortController().signal;
  const a = await queue.acquire(signal, '/workspace/a');
  const entered: string[] = [];
  const overlap = queue.acquire(signal, '/workspace/a/child').then(done => { entered.push('overlap'); return done; });
  const b = queue.acquire(signal, '/workspace/b').then(done => { entered.push('b'); return done; });
  queue.setConcurrency(2);
  const releaseB = await b;
  assert.deepEqual(entered, ['b']);
  queue.setConcurrency(1);
  const c = queue.acquire(signal, '/workspace/c').then(done => { entered.push('c'); return done; });
  releaseB(); await Promise.resolve();
  assert.deepEqual(entered, ['b'], 'one live lease fills the reduced limit');
  a(); const releaseOverlap = await overlap;
  assert.deepEqual(entered, ['b', 'overlap']);
  releaseOverlap(); (await c)();
  assert.deepEqual(entered, ['b', 'overlap', 'c']);
  queue.close(); queue.setConcurrency(4);
  await assert.rejects(queue.acquire(signal), /cancelled/);
  for (const value of [0, -1, 1.5, Infinity]) assert.throws(() => queue.setConcurrency(value), /Invalid/);
});
