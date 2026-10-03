import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { MemoryService } from '../src/memory/index.js';
import { LIMITS, MemoryStore } from '../src/memory/store.js';
import { scopeId, type MemoryScope } from '../src/memory/scope.js';
import { fakeMemoryDomain } from './memoryFixture.js';

const a: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/a' };
const b: MemoryScope = { kind: 'project', owner: 'remote', project: '/fixture/b' };
const source = { async resolveSession(id: string) { return id === 'a' ? a : b; }, async projects() { return [a, b]; } };
const all = { profile: true, events: true, proposals: true };
const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '数据库' }] });

test('proposal validation matches final writes and an old oversized proposal can be edited before accepting', async t => {
  const fixture = fakeMemoryDomain();
  const store = await MemoryStore.open(fixture.opener); t.after(() => store.close());
  for (const input of [
    { kind: 'profile' as const, key: 'x'.repeat(41), text: 'v' },
    { kind: 'profile' as const, key: 'x', text: 'v'.repeat(301) },
    { kind: 'event' as const, text: 'v'.repeat(501) },
  ]) await assert.rejects(store.propose(input));
  assert.equal(store.proposals().length, 0);
  const proposal = await store.propose({ kind: 'event', text: 'original' });
  fixture.tables.get('proposals')!.set(proposal.id, { ...proposal, text: 'x'.repeat(501) });
  await assert.rejects(store.settleProposal(proposal.id, true));
  assert.equal(store.proposals().length, 1);
  await store.settleProposal(proposal.id, true, 1, { text: '已精简' });
  assert.equal(store.events()[0]!.text, '已精简');
  assert.equal(store.proposals().length, 0);
});

test('per-scope policies survive reopen, summaries are independent, and restoring inheritance takes effect', async t => {
  const fixture = fakeMemoryDomain();
  const service = await MemoryService.open(fixture.opener, () => 1, source);
  await service.handle('policy', { target: 'default', remember: 'off', summary: 'off', inject: false });
  await service.handle('policy', { scopeId: scopeId(a), target: 'scope', remember: 'auto', summary: 'ask', inject: true });
  await service.remember({ sessionId: 'a', kind: 'profile', key: '数据库', text: 'Postgres' });
  await service.summarize('摘要应待确认', 'a');
  assert.equal(service.store.forScope(a).profile().length, 1);
  assert.equal(service.store.forScope(a).proposals().length, 1);
  await assert.rejects(service.remember({ sessionId: 'b', kind: 'event', text: '不可写入' }));
  const injected = await service.inject('a', [user]);
  assert.ok(injected);
  const snapshot = service.store.forScope(a).injections()[0]!.content;
  assert.match(snapshot!, /数据库：Postgres/);
  await service.handle('profile/set', { scopeId: scopeId(a), key: '数据库', value: 'SQLite' });
  assert.equal(service.store.forScope(a).injections()[0]!.content, snapshot);
  await service.close();
  const reopened = await MemoryService.open(fixture.opener, () => 2, source); t.after(() => reopened.close());
  assert.equal((await reopened.handle('list', { scopeId: scopeId(a) })).policyOverride, true);
  await reopened.handle('policy', { scopeId: scopeId(a), target: 'scope', inherit: true, remember: 'auto', inject: true });
  assert.equal((await reopened.handle('list', { scopeId: scopeId(a) })).policy.remember, 'off');
  assert.equal(await reopened.inject('a', [user]), undefined);
});

