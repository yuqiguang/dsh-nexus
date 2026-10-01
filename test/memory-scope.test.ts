import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { sessionIdAt, sessionIdFor } from '../src/channels/protocol.js';
import { MemoryService, installMemory } from '../src/memory/index.js';
import { MemoryStore } from '../src/memory/store.js';
import { LEGACY_SCOPE, LOCAL_PREFERENCES, projectScope, scopeId, sessionMemoryScope, type MemoryScope } from '../src/memory/scope.js';
import { fakeMemoryDomain } from './memoryFixture.js';

const A: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/a' };
const B: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/b' };
const R: MemoryScope = { kind: 'project', owner: sessionIdFor('bot', 'owner', 'owner', 'wechat'), project: '/fixture/a' };
const text = (message: UserMessage | undefined) => message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
const user = (value: string) => createUserMessage({ content: [{ type: 'text', text: value }], source: { kind: 'user' } });
const source = { async resolveSession(id: string) { return ({ a: A, a2: A, b: B, remote: R } as Record<string, MemoryScope>)[id]; }, async projects() { return [A, B, R]; } };

test('initialization preserves a legacy opt-out and never resets a later explicit scoped policy on restart', async () => {
  const fixture = fakeMemoryDomain();
  const legacy = await MemoryStore.open(fixture.opener);
  await legacy.setPolicy({ remember: 'off', inject: false });
  const first = await MemoryService.open(fixture.opener, () => 1, source);
  assert.deepEqual(first.store.policy(), { remember: 'off', inject: false, scopeVersion: 1 });
  await first.handle('policy', { remember: 'auto', inject: true });
  await first.close();
  const restarted = await MemoryService.open(fixture.opener, () => 2, source);
  assert.deepEqual(restarted.store.policy(), { remember: 'auto', inject: true, scopeVersion: 1 });
  assert.deepEqual(legacy.policy(), { remember: 'off', inject: false });
  await restarted.close();
});

test('registered model tools ignore supplied scope and session selectors and require an execution owner', async t => {
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1, source);
  t.after(() => service.close());
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ text: string }> }>();
  const ctx = { effect: (run: () => unknown) => run(), on: () => () => {},
    tools: { register: (tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
  } as unknown as Context;
  installMemory(ctx, service);
  await tools.get('memory_remember')!.execute({ kind: 'event', text: 'scope-probe', sessionId: 'b', scopeId: scopeId(B), project: B.project }, { agent: { id: 'a' } });
  assert.equal(service.store.forScope(A).events().length, 1);
  assert.equal(service.store.forScope(B).events().length, 0);
  const reply = await tools.get('memory_recall')!.execute({ query: 'scope-probe', sessionId: 'a', scopeId: scopeId(A) }, { agent: { id: 'b' } });
  assert.doesNotMatch(reply.text, /scope-probe/);
  await assert.rejects(tools.get('memory_recall')!.execute({ query: 'scope-probe', sessionId: 'a' }, {}), /memory_scope_unavailable/);
});

test('disabling memory while native scope resolution is pending prevents later injection and summary writes', async t => {
  let release!: (scope: MemoryScope) => void;
  const pending = new Promise<MemoryScope>(resolve => { release = resolve; });
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1,
    { async resolveSession() { return pending; }, async projects() { return [A]; } });
  t.after(() => service.close());
  await service.handle('profile/set', { scopeId: scopeId(A), key: '数据库', value: 'A-secret' });
  const injection = service.inject('a', [user('数据库')]);
  const summary = service.summarize('late-summary', 'a');
  await service.handle('policy', { remember: 'off', inject: false });
  release(A);
  assert.equal(await injection, undefined);
  assert.equal(await summary, undefined);
  assert.equal(service.store.forScope(A).events().length, 0);
  assert.equal(service.store.forScope(A).injections().length, 0);
});

