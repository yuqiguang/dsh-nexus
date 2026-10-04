import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UserWaits } from '../src/coders/user-waits.js';
import { advanceTiming, initialTiming } from '../src/coders/timing.js';
import type { TaskRecord } from '../src/coders/types.js';

test('overlapping waits retain first pending question and accrue waiting until the last answer', () => {
  const waits = new UserWaits();
  let task: TaskRecord = { id: 'task', coder: 'codex', description: 'work', cwd: '/work', ownerSession: 'owner', status: 'verifying', createdAt: 0, updatedAt: 0, escalations: 0, decisions: [] };
  task.timing = initialTiming(task);
  const update = (patch: Partial<TaskRecord>, at: number) => { const next = { ...task, ...patch }; task = { ...next, timing: advanceTiming(task, next, at) }; };
  const first = Symbol(), second = Symbol();
  update(waits.add(task, first, { at: 10, kind: 'question', summary: 'first' }), 10);
  update(waits.add(task, second, { at: 20, kind: 'question', summary: 'second' }), 20);
  assert.equal(task.pending?.summary, 'first');
  update(waits.remove(task, first), 30);
  assert.equal(task.status, 'waiting-user'); assert.equal(task.pending?.summary, 'second');
  update(waits.remove(task, second), 50);
  assert.equal(task.status, 'verifying'); assert.equal(task.pending, undefined);
  assert.equal(task.timing?.ms.user, 40);
  assert.deepEqual(waits.remove(task, second), {});
  update(waits.add(task, first, { at: 60, kind: 'question', summary: 'cancel' }), 60);
  task.status = 'cancelled';
  assert.deepEqual(waits.remove(task, first), {});
});