test('memory migration previews conflicts, merges selected records without sessions or policy and rejects stale/cross-scope previews', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1, source); t.after(() => service.close());
  const origin = service.store.forScope(a), target = service.store.forScope(b);
  await origin.setProfile('数据库', 'Postgres', 'user');
  await origin.addEvent({ text: '数据库升级完成', source: 'model', sessionId: 'a' }, 123);
  await origin.propose({ kind: 'event', text: '用户尚未确认', sessionId: 'a' }, 456);
  await target.setProfile('数据库', 'SQLite', 'user');
  const json = (await service.handle('export', { scopeId: scopeId(a) })).exportJson!;
  const payload = { scopeId: scopeId(b), json, selection: all, conflict: 'keep' };
  const preview = (await service.handle('import/preview', payload)).importPreview!;
  assert.deepEqual([preview.add, preview.overwrite, preview.skip, preview.conflicts], [2, 0, 1, 1]);
  assert.equal(target.events().length, 0);
  await service.handle('import/apply', { ...payload, token: preview.token });
  assert.equal(target.profile()[0]!.value, 'SQLite');
  assert.equal(target.events()[0]!.at, 123);
  assert.equal(target.events()[0]!.sessionId, undefined);
  assert.equal(target.proposals()[0]!.sessionId, undefined);
  assert.equal(target.policy().remember, 'ask');
  const again = (await service.handle('import/preview', payload)).importPreview!;
  assert.deepEqual([again.add, again.skip], [0, 3]);
  const overwrite = { ...payload, conflict: 'overwrite' };
  const before = (await service.handle('import/preview', overwrite)).importPreview!;
  await target.setProfile('数据库', 'newer-value', 'model');
  await assert.rejects(service.handle('import/apply', { ...overwrite, token: before.token }), /memory_import_changed/);
  assert.equal(target.profile()[0]!.value, 'newer-value');
  const fresh = (await service.handle('import/preview', overwrite)).importPreview!;
  await assert.rejects(service.handle('import/apply', { ...overwrite, scopeId: scopeId(a), token: fresh.token }), /memory_import_changed/);
  await service.handle('import/apply', { ...overwrite, token: fresh.token });
  assert.equal(target.profile()[0]!.value, 'Postgres');
});

test('invalid or over-capacity imports write nothing, and event edits require the visible revision and correct scope', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1, source); t.after(() => service.close());
  const target = service.store.forScope(b);
  const archive = { exportedAt: 1, profile: [{ key: 'first', value: 'valid' }], events: [{ text: 'x'.repeat(501), at: 1 }], proposals: [] };
  await assert.rejects(service.handle('import/preview', { scopeId: scopeId(b), json: JSON.stringify(archive), selection: all, conflict: 'keep' }), /memory_limit/);
  assert.equal(target.profile().length, 0);
  for (let i = 0; i < LIMITS.profileEntries; i++) await target.setProfile(String(i), 'v', 'user');
  archive.events = [];
  await assert.rejects(service.handle('import/preview', { scopeId: scopeId(b), json: JSON.stringify(archive), selection: all, conflict: 'keep' }), /memory_limit/);
  const event = await target.addEvent({ text: '旧内容', tags: ['tag'], source: 'model', sessionId: 'b' }, 42);
  await assert.rejects(service.handle('event/edit', { scopeId: scopeId(a), id: event.id, expectedText: event.text, text: '跨范围修改' }));
  await service.handle('event/edit', { scopeId: scopeId(b), id: event.id, expectedText: event.text, text: '修订内容' });
  await assert.rejects(service.handle('event/edit', { scopeId: scopeId(b), id: event.id, expectedText: event.text, text: '过期窗口' }), /configuration_changed/);
  assert.deepEqual([target.event(event.id)!.at, target.event(event.id)!.tags], [42, ['tag']]);
});

test('batch deletion checks every selected revision before removing any records', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1, source); t.after(() => service.close());
  const store = service.store.forScope(a);
  const event = await store.addEvent({ text: 'keep until confirmed', source: 'user' });
  await store.setProfile('k', 'v', 'user');
  const records = [{ kind: 'event', id: event.id, expectedText: event.text }, { kind: 'profile', key: 'k', expectedText: 'stale' }];
  await assert.rejects(service.handle('records/delete', { scopeId: scopeId(a), records }), /configuration_changed/);
  assert.ok(store.event(event.id));
  records[1]!.expectedText = 'v';
  await service.handle('records/delete', { scopeId: scopeId(a), records });
  assert.equal(store.events().length, 0); assert.equal(store.profile().length, 0);
});
