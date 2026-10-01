import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ActiveBudget } from '../src/coders/budget.js';
test('nested approval waits pause the runtime budget and resume only after the last wait', async () => {
  let expired = 0; const budget = new ActiveBudget(50, () => expired++);
  const first = budget.pause(), second = budget.pause();
  await delay(80); assert.equal(expired, 0);
  first(); first(); await delay(80); assert.equal(expired, 0);
  second(); await delay(80); assert.equal(expired, 1); budget.close();
});
