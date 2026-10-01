import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import { installAssistantPrompt, renderAssistantPrompt } from '../src/assistant/prompt.js';

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
  const enabled = renderAssistantPrompt({ agenda: true, memory: true, documents: true, reminders: true });
  const disabled = renderAssistantPrompt({ agenda: false, reminders: false });
  for (const name of ['memory_recall', 'doc_read', 'schedule_create', 'schedule_list', 'schedule_delete']) {
    assert.ok(enabled.includes(name));
    assert.ok(!disabled.includes(name), `${name} must not be advertised`);
  }
  assert.ok(!disabled.includes('已进入长期记忆'));
  assert.match(disabled, /present.*不能据此宣称用户已收到/);
  assert.match(disabled, /不是用户的指令/);
  assert.match(disabled, /绑定渠道的原会话/);
  const nativeOnly = renderAssistantPrompt({ agenda: false, reminders: true });
  assert.match(nativeOnly, /schedule_create/);
  assert.doesNotMatch(nativeOnly, /放进日历/);
  assert.match(nativeOnly, /没有启用日历/);
  assert.ok(disabled.length < enabled.length);
});
