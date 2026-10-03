import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { MemorySettings, type MemoryApi } from '../src/client/MemorySettings.js';
import { MemoryService, type MemoryView } from '../src/memory/index.js';
import { LIMITS } from '../src/memory/store.js';
import { LEGACY_SCOPE, scopeId, type MemoryScope } from '../src/memory/scope.js';
import { fakeMemoryDomain } from './memoryFixture.js';

const T0 = Date.parse('2026-09-20T10:00:00+08:00');
const initial = (): MemoryView => ({ policy: { remember: 'auto', inject: true }, limits: LIMITS,
  profile: [{ key: '称呼', value: '老于', updatedAt: T0, source: 'model' }],
  events: [{ id: 'me-1', text: '9 月 12 日和王总谈了合作', tags: ['王总'], at: T0, source: 'model' }, { id: 'me-2', text: '家里的猫叫团子', at: T0, source: 'user' }],
  proposals: [{ id: 'mp-1', kind: 'profile', key: '公司', text: 'Nexus', at: T0 }],
  injections: [{ id: 'mi-1', at: T0, sessionId: 's1', query: '王总那边怎么说', eventIds: ['me-1'], profile: true }],
  counts: { profile: 1, events: 2, proposals: 1 } });

test('disabled native memory component leaves data controls available and refreshes live state', async t => {
  let enabled = false;
  const ui = await page(t, async method => ({ ...initial(), moduleEnabled: enabled,
    ...(method === 'export' ? { exportJson: 'retained-memory' } : {}) }));
  assert.match(ui.text(), /组件当前未运行/);
  assert.match(ui.text(), /DSH 插件详情的组件列表/);
  assert.doesNotMatch(ui.text(), /“Nexus 扩展”重新启用/);
  assert.equal(ui.field('memory-remember').disabled, false);
  enabled = true;
  await ui.click('导出 JSON');
  assert.match(ui.text(), /组件正在运行/);
  assert.match(ui.text(), /retained-memory/);
});

async function page(t: TestContext, api: MemoryApi) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(MemorySettings, { api })));
  const field = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const enter = async (id: string, value: string) => {
    await act(async () => {
      const element = field(id);
      const proto = element instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype
        : element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event(element instanceof dom.window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label || item.getAttribute('aria-label') === label);
    assert.ok(button, `button ${label} missing`);
    await act(async () => { button.click(); });
  };
  const submit = async (id: string) => { const form = field(id).closest('form')!; await act(async () => { form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); }); };
  return { dom, field, enter, click, submit, text: () => dom.window.document.body.textContent ?? '' };
}

test('the memory page shows profile, events, proposals and injections, and every edit goes through the routes', async t => {
  let view = initial();
  const calls: { method: string; payload: any }[] = [];
  const api: MemoryApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'policy') view = { ...view, policy: { remember: payload.remember, inject: payload.inject } };
    if (method === 'proposal/settle') view = { ...view, proposals: [], counts: { ...view.counts, proposals: 0 },
      profile: payload.accept ? [...view.profile, { key: '公司', value: 'Nexus', updatedAt: T0, source: 'user' }] : view.profile };
    if (method === 'profile/delete') view = { ...view, profile: view.profile.filter(entry => entry.key !== payload.key) };
    if (method === 'profile/set') view = { ...view, profile: [...view.profile, { key: payload.key, value: payload.value, updatedAt: T0, source: 'user' }] };
    if (method === 'event/delete') view = { ...view, events: view.events.filter(event => event.id !== payload.id) };
    if (method === 'event/add') view = { ...view, events: [{ id: 'me-3', text: payload.text, at: T0, source: 'user' }, ...view.events] };
    if (method === 'export') return { ...structuredClone(view), exportJson: '{"exported":true}' };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  assert.deepEqual([...ui.dom.window.document.querySelectorAll('h3')].map(item => item.textContent), ['写入策略', '待确认', '画像', '事件', '最近注入', '记忆迁移']);
  assert.match(ui.text(), /画像 1\/60，事件 2\/1000/);
  assert.match(ui.text(), /称呼：老于/);
  assert.match(ui.text(), /王总谈了合作/);
  assert.match(ui.text(), /“王总那边怎么说” → 画像、1 条事件/);
  await ui.enter('memory-remember', 'ask');
  assert.deepEqual(calls.at(-1), { method: 'policy', payload: { remember: 'ask', inject: true } });
  await ui.click('采纳');
  assert.deepEqual(calls.at(-1), { method: 'proposal/settle', payload: { id: 'mp-1', accept: true } });
  assert.match(ui.text(), /公司：Nexus/);
  assert.deepEqual([...ui.dom.window.document.querySelectorAll('h3')].map(item => item.textContent), ['写入策略', '画像', '事件', '最近注入', '记忆迁移']);
  await ui.click('删除画像 称呼');
  assert.deepEqual(calls.at(-1), { method: 'profile/delete', payload: { key: '称呼' } });
  assert.doesNotMatch(ui.text(), /称呼：老于/);
  await ui.enter('memory-profile-key', '饮食');
  await ui.enter('memory-profile-value', '不吃香菜');
  await ui.submit('memory-profile-key');
  assert.deepEqual(calls.at(-1), { method: 'profile/set', payload: { key: '饮食', value: '不吃香菜' } });
  assert.match(ui.text(), /饮食：不吃香菜/);
  assert.equal((ui.field('memory-profile-key') as HTMLInputElement).value, '', 'the form clears after a successful save');
  await ui.enter('memory-filter', '团子');
  assert.doesNotMatch(ui.text(), /王总谈了合作/);
  assert.match(ui.text(), /团子/);
  await ui.click('删除事件 me-2');
  assert.deepEqual(calls.at(-1), { method: 'event/delete', payload: { id: 'me-2' } });
  await ui.enter('memory-filter', '');
  await ui.enter('memory-event-text', '国庆去成都');
  await ui.submit('memory-event-text');
  assert.deepEqual(calls.at(-1), { method: 'event/add', payload: { text: '国庆去成都' } });
  assert.match(ui.text(), /国庆去成都/);
  await ui.click('导出 JSON');
  assert.equal(calls.at(-1)!.method, 'export');
  assert.equal((ui.field('memory-event-text').ownerDocument.querySelector('textarea[aria-label="导出的记忆"]') as HTMLTextAreaElement).value, '{"exported":true}');
});

