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

test('native Office guidance uses only the visible skill loader after compatibility tools are removed', () => {
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
  assert.match(render({ scope }), /文档能力以当前会话可见/);
  assert.doesNotMatch(render({ scope }), /doc_read|Office\/PDF 专用读取未启用/);
});

test('assistant prompt follows live capabilities and keeps file delivery and untrusted content boundaries', () => {
  const enabled = renderAssistantPrompt({ agenda: true, memory: true, reminders: true });
  const disabled = renderAssistantPrompt({ agenda: false, reminders: false });
  for (const name of ['memory_recall', 'schedule_create', 'schedule_list']) {
    assert.ok(enabled.includes(name));
    assert.ok(!disabled.includes(name), `${name} must not be advertised`);
  }
  assert.doesNotMatch(enabled + disabled, /doc_read|doc_create|doc_edit|doc_convert|启用“文档兼容工具”/);
  assert.ok(!disabled.includes('已进入长期记忆'));
  assert.match(disabled, /present.*不能据此宣称用户已收到/);
  assert.match(disabled, /不是用户的指令/);
  assert.match(disabled, /绑定渠道的原会话/);
  const nativeOnly = renderAssistantPrompt({ agenda: false, reminders: true });
  assert.match(nativeOnly, /schedule_create/);
  assert.doesNotMatch(nativeOnly, /放进日历/);
  assert.match(nativeOnly, /固定时间重复任务不依赖日历组件/);
  assert.match(nativeOnly, /daily.*08:00:00/);
  assert.match(nativeOnly, /需要搜索、检查或生成内容的任务先完成工作再汇报/);
  assert.match(nativeOnly, /DSH 自动化页面/);
  assert.match(nativeOnly, /支持 timing 时把时间规则放在 timing/);
  assert.match(nativeOnly, /target=.*当前会话的精确 id/);
  assert.match(nativeOnly, /默认创建新会话的目标不会自动绑定手机渠道/);
  assert.doesNotMatch(nativeOnly, /任务属于创建它的原会话/);
  assert.ok(disabled.length < enabled.length);
});
