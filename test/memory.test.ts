import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import { rank, tokens } from '../src/memory/search.js';
import { LIMITS, MemoryLimitError, MemoryStore, memoryDomain, type MemoryDomain, type MemoryDomainOpener, type MemoryPolicy } from '../src/memory/store.js';
import { scopeId, type MemoryScope } from '../src/memory/scope.js';
import { INJECT_BUDGET, MemoryService } from '../src/memory/index.js';

import { fakeMemoryDomain } from './memoryFixture.js';

const TEST_SCOPE: MemoryScope = { kind: 'project', owner: 'local', project: '/fixture/project' };
const source = { async resolveSession() { return TEST_SCOPE; }, async projects() { return [TEST_SCOPE]; } };

const textOf = (message: UserMessage | undefined) => message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') ?? '';
const user = (text: string): UserMessage => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const T0 = Date.parse('2026-09-20T10:00:00+08:00');

test('tokens split ASCII words and Chinese bigrams so a Chinese query matches without a segmenter', () => {
  assert.deepEqual(tokens('Hello 世界 v2'), ['hello', '世界', 'v2']);
  assert.deepEqual(tokens('我喜欢喝咖啡'), ['我喜', '喜欢', '欢喝', '喝咖', '咖啡']);
  assert.deepEqual(tokens('猫'), ['猫']);
});

test('ranking returns only items sharing a term, rare terms outrank common ones, and ties go to the newer item', () => {
  const items = [
    { id: 'a', text: '用户喜欢喝咖啡，不加糖', at: T0 - 86_400_000 * 10 },
    { id: 'b', text: '用户喜欢喝茶', at: T0 - 86_400_000 * 2 },
    { id: 'c', text: '用户喜欢跑步', at: T0 },
    { id: 'd', text: '周三开会讨论预算', at: T0 },
  ];
  const coffee = rank('咖啡', items, T0);
  assert.deepEqual(coffee.map(item => item.item.id), ['a']);
  const likes = rank('用户喜欢什么', items, T0);
  assert.deepEqual(likes.map(item => item.item.id), ['c', 'b', 'a'], 'equal overlap resolves by recency');
  assert.deepEqual(rank('天气', items, T0), []);
  assert.deepEqual(rank('', items, T0), []);
});

test('the store enforces hard limits with actionable errors instead of truncating, and dedupes identical events', async () => {
  const { opener } = fakeMemoryDomain({ remember: 'auto', inject: true });
  const store = await MemoryStore.open(opener);
  const entry = await store.setProfile(' 称呼 ', '  老 于  ', 'model', T0);
  assert.deepEqual(entry, { key: '称呼', value: '老 于', updatedAt: T0, source: 'model' });
  await store.setProfile('称呼', '于工', 'user', T0 + 1);
  assert.equal(store.profile().length, 1);
  assert.equal(store.profile()[0]!.value, '于工');
  await assert.rejects(store.setProfile('k', 'x'.repeat(LIMITS.profileValueChars + 1), 'model'), MemoryLimitError);
  await assert.rejects(store.setProfile('k'.repeat(LIMITS.profileKeyChars + 1), 'v', 'model'), MemoryLimitError);
  for (let index = 1; index < LIMITS.profileEntries; index++) await store.setProfile(`k${index}`, 'v', 'model', T0);
  await assert.rejects(store.setProfile('one-too-many', 'v', 'model'), /先用 memory_forget/);
  await store.setProfile('称呼', '还能改已有的', 'model', T0);
  const first = await store.addEvent({ text: '9 月 18 日决定用飞书做备用入口', tags: ['飞书', '飞书', '', '入口'], source: 'model', sessionId: 's1' }, T0);
  assert.deepEqual(first.tags, ['飞书', '入口']);
  const again = await store.addEvent({ text: ' 9 月 18 日决定用飞书做备用入口 ', source: 'user' }, T0 + 5);
  assert.equal(again.id, first.id, 'the same sentence is one memory');
  await assert.rejects(store.addEvent({ text: 'x'.repeat(LIMITS.eventChars + 1), source: 'model' }), /只记结论/);
  await assert.rejects(store.addEvent({ text: '   ', source: 'model' }), MemoryLimitError);
  assert.equal(store.recall('飞书', 5)[0]!.item.id, first.id);
  assert.equal(await store.deleteEvent(first.id), true);
  assert.equal(await store.deleteEvent(first.id), false);
  assert.deepEqual(store.recall('飞书', 5), []);
});

