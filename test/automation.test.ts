import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ScheduleId, type ScheduleCatalogEntry, type ScheduleUpdateRequest } from '@deepseek-ai/dsh-schedule';
import { SessionId } from '@deepseek-ai/dsh-session';
import { automationRevision, manageAutomation } from '../src/dsh/automation.js';

function fixture() {
  const original: ScheduleCatalogEntry = { id: ScheduleId('schedule-original'), sessionId: SessionId('chat-old'), status: 'active', kind: 'daily',
    title: '每日资讯', prompt: '搜索今日资讯，列出来源与日期，生成摘要后推送。', time: '08:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-10-04T00:00:00.000Z' };
  let entries: ScheduleCatalogEntry[] = [original, { ...original, id: ScheduleId('schedule-foreign'), sessionId: SessionId('foreign') }];
  let enabled = true, bound = true, readOnly = false, writes = 0, corruptReadback = false, conflict = false;
  const session = { id: SessionId('chat-new') };
  const agent = { session };
  const schedule = {
    async catalog() { return structuredClone(entries); },
    async update(request: ScheduleUpdateRequest) {
      assert.equal(request.sessionId, original.sessionId);
      assert.equal('sessionId' in request.expected, false);
      if (conflict) return { id: request.id, updated: false, code: 'schedule_conflict' };
      writes++;
      const record = { ...request.expected, ...(request.title ? { title: request.title } : {}), ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.change?.kind === 'daily' ? { time: request.change.daily.time } : {}) };
      entries[0] = { ...record, sessionId: original.sessionId, status: 'active' };
      if (corruptReadback) entries = entries.slice(1);
      return { id: request.id, updated: true, record };
    },
    async delete() { writes++; entries = entries.slice(1); return { deleted: true }; },
  };
  const ctx = { get: () => ({ ...schedule }), tools: { get: (_name: string, scope: unknown) => enabled && scope === agent ? {} : undefined },
    sandboxPolicy: { resolve: () => ({ mode: readOnly ? 'read-only' : 'workspace-write' }) } } as unknown as Context;
  const registry = { sameChat: (a: string, b: string) => bound && [a, b].every(id => id.startsWith('chat-')) };
  const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext;
  const run = (args: Parameters<typeof manageAutomation>[2]) => manageAutomation(ctx, registry, args, exec) as Promise<any>;
  const edit = { action: 'update' as const, id: original.id, revision: automationRevision(original), change: { kind: 'daily' as const, daily: { time: '08:15:00.000', time_zone: 'Asia/Shanghai' } } };
  return { run, edit, original, writes: () => writes, disable: () => { enabled = false; }, unbind: () => { bound = false; },
    readOnly: () => { readOnly = true; }, corrupt: () => { corruptReadback = true; }, conflict: () => { conflict = true; } };
}

test('rotated chat lists original automation and updates timing without losing prompt or binding', async () => {
  const f = fixture();
  const list = await f.run({ action: 'list' });
  assert.deepEqual(list.tasks.map((task: any) => task.id), [f.original.id]);
  assert.equal(list.tasks[0].type, 'automation');
  const result = await f.run(f.edit);
  assert.equal(result.updated, true);
  assert.equal(result.time, '08:15:00.000');
  assert.equal(result.prompt, f.original.prompt);
  assert.equal(result.sessionId, f.original.sessionId);
  assert.notEqual(result.revision, f.edit.revision);
  assert.equal((await f.run(f.edit)).code, 'schedule_conflict');
  assert.equal(f.writes(), 1);
  assert.equal((await f.run({ action: 'delete', id: result.id, revision: result.revision })).deleted, true);
  assert.deepEqual((await f.run({ action: 'list' })).tasks, []);
});

test('foreign task IDs, missing revision, unbound chats, disabled native tools and read-only sessions cannot mutate', async () => {
  for (const mode of ['foreign', 'revision', 'unbind', 'disable', 'readOnly'] as const) {
    const f = fixture();
    const args = { ...f.edit };
    if (mode === 'foreign') args.id = ScheduleId('schedule-foreign');
    else if (mode === 'revision') args.revision = '';
    else f[mode]();
    assert.ok((await f.run(args)).code);
    assert.equal(f.writes(), 0);
    if (mode === 'unbind') assert.deepEqual((await f.run({ action: 'list' })).tasks, []);
    if (mode === 'disable') assert.equal((await f.run({ action: 'list' })).code, 'automation_unavailable');
  }
});

test('native conflict and failed persisted readback never report success', async () => {
  const f = fixture(); f.conflict();
  assert.equal((await f.run(f.edit)).code, 'schedule_conflict');
  assert.equal(f.writes(), 0);
  const g = fixture(); g.corrupt();
  assert.equal((await g.run(g.edit)).code, 'verification_failed');
  assert.equal(g.writes(), 1);
});
