import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validatePlan, resolvePlanStep } from '../src/coders/plan.js';
import type { CoderBrief } from '../src/coders/brief.js';
import type { TaskRecord } from '../src/coders/types.js';
const acceptance = [{ id: 'a1' }, { id: 'a2' }];
const steps = [
  { id: 'ui', description: 'UI', acceptance_ids: ['a2'], depends_on: ['api'], verify: 'npm test' },
  { id: 'api', description: 'API', acceptance_ids: ['a1'], depends_on: [], verify: 'npm test' },
];
test('plan checking orders dependencies and rejects missing coverage, references, cycles and ineffective verification commands', () => {
  assert.deepEqual(validatePlan(steps, acceptance).map(step => step.id), ['api', 'ui']);
  assert.throws(() => validatePlan([steps[1]], acceptance), /遗漏验收项/);
  assert.throws(() => validatePlan([steps[0], steps[0]], acceptance), /不能重复/);
  assert.throws(() => validatePlan([{ ...steps[0], depends_on: ['missing'] }, steps[1]], acceptance), /不存在的前置/);
  assert.throws(() => validatePlan([{ ...steps[0], acceptance_ids: ['missing'] }, steps[1]], acceptance), /不存在的验收/);
  assert.throws(() => validatePlan([steps[0], { ...steps[1], depends_on: ['ui'] }], acceptance), /循环/);
  assert.throws(() => validatePlan([{ ...steps[0], depends_on: ['ui'] }, steps[1]], acceptance), /循环/);
  assert.throws(() => validatePlan([{ ...steps[0], verify: 'npm test && npm run build' }, steps[1]], acceptance), /shell/);
  assert.throws(() => validatePlan([{ ...steps[0], verify: '' }, steps[1]], acceptance));
});
test('step dependencies resolve only within owner and revision, follow explicit resumes, and reject duplicates', () => {
  const brief: CoderBrief = { id: 'brief', ownerSession: 'owner', revision: 2, objective: 'goal', constraints: '', acceptance: acceptance.map(item => ({ ...item, text: item.id })), createdAt: 0, updatedAt: 0, plan: validatePlan(steps, acceptance) };
  const original: TaskRecord = { id: 'task1', coder: 'claude', description: 'API', cwd: '/work', ownerSession: 'owner', status: 'completed',
    createdAt: 1, updatedAt: 1, escalations: 0, decisions: [], planStep: 'api', jobId: 'job1', brief };
  assert.throws(() => resolvePlanStep(brief, undefined, []), /plan_step/);
  assert.throws(() => resolvePlanStep(brief, 'ui', []), /尚未派发/);
  assert.throws(() => resolvePlanStep(brief, 'ui', [{ ...original, ownerSession: 'foreign' }]), /尚未派发/);
  assert.throws(() => resolvePlanStep(brief, 'ui', [{ ...original, brief: { ...brief, revision: 1 } }]), /尚未派发/);
  assert.deepEqual(resolvePlanStep(brief, 'ui', [original])!.dependsOn, ['task1']);
  assert.throws(() => resolvePlanStep(brief, 'api', [original]), /已经派发/);
  assert.ok(resolvePlanStep(brief, 'api', [original], 'task1'));
  const resumed = { ...original, id: 'task2', resumedFrom: 'task1' };
  assert.deepEqual(resolvePlanStep(brief, 'ui', [original, resumed])!.dependsOn, ['task2']);
  assert.throws(() => resolvePlanStep(brief, 'ui', [original, { ...original, id: 'branch' }]), /多个执行分支/);
});

test('rotated channel generations resolve latest dependencies and still reject duplicate dispatch', () => {
  const owner = `nexus-wechat-${'a'.repeat(32)}`;
  const brief: CoderBrief = { id: 'rotated', ownerSession: owner, revision: 2, objective: 'goal', constraints: '', acceptance: acceptance.map(item => ({ ...item, text: item.id })), createdAt: 0, updatedAt: 0, plan: validatePlan(steps, acceptance) };
  const prior: TaskRecord = { id: 'prior', coder: 'codex', description: 'API', cwd: '/work', ownerSession: `${owner}-1`, status: 'completed', createdAt: 1, updatedAt: 1, escalations: 0, decisions: [], planStep: 'api', jobId: 'job1', brief };
  const latest = { ...prior, id: 'latest', ownerSession: `${owner}-2`, resumedFrom: prior.id };
  assert.deepEqual(resolvePlanStep(brief, 'ui', [prior, latest])!.dependsOn, ['latest']);
  assert.throws(() => resolvePlanStep(brief, 'api', [prior, latest]), /已经派发/);
  assert.throws(() => resolvePlanStep(brief, 'api', [prior, latest], prior.id), /后续执行/);
  assert.throws(() => resolvePlanStep(brief, 'ui', [{ ...latest, ownerSession: `nexus-wechat-${'b'.repeat(32)}-2` }]), /尚未派发/);
});
