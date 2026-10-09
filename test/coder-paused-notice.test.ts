import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ToolExecution, PreToolDecision } from '@deepseek-ai/dsh-tools';
import type { TaskRecord } from '../src/coders/types.js';
import { installPausedNoticeGuard, pausedNoticeTask } from '../src/coders/paused-notice.js';
import { timeoutSummary } from '../src/coders/timing.js';
import { taskSchema } from '../src/coders/store.js';

const task: TaskRecord = { id: 'ct-test', coder: 'codex', ownerSession: 'owner', cwd: '/workspace', description: 'fixture',
  status: 'interrupted', stopCause: 'user-wait-timeout', createdAt: 0, updatedAt: 700_000, escalations: 1, decisions: [],
  userWaitTimeout: { startedAt: 100_000, endedAt: 700_000, summary: 'node verify.mjs', reason: 'missing evidence' } };
const event = (type: string, seq: number, data: unknown, time = 701_000) => ({ type, seq, time, data }) as SessionEvent;
const events = [event('turn/start', 1, { turn: 2 }), event('user/message', 2, { source: { kind: 'tool-jobs', form: 'notice', summary: 'Codex [ct-test] stopped' }, content: 'notice' })];

test('automatic timeout notice blocks execution, changes and redispatch through the public guard', async () => {
  let hook!: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>;
  const ctx = { on(name: string, fn: typeof hook) { assert.equal(name, 'tools/pre-execute'); hook = fn; } } as unknown as Context;
  installPausedNoticeGuard(ctx, () => [task]);
  let executed = 0;
  const run = async (name: string, args: unknown = {}, current = events) => hook({ name, arguments: args,
    agent: { id: 'owner', session: { snapshotEvents: () => current } } } as unknown as ToolExecution, async () => { executed++; return { kind: 'allow' }; });
  for (const name of ['pwsh', 'bash', 'write', 'edit', 'coder_task', 'load_workspace_dependencies', 'unknown_mutator', 'present']) {
    const result = await run(name); assert.equal(result.kind, 'deny', name);
    if (result.kind === 'deny') assert.match(result.reason, /等待用户明确续接/);
  }
  assert.equal(executed, 0);
  for (const name of ['read', 'grep', 'glob', 'coder_status', 'job_output', 'run_code']) assert.equal((await run(name)).kind, 'allow');
  assert.equal((await run('coder_brief', { action: 'recover' })).kind, 'allow');
  assert.equal((await run('coder_brief', { action: 'amend' })).kind, 'deny');
  assert.equal((await run('str_replace_editor', { command: 'view' })).kind, 'allow');
  assert.equal((await run('str_replace_editor', { command: 'create' })).kind, 'deny');
  const input = event('user/message', 3, { source: { kind: 'user' }, content: '继续' }, 702_000);
  assert.equal((await run('coder_task', {}, [...events, input])).kind, 'allow', 'a new real user message returns to normal native policy');
});

test('timeout boundary ignores other owners, other jobs, stale answers and synthetic contexts', () => {
  assert.equal(pausedNoticeTask('other', events, [task]), undefined);
  assert.equal(pausedNoticeTask('owner', events, [{ ...task, id: 'ct-other' }]), undefined);
  assert.equal(pausedNoticeTask('owner', [...events, event('user/message', 3, { source: { kind: 'compact-checkpoint' }, content: 'continue' })], [task]), task);
  assert.equal(pausedNoticeTask('owner', [...events, event('user/message', 3, { source: { kind: 'user-question-reply' }, content: '允许' })], [task]), task);
  assert.equal(pausedNoticeTask('owner', [...events, event('user/message', 3, { source: { kind: 'user', rpcId: 'wechat-hook-finish' }, content: 'continue' })], [task]), task);
  assert.equal(pausedNoticeTask('owner', [...events, event('turn/start', 4, { turn: 3 })], [task]), undefined);
  assert.equal(pausedNoticeTask('owner', events, [task, { ...task, id: 'next', resumedFrom: task.id }]), undefined);
});

test('persisted timeout duration is separate from whole-task time and legacy unknowns', () => {
  const stored = taskSchema.parse(task);
  assert.deepEqual(stored.userWaitTimeout, task.userWaitTimeout);
  assert.match(timeoutSummary(stored).join('\n'), /600\.0 秒.*不是任务总耗时/);
  assert.match(timeoutSummary({ ...task, userWaitTimeout: undefined }).join('\n'), /未保存单次时长/);
  assert.deepEqual(timeoutSummary({ ...task, stopCause: undefined }), []);
});

test('no-progress retry completion cannot trigger an automatic fresh job that resets the wait budget', async () => {
  const stalled = { ...task, stopCause: 'retry-no-progress' as const, userWaitTimeout: undefined };
  let hook!: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>;
  installPausedNoticeGuard({ on(_name: string, fn: typeof hook) { hook = fn; } } as unknown as Context, () => [stalled]);
  const call = (current: SessionEvent[]) => hook({ name: 'coder_task', arguments: { retry_task_id: stalled.id },
    agent: { id: 'owner', session: { snapshotEvents: () => current } } } as unknown as ToolExecution, async () => ({ kind: 'allow' }));
  const denied = await call(events);
  assert.equal(denied.kind, 'deny'); if (denied.kind === 'deny') assert.match(denied.reason, /重试长时间没有进展/);
  assert.equal((await call([...events, event('user/message', 3, { source: { kind: 'user' }, content: '继续' }, 702_000)])).kind, 'allow');
});
