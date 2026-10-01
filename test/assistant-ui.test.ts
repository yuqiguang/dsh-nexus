import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { AssistantSettings, type AssistantApi } from '../src/client/AssistantSettings.js';
import type { AssistantView } from '../src/assistant/index.js';
import { CHAT_FOLD_ATTRIBUTE, CHAT_FOLD_KEY, applyChatFold, readChatFold, writeChatFold } from '../src/client/chatFold.js';

const initial = (): AssistantView => ({ settings: { revision: 0, timeZone: 'Asia/Shanghai', hookEnabled: false, persona: { name: 'Nexus', userName: '', tone: 'plain', initiative: 'medium' },
  speech: { baseUrl: '', model: '', apiKeyConfigured: false }, rotation: { daily: true, contextTokens: 60000 } },
  localTime: '9/19 08:00', quietNow: false, heldPushes: 0 });

async function page(t: TestContext, api: AssistantApi) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(AssistantSettings, { api })));
  const input = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement;
  const enter = async (id: string, value: string) => { await act(async () => {
    const element = input(id);
    const isSelect = element instanceof dom.window.HTMLSelectElement;
    Object.getOwnPropertyDescriptor(isSelect ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event(isSelect ? 'change' : 'input', { bubbles: true })); }); };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `button ${label} missing`);
    await act(async () => { button.click(); });
  };
  const submit = async () => { const form = input('assistant-zone').closest('form')!; await act(async () => { form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); }); };
  return { dom, input, enter, click, submit, text: () => dom.window.document.body.textContent ?? '' };
}

test('the assistant page saves quiet hours and briefing, shows held pushes, and reveals a minted hook token once', async t => {
  let view = initial();
  const calls: { method: string; payload: any }[] = [];
  const api: AssistantApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'save') view = { ...view, settings: { ...view.settings, revision: view.settings.revision + 1, timeZone: payload.config.timeZone,
      quietStart: payload.config.quietStart || undefined, quietEnd: payload.config.quietEnd || undefined, briefingTime: payload.config.briefingTime || undefined, persona: payload.config.persona,
      speech: { baseUrl: payload.config.speech.baseUrl, model: payload.config.speech.model, apiKeyConfigured: payload.config.speech.apiKey.length > 0 },
      rotation: { daily: payload.config.rotation.daily, contextTokens: Number(payload.config.rotation.contextTokens) } },
      quietNow: true, heldPushes: 2, nextBriefingAt: Date.parse('2026-09-20T08:00:00+08:00') };
    if (method === 'hook/rotate') return { ...view, settings: { ...view.settings, revision: view.settings.revision + 1, hookEnabled: payload.enabled },
      hookUrl: payload.enabled ? 'http://127.0.0.1:3080/nexus-hooks/inbound' : undefined, hookToken: payload.enabled ? 'minted-token-fixture' : undefined };
    if (method === 'flush') view = { ...view, heldPushes: 0 };
    if (method === 'speech/clear') view = { ...view, settings: { ...view.settings, revision: view.settings.revision + 1, speech: { baseUrl: '', model: '', apiKeyConfigured: false } } };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  const input = ui.input;
  assert.deepEqual([...ui.dom.window.document.querySelectorAll('h3')].map(item => item.textContent), ['人设', '时间与安静时段', '每日简报', '会话换新', '语音', '对话页显示', '外部事件入口']);
  // A template fills the persona fields; the user then edits one of them before saving everything in one request.
  await ui.enter('assistant-template', 'secretary');
  assert.equal(input('assistant-name').value, '小秘');
  assert.equal(input('assistant-tone').value, 'brisk');
  assert.equal(input('assistant-initiative').value, 'high');
  await ui.enter('assistant-user-name', '老于');
  await ui.enter('assistant-quiet-start', '23:00');
  await ui.enter('assistant-quiet-end', '07:00');
  await ui.enter('assistant-briefing', '08:00');
  await ui.enter('assistant-speech-url', 'https://api.siliconflow.cn/v1');
  await ui.enter('assistant-speech-model', 'FunAudioLLM/SenseVoiceSmall');
  await ui.enter('assistant-speech-key', 'sk-fixture');
  await ui.enter('assistant-rotate-tokens', '80000');
  await ui.submit();
  const save = calls.find(call => call.method === 'save')!;
  assert.deepEqual(save.payload, { revision: 0, config: { timeZone: 'Asia/Shanghai', quietStart: '23:00', quietEnd: '07:00', briefingTime: '08:00',
    persona: { name: '小秘', userName: '老于', tone: 'brisk', initiative: 'high' }, rotation: { daily: true, contextTokens: '80000' },
    speech: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', apiKey: 'sk-fixture' } } });
  assert.equal(input('assistant-rotate-tokens').value, '80000');
  assert.equal(input('assistant-name').value, '小秘', 'the saved persona stays in the form');
  assert.equal(input('assistant-speech-key').value, '', 'the key never comes back into the form');
  assert.equal(input('assistant-speech-key').placeholder, '已保存，留空保留当前密钥');
  assert.match(ui.text(), /语音已配置/);
  await ui.click('清除语音服务');
  assert.deepEqual(calls.at(-1), { method: 'speech/clear', payload: { revision: 1 } });
  assert.match(ui.text(), /语音未配置/);
  assert.match(ui.text(), /安静时段中/);
  assert.match(ui.text(), /当前保留 2 条/);
  assert.match(ui.text(), /下次：2026\/9\/20 08:00:00/);
  await ui.click('现在发送保留的消息');
  assert.equal(calls.at(-1)!.method, 'flush');
  assert.doesNotMatch(ui.text(), /当前保留/);
  await ui.click('启用并生成令牌');
  assert.deepEqual(calls.at(-1), { method: 'hook/rotate', payload: { revision: 2, enabled: true } });
  assert.match(ui.text(), /新令牌只显示这一次：minted-token-fixture/);
  assert.match(ui.text(), /http:\/\/127\.0\.0\.1:3080\/nexus-hooks\/inbound/);
  await ui.click('停用');
  assert.equal(calls.at(-1)!.payload.enabled, false);
  assert.doesNotMatch(ui.text(), /minted-token-fixture/);
  await ui.click('现在发一份');
  assert.equal(calls.at(-1)!.method, 'briefing/send');
});

test('the chat fold preference defaults on, survives in storage, and is written to the document root', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } };
  assert.equal(readChatFold(storage), true, 'default is one line per turn');
  writeChatFold(false, storage);
  assert.equal(store.get(CHAT_FOLD_KEY), 'off');
  assert.equal(readChatFold(storage), false);
  writeChatFold(true, storage);
  assert.equal(readChatFold(storage), true);
  const attributes = new Map<string, string>();
  const root = { setAttribute: (name: string, value: string) => { attributes.set(name, value); } } as unknown as Element;
  applyChatFold(false, root);
  assert.equal(attributes.get(CHAT_FOLD_ATTRIBUTE), 'off');
  applyChatFold(true, root);
  assert.equal(attributes.get(CHAT_FOLD_ATTRIBUTE), 'on');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readChatFold(broken), true);
  assert.doesNotThrow(() => writeChatFold(false, broken));
});
