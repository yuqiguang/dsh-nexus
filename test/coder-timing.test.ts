import assert from 'node:assert/strict';
import { test } from 'node:test';
import { advanceTiming, initialTiming, timingSummary } from '../src/coders/timing.js';
import { taskSchema } from '../src/coders/store.js';
import type { TaskRecord } from '../src/coders/types.js';
const fixture = (): TaskRecord => ({ id: 'ct-timed', coder: 'codex', description: 'work', cwd: '/work', ownerSession: 'owner', status: 'queued', createdAt: 0, updatedAt: 0, escalations: 0, decisions: [] });

test('phase accounting splits nested review/user waits, retries, verification and terminal time without overlap', () => {
  let record = fixture(); record.timing = initialTiming(record);
  const change = (at: number, patch: Partial<TaskRecord>) => {
    const next = { ...record, ...patch, updatedAt: at };
    record = { ...next, timing: advanceTiming(record, next, at) };
  };
  change(100, { status: 'running' });
  change(300, { reviewDepth: 1 });
  change(400, { reviewDepth: 2 });
  change(450, { reviewDepth: 1 });
  change(500, { status: 'waiting-user' });
  change(800, { reviewDepth: 0 });
  change(900, { status: 'running' });
  change(1000, { retry: { source: 'nexus', phase: 'waiting', reason: 'network', attempt: 1 } });
  change(1050, { activity: 'no new retry' });
  change(1200, { retry: undefined });
  change(1300, { status: 'verifying' });
  change(1400, { reviewDepth: 1 });
  change(1500, { reviewDepth: 0 });
  change(1600, { status: 'completed' });
  change(5000, { completionNotice: { messageId: 'notice', seq: 1, at: 5000 } });
  assert.deepEqual(record.timing?.ms, { queue: 100, execution: 400, review: 300, user: 400, verification: 200, retry: 200 });
  assert.equal(record.timing?.reviews, 3);
  assert.equal(record.timing?.retries, 1);
  assert.equal(record.timing?.toolRetries, 0); assert.equal(record.timing?.resumes, 1);
  assert.equal(Object.values(record.timing!.ms).reduce((a, b) => a + b), 1600);
  assert.deepEqual(taskSchema.parse(record).timing, record.timing);
  assert.equal(timingSummary(record, 9000), timingSummary(record, 5000));
});

test('legacy records stay unknown and backwards clock changes cannot create negative durations', () => {
  const task = fixture();
  assert.equal(advanceTiming(task, task, 100), undefined);
  assert.match(timingSummary(task), /历史任务未记录/);
  task.timing = initialTiming(task, 100);
  const timing = advanceTiming(task, task, 50)!;
  assert.equal(timing.ms.queue, 0); assert.equal(timing.since, 100);
});
