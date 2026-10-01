import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dependencyIds, waitForDependencies } from '../src/coders/dependencies.js';
import { taskStatusLabel } from '../src/coders/status.js';
import type { TaskRecord } from '../src/coders/types.js';

const passed: TaskRecord = { id: 'a', coder: 'claude', cwd: '/work', description: 'A', status: 'completed', ownerSession: 'owner',
  createdAt: 1, updatedAt: 2, escalations: 0, decisions: [], result: { summary: '', execution: 'completed', verification: 'passed', verifyOk: true, changedFiles: [], outsideRoots: [] } };
const dependent = { ...passed, id: 'b', dependsOn: ['a'] };

test('dependency admission rejects missing/foreign/invalid IDs and deduplicates existing prerequisites', () => {
  const get = (id: string) => id === 'a' ? passed : undefined;
  assert.deepEqual(dependencyIds(['a', 'a'], 'owner', get), ['a']);
  for (const ids of [['unknown'], [1], 'a', Array(11).fill('a')]) assert.throws(() => dependencyIds(ids, 'owner', get));
  assert.throws(() => dependencyIds(['a'], 'foreign', get), /不存在或不属于/);
});

test('a prerequisite must both finish execution and pass independent verification', async () => {
  const signal = new AbortController().signal;
  await waitForDependencies(dependent, () => passed, () => undefined, signal);
  const invalid: TaskRecord[] = [
    ...(['failed', 'cancelled', 'interrupted', 'queued'] as const).map(status => ({ ...passed, status })),
    { ...passed, result: undefined },
    { ...passed, result: { ...passed.result!, verification: 'not-run' } },
    { ...passed, result: { ...passed.result!, verification: 'failed', verifyOk: false } },
    { ...passed, result: { ...passed.result!, execution: 'stopped' } },
    { ...passed, result: { ...passed.result!, outsideRoots: ['/outside'] } },
  ];
  for (const record of invalid) await assert.rejects(waitForDependencies(dependent, () => record, () => undefined, signal), /前置任务/);
  assert.equal(taskStatusLabel(passed), '执行结束，验证通过');
  assert.equal(taskStatusLabel({ ...passed, result: undefined }), '执行结束，尚未独立验证');
});

test('cancelling a dependency wait settles promptly without completing or cancelling the prerequisite', async () => {
  const controller = new AbortController();
  const running = { ...passed, status: 'running' as const };
  const pending = new Promise(() => {});
  const wait = waitForDependencies(dependent, () => running, () => pending, controller.signal);
  controller.abort();
  await assert.rejects(wait, /cancelled/);
  await assert.rejects(waitForDependencies(dependent, () => undefined, () => pending, controller.signal));
  assert.equal(running.status, 'running');
});
