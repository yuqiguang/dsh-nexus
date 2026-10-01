import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryService } from '../src/memory/index.js';
import { MemoryStore, LIMITS } from '../src/memory/store.js';
import { LEGACY_SCOPE, scopeId, type MemoryScope } from '../src/memory/scope.js';
import { fakeMemoryDomain } from './memoryFixture.js';

const A: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/page-a' };
const B: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/page-b' };
const source = { async resolveSession() { return A; }, async projects() { return [A, B]; } };

test('settings search reaches events older than the former 200-row window and never crosses scopes', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1000, source);
  t.after(() => service.close());
  const a = service.store.forScope(A), b = service.store.forScope(B);
  for (let n = 0; n < 245; n++) await a.addEvent({ text: `A-event-${n}`, tags: n === 0 ? ['Older-Tag'] : [], source: 'user' }, n);
  await b.addEvent({ text: 'B-secret', tags: ['Older-Tag'], source: 'user' });
  const first = await service.handle('list', { scopeId: scopeId(A) });
  assert.equal(first.events.length, 20);
  assert.equal(first.counts.events, 245);
  assert.equal(first.pagination!.events.pages, 13);
  const seen = new Set<string>();
  for (let eventPage = 0; eventPage < 13; eventPage++) {
    const view = await service.handle('list', { scopeId: scopeId(A), eventPage });
    for (const event of view.events) { assert.ok(!seen.has(event.id)); seen.add(event.id); }
  }
  assert.equal(seen.size, 245);
  const found = await service.handle('list', { scopeId: scopeId(A), eventQuery: ' older-TAG ', eventPage: 500 });
  assert.deepEqual(found.events.map(event => event.text), ['A-event-0']);
  assert.equal(found.pagination!.events.page, 0);
  assert.equal(found.pagination!.events.total, 1);
  assert.equal(found.counts.events, 245);
  const exported = JSON.parse((await service.handle('export', { scopeId: scopeId(A), eventQuery: 'Older-Tag', eventPage: 12 })).exportJson!);
  assert.equal(exported.events.length, 245, 'export is complete even with a filter or page selected');
  assert.ok(!JSON.stringify(exported).includes('B-secret'));
});

test('empty and deleted final pages clamp safely, while malformed paging cannot mutate records', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1000, source);
  t.after(() => service.close());
  const store = service.store.forScope(A);
  for (let n = 0; n < 21; n++) await store.addEvent({ text: `row-${n}`, source: 'user' }, 1);
  const last = await service.handle('list', { scopeId: scopeId(A), eventPage: 1 });
  assert.equal(last.events.length, 1);
  const deleted = await service.handle('event/delete', { scopeId: scopeId(A), eventPage: 1, id: last.events[0]!.id });
  assert.equal(deleted.pagination!.events.page, 0);
  assert.equal(deleted.events.length, 20);
  const empty = await service.handle('list', { scopeId: scopeId(A), eventQuery: 'missing', eventPage: 9 });
  assert.deepEqual(empty.pagination!.events, { page: 0, pageSize: 20, total: 0, pages: 1 });
  for (const input of [{ eventPage: -1 }, { eventPage: 1.5 }, { eventPage: '1' }, { eventPage: NaN },
    { injectionPage: Number.MAX_SAFE_INTEGER + 1 }, { eventQuery: 1 }, { eventQuery: 'x'.repeat(201) }]) {
    await assert.rejects(service.handle('event/delete', { scopeId: scopeId(A), id: deleted.events[0]!.id, ...input }), /invalid_configuration/);
  }
  assert.equal(store.events().length, 20);
});

test('injection audit rolls at 200 per scope and all retained records can be paged without deleting memory', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => 1000, source);
  t.after(() => service.close());
  const a = service.store.forScope(A), b = service.store.forScope(B);
  const event = await a.addEvent({ text: 'keep-memory', source: 'user' });
  for (let n = 0; n < 205; n++) await a.recordInjection({ at: n, query: `query-${n}`, sessionId: 'a', eventIds: [event.id], profile: false });
  await b.recordInjection({ at: 999, query: 'B-private', sessionId: 'b', eventIds: [], profile: true });
  const all = [];
  for (let injectionPage = 0; injectionPage < 20; injectionPage++) {
    const view = await service.handle('list', { scopeId: scopeId(A), injectionPage });
    assert.equal(view.injections.length, 10);
    assert.equal(view.pagination!.injections.total, LIMITS.injections);
    all.push(...view.injections);
  }
  assert.equal(new Set(all.map(item => item.id)).size, 200);
  assert.equal(all[0]!.query, 'query-204');
  assert.equal(all.at(-1)!.query, 'query-5');
  assert.equal(a.events().length, 1);
  assert.equal(b.injections().length, 1);
});

test('legacy pagination supports finding and explicitly copying older records without automatic migration', async t => {
  const fixture = fakeMemoryDomain();
  const legacy = await MemoryStore.open(fixture.opener);
  for (let n = 0; n < 225; n++) await legacy.addEvent({ text: `legacy-${n}`, source: 'user' }, n);
  const service = await MemoryService.open(fixture.opener, () => 1000, source);
  t.after(() => service.close());
  const view = await service.handle('list', { scopeId: LEGACY_SCOPE, eventQuery: 'legacy-0' });
  assert.equal(view.events.length, 1);
  assert.equal(service.store.forScope(A).events().length, 0);
  await service.handle('legacy/copy', { scopeId: LEGACY_SCOPE, eventQuery: 'legacy-0', targetScopeId: scopeId(A), kind: 'event',
    id: view.events[0]!.id, expectedText: 'legacy-0' });
  assert.equal(legacy.events().length, 225);
  assert.deepEqual(service.store.forScope(A).events().map(event => event.text), ['legacy-0']);
});
