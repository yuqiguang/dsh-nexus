import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { act, createElement, useEffect } from 'react';
import { ModuleBoundary, ModuleSettings, type ModulesApi } from '../src/client/ModuleSettings.js';
import { ModuleSettings as Settings } from '../src/modules/settings.js';
import { MemoryRecords } from './helpers.js';

async function page(t: TestContext, component: ReturnType<typeof createElement>) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(component));
  return {
    dom, text: () => dom.window.document.body.textContent ?? '',
    click: async (label: string) => { const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label); assert.ok(button); await act(async () => button.click()); },
    submit: async () => { await act(async () => dom.window.document.querySelector('form')!.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true }))); },
  };
}

test('module UI distinguishes draft, saved and active states and reloads after a revision conflict', async t => {
  const records = new MemoryRecords();
  const settings = await Settings.open(records, true);
  const calls: string[] = [];
  const api: ModulesApi = async (method, payload) => { calls.push(method); return settings.handle(method, payload); };
  const ui = await page(t, createElement(ModuleSettings, { api }));
  assert.match(ui.text(), /兼容默认值/);
  await ui.click('仅保留编码核心');
  assert.deepEqual(calls, ['list'], 'preset only changes the draft');
  assert.equal(ui.dom.window.document.querySelectorAll('input:checked').length, 0);
  assert.match(ui.text(), /当前：开启 · 已保存：开启/);
  await ui.submit();
  assert.match(ui.text(), /等待重启生效/);
  assert.match(ui.text(), /当前：开启 · 已保存：关闭/);
  assert.match(ui.text(), /不会自动重启或中断/);
  await settings.handle('save', { revision: 1, enabled: { memory: true, mail: false, agenda: false, documents: false } });
  await ui.submit();
  assert.match(ui.text(), /配置已在其他窗口修改/);
  assert.equal(ui.dom.window.document.querySelectorAll('input:checked').length, 0, 'conflicts retain draft');
  await ui.click('重新载入');
  assert.equal(ui.dom.window.document.querySelectorAll('input:checked').length, 1);
  assert.match(ui.text(), /原生定时提醒：宿主服务可用/);
});

test('disabled module settings never mount the document poller, including pending enable', async t => {
  const records = new MemoryRecords();
  const before = await Settings.open(records);
  await before.handle('save', { revision: 0, enabled: { memory: false, mail: false, agenda: false, documents: false } });
  const settings = await Settings.open(records);
  await settings.handle('save', { revision: 1, enabled: { memory: false, mail: false, agenda: false, documents: true } });
  let mounted = 0;
  function Child() { useEffect(() => { mounted++; }, []); return createElement('p', null, 'document poller'); }
  const ui = await page(t, createElement(ModuleBoundary, { module: 'documents', api: (m, p) => settings.handle(m, p), children: createElement(Child) }));
  assert.equal(mounted, 0);
  assert.match(ui.text(), /已保存开启配置，重启 DSH 后生效/);
  assert.doesNotMatch(ui.text(), /document poller/);
});

test('an active module remains mounted while its disable is pending restart', async t => {
  const settings = await Settings.open(new MemoryRecords());
  await settings.handle('save', { revision: 0, enabled: { memory: false, mail: false, agenda: false, documents: false } });
  const ui = await page(t, createElement(ModuleBoundary, { module: 'documents', api: (m, p) => settings.handle(m, p), children: createElement('p', null, 'document settings active') }));
  assert.match(ui.text(), /document settings active/);
});
