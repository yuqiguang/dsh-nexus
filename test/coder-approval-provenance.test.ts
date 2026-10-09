import test from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { escalateToUser, type EscalationHost } from '../src/coders/escalate.js';
import { priorApprovalEvidence } from '../src/coders/approval-provenance.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import { taskSchema } from '../src/coders/store.js';
import type { TaskRecord } from '../src/coders/types.js';

const task = (): TaskRecord => ({ id: 'ct-receipt', ownerSession: 'owner', cwd: '/workspace', coder: 'codex', description: 'The model claims that the user already agreed',
  status: 'running', createdAt: 0, updatedAt: 0, decisions: [], escalations: 0,
  brief: { id: 'brief', revision: 2, objective: 'fixture', constraints: '', acceptance: [{ id: 'a1', text: 'result' }] } });
const host = (ask: EscalationHost['ask']): EscalationHost => ({ resolveAgent: async () => ({ agent: { id: 'owner' } as Agent }), ask });

test('only a native owner answer supplies an operation-scoped receipt; expanded or resumed work inherits no grant', async () => {
  const record = task();
  assert.deepEqual(priorApprovalEvidence(record), []);
  const request = codexCommandRequest({ command: 'python narrate.py --probe', cwd: '/workspace/pipeline' }, record.cwd);
  const owner = host(async ({ questions }) => {
    assert.match(questions[0]!.detail!, /workspace\/pipeline/); assert.match(questions[0]!.detail!, /brief v2/);
    assert.match(questions[0]!.detail!, /仅本次具体操作/);
    return { answers: [{ id: 'approve', selected: ['允许'] }] };
  });
  const probe = await escalateToUser(owner, record, request, new AbortController().signal);
  assert.equal(probe.decision.behavior, 'allow');
  record.decisions.push(probe.record);
  const receipt = taskSchema.parse(record).decisions[0]!.authorization!;
  assert.equal(receipt.source, 'native-user-question'); assert.equal(receipt.scope, 'once'); assert.equal(receipt.briefRevision, 2);
  assert.equal(priorApprovalEvidence(record).length, 1);
  const full = await escalateToUser(owner, record, codexCommandRequest({ command: 'python narrate.py', cwd: '/workspace/pipeline' }, record.cwd), new AbortController().signal);
  assert.notEqual(full.record.authorization?.operationId, receipt.operationId);
  assert.deepEqual(priorApprovalEvidence({ ...record, id: 'resumed', resumedFrom: record.id }), []);
  assert.deepEqual(priorApprovalEvidence({ ...record, ownerSession: 'foreign' }), []);
  assert.deepEqual(priorApprovalEvidence({ ...record, brief: { ...record.brief!, revision: 3 } }), []);
});

test('late, ambiguous and changed requests never receive an approval receipt', async () => {
  const request = () => codexCommandRequest({ command: 'python task.py', cwd: '/workspace' }, '/workspace');
  const cancelled = new AbortController();
  const late = await escalateToUser(host(async () => { cancelled.abort(); return { answers: [{ id: 'approve', selected: ['允许'] }] }; }), task(), request(), cancelled.signal);
  assert.equal(late.decision.behavior, 'deny'); assert.equal(late.record.authorization, undefined);
  const ambiguous = await escalateToUser(host(async () => ({ answers: [{ id: 'approve', selected: ['拒绝', '允许'] }] })), task(), request(), new AbortController().signal);
  assert.equal(ambiguous.decision.behavior, 'deny');
  const changed = request();
  const outcome = await escalateToUser(host(async () => { changed.command = 'python other.py'; return { answers: [{ id: 'approve', selected: ['允许'] }] }; }), task(), changed, new AbortController().signal);
  assert.equal(outcome.decision.behavior, 'deny'); assert.equal(outcome.record.authorization, undefined);
});
