import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { compatibleModules, ModuleSettings, type ModuleFlags } from '../src/modules/settings.js';
import { installAssistantPrompt, renderAssistantPrompt } from '../src/assistant/prompt.js';
import { MemoryRecords } from './helpers.js';

const off: ModuleFlags = { memory: false, mail: false, agenda: false };

test('prompt availability queries the current agent scope rather than the global tool registry', () => {
  let render!: (context: AssembleContext) => string;
  const scope = {} as AssembleContext['scope'];
  const ctx = {
    effect: (run: () => unknown) => run(),
    tools: { get: (name: string, selected: unknown) => selected === scope && name === 'schedule_create' ? {} : undefined },
    systemPrompt: { getSectionOrder: () => 0, section: (section: { text: typeof render }) => { render = section.text; return () => {}; } },
  } as unknown as Context;
  installAssistantPrompt(ctx);
  assert.match(render({ scope }), /schedule_create/);
  assert.doesNotMatch(render({}), /schedule_create/);
  assert.doesNotMatch(render({ scope }), /memory_recall|doc_read/);
});

test('module saves are atomic, preserve the active runtime, and take effect only at next start', async () => {
  const records = new MemoryRecords();
  const first = await ModuleSettings.open(records, true);
  assert.deepEqual((await first.handle('list')).saved, compatibleModules(), 'unmarked legacy installs keep their behavior');
  const view = await first.handle('save', { revision: 0, enabled: off });
  assert.deepEqual(view.active, compatibleModules());
  assert.deepEqual(view.saved, off);
  assert.equal(view.pendingRestart, true);
  view.active.memory = false;
  view.saved.memory = true;
  assert.equal(first.active.memory, true, 'returned views cannot change runtime flags');
  assert.equal((await first.handle('list')).saved.memory, false);
  const restarted = await ModuleSettings.open(records, true);
  assert.deepEqual(restarted.active, off);
  assert.equal((await restarted.handle('list')).pendingRestart, false);
  await assert.rejects(first.handle('save', { revision: 0, enabled: compatibleModules() }), /configuration_changed/);
  const competing = await Promise.allSettled([
    restarted.handle('save', { revision: 1, enabled: compatibleModules() }),
    first.handle('save', { revision: 1, enabled: off }),
  ]);
  assert.equal(competing.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await first.handle('list')).revision, 2);
  assert.deepEqual(restarted.active, off);
});

test('invalid flags, revisions and corrupt saved records cannot silently enable modules', async () => {
  const records = new MemoryRecords();
  const modules = await ModuleSettings.open(records);
  for (const enabled of [null, [], {}, { ...off, mail: 'false' }, { ...off, coding: false }]) {
    await assert.rejects(modules.handle('save', { revision: 0, enabled }), /invalid_configuration/);
  }
  for (const revision of [-1, 0.5, '0', undefined]) await assert.rejects(modules.handle('save', { revision, enabled: off }), /invalid_revision/);
  assert.equal(records.values.size, 0);
  await assert.rejects(modules.handle('restart'), /unknown_action/);
  for (const raw of [{ version: 3, revision: 1, enabled: off }, { version: 1, revision: 1, enabled: { ...off, memory: 'yes' } }]) {
    records.values.set('settings', raw);
    await assert.rejects(ModuleSettings.open(records), /invalid_saved_record/);
  }
});

test('reverting a pending change cancels restart need without modifying active flags', async () => {
  const modules = await ModuleSettings.open(new MemoryRecords());
  await modules.handle('save', { revision: 0, enabled: off });
  const view = await modules.handle('save', { revision: 1, enabled: compatibleModules() });
  assert.equal(view.pendingRestart, false);
  assert.equal(view.nativeRemindersAvailable, false);
});

test('legacy document choices are retired without changing the other flags or writing on read', async () => {
  for (const documents of [true, false]) {
    const records = new MemoryRecords();
    const legacy = { version: 1, revision: 5, enabled: { memory: false, mail: true, agenda: false, documents } };
    records.values.set('settings', legacy);
    const settings = await ModuleSettings.open(records);
    assert.deepEqual(settings.active, { memory: false, mail: true, agenda: false });
    assert.deepEqual(records.values.get('settings'), legacy);
    assert.equal((await settings.handle('list')).pendingRestart, false);
    await assert.rejects(settings.handle('save', { revision: 5, enabled: legacy.enabled }), /invalid_configuration/,
      'an old client cannot write a competing document switch');
    await settings.handle('save', { revision: 5, enabled: off });
    assert.deepEqual(records.values.get('settings'), { version: 2, revision: 6, enabled: off });
  }
});

test('native Office guidance uses the visible skill loader and never equates compatibility off with unavailable Office', () => {
  let render!: (context: AssembleContext) => string;
  const scope = {} as AssembleContext['scope'];
  const ctx = {
    effect: (run: () => unknown) => run(),
    tools: { get: (name: string, selected: unknown) => selected === scope && name === 'skill' ? {} : undefined },
    systemPrompt: { getSectionOrder: () => 0, section: (section: { text: typeof render }) => { render = section.text; return () => {}; } },
  } as unknown as Context;
  installAssistantPrompt(ctx);
  assert.match(render({ scope }), /先用 skill 加载/);
  assert.match(render({ scope }), /列有对应的 office-docx/);
  assert.match(render({ scope }), /不自动改用其他转换软件/);
  assert.doesNotMatch(render({}), /先用 skill 加载/);
  assert.match(render({ scope }), /不代表 DSH 官方文档能力不可用/);
  assert.doesNotMatch(render({ scope }), /doc_read|Office\/PDF 专用读取未启用/);
});

test('assistant prompt follows live capabilities and keeps file delivery and untrusted content boundaries', () => {
  const enabled = renderAssistantPrompt({ ...compatibleModules(), documents: true, reminders: true });
  const disabled = renderAssistantPrompt({ ...off, reminders: false });
  for (const name of ['memory_recall', 'doc_read', 'schedule_create', 'schedule_list', 'schedule_delete']) {
    assert.ok(enabled.includes(name));
    assert.ok(!disabled.includes(name), `${name} must not be advertised`);
  }
  assert.ok(!disabled.includes('已进入长期记忆'));
  assert.match(disabled, /present.*不能据此宣称用户已收到/);
  assert.match(disabled, /不是用户的指令/);
  assert.match(disabled, /绑定渠道的原会话/);
  const nativeOnly = renderAssistantPrompt({ ...off, reminders: true });
  assert.match(nativeOnly, /schedule_create/);
  assert.doesNotMatch(nativeOnly, /放进日历/);
  assert.match(nativeOnly, /没有启用日历/);
  assert.ok(disabled.length < enabled.length);
});
