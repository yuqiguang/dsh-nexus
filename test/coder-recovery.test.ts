import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskRecovery, recoveryReport } from '../src/coders/recovery.js';
import { taskStatusLabel } from '../src/coders/status.js';
import type { TaskRecord } from '../src/coders/types.js';
import type { CoderBrief } from '../src/coders/brief.js';

const task = (patch: Partial<TaskRecord> = {}): TaskRecord => ({ id: 'old', coder: 'codex', ownerSession: 'owner', cwd: '/work',
  description: 'fix', status: 'interrupted', createdAt: 1, updatedAt: 2, escalations: 0, decisions: [], ...patch });
const passed = { summary: 'done', changedFiles: [], outsideRoots: [], execution: 'completed' as const, verification: 'passed' as const, verifyOk: true };
const brief: CoderBrief = { id: 'goal', ownerSession: 'owner', revision: 2, objective: 'goal', constraints: '', acceptance: [{ id: 'a1', text: 'works' }], createdAt: 1, updatedAt: 2 };

test('recovery distinguishes retained coder context, failed checks, and absent verification evidence', () => {
  assert.match(taskRecovery(task(), []).context!, /没有可续接.*新的编码执行/);
  assert.match(taskRecovery(task({ coderSessionId: 'native-id' }), []).context!, /可尝试在原上下文续接/);
  const failure = task({ status: 'failed', result: { ...passed, verification: 'failed', verifyOk: false } });
  assert.equal(taskRecovery(failure, []).title, '独立验证未通过');
  assert.match(taskStatusLabel(failure), /验证失败/);
  const notRun = task({ status: 'failed', result: { ...passed, verification: 'not-run', verifyOk: false } });
  assert.equal(taskRecovery(notRun, []).title, '尚未独立验证');
  const done = task({ status: 'completed', result: passed });
  assert.match(taskRecovery(done, []).nextStep, /保留.*仍由你验收/);
  assert.equal(taskRecovery(task({ status: 'completed', result: { summary: 'done', changedFiles: [], outsideRoots: [], verifyOk: true } }), []).title, '尚未独立验证');
});

test('recovery only links following executions owned by the same native session', () => {
  const records = [task({ id: 'foreign', ownerSession: 'other', replaces: 'old' }), task({ id: 'next', replaces: 'old' })];
  assert.deepEqual(taskRecovery(task(), records).followingTasks, ['next']);
  assert.match(taskRecovery(task(), records).nextStep, /不要重复恢复/);
  assert.deepEqual(taskRecovery(task(), records.slice(0, 1)).followingTasks, []);
  const branched = taskRecovery(task(), [...records, task({ id: 'branch', resumedFrom: 'old' })]);
  assert.deepEqual(branched.followingTasks, ['next', 'branch'], 'do not silently pick one branch as the latest');
});

test('old or unavailable goals do not recommend recovering an outdated task', () => {
  const old = task({ brief: { ...brief, revision: 1 } });
  assert.equal(taskRecovery(old, [], brief).title, '此任务属于旧目标版本');
  assert.equal(taskRecovery(old, []).title, '当前目标记录不可用');
  assert.match(taskRecovery(old, [], brief).nextStep, /核对当前目标和验收项/);
});

test('guidance uses current plan dependencies while preserving passed independent steps', () => {
  const current: CoderBrief = { ...brief, plan: [
    { id: 'a', description: 'A', acceptance_ids: ['a1'], depends_on: [], verify: 'test' },
    { id: 'b', description: 'B', acceptance_ids: ['a1'], depends_on: ['a'], verify: 'test' },
    { id: 'c', description: 'C', acceptance_ids: ['a1'], depends_on: [], verify: 'test' },
  ] };
  const a = task({ id: 'a', brief, planStep: 'a', jobId: 'job-a' });
  const fixed = task({ id: 'fixed', brief, planStep: 'a', replaces: 'a', jobId: 'job-fixed', status: 'completed', result: passed });
  const b = task({ brief, planStep: 'b', dependsOn: ['a'], jobId: 'job-b' });
  const c = task({ id: 'c', brief, planStep: 'c', jobId: 'job-c', status: 'completed', result: passed });
  assert.deepEqual(taskRecovery(b, [a, fixed, b, c], current).blockers, []);
  const report = recoveryReport(current, [a, fixed, b, c], true);
  assert.match(report, /c：保留已通过的结果，无需重做/);
  assert.match(report, /b：可在所属会话中恢复/);
  assert.doesNotMatch(report, /retry_task_id/);
  assert.match(taskRecovery(b, [a, b, c], current).blockers.join(''), /前置任务尚未通过/);
  assert.match(recoveryReport(current, [a, b, c], true), /b：前置步骤尚未通过/);
});

test('active downstream work and foreign dependencies block recovery guidance', () => {
  const a = task();
  const downstream = task({ id: 'down', status: 'running', dependsOn: [a.id] });
  assert.match(taskRecovery(a, [a, downstream]).blockers.join(''), /下游任务活动/);
  const parent = task({ id: 'parent', ownerSession: 'foreign', status: 'completed', result: passed });
  assert.match(taskRecovery(task({ dependsOn: ['parent'] }), [parent]).blockers.join(''), /前置任务尚未通过或不可用/);
});

test('waiting approvals and in-flight verification direct the user to existing work', () => {
  assert.match(taskRecovery(task({ status: 'waiting-user' }), []).nextStep, /旧消息中的审批回复不能用于新的请求/);
  assert.match(taskRecovery(task({ status: 'verifying' }), []).nextStep, /不代表验证和总体目标已经完成/);
  assert.equal(taskRecovery(task({ status: 'running' }), []).context, undefined);
});

test('timeout and preflight failure explain the stopped boundary without automatic redispatch', () => {
  const timeout = task({ stopCause: 'user-wait-timeout', result: { ...passed, verification: 'not-run', verifyOk: false } });
  assert.equal(taskRecovery(timeout, []).title, '等待用户超时，已暂停');
  assert.match(taskStatusLabel({ ...timeout, status: 'interrupted' }), /超时，已暂停/);
  assert.match(taskRecovery(timeout, []).nextStep, /等待用户明确.*不自动重复派发/);
  const preflight = task({ status: 'failed', result: { ...passed, execution: 'failed', verification: 'not-run', verifyOk: undefined,
    preflightCheck: { command: 'node check.cjs', ok: false, executed: true, output: 'environment failure' } } });
  assert.equal(taskRecovery(preflight, []).title, '执行前环境预检未通过');
  assert.match(taskRecovery(preflight, []).context!, /编码工具尚未启动/);
  assert.match(taskRecovery(task({ status: 'failed', result: { ...passed, verification: 'failed', verifyOk: false } }), []).nextStep, /verification_only=true/);
});