test('a limit error from the server is explained and the page keeps working', async t => {
  const view = initial();
  const api: MemoryApi = async method => { if (method === 'event/add') throw new Error('memory_limit'); return structuredClone(view); };
  const ui = await page(t, api);
  await ui.enter('memory-event-text', '太长');
  await ui.submit('memory-event-text');
  assert.match(ui.text(), /超出记忆容量或长度限制/);
  assert.equal((ui.field('memory-event-text') as HTMLTextAreaElement).value, '太长', 'the draft survives a refused write');
});

test('event and injection pages stay small, search reaches old records, and exports ignore the visible filter', async t => {
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => T0);
  t.after(() => service.close());
  const { LOCAL_PREFERENCES } = await import('../src/memory/scope.js');
  const store = service.store.forScope(LOCAL_PREFERENCES);
  for (let n = 0; n < 221; n++) await store.addEvent({ text: `event-row-${n}`, tags: n === 0 ? ['old-tag'] : [], source: 'user' }, n);
  for (let n = 0; n < 25; n++) await store.recordInjection({ at: n, query: `injected-row-${n}`, sessionId: 'fixture', eventIds: [], profile: true });
  const ui = await page(t, (method, payload) => service.handle(method, payload));
  const listCount = (title: string) => [...ui.dom.window.document.querySelectorAll('h3')].find(node => node.textContent === title)!.closest('.nexus-channel-card')!.querySelectorAll('li').length;
  assert.equal(listCount('事件'), 20);
  assert.equal(listCount('最近注入'), 10);
  await ui.click('事件下一页');
  assert.match(ui.text(), /第 2\/12 页/);
  await ui.click('注入记录下一页');
  assert.match(ui.text(), /第 2\/3 页/);
  await ui.enter('memory-filter', 'OLD-TAG');
  assert.equal(listCount('事件'), 1);
  assert.match(ui.text(), /event-row-0/);
  assert.match(ui.text(), /第 1\/1 页/);
  assert.match(ui.text(), /第 2\/3 页/, 'event search does not reset the audit page');
  await ui.click('导出 JSON');
  const exported = JSON.parse((ui.dom.window.document.querySelector('[aria-label="导出的记忆"]') as HTMLTextAreaElement).value);
  assert.equal(exported.events.length, 221);
  await ui.click(`删除事件 ${store.events().find(item => item.text === 'event-row-0')!.id}`);
  assert.match(ui.text(), /没有匹配的事件记忆/);
  await ui.enter('memory-filter', '');
  assert.equal(listCount('事件'), 20);
});

test('a late search response cannot replace newer results or a newly selected scope', async t => {
  const a: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/a' };
  const b: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/b' };
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => T0,
    { async resolveSession() { return a; }, async projects() { return [a, b]; } });
  t.after(() => service.close());
  await service.handle('event/add', { scopeId: scopeId(a), text: 'slow-private' });
  await service.handle('event/add', { scopeId: scopeId(a), text: 'current-result' });
  await service.handle('event/add', { scopeId: scopeId(b), text: 'B-current' });
  let release!: () => void;
  const ui = await page(t, async (method, payload: any) => {
    const result = await service.handle(method, payload);
    if (method === 'list' && payload.eventQuery === 'slow') await new Promise<void>(resolve => { release = resolve; });
    return result;
  });
  await ui.enter('memory-scope', scopeId(a));
  await ui.enter('memory-filter', 'slow');
  await ui.enter('memory-filter', 'current');
  assert.match(ui.text(), /current-result/);
  assert.doesNotMatch(ui.text(), /slow-private/);
  await act(async () => release());
  assert.doesNotMatch(ui.text(), /slow-private/);
  await ui.enter('memory-filter', 'slow');
  await ui.enter('memory-scope', scopeId(b));
  await act(async () => release());
  assert.match(ui.text(), /B-current/);
  assert.doesNotMatch(ui.text(), /slow-private|current-result/);
  assert.equal(ui.field('memory-filter').value, '');
});

