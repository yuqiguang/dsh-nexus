import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { MemoryService, installMemory } from '../src/memory/index.js';
import { scopeId, type MemoryScope } from '../src/memory/scope.js';
import type { MemoryDomainOpener } from '../src/memory/store.js';
import { fakeMemoryDomain } from './memoryFixture.js';

const project: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/project' };
const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '数据库' }] });
const source = { async resolveSession() { return project; }, async projects() { return [project]; } };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

function mount(service: MemoryService, visible: (scope: unknown) => boolean = () => true) {
  const disposers: (() => unknown)[] = [];
  const listeners = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, { execute(...args: any[]): Promise<unknown> }>();
  let prompt!: (context: { scope?: unknown }) => string;
  const ctx = {
    effect: (run: () => () => unknown) => { const dispose = run(); disposers.push(dispose); return dispose; },
    on: (name: string, fn: (...args: any[]) => any) => { listeners.set(name, fn); const dispose = () => listeners.delete(name); disposers.push(dispose); return dispose; },
    tools: {
      get: (name: string, scope: unknown) => visible(scope) ? tools.get(name) : undefined,
      register: (tool: { name: string; execute(...args: any[]): Promise<unknown> }) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
    },
    systemPrompt: { getSectionOrder: () => 0, section: (section: { text: typeof prompt }) => { prompt = section.text; return () => {}; } },
  } as unknown as Context;
  const runtime = installMemory(ctx, service, { closeService: false });
  return { runtime, tools, listeners, prompt: (scope?: unknown) => prompt({ scope }),
    close: async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); } };
}

test('memory component unload keeps data management open and reactivation resets injection state', async t => {
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1, source);
  t.after(() => service.close());
  await service.handle('profile/set', { scopeId: scopeId(project), key: '数据库', value: 'PostgreSQL' });
  const first = mount(service);
  const staleTool = first.tools.get('memory_remember')!;
  const decision = { kind: 'enter', messages: [user] };
  const payload = { agent: { id: 'session' } };
  assert.equal((await first.listeners.get('agent/pre-step')!(payload, async () => decision)).messages.length, 2);
  await first.close();
  assert.equal(first.tools.size, 0);
  assert.equal(first.listeners.size, 0);
  await assert.rejects(staleTool.execute({ kind: 'event', text: 'stale' }, { agent: { id: 'session' } }), /module_disabled/);
  assert.equal(await first.runtime.summarize('stale summary', 'session'), undefined);
  const retained = await service.handle('export', { scopeId: scopeId(project) });
  assert.match(retained.exportJson!, /PostgreSQL/);
  await service.handle('event/add', { scopeId: scopeId(project), text: 'user edit while disabled' });
  const second = mount(service);
  assert.equal((await second.listeners.get('agent/pre-step')!(payload, async () => decision)).messages.length, 2);
  assert.equal(service.store.forScope(project).events().length, 1);
  assert.equal(service.store.policy().remember, 'auto');
  await second.close();
});

test('disable during project resolution blocks late writes, deletes, summaries and injections', async t => {
  const gate = deferred<MemoryScope>();
  const entered = deferred<void>();
  let resolving = 0;
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1,
    { async resolveSession() { if (++resolving === 4) entered.resolve(); return gate.promise; }, async projects() { return [project]; } });
  t.after(() => service.close());
  await service.handle('profile/set', { scopeId: scopeId(project), key: '数据库', value: 'retain me' });
  const active = mount(service);
  const operations = Promise.allSettled([
    active.runtime.use(signal => service.remember({ kind: 'event', text: 'late event', sessionId: 's' }, signal)),
    active.runtime.use(signal => service.forget({ key: '数据库' }, 's', signal)),
    active.runtime.use(signal => service.inject('s', [user], signal)),
    active.runtime.summarize('late summary', 's'),
  ]);
  await entered.promise;
  const closed = active.close();
  assert.equal(active.runtime.enabled, false);
  gate.resolve(project);
  const results = await operations;
  await closed;
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected', 'rejected', 'fulfilled']);
  assert.equal(service.store.forScope(project).events().length, 0);
  assert.equal(service.store.forScope(project).injections().length, 0);
  assert.equal(service.store.forScope(project).profile()[0]!.value, 'retain me');
});

test('a pre-step listener resumed after unload cannot inject into the pending turn', async t => {
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1, source);
  t.after(() => service.close());
  await service.handle('profile/set', { scopeId: scopeId(project), key: '数据库', value: 'retained' });
  const active = mount(service);
  const next = deferred<{ kind: string; messages: typeof user[] }>();
  const pending = active.listeners.get('agent/pre-step')!({ agent: { id: 'session' } }, () => next.promise);
  await active.close();
  const decision = { kind: 'enter', messages: [user] };
  next.resolve(decision);
  assert.equal(await pending, decision);
  assert.equal(service.store.forScope(project).injections().length, 0);
});

test('unload waits for a storage write already admitted before disable', async t => {
  const fixture = fakeMemoryDomain({ remember: 'auto', inject: true });
  const writing = deferred<void>();
  const finish = deferred<void>();
  const opener: MemoryDomainOpener = { async open(spec) {
    const domain = await fixture.opener.open(spec);
    return new Proxy(domain, { get(target, key) {
      if (key !== 'table') return Reflect.get(target, key);
      return (name: Parameters<typeof domain.table>[0]) => {
        const table = domain.table(name);
        return new Proxy(table, { get(tableTarget, field) {
          if (field !== 'put' || name !== 'events') return Reflect.get(tableTarget, field);
          return async (...args: unknown[]) => {
            writing.resolve();
            await finish.promise;
            return Reflect.apply(tableTarget.put, tableTarget, args);
          };
        } });
      };
    } });
  } };
  const service = await MemoryService.open(opener, () => 1, source);
  t.after(() => service.close());
  const active = mount(service);
  const admitted = active.runtime.summarize('admitted summary', 'session');
  await writing.promise;
  let unloaded = false;
  const closing = active.close().then(() => { unloaded = true; });
  await Promise.resolve();
  assert.equal(unloaded, false);
  finish.resolve();
  await admitted;
  await closing;
  assert.equal(service.store.forScope(project).events()[0]!.text, 'admitted summary');
  assert.equal(await active.runtime.summarize('late summary', 'session'), undefined);
  assert.equal(service.store.forScope(project).events().length, 1);
});

test('memory prompt and automatic injection follow the current agent tool scope', async t => {
  const service = await MemoryService.open(fakeMemoryDomain({ remember: 'auto', inject: true }).opener, () => 1, source);
  t.after(() => service.close());
  await service.handle('profile/set', { scopeId: scopeId(project), key: '数据库', value: 'scoped' });
  const allowed = { id: 'allowed' };
  const active = mount(service, scope => scope === allowed);
  const decision = { kind: 'enter', messages: [user] };
  assert.equal(active.prompt(), '');
  assert.match(active.prompt(allowed), /memory_recall/);
  assert.equal(await active.listeners.get('agent/pre-step')!({ agent: { id: 'hidden' } }, async () => decision), decision);
  assert.equal((await active.listeners.get('agent/pre-step')!({ agent: allowed }, async () => decision)).messages.length, 2);
  await active.close();
});
