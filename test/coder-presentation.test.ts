import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { noticeTask, taskNotices, taskSummary } from '../src/coders/presentation.js';
import { CoderStore, taskSchema, type DomainOpener } from '../src/coders/store.js';
import type { TaskRecord } from '../src/coders/types.js';

const task = (extra: Partial<TaskRecord> = {}): TaskRecord => ({ id: 'ct-00000001', coder: 'codex', ownerSession: 'owner', jobId: 'coder-1',
  cwd: '/work', description: 'do work', status: 'completed', createdAt: 10, updatedAt: 20, escalations: 0, decisions: [], ...extra });
const notice = (extra: { seq?: number; time?: number; id?: string; kind?: string; form?: string; text?: string } = {}) => ({
  type: 'user/message', seq: extra.seq ?? 4, time: extra.time ?? 30,
  data: { id: extra.id ?? 'message-1', source: { kind: extra.kind ?? 'tool-jobs', form: extra.form ?? 'notice' },
    content: [{ type: 'text', text: extra.text ?? 'background job coder-1 (coder: Codex [ct-00000001]: do work) finished completed. Read its output with job_output.' }] },
} as unknown as SessionEvent);

test('native notices require the owner, coder, job, stable task ID and a settled task', () => {
  const record = task();
  assert.equal(noticeTask([record], 'owner', notice()), record);
  for (const event of [notice({ kind: 'user' }), notice({ form: 'request' }), notice({ time: 5 }), notice({ text: 'background job coder-2 (coder: Codex [ct-00000001]: work)' }),
    notice({ text: 'background job coder-1 (coder: Claude Code [ct-00000001]: work)' }), notice({ text: 'background job coder-1 (coder: Codex [ct-00000002]: work)' }),
    notice({ text: 'background job coder-1\n[notice truncated]\nDone; job_output.' })]) assert.equal(noticeTask([record], 'owner', event), undefined);
  assert.equal(noticeTask([record], 'foreign', notice()), undefined);
  assert.equal(noticeTask([task({ status: 'running' })], 'owner', notice()), undefined);
});

test('reused native job IDs after restart cannot attach an older notice to a new task', () => {
  const old = task(), next = task({ id: 'ct-00000002', createdAt: 40, updatedAt: 50 });
  assert.equal(noticeTask([next, old], 'owner', notice()), old);
  assert.equal(noticeTask([next, old], 'owner', notice({ time: 60, text: 'background job coder-1 (coder: Codex [ct-00000002]: new)' })), next);
  const legacy = 'background job coder-1 (coder: Codex: legacy) finished completed.';
  assert.equal(noticeTask([next, old], 'owner', notice({ text: legacy })), old);
  assert.equal(noticeTask([next, old], 'owner', notice({ text: legacy, time: 60 })), next);
  assert.equal(noticeTask([old, task({ id: 'ct-00000002' })], 'owner', notice({ text: legacy })), undefined);
  assert.equal(noticeTask([old, task({ id: 'ct-00000002', createdAt: 25, status: 'running' })], 'owner', notice({ text: legacy })), undefined);
});

test('summary preserves verification evidence and pending state without exposing logs or transcript', () => {
  const base = task({ result: { execution: 'completed', verification: 'not-run', summary: 'claims success', changedFiles: [], outsideRoots: [] }, trace: [{ at: 1, text: 'private process' }] });
  assert.match(taskSummary(base).statusLabel, /尚未独立验证/);
  assert.match(taskSummary(task({ ...base, result: { ...base.result!, verification: 'failed', verifyOk: false } })).statusLabel, /验证失败/);
  assert.equal('result' in taskSummary(base), false);
  assert.equal('trace' in taskSummary(base), false);
  assert.equal(taskSummary(task({ status: 'waiting-user', pending: { at: 1, kind: 'command', summary: 'allow?' } })).pending, 'allow?');
  assert.equal(taskSummary(task({ pending: { at: 1, kind: 'command', summary: 'old approval' } })).pending, undefined);
});

test('native history backfill persists the first exact placement, ignores inherited events and never changes execution timestamps', async () => {
  const records = new Map<string, TaskRecord>([[task().id, task()]]);
  let writes = 0, inspections = 0;
  const store = await CoderStore.open({ async open() { return { table: () => ({ get: (id: string) => records.get(id), entries: () => records.entries(),
    async update(id: string, update: (record: TaskRecord) => TaskRecord) { const next = taskSchema.parse(update(records.get(id)!)); records.set(id, next); writes++; return next; } }) }; } } as unknown as DomainOpener);
  let listener!: (session: { id: string }, event: SessionEvent) => void;
  const ctx = { on(_event: string, callback: typeof listener) { listener = callback; }, effect() {}, sessionController: {
    async inspect(owner: string) { inspections++; assert.equal(owner, 'owner'); return { inheritedEventCount: 1,
      events: [notice({ seq: 1, id: 'inherited' }), notice(), notice({ seq: 8, id: 'duplicate' })] }; },
  } } as unknown as Context;
  const sync = taskNotices(ctx, store);
  await Promise.all([sync('owner'), sync('owner')]);
  assert.equal(inspections, 1); assert.equal(writes, 1);
  assert.deepEqual(store.get(task().id)!.completionNotice, { messageId: 'message-1', seq: 4, at: 30 });
  assert.equal(store.get(task().id)!.updatedAt, 20);
  listener({ id: 'owner' }, notice({ seq: 9 })); await sync('owner'); assert.equal(writes, 1);
  // A newly observed task is linked even after that owner's one-time backfill.
  records.set('ct-00000002', task({ id: 'ct-00000002', jobId: 'coder-2' }));
  listener({ id: 'owner' }, notice({ seq: 10, text: 'background job coder-2 (coder: Codex [ct-00000002]: new) finished completed.' }));
  await sync('owner'); assert.equal(store.get('ct-00000002')!.completionNotice?.seq, 10);
  assert.equal(inspections, 1);
  const reloaded = taskNotices(ctx, store); await reloaded('owner'); assert.equal(writes, 2, 'reloading must not overwrite established links');
});