test('scope selection clears old export and drafts; mutations and exports stay in the visible scope', async t => {
  const a: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/a' };
  const b: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/b' };
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => T0,
    { async resolveSession() { return a; }, async projects() { return [a, b]; } });
  t.after(() => service.close());
  await service.handle('event/add', { scopeId: scopeId(a), text: 'A-private' });
  await service.handle('event/add', { scopeId: scopeId(b), text: 'B-private' });
  const calls: { method: string; payload: any }[] = [];
  const ui = await page(t, async (method, payload) => { calls.push({ method, payload }); return service.handle(method, payload); });
  await ui.enter('memory-scope', scopeId(a));
  assert.match(ui.text(), /A-private/); assert.doesNotMatch(ui.text(), /B-private/);
  await ui.click('导出 JSON');
  assert.match((ui.dom.window.document.querySelector('[aria-label="导出的记忆"]') as HTMLTextAreaElement).value, /A-private/);
  await ui.enter('memory-event-text', 'unsaved-A');
  await ui.enter('memory-scope', scopeId(b));
  assert.equal(ui.dom.window.document.querySelector('[aria-label="导出的记忆"]'), null);
  assert.equal(ui.field('memory-event-text').value, '');
  assert.doesNotMatch(ui.text(), /A-private/); assert.match(ui.text(), /B-private/);
  await ui.enter('memory-event-text', 'B-new'); await ui.submit('memory-event-text');
  assert.equal(calls.at(-1)?.payload.scopeId, scopeId(b));
  assert.doesNotMatch((await service.handle('export', { scopeId: scopeId(a) })).exportJson!, /B-new/);
});

test('legacy classification requires an explicit target and copies the exact visible record without removing the original', async t => {
  const scope: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/project' };
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => T0,
    { async resolveSession() { return scope; }, async projects() { return [scope]; } });
  t.after(() => service.close());
  await service.legacy.setProfile('数据库', 'legacy-A', 'model');
  const ui = await page(t, (method, payload) => service.handle(method, payload));
  await ui.enter('memory-scope', LEGACY_SCOPE);
  assert.equal(ui.dom.window.document.getElementById('memory-profile-key'), null);
  const copyButton = [...ui.dom.window.document.querySelectorAll('button')].find(button => button.textContent === '复制到所选范围')!;
  assert.equal(copyButton.disabled, true);
  await ui.enter('memory-copy-target', scopeId(scope)); await ui.click('复制到所选范围');
  assert.match(ui.text(), /已复制到所选范围/);
  assert.equal(service.legacy.profile()[0]?.value, 'legacy-A');
  assert.equal(service.store.forScope(scope).profile()[0]?.value, 'legacy-A');
  await ui.click('复制到所选范围');
  assert.match(ui.text(), /目标范围已有同名画像/);
});

test('the page edits memories with revision checks and previews migration before writing', async t => {
  const scope: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/edit' };
  const service = await MemoryService.open(fakeMemoryDomain().opener, () => T0,
    { async resolveSession() { return scope; }, async projects() { return [scope]; } });
  t.after(() => service.close());
  const store = service.store.forScope(scope);
  await store.setProfile('数据库', '旧配置', 'user');
  const event = await store.addEvent({ text: '旧事件', source: 'model' });
  const proposal = await store.propose({ kind: 'event', text: '待修订' });
  const ui = await page(t, (method, payload) => service.handle(method, payload));
  await ui.enter('memory-scope', scopeId(scope));
  await ui.click('编辑画像 数据库'); await ui.enter('memory-edit-text', '新配置'); await ui.click('保存修改');
  assert.equal(store.profile()[0]!.value, '新配置');
  await ui.click(`编辑事件 ${event.id}`); await ui.enter('memory-edit-text', '新事件'); await ui.click('保存修改');
  assert.equal(store.event(event.id)!.text, '新事件');
  await ui.click(`编辑提案 ${proposal.id}`); await ui.enter('memory-edit-text', '确认后的内容'); await ui.click('保存并采纳');
  assert.equal(store.proposals().length, 0);
  assert.ok(store.events().some(item => item.text === '确认后的内容'));
  const incoming = JSON.stringify({ exportedAt: 1, profile: [{ key: '导入画像', value: '导入内容' }], events: [], proposals: [] });
  await ui.enter('memory-import-json', incoming); await ui.click('预览记忆导入');
  assert.match(ui.text(), /新增 1 条/);
  assert.equal(store.profile().length, 1);
  await ui.click('确认导入记忆');
  assert.equal(store.profile().length, 2);
  assert.match(ui.text(), /记忆已导入当前范围/);
  await ui.enter('memory-summary', 'off');
  assert.equal(store.policy().summary, 'off');
  assert.equal((await service.handle('list', { scopeId: scopeId(scope) })).policyOverride, true);
});
