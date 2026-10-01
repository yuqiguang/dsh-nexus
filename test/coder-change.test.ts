import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeChange } from '../src/coders/change.js';
import type { CoderBrief } from '../src/coders/brief.js';
test('plan change impact includes downstream steps but not independent successes', () => {
  const steps = ['a', 'b', 'c'].map((id, i) => ({ id, description: id, acceptance_ids: [`a${i+1}`], depends_on: id === 'b' ? ['a'] : [], verify: 'true' }));
  const brief: CoderBrief = { id: 'b', revision: 1, objective: 'goal', constraints: '', ownerSession: 'o', acceptance: ['a1','a2','a3'].map(id => ({ id, text: id })), plan: steps, createdAt: 0, updatedAt: 0 };
  assert.deepEqual(analyzeChange(brief, { steps: steps.map(step => step.id === 'a' ? { ...step, verify: 'npm test' } : step) }).affected.sort(), ['a', 'b']);
  assert.deepEqual(analyzeChange(brief, { constraints: 'new constraint' }).affected.sort(), ['a', 'b', 'c']);
});