test('proposals are settled by the user: accepting writes with user provenance, rejecting only removes', async () => {
  const { opener } = fakeMemoryDomain({ remember: 'ask', inject: true });
  const service = await MemoryService.open(opener, () => T0, source);
  const reply = await service.remember({ sessionId: 's1', kind: 'profile', key: '公司', text: 'Nexus' });
  assert.match(reply, /待确认/);
  await service.remember({ sessionId: 's1', kind: 'event', text: '用户说下周出差' });
  assert.deepEqual(service.store.forScope(TEST_SCOPE).profile(), []);
  assert.deepEqual(service.store.forScope(TEST_SCOPE).events(), []);
  const [profileProposal, eventProposal] = service.store.forScope(TEST_SCOPE).proposals();
  await service.handle('proposal/settle', { scopeId: scopeId(TEST_SCOPE), id: profileProposal!.id, accept: true });
  await service.handle('proposal/settle', { scopeId: scopeId(TEST_SCOPE), id: eventProposal!.id, accept: false });
  assert.deepEqual(service.store.forScope(TEST_SCOPE).profile().map(({ scope, ...entry }) => entry), [{ key: '公司', value: 'Nexus', updatedAt: T0, source: 'user' }]);
  assert.deepEqual(service.store.forScope(TEST_SCOPE).events(), []);
  assert.deepEqual(service.store.forScope(TEST_SCOPE).proposals(), []);
  await assert.rejects(service.handle('proposal/settle', { scopeId: scopeId(TEST_SCOPE), id: 'mp-gone', accept: true }), /not_found/);
  await service.handle('policy', { scopeId: scopeId(TEST_SCOPE), remember: 'off', inject: true });
  await assert.rejects(service.remember({ sessionId: 's1', kind: 'event', text: '不会被记住' }), /已关闭记忆写入/);
  await assert.rejects(service.handle('policy', { scopeId: scopeId(TEST_SCOPE), remember: 'sometimes', inject: true }), /invalid_configuration/);
});

test('injection admits the profile once per session, only relevant events, never twice, and audits every injection', async () => {
  const { opener } = fakeMemoryDomain({ remember: 'auto', inject: true });
  let now = T0;
  const service = await MemoryService.open(opener, () => now++, source);
  assert.equal(await service.inject('s1', [user('你好')]), undefined, 'nothing stored means nothing injected');
  await service.remember({ sessionId: 's1', kind: 'profile', key: '称呼', text: '老于' });
  await service.remember({ sessionId: 's1', kind: 'event', text: '9 月 12 日和王总谈了合作，下月签约', tags: ['王总'] });
  await service.remember({ sessionId: 's1', kind: 'event', text: '用户家里的猫叫团子' });
  const first = await service.inject('s1', [user('王总那边怎么说')]);
  assert.ok(first);
  assert.equal(first.source.kind, 'nexus-memory');
  assert.match(textOf(first), /^\[记忆\]/);
  const text = textOf(first);
  assert.match(text, /称呼：老于/);
  assert.match(text, /王总谈了合作/);
  assert.doesNotMatch(text, /团子/, 'an unrelated event is not admitted');
  const second = await service.inject('s1', [user('王总什么时候签约')]);
  assert.equal(second, undefined, 'the same profile and the same event are not injected again in one session');
  const cat = await service.inject('s1', [user('团子今天吃了吗')]);
  assert.ok(cat);
  const catText = textOf(cat);
  assert.match(catText, /团子/);
  assert.doesNotMatch(catText, /称呼/, 'the profile went in earlier this session');
  // Plugin-initiated messages (a reminder, a job notice) never trigger a lookup. dsh-schedule declares its `schedule` source in types it does not export.
  const reminder = createUserMessage({ content: [{ type: 'text', text: '[SCHEDULE REMINDER] 王总' }], source: { kind: 'schedule' } as unknown as UserMessage['source'] });
  assert.equal(await service.inject('s2', [reminder]), undefined);
  // Another session sees the profile again; after compaction the same session sees everything again.
  const other = await service.inject('s2', [user('随便聊聊')]);
  assert.ok(other && /称呼：老于/.test(textOf(other)));
  service.onSessionEvent({ id: 's1' } as never, { type: 'compaction/end' } as never);
  const afterCompaction = await service.inject('s1', [user('王总')]);
  assert.ok(afterCompaction && /称呼：老于/.test(textOf(afterCompaction)));
  const audit = service.store.forScope(TEST_SCOPE).injections();
  assert.equal(audit.length, 4);
  assert.deepEqual(audit.map(record => record.sessionId), ['s1', 's2', 's1', 's1'], 'newest first');
  assert.equal(audit.at(-1)!.query, '王总那边怎么说');
  assert.equal(audit.at(-1)!.profile, true);
  assert.equal(audit.at(-1)!.eventIds.length, 1);
  // A changed profile is injected again in the same session; a deleted event is not.
  await service.remember({ sessionId: 's1', kind: 'profile', key: '公司', text: 'Nexus' });
  const changed = await service.inject('s1', [user('公司的事')]);
  assert.ok(changed && /公司：Nexus/.test(textOf(changed)));
  const catEvent = service.store.forScope(TEST_SCOPE).events().find(event => event.text.includes('团子'))!;
  await service.forget({ id: catEvent.id }, 's1');
  assert.doesNotMatch(textOf(await service.inject('s3', [user('团子')])), /团子/, 'a deleted event is never injected again');
  assert.doesNotMatch(await service.recall('团子', 5, 's1'), /团子/);
  await service.handle('policy', { scopeId: scopeId(TEST_SCOPE), remember: 'auto', inject: false });
  assert.equal(await service.inject('s4', [user('王总')]), undefined, 'injection can be switched off');
});