test('scope comes from a native root cwd and admitted channel identity; missing directories and subagents are excluded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-memory-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const real = join(root, 'project'); await mkdir(real);
  const alias = join(root, 'alias'); await symlink(real, alias, 'dir');
  assert.deepEqual(await projectScope(alias), await projectScope(real));
  assert.equal(await sessionMemoryScope({ id: 'local' }), undefined);
  assert.equal(await sessionMemoryScope({ id: 'child', cwd: real, parentSession: 'parent' }), undefined);
  assert.equal(await sessionMemoryScope({ id: 'local', cwd: join(root, 'missing') }), undefined);
  assert.equal(await sessionMemoryScope({ id: 'nexus-wechat-invalid', cwd: real }), undefined);
  const base = sessionIdFor('bot', 'owner', 'chat', 'wechat');
  const first = await sessionMemoryScope({ id: base, cwd: real });
  assert.deepEqual(await sessionMemoryScope({ id: sessionIdAt(base, 2), cwd: real }), first, 'rotations retain the admitted identity');
  assert.notDeepEqual(await sessionMemoryScope({ id: sessionIdFor('bot', 'other-owner', 'chat', 'wechat'), cwd: real }), first);
  assert.notDeepEqual(await sessionMemoryScope({ id: sessionIdFor('new-bot', 'owner', 'chat', 'wechat'), cwd: real }), first, 'rebinds do not implicitly share memory');
  assert.notDeepEqual(await sessionMemoryScope({ id: 'local-session', cwd: real }), first);
});

test('identical keys and event texts stay independent across projects and channel owners, including all mutation routes', async t => {
  const { opener } = fakeMemoryDomain({ remember: 'auto', inject: true });
  const service = await MemoryService.open(opener, () => 1, source); t.after(() => service.close());
  for (const [sessionId, scope, value] of [['a', A, 'A-only'], ['b', B, 'B-only'], ['remote', R, 'remote-only']] as const) {
    await service.remember({ sessionId, kind: 'profile', key: '数据库', text: value });
    await service.remember({ sessionId, kind: 'event', text: '相同关键词决定', tags: ['数据库'] });
    assert.equal(service.store.forScope(scope).profile()[0]?.value, value);
  }
  const ea = service.store.forScope(A).events()[0]!, eb = service.store.forScope(B).events()[0]!;
  assert.notEqual(ea.id, eb.id, 'deduplication is scoped');
  assert.match(await service.recall('数据库', 8, 'a'), /A-only/);
  assert.doesNotMatch(await service.recall('数据库', 8, 'a'), /B-only|remote-only/);
  assert.match(text(await service.inject('b', [user('数据库')])), /B-only/);
  assert.doesNotMatch(text(await service.inject('a', [user('数据库')])), /B-only|remote-only/);
  await assert.rejects(service.forget({ id: eb.id }, 'a'), /not_found/);
  await assert.rejects(service.handle('event/delete', { scopeId: scopeId(A), id: eb.id }), /not_found/);
  assert.equal(service.store.forScope(B).events().length, 1);
  await service.forget({ key: '数据库' }, 'a');
  assert.equal(service.store.forScope(B).profile()[0]?.value, 'B-only');
  const exported = (await service.handle('export', { scopeId: scopeId(B) })).exportJson!;
  assert.match(exported, /B-only/); assert.doesNotMatch(exported, /A-only|remote-only/);
  for (const method of ['list', 'export', 'profile/set', 'event/delete', 'proposal/settle']) {
    await assert.rejects(service.handle(method, { scopeId: 'invented-project', id: eb.id }), /memory_scope_unavailable/);
  }
});

test('only explicitly saved global preferences are shared within an owner and model tools cannot modify them', async t => {
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1, source);
  t.after(() => service.close());
  await service.handle('profile/set', { scopeId: scopeId(LOCAL_PREFERENCES), key: '语言', value: 'global-Chinese' });
  assert.match(await service.recall('', 8, 'a'), /global-Chinese/);
  assert.match(await service.recall('', 8, 'b'), /global-Chinese/);
  assert.doesNotMatch(await service.recall('', 8, 'remote'), /global-Chinese/);
  await assert.rejects(service.forget({ key: '语言' }, 'a'), /全局个人偏好/);
  await service.remember({ sessionId: 'a', kind: 'profile', key: '语言', text: 'A-English' });
  assert.doesNotMatch(await service.recall('', 8, 'a'), /global-Chinese/);
  assert.match(await service.recall('', 8, 'b'), /global-Chinese/);
  await assert.rejects(service.remember({ kind: 'event', text: 'no-owner' }), /memory_scope_unavailable/);
  await assert.rejects(service.recall('数据库', 5, 'missing'), /memory_scope_unavailable/);
  assert.equal(await service.inject('missing', [user('数据库')]), undefined);
  assert.equal(await service.summarize('no-owner', 'missing'), undefined);
});

