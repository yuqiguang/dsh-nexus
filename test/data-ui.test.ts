import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { DataSettings, type DataApi } from '../src/client/DataSettings.js';
import type { DataSummary } from '../src/data/archive.js';

async function page(t: TestContext, api: DataApi) {
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
  await act(async () => root.render(createElement(DataSettings, { api })));
  const buttons = () => [...dom.window.document.querySelectorAll('button')].map(item => item.textContent);
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `button ${label} missing; have ${buttons().join('、')}`);
    await act(async () => { button.click(); });
  };
  const choose = async (file: File) => {
    const input = dom.window.document.querySelector('input[type=file]')!;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  };
  return { click, choose, buttons, text: () => dom.window.document.body.textContent ?? '' };
}

const summary: DataSummary = { createdAt: Date.parse('2026-09-27T10:00:00+08:00'), sessions: 14, records: 81, credentials: 9, bytes: 5 * 1024 * 1024 };

test('the data page exports a download with a plain warning, and imports only after a second confirmation', async t => {
  const saved: { size: number; filename: string }[] = [];
  const imported: number[] = [];
  let fail: string | undefined;
  const api: DataApi = {
    async capabilities() { return { importEnabled: true }; },
    async exportData() { if (fail) throw new Error(fail); return { blob: new Blob(['zip']), filename: 'nexus-data-2026-09-27.zip', summary }; },
    async importData(file) {
      if (fail) throw new Error(fail);
      imported.push(file.size);
      return { pending: { stagedAt: 1, replacedDir: 'replaced-20260927-101500-abcdef', summary }, restarting: true };
    },
    save(blob, filename) { saved.push({ size: blob.size, filename }); },
  };
  const ui = await page(t, api);
  assert.match(ui.text(), /明文的微信登录、邮箱授权码和模型 API key，等于你所有账号的钥匙/);
  assert.match(ui.text(), /收到的附件和工作区里的文件不在里面/);
  await ui.click('导出数据');
  assert.deepEqual(saved, [{ size: 3, filename: 'nexus-data-2026-09-27.zip' }]);
  assert.match(ui.text(), /已导出 nexus-data-2026-09-27\.zip：14 个会话、81 条存储记录、9 条凭据，共 5\.0 MiB。/);
  // Nothing to import until a file is chosen; choosing one asks, cancelling backs out, confirming sends it.
  assert.equal(ui.buttons().includes('导入并重启'), false);
  await ui.choose(new File(['x'.repeat(2048)], 'nexus-data-2026-09-20.zip', { type: 'application/zip' }));
  assert.match(ui.text(), /nexus-data-2026-09-20\.zip（0\.0 MiB）/);
  await ui.click('导入并重启');
  assert.match(ui.text(), /确定用 nexus-data-2026-09-20\.zip 替换现在的全部数据吗？/);
  await ui.click('取消');
  assert.deepEqual(imported, []);
  await ui.click('导入并重启');
  await ui.click('确定替换');
  assert.deepEqual(imported, [2048]);
  assert.match(ui.text(), /已检查并准备好：.*导出，14 个会话、81 条存储记录、9 条凭据，共 5\.0 MiB。服务正在重启，半分钟左右后刷新页面。原来的数据会在 \.nexus\/replaced-20260927-101500-abcdef\/ 里。/);
  assert.equal(ui.buttons().includes('确定替换'), false, 'the choice is spent');
  // A refused archive says why in words, and nothing is left half-confirmed.
  fail = 'archive_corrupt';
  await ui.choose(new File(['y'], 'bad.zip'));
  await ui.click('导入并重启');
  await ui.click('确定替换');
  assert.match(ui.text(), /数据包里有文件和清单对不上，可能损坏或被改过。/);
  // Past the upload cap it is refused before anything is sent.
  fail = undefined;
  const huge = new File(['z'], 'huge.zip');
  Object.defineProperty(huge, 'size', { value: 300 * 1024 * 1024 });
  await ui.choose(huge);
  await ui.click('导入并重启');
  await ui.click('确定替换');
  assert.match(ui.text(), /文件太大（上限 256 MiB）。/);
  assert.deepEqual(imported, [2048]);
  fail = 'session_expired';
  await ui.click('导出数据');
  assert.match(ui.text(), /登录已过期/);
  assert.equal(saved.length, 1);
});


test('an installed plugin keeps export available and hides import without a startup importer', async t => {
  let exports = 0;
  const ui = await page(t, {
    async capabilities() { return { importEnabled: false }; },
    async exportData() { exports++; return { blob: new Blob(['zip']), filename: 'backup.zip' }; },
    async importData() { throw new Error('must not be called'); },
    save() {},
  });
  assert.match(ui.text(), /暂不支持整体导入/);
  assert.equal(ui.buttons().includes('导入并重启'), false);
  await ui.click('导出数据');
  assert.equal(exports, 1);
});