test('injection stays within the character budget and caps the number of events', async () => {
  const { opener } = fakeMemoryDomain({ remember: 'auto', inject: true });
  const service = await MemoryService.open(opener, () => T0, source);
  for (let index = 0; index < 12; index++) await service.remember({ sessionId: 's1', kind: 'event', text: `第 ${index} 次会议讨论预算 ${'细节'.repeat(100)}` });
  const injected = await service.inject('s1', [user('预算会议')]);
  assert.ok(injected);
  const text = textOf(injected);
  assert.ok(text.length <= INJECT_BUDGET.totalChars + 200, `injected ${text.length} chars`);
  const shown = (text.match(/\[me-/g) ?? []).length;
  assert.ok(shown >= 1 && shown <= INJECT_BUDGET.events, `showed ${shown} events`);
  assert.equal(service.store.forScope(TEST_SCOPE).injections()[0]!.eventIds.length, shown);
});

test('the settings routes write with user provenance, validate input, and export everything', async () => {
  const { opener } = fakeMemoryDomain({ remember: 'auto', inject: true });
  const service = await MemoryService.open(opener, () => T0, source);
  await service.handle('profile/set', { scopeId: scopeId(TEST_SCOPE), key: '称呼', value: '老于' });
  await service.handle('event/add', { scopeId: scopeId(TEST_SCOPE), text: '国庆去成都', tags: ['旅行'] });
  const view = await service.handle('list', { scopeId: scopeId(TEST_SCOPE),});
  assert.deepEqual(view.profile.map(({ scope, ...entry }) => entry), [{ key: '称呼', value: '老于', updatedAt: T0, source: 'user' }]);
  assert.equal(view.events[0]!.source, 'user');
  assert.deepEqual(view.counts, { profile: 1, events: 1, proposals: 0 });
  await assert.rejects(service.handle('profile/set', { scopeId: scopeId(TEST_SCOPE), key: '', value: 'x' }), /memory_limit/);
  await assert.rejects(service.handle('profile/delete', { scopeId: scopeId(TEST_SCOPE), key: '没有' }), /not_found/);
  await assert.rejects(service.handle('event/delete', { scopeId: scopeId(TEST_SCOPE), id: 'me-none' }), /not_found/);
  await assert.rejects(service.handle('nope', { scopeId: scopeId(TEST_SCOPE),}), /unknown_action/);
  await assert.rejects(service.handle('policy', 'bad'), /invalid_configuration/);
  const exported = JSON.parse((await service.handle('export', { scopeId: scopeId(TEST_SCOPE),})).exportJson!);
  assert.deepEqual(Object.keys(exported).sort(), ['events', 'exportedAt', 'policy', 'profile', 'proposals', 'scope']);
  assert.equal(exported.events[0].text, '国庆去成都');
  await service.handle('event/delete', { scopeId: scopeId(TEST_SCOPE), id: view.events[0]!.id });
  assert.deepEqual((await service.handle('list', { scopeId: scopeId(TEST_SCOPE),})).events, []);
});
