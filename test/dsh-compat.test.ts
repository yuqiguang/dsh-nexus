import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { executeNativeTool } from '../src/dsh/tools.js';
import { inspectSession } from '../src/dsh/history.js';
import { scheduleCatalog } from '../src/dsh/schedule.js';
import { automationRevision, manageAutomation } from '../src/dsh/automation.js';
import { ChannelNavigation } from '../src/dsh/navigation.js';
import type { SessionRosterView } from '../src/sessions/index.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('channel session menus accept optional title projections without rendering malformed values', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-title-projection-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const base = 'nexus-wechat-' + 'a'.repeat(32);
  const items = ['旧会话标题', undefined, { text: 'unexpected title shape' }, ''].map((title, index) => ({
    sessionId: SessionId(index ? `${base}-${index}` : base), cwd, updatedAt: index, running: false, blank: false, agentAvailable: false,
    ...(title === undefined ? {} : { projections: { values: { title } } }),
  }));
  const ctx = { sessionController: { list: async () => ({ items }) } } as unknown as Context;
  const roster = { activeFor: () => base } as unknown as SessionRosterView;
  const navigation = new ChannelNavigation(ctx, cwd, roster, new AbortController().signal, Date.now, async () => false, () => {});
  const menu = await navigation.run(base, 'chat', { kind: 'sessions' });
  assert.match(menu, /0 \[当前\] 旧会话标题/);
  assert.equal(menu.match(/未命名/g)?.length, 3);
  assert.doesNotMatch(menu, /\[object Object\]|unexpected title shape/);
});

test('single-call and batch native tools preserve call identity, scope, errors and deferred context', async () => {
  const callId = ToolCallId('runtime-call');
  const agent = { session: { id: SessionId('chat-current') } };
  const scope = {};
  const exec = { agent, signal: new AbortController().signal, callId, rootCallId: callId, token: {}, toolSet: scope } as unknown as ToolRunContext;
  for (const modern of [false, true]) {
    const expected = { isError: false, value: { python: '/python' }, content: [] };
    const contexts: never[] = [];
    const ctx = { tools: { ...(modern ? { setExecutor() {} } : {}),
      async execute(input: Record<string, unknown>) {
        assert.equal(input.agent, agent); assert.equal(input.signal, exec.signal);
        if (modern) {
          assert.deepEqual(input.calls, [{ type: 'tool-call', id: callId, name: 'runtime', arguments: '{}' }]);
          assert.equal(input.toolSet, scope);
          return { results: [{ callId, result: expected }], additionalContexts: contexts };
        }
        assert.equal(input.callId, callId); assert.equal(input.parent, exec.token);
        return { ...expected, additionalContexts: contexts };
      } } } as unknown as Context;
    assert.deepEqual(await executeNativeTool(ctx, 'runtime', {}, exec, callId), { ...expected, additionalContexts: contexts });
  }
  const mismatch = { tools: { setExecutor() {}, execute: async () => ({ results: [{ callId: 'other', result: {} }] }) } } as unknown as Context;
  await assert.rejects(executeNativeTool(mismatch, 'runtime', {}, exec, callId), /native_tool_result_mismatch/);
  const failed = { isError: true, content: [], error: { code: 'denied' } };
  const ctx = { tools: { setExecutor() {}, execute: async () => ({ results: [{ callId, result: failed }] }) } } as unknown as Context;
  assert.equal((await executeNativeTool(ctx, 'runtime', {}, exec, callId)).isError, true);
});

test('history fallback keeps the inherited cut, opens read-only and closes on failed reads', async () => {
  const id = SessionId('fork'); const signal = new AbortController().signal;
  for (const fail of [false, true]) {
    let closed = false;
    const ctx = { sessionController: {}, sessionPersistence: { async open(actual: unknown, mode: string, options: { signal: unknown }) {
      assert.equal(actual, id); assert.equal(mode, 'read'); assert.equal(options.signal, signal);
      return { inheritedEventCount: 5, read: async () => { if (fail) throw new Error('read failed'); return { events: [] }; }, close: async () => { closed = true; } };
    } } } as unknown as Context;
    if (fail) await assert.rejects(inspectSession(ctx, id, signal), /read failed/);
    else assert.deepEqual(await inspectSession(ctx, id, signal), { events: [], inheritedEventCount: 5 });
    assert.equal(closed, true);
  }
  const ctx = { sessionController: { inspect: async () => ({ events: [], inheritedEventCount: 3 }) } } as unknown as Context;
  assert.equal((await inspectSession(ctx, id, signal)).inheritedEventCount, 3);
});

