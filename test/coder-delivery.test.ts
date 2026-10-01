import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionEvidence, deliveryReport } from '../src/coders/delivery.js';
import type { CoderBrief } from '../src/coders/brief.js';
import type { TaskRecord } from '../src/coders/types.js';
const brief: CoderBrief = { id: 'b', revision: 1, objective: 'goal', constraints: '', acceptance: [{ id: 'a1', text: 'works' }], ownerSession: 'owner', createdAt: 0, updatedAt: 0 };
const record: TaskRecord = { id: 't', ownerSession: 'owner', brief, description: 'work', coder: 'claude', cwd: '/work', status: 'completed', createdAt: 1, updatedAt: 2,
  escalations: 0, decisions: [], result: { summary: 'done', changedFiles: ['/work/out'], commits: ['a'.repeat(40)], outsideRoots: [], execution: 'completed', verification: 'passed', verifyOk: true } };
test('delivery separates command checks from user acceptance and invalidates changed evidence', () => {
  assert.match(deliveryReport(brief, [record]), /业务验收待确认/);
  const accepted = { ...brief, reviews: [{ criterion: 'a1', evidence: criterionEvidence(brief, [record], 'a1').evidence, accepted: true, note: 'tested actual flow', at: 3 }] };
  assert.match(deliveryReport(accepted, [record]), /检查与业务验收均通过/);
  assert.match(deliveryReport(accepted, [record]), /\/work\/out/);
  assert.match(deliveryReport(accepted, [record]), new RegExp('a'.repeat(40)));
  assert.match(deliveryReport(accepted, [{ ...record, updatedAt: 4 }]), /业务验收待确认/);
  assert.match(deliveryReport(accepted, [{ ...record, ownerSession: 'foreign' }]), /任务 未安排/);
  assert.match(deliveryReport({ ...accepted, revision: 2 }, [record]), /尚未完成全部验收/);
});
