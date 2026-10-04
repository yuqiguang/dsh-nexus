import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { UpdateSettings, type UpdatesApi } from '../src/client/UpdateSettings.js';
import type { UpdatesView } from '../src/updates/manager.js';

async function page(t: TestContext, api: UpdatesApi) {
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
  await act(async () => root.render(createElement(UpdateSettings, { api })));
  const details = dom.window.document.querySelector('details')!;
  assert.equal(details.open, false, 'update details start collapsed');
  const summary = () => details.querySelector('summary')!.textContent ?? '';
  const expand = async () => { if (!details.open) await act(async () => { details.querySelector('summary')!.click(); }); };
  const buttons = () => [...dom.window.document.querySelectorAll('button')].map(item => item.textContent);
  const click = async (label: string) => {
    await expand();
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `button ${label} missing; have ${buttons().join('、')}`);
    await act(async () => { button.click(); });
  };
  const check = async (index: number) => { await expand(); await act(async () => { (dom.window.document.querySelectorAll('input[type=checkbox]')[index] as HTMLInputElement).click(); }); };
  return { click, check, buttons, summary, details, text: () => dom.window.document.body.textContent ?? '' };
}

const initial: UpdatesView = { supported:true,currentVersion:'0.2.39',installedVersion:'0.2.39',dshVersion:'0.2.0-rc.2',revision:0,autoCheck:true,autoInstall:false,phase:'idle' };
test('automatic installation requires an explicit settings choice and states the restart boundary',async t=>{
  let view={...initial};let saved:unknown;
  const ui=await page(t,async(method,payload)=>{if(method==='save'){saved=payload;view={...view,...payload as object,revision:1};}return view;});
  assert.match(ui.text(),/空闲时自动安装（重启后生效）/);assert.match(ui.text(),/默认关闭/);
  await ui.check(1);assert.deepEqual(saved,{revision:0,autoCheck:true,autoInstall:true});
});
test('installed updates still display the running old version and a restart instruction',async t=>{
  const ui=await page(t,async()=>({...initial,installedVersion:'0.2.40',phase:'restart-required'}));
  assert.match(ui.text(),/正在运行：0.2.39/);assert.match(ui.text(),/已安装：0.2.40/);
  assert.match(ui.summary(), /v0.2.39.*待重启/);
  assert.equal(ui.details.open, false);
  assert.match(ui.text(),/当前仍运行旧版/);assert.match(ui.text(),/从托盘菜单完全退出/);
  assert.ok(!ui.buttons().includes('立即更新'));
});
test('source-managed profiles do not offer automatic installation controls',async t=>{
  const ui=await page(t,async()=>({...initial,supported:false}));
  assert.match(ui.text(),/源码 Web 由源码服务/);assert.equal(ui.buttons().length,0);
});

const latest = { version: '0.2.42', compatible: true, dshVersion: '0.2.0-rc.2', releaseUrl: 'https://github.com/yuqiguang/dsh-nexus/releases/tag/v0.2.42' };
test('manual update queues once and explains the current blocker instead of an automatic quiet period', async t => {
  let view: UpdatesView = { ...initial, phase: 'available', latest };
  const installs: unknown[] = [];
  const ui = await page(t, async (method, payload) => {
    if (method === 'install') {
      installs.push(payload);
      view = { ...view, phase: 'waiting', installMode: 'manual', waitReason: '微信还有 3 条消息等待投递。请先用绑定微信账号发送一条新消息。' };
    }
    if (method === 'cancel') view = { ...initial, phase: 'available', latest };
    return view;
  });
  assert.ok(ui.buttons().includes('立即更新'));
  assert.ok(!ui.buttons().includes('空闲时安装'));
  await ui.click('立即更新');
  assert.deepEqual(installs, [{ version: latest.version }]);
  assert.equal(ui.details.open, true, 'status updates preserve the expanded state');
  assert.match(ui.summary(), /等待更新/);
  assert.match(ui.text(), /等待原因：微信还有 3 条消息等待投递/);
  assert.doesNotMatch(ui.text(), /两分钟/);
  await ui.click('等待更新');
  assert.equal(installs.length, 1, 'a queued manual request cannot be submitted twice');
  await ui.click('取消本次更新');
  assert.ok(ui.buttons().includes('立即更新'));
  assert.doesNotMatch(ui.text(), /等待原因：/);
});
test('automatic waiting still offers immediate manual installation and clears the waiting explanation while preparing', async t => {
  let view: UpdatesView = { ...initial, autoInstall: true, phase: 'waiting', installMode: 'automatic', latest,
    waitReason: '自动更新需连续两分钟无会话活动。' };
  let requested = false;
  const ui = await page(t, async method => {
    if (method === 'install') { requested = true; view = { ...view, phase: 'preparing' }; }
    return view;
  });
  assert.match(ui.text(), /等待原因：自动更新需连续两分钟/);
  await ui.click('立即更新');
  assert.equal(requested, true);
  assert.match(ui.text(), /正在校验安装包/);
  assert.doesNotMatch(ui.text(), /等待原因：/);
});
