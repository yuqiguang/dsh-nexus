import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { DocumentSettings, type DocumentApi } from '../src/client/DocumentSettings.js';
import type { DocumentsView } from '../src/documents/index.js';

async function page(t: TestContext, api: DocumentApi) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(DocumentSettings, { api })));
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `button ${label} missing`);
    await act(async () => { button.click(); });
  };
  return { click, text: () => dom.window.document.body.textContent ?? '' };
}

test('the document page lists capabilities, offers the pandoc download, and shows install progress and failure', async t => {
  let view: DocumentsView = { platform: 'linux', converters: [{ kind: 'ghostscript', path: '/usr/bin/gs' }], detectedAt: 1, capabilities: ['读取 docx', '不能转 PDF：本机没有 Word、WPS 或 LibreOffice'] };
  const calls: string[] = [];
  const api: DocumentApi = async method => {
    calls.push(method);
    if (method === 'pandoc/install') {
      if (view.pandoc?.phase === 'installing') throw new Error('install_in_progress');
      view = { ...view, pandoc: { phase: 'installing', startedAt: 2, bytes: 5 * 1024 * 1024 } };
    }
    if (method === 'detect') view = { ...view, detectedAt: 3, converters: [...view.converters, { kind: 'soffice', path: '/usr/bin/soffice' }] };
    return view;
  };
  const ui = await page(t, api);
  assert.match(ui.text(), /不能转 PDF：本机没有/);
  assert.match(ui.text(), /Ghostscript（\/usr\/bin\/gs）/);
  assert.match(ui.text(), /sudo apt install libreoffice-writer-nogui/);
  assert.match(ui.text(), /未安装/);
  await ui.click('下载 pandoc');
  assert.match(ui.text(), /下载中… 已收到 5\.0 MiB/);
  assert.ok((ui as unknown as { text(): string }).text().includes('下载 pandoc'));
  await ui.click('重新检测');
  assert.match(ui.text(), /可转 PDF/);
  assert.match(ui.text(), /LibreOffice（\/usr\/bin\/soffice）/);
  view = { ...view, pandoc: { phase: 'failed', startedAt: 2, finishedAt: 4, error: 'HTTP 403' }, converters: [...view.converters, { kind: 'pandoc', path: '/data/pandoc/bin/pandoc' }] };
  await ui.click('重新检测');
  assert.match(ui.text(), /安装失败：HTTP 403/);
  assert.match(ui.text(), /重新下载 pandoc/);
  assert.deepEqual(calls.slice(0, 4), ['list', 'pandoc/install', 'detect', 'detect']);
});
