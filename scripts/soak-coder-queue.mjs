// Bounded local lifecycle soak; no model requests or channel messages.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { CoderQueue } = await import(pathToFileURL(resolve(process.env.NEXUS_DIST ?? 'dist', 'src/coders/queue.js')));
const duration = Number(process.env.NEXUS_SOAK_MS ?? 60_000);
assert.ok(Number.isFinite(duration) && duration >= 1000 && duration <= 600_000);
const start = Date.now();
let rounds = 0, checkpoint = start, peakRss = 0;
while (Date.now() - start < duration) {
  const queue = new CoderQueue(3), signal = new AbortController().signal;
  const owner = await queue.acquire(signal, '/workspace/repo');
  const cancelled = new AbortController();
  const rejected = assert.rejects(queue.acquire(cancelled.signal, '/workspace/repo/sub'), /cancelled/);
  cancelled.abort(); await rejected;
  let entered = false;
  const waiting = queue.acquire(signal, '/workspace/repo').then(release => { entered = true; return release; });
  const independent = await queue.acquire(signal, '/workspace/other');
  assert.equal(entered, false); independent(); owner(); owner(); (await waiting)();
  queue.close(); await assert.rejects(queue.acquire(signal), /cancelled/);
  rounds++; peakRss = Math.max(peakRss, process.memoryUsage().rss);
  await delay(1);
  if (Date.now() - checkpoint >= 15_000) { console.log(JSON.stringify({ rounds, elapsedMs: Date.now() - start })); checkpoint = Date.now(); }
}
console.log(JSON.stringify({ passed: true, rounds, elapsedMs: Date.now() - start, peakRssMiB: Math.ceil(peakRss / 1048576) }));