test('Host schedules bind only to their fixed destination, never to editors or new-session targets', async () => {
  const entries = await scheduleCatalog({ catalog: async () => [
    { id: 'old', sessionId: 'chat-old' },
    { id: 'fixed', sessionId: 'spoofed', target: { kind: 'session', sessionId: 'chat-new' } },
    { id: 'reserved', target: { kind: 'new_once', sessionId: 'chat-new' } },
    { id: 'fresh', target: { kind: 'new' }, involvedSessionIds: ['chat-new'] },
  ] });
  assert.deepEqual(entries.map(entry => [entry.id, entry.sessionId]), [['old', 'chat-old'], ['fixed', 'chat-new']]);
});

test('Host edits use optimistic timestamps, preserve destination and prompt, and verify readback', async () => {
  const agent = { session: { id: SessionId('chat-new') } };
  let entry: Record<string, unknown> | undefined = { id: 'task', target: { kind: 'session', sessionId: 'chat-old' },
    involvedSessionIds: ['chat-new'], status: 'active', kind: 'daily', title: 'Title', prompt: 'Keep prompt',
    time: '08:00', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-27T00:00:00Z', updatedAt: 'v1' };
  let writes = 0, readOnly = false, conflict = false;
  const schedule = { catalog: async () => entry ? [structuredClone(entry)] : [],
    async edit(request: { action: string; expectedUpdatedAt: unknown; patch?: Record<string, unknown> }, actor: unknown) {
      assert.equal(actor, agent.session.id); assert.equal(request.expectedUpdatedAt, entry?.updatedAt);
      if (conflict) return { code: 'schedule_conflict' };
      writes++;
      if (request.action === 'delete') { entry = undefined; return { deleted: true }; }
      assert.equal('target' in request.patch!, false); assert.equal('prompt' in request.patch!, false);
      entry = { ...entry, title: request.patch!.title, updatedAt: 'v2' }; return structuredClone(entry);
    } };
  const ctx = { get: () => schedule, tools: { get: (name: string) => ['schedule_list', 'schedule_edit'].includes(name) ? {} : undefined },
    sandboxPolicy: { resolve: () => ({ mode: readOnly ? 'read-only' : 'workspace-write' }) } } as unknown as Context;
  const registry = { sameChat: (a: string, b: string) => [a, b].every(id => id.startsWith('chat-')) };
  const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext;
  const [original] = await scheduleCatalog(schedule);
  const args = { action: 'update' as const, id: 'task', title: 'Changed', revision: automationRevision(original!) };
  readOnly = true;
  assert.equal((await manageAutomation(ctx, registry, args, exec) as { code: string }).code, 'read_only'); assert.equal(writes, 0);
  readOnly = false; conflict = true;
  assert.equal((await manageAutomation(ctx, registry, args, exec) as { code: string }).code, 'schedule_conflict'); assert.equal(writes, 0);
  conflict = false;
  const result = await manageAutomation(ctx, registry, args, exec) as { updated: boolean; prompt: string; sessionId: string; revision: string };
  assert.equal(result.updated, true); assert.equal(result.prompt, 'Keep prompt'); assert.equal(result.sessionId, 'chat-old'); assert.equal(writes, 1);
  assert.equal((await manageAutomation(ctx, registry, args, exec) as { code: string }).code, 'schedule_conflict');
  const deleted = await manageAutomation(ctx, registry, { action: 'delete', id: 'task', revision: result.revision }, exec) as { deleted: boolean };
  assert.equal(deleted.deleted, true); assert.equal(writes, 2);
});