test('legacy records are retained in a separate native domain and only explicit copying admits them into a scope', async t => {
  const fixture = fakeMemoryDomain();
  const legacy = await MemoryStore.open(fixture.opener);
  await legacy.setProfile('称呼', 'legacy-private', 'model', 1);
  const oldEvent = await legacy.addEvent({ text: 'legacy-event', source: 'summary', sessionId: 'a' }, 1);
  const proposal = await legacy.propose({ kind: 'profile', key: '习惯', text: 'legacy-proposed' }, 1);
  const service = await MemoryService.open(fixture.opener, () => 2, source); t.after(() => service.close());
  assert.equal(service.store.policy().remember, 'ask', 'new domain defaults to confirmation even if legacy defaults to auto');
  assert.doesNotMatch(await service.recall('legacy', 5, 'a'), /legacy-private|legacy-event|legacy-proposed/);
  assert.equal(await service.inject('a', [user('legacy')]), undefined);
  const view = await service.handle('list', { scopeId: LEGACY_SCOPE });
  assert.equal(view.profile[0]?.value, 'legacy-private');
  await assert.rejects(service.handle('proposal/settle', { scopeId: LEGACY_SCOPE, id: proposal.id, accept: true }), /memory_legacy_readonly/);
  await assert.rejects(service.handle('legacy/copy', { scopeId: LEGACY_SCOPE, kind: 'profile', key: '称呼', targetScopeId: scopeId(A), expectedText: 'stale' }), /configuration_changed/);
  await service.handle('legacy/copy', { scopeId: LEGACY_SCOPE, kind: 'profile', key: '称呼', targetScopeId: scopeId(A), expectedText: 'legacy-private' });
  assert.match(await service.recall('legacy', 5, 'a'), /legacy-private/);
  assert.doesNotMatch(await service.recall('legacy', 5, 'b'), /legacy-private/);
  assert.equal(legacy.profile()[0]?.value, 'legacy-private');
  await assert.rejects(service.handle('legacy/copy', { scopeId: LEGACY_SCOPE, kind: 'profile', key: '称呼', targetScopeId: scopeId(A), expectedText: 'legacy-private' }), /memory_profile_exists/);
  await service.handle('legacy/copy', { scopeId: LEGACY_SCOPE, kind: 'event', id: oldEvent.id, targetScopeId: scopeId(B), expectedText: oldEvent.text });
  assert.doesNotMatch(await service.recall('legacy', 5, 'a'), /legacy-event/);
  assert.match(await service.recall('legacy', 5, 'b'), /legacy-event/);
  assert.equal(legacy.events().length, 1);
  const legacyExport = (await service.handle('export', { scopeId: LEGACY_SCOPE })).exportJson!;
  assert.match(legacyExport, /legacy-private/); assert.match(legacyExport, /legacy-event/);
});

test('proposals and channel summaries follow confirmation policy and cannot be settled from another project', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1, source); t.after(() => service.close());
  await service.remember({ sessionId: 'a', kind: 'event', text: 'A-pending' });
  await service.summarize('A-summary', 'a');
  assert.equal(service.store.forScope(A).events().length, 0);
  const [proposal, summary] = service.store.forScope(A).proposals();
  assert.ok(proposal && summary);
  await assert.rejects(service.handle('proposal/settle', { scopeId: scopeId(B), id: proposal.id, accept: true }), /not_found/);
  await service.handle('proposal/settle', { scopeId: scopeId(A), id: proposal.id, accept: true });
  assert.match(await service.recall('A-pending', 8, 'a'), /A-pending/);
  assert.doesNotMatch(await service.recall('A-pending', 8, 'b'), /A-pending/);
  await service.handle('policy', { scopeId: scopeId(A), remember: 'off', inject: false });
  assert.equal(await service.summarize('new-summary', 'a'), undefined);
  assert.equal(service.store.forScope(A).proposals().length, 1);
  assert.equal(await service.inject('a2', [user('A-pending')]), undefined);
});
