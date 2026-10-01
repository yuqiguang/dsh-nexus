import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { CoderSettings, type CoderApi } from '../src/client/CoderSettings.js';
import type { CodersView } from '../src/coders/manager.js';

const initial = (): CodersView => ({
  platform: 'linux',
  settings: { revision: 0, defaultCoder: 'codex', codex: { source: 'managed', apiKeyConfigured: false }, claude: { source: 'managed', authHeader: 'auth-token', tokenConfigured: false } },
  profileRoots: ['/home/dev/project'], effectiveRoots: ['/home/dev/project'], managedRoot: '/home/dev/.nexus/nexus-coders', claudeHome: '/home/dev/.nexus/nexus-coders/claude-home',
  codex: { managed: { installed: false }, system: { installed: true, version: '0.155.0', path: '/usr/bin/codex' }, active: 'system', fallback: true, ready: true, login: 'Logged in using an API key - sk-a…' },
  claude: { managed: { installed: false }, system: { installed: false }, active: 'none', fallback: false, ready: false, problem: 'Claude Code 的 Agent SDK 尚未安装。' },
  rules: [{ id: 'cr-1', source: 'user', text: 'cr-1 允许命令「npm test」（用户设定）' }],
  recentTasks: [{ id: 'ct-1', coder: 'codex', status: 'completed', description: '列目录', updatedAt: 1 }],
});

test('tool readiness needs no separate project choice and checks only the saved default tool', async t => {
  const view = initial();
  view.codex.credentialState = 'configured';
  const calls: string[] = [];
  const ui = await page(t, async method => { calls.push(method); return structuredClone(view); });
  const panel = () => ui.dom.window.document.querySelector('[aria-label="工具状态检查"]')!;
  assert.match(panel().textContent!, /默认工具配置已准备/);
  assert.match(panel().textContent!, /默认工具：Codex/);
  assert.match(panel().textContent!, /DSH 新建会话时选择/);
  assert.equal(ui.field('nexus-project-path'), null);
  assert.equal(ui.field('nexus-known-project'), null);
  assert.doesNotMatch(ui.text(), /开始编码|完成以下准备|使用此项目|打开项目会话/);
  assert.match(ui.text(), /共用托管安装目录/);
  assert.match(ui.text(), /另一工具未完成的安装需单独重试/);
  await ui.click('重新检查');
  assert.deepEqual(calls, ['list', 'refresh']);
  view.settings.defaultCoder = 'claude';
  await ui.click('重新检查');
  assert.match(panel().textContent!, /默认工具：Claude Code/);
  assert.match(panel().textContent!, /默认工具待配置/);
  assert.match(panel().textContent!, /安装：尚未安装/);
  assert.match(panel().textContent!, /凭据：尚未确认/);
});

test('readiness distinguishes missing credentials and preserves task navigation without project controls', async t => {
  const view = initial();
  view.codex.credentialState = 'missing';
  const opened: string[] = []; let closed = 0;
  const ui = await page(t, async () => structuredClone(view), {
    navigation: () => ({ openTask: id => { opened.push(id); } }), close: () => { closed++; },
  });
  const panel = () => ui.dom.window.document.querySelector('[aria-label="工具状态检查"]')!;
  assert.match(panel().textContent!, /默认工具待配置/);
  assert.match(panel().textContent!, /凭据：尚未配置/);
  await ui.click('查看任务与验收');
  assert.deepEqual(opened, ['ct-1']); assert.equal(closed, 1);
  await ui.enter('codex-model', 'unsaved-model');
  assert.equal([...panel().querySelectorAll('button')].find(b => b.textContent === '重新检查')!.disabled, true);
});

test('Windows sandbox setup is an explicit settings action and firewall failures are not offered as setup retries', async t => {
  let view = initial();
  view.codex = { ...view.codex, ready: false, windowsSandbox: 'notConfigured' };
  const calls: string[] = [];
  const ui = await page(t, async method => {
    calls.push(method);
    if (method === 'windows-sandbox/setup') view = { ...view, codex: { ...view.codex, windowsSandbox: 'firewallDisabled', problem: '请在 Windows 安全中心启用防火墙。' } };
    return structuredClone(view);
  });
  assert.equal(calls.includes('windows-sandbox/setup'), false);
  await ui.click('配置 Windows 沙箱');
  assert.equal(calls.filter(method => method === 'windows-sandbox/setup').length, 1);
  assert.match(ui.text(), /启用防火墙/);
  assert.equal([...ui.dom.window.document.querySelectorAll('button')].some(button => button.textContent === '配置 Windows 沙箱'), false);
});

test('settings use the host platform and host-generated login command, even in a browser on another OS', async t => {
  const view = initial();
  view.platform = 'win32';
  view.claudeHome = 'C:\\Users\\Jane Doe\\.dsh\\nexus-coders\\claude-home';
  view.claudeLogin = { shell: 'PowerShell', command: "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\Jane Doe\\.dsh\\nexus-coders\\claude-home'; & 'C:\\Program Files\\Claude\\claude.exe' auth login" };
  const ui = await page(t, async () => structuredClone(view));
  assert.match(ui.text(), /%USERPROFILE%\\.codex/);
  assert.doesNotMatch(ui.text(), /~\/\.codex/);
  assert.match(ui.text(), /DSH 启动环境设置了 CODEX_HOME/);
  assert.match(ui.text(), /不会自动沿用终端中 Claude Code 的登录/);
  assert.equal(ui.dom.window.document.querySelector('pre code')?.textContent, view.claudeLogin.command);
  assert.match(ui.text(), /DSH 所在电脑的 PowerShell/);
});

async function page(t: TestContext, api: CoderApi, extra: Partial<Parameters<typeof CoderSettings>[0]> = {}) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  await act(async () => root.render(createElement(CoderSettings, { api, ...extra })));
  const field = (id: string) => dom.window.document.getElementById(id) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  const enter = async (id: string, value: string) => {
    await act(async () => {
      const element = field(id);
      const proto = element instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype
        : element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
      element.dispatchEvent(new dom.window.Event(element instanceof dom.window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `button ${label} missing`);
    await act(async () => { button.click(); });
  };
  const submit = async () => {
    const form = field('coders-default').closest('form')!;
    await act(async () => { form.dispatchEvent(new dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
  };
  return { dom, field, enter, click, submit, text: () => dom.window.document.body.textContent ?? '' };
}

test('the coder settings page shows status, saves every field while clearing typed secrets, and drives install and rule removal', async t => {
  let view = initial();
  const calls: { method: string; payload: any }[] = [];
  const api: CoderApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'save') view = { ...view, settings: { ...view.settings, revision: view.settings.revision + 1, defaultCoder: payload.config.defaultCoder,
      roots: payload.config.roots.split('\n').filter(Boolean), maxConcurrent: payload.config.maxConcurrent,
      codex: { ...view.settings.codex, source: payload.config.codex.source, model: payload.config.codex.model, baseUrl: payload.config.codex.baseUrl, apiKeyConfigured: view.settings.codex.apiKeyConfigured || !!payload.config.codex.apiKey },
      claude: { ...view.settings.claude, model: payload.config.claude.model, baseUrl: payload.config.claude.baseUrl, authHeader: payload.config.claude.authHeader, tokenConfigured: view.settings.claude.tokenConfigured || !!payload.config.claude.token } } };
    if (method === 'install') view = { ...view, install: { coder: payload.coder, phase: 'installing', startedAt: 1, log: 'npm http fetch GET 200 …' } };
    if (method === 'rules/remove') view = { ...view, rules: view.rules.filter(rule => rule.id !== payload.id) };
    if (method === 'clear-secret') view = { ...view, settings: { ...view.settings, revision: view.settings.revision + 1, claude: { ...view.settings.claude, tokenConfigured: false } } };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  assert.deepEqual([...ui.dom.window.document.querySelectorAll('h3')].map(item => item.textContent), ['工具状态检查', '通用', 'Codex', 'Claude Code', '习惯规则', '最近任务']);
  assert.match(ui.text(), /可用（系统安装，首选的Nexus 托管不可用）/);
  assert.match(ui.text(), /Logged in using an API key - sk-a…/);
  assert.match(ui.text(), /Claude Code 的 Agent SDK 尚未安装/);
  assert.match(ui.text(), /~\/\.codex/);
  assert.equal(ui.dom.window.document.querySelector('pre code'), null, 'no unusable OAuth command before installation');
  assert.match(ui.text(), /cr-1 允许命令「npm test」/);
  assert.match(ui.text(), /ct-1 · Codex · 已完成/);
  assert.equal(ui.field('coders-security').value, 'standard');
  assert.equal(ui.field('coders-concurrency').value, '2');
  assert.match(ui.text(), /独立工作区可并行/);
  await ui.enter('coders-concurrency', '3');
  await ui.enter('coders-security', 'strict');
  await ui.enter('coders-default', 'claude');
  await ui.enter('coders-roots', '/srv/a\n/srv/b');
  await ui.enter('codex-source', 'system');
  await ui.enter('codex-model', 'gpt-x');
  await ui.enter('codex-key', 'codex-typed-secret');
  await ui.enter('claude-endpoint', 'https://api.deepseek.com/anthropic');
  await ui.enter('claude-model', 'deepseek-flash');
  await ui.enter('claude-token', 'claude-typed-secret');
  await ui.submit();
  const save = calls.find(call => call.method === 'save')!;
  assert.equal(save.payload.revision, 0);
  assert.deepEqual(save.payload.config.defaultCoder, 'claude');
  assert.equal(save.payload.config.securityMode, 'strict');
  assert.equal(save.payload.config.maxConcurrent, 3);
  assert.equal(save.payload.config.roots, '/srv/a\n/srv/b');
  assert.deepEqual(save.payload.config.codex, { source: 'system', model: 'gpt-x', baseUrl: '', wireApi: 'responses', apiKey: 'codex-typed-secret' });
  assert.deepEqual(save.payload.config.claude, { source: 'managed', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', authHeader: 'auth-token', token: 'claude-typed-secret' });
  assert.equal((ui.field('codex-key') as HTMLInputElement).value, '');
  assert.equal((ui.field('claude-token') as HTMLInputElement).value, '');
  assert.equal(ui.field('coders-concurrency').value, '3');
  assert.equal((ui.field('codex-key') as HTMLInputElement).placeholder, '已保存，留空保留当前密钥');
  await ui.submit();
  const second = calls.filter(call => call.method === 'save').at(-1)!;
  assert.equal(second.payload.revision, 1);
  assert.equal(second.payload.config.maxConcurrent, 3);
  assert.equal('apiKey' in second.payload.config.codex, false, 'an untouched secret field is not resent');
  await ui.click('安装托管版本');
  assert.deepEqual(calls.at(-1), { method: 'install', payload: { coder: 'codex' } });
  assert.match(ui.text(), /Codex 托管安装：进行中/);
  await ui.click('删除');
  assert.deepEqual(calls.at(-1), { method: 'rules/remove', payload: { id: 'cr-1' } });
  assert.match(ui.text(), /还没有习惯规则/);
  await ui.click('清除 token');
  assert.deepEqual(calls.at(-1), { method: 'clear-secret', payload: { coder: 'claude', revision: 2 } });
});

test('managed install gives immediate local feedback then polls stage, logs and completion', async t => {
  let view = initial();
  let confirm!: (view: CodersView) => void;
  const request = new Promise<CodersView>(resolve => { confirm = resolve; });
  const installs: unknown[] = [];
  const ui = await page(t, async (method, payload) => {
    if (method === 'install') { installs.push(payload); return request; }
    return structuredClone(view);
  });
  const codex = [...ui.dom.window.document.querySelectorAll('article')].find(card => card.querySelector('h3')?.textContent === 'Codex')!;
  const claude = [...ui.dom.window.document.querySelectorAll('article')].find(card => card.querySelector('h3')?.textContent === 'Claude Code')!;
  await ui.click('安装托管版本');
  assert.match(codex.textContent!, /正在启动 Codex 托管安装/);
  assert.equal((codex.querySelector('footer button') as HTMLButtonElement).textContent, '正在启动安装…');
  assert.equal((claude.querySelector('footer button') as HTMLButtonElement).disabled, true);
  assert.match(claude.querySelector('footer button')!.textContent!, /请先等待 Codex 安装结束/);
  assert.match(claude.textContent!, /不会自动排队/);
  view = { ...view, install: { coder: 'codex', phase: 'installing', stage: 'packages', startedAt: Date.now() - 65_000, log: '' } };
  await act(async () => confirm(structuredClone(view)));
  assert.match(codex.textContent!, /安装依赖/);
  assert.match(codex.textContent!, /已用时 1 分/);
  assert.match(codex.textContent!, /暂时没有新日志/);
  assert.equal(codex.querySelector('progress')?.hasAttribute('value'), false, 'download totals are unknown');
  assert.equal(claude.querySelector('progress'), null);
  assert.equal((codex.querySelector('footer button') as HTMLButtonElement).textContent, '正在安装…');
  await act(async () => { (claude.querySelector('footer button') as HTMLButtonElement).click(); });
  assert.deepEqual(installs, [{ coder: 'codex' }], 'disabled controls must not enqueue a second installer');
  view.install = { ...view.install!, stage: 'verifying', lastOutputAt: Date.now(), log: 'npm http fetch GET 200 https://registry.npmjs.org/@openai/codex 100ms\nadded 2 packages\n' };
  await act(async () => { await delay(1700); });
  assert.match(codex.textContent!, /检查程序文件/);
  assert.match(codex.querySelector('details pre')!.textContent!, /added 2 packages/);
  assert.match(codex.querySelector('details pre')!.textContent!, /https:\/\/registry.npmjs.org\/@openai\/codex/);
  view.install = { ...view.install!, phase: 'installed', finishedAt: Date.now() };
  view.codex.managed = { installed: true, version: '0.155.1' };
  await act(async () => { await delay(1700); });
  assert.match(codex.textContent!, /Codex 托管安装：已完成/);
  assert.match(codex.textContent!, /总用时/);
  assert.equal(codex.querySelector('progress'), null);
  assert.equal((codex.querySelector('footer button') as HTMLButtonElement).disabled, false);
  assert.match(codex.querySelector('footer button')!.textContent!, /重新安装托管版本/);
  assert.ok(codex.querySelector('details'), 'logs remain available after success');
  assert.equal((claude.querySelector('footer button') as HTMLButtonElement).disabled, false);
  assert.equal(claude.querySelector('footer button')!.textContent, '安装托管版本');
  assert.doesNotMatch(claude.textContent!, /不会自动排队/);
  assert.deepEqual(installs, [{ coder: 'codex' }], 'the second tool still requires an explicit click');
});

test('reopening settings shows an existing Claude install, refresh failures and timeout with retry', async t => {
  let failRead = false;
  let view: CodersView = { ...initial(), install: { coder: 'claude', phase: 'installing', stage: 'packages', startedAt: Date.now() - 40_000, lastOutputAt: Date.now() - 35_000, log: '' } };
  const ui = await page(t, async () => {
    if (failRead) throw new Error('connection_failed');
    return structuredClone(view);
  });
  const panel = () => ui.dom.window.document.querySelector('[aria-label="Claude Code 托管安装状态"]')!;
  assert.match(panel().textContent!, /安装依赖/);
  assert.match(panel().textContent!, /最近输出在/);
  const codex = [...ui.dom.window.document.querySelectorAll('article')].find(card => card.querySelector('h3')?.textContent === 'Codex')!;
  assert.match(codex.querySelector('footer button')!.textContent!, /请先等待 Claude Code 安装结束/);
  failRead = true;
  await act(async () => { await delay(1700); });
  assert.match(panel().textContent!, /安装状态暂时无法刷新/);
  failRead = false;
  view.install = { ...view.install!, phase: 'failed', finishedAt: Date.now(), error: 'install_timeout', log: 'npm error ETIMEDOUT\n' };
  await act(async () => { await delay(1700); });
  assert.match(panel().querySelector('[role=alert]')!.textContent!, /下载或安装超时/);
  assert.match(panel().textContent!, /ETIMEDOUT/);
  assert.doesNotMatch(panel().textContent!, /暂时无法刷新|install_timeout/);
  assert.equal(panel().querySelector('progress'), null);
  const button = panel().closest('article')!.querySelector('footer button') as HTMLButtonElement;
  assert.equal(button.disabled, false);
  assert.equal((codex.querySelector('footer button') as HTMLButtonElement).disabled, false);
  assert.equal(codex.querySelector('footer button')!.textContent, '安装托管版本');
});

test('a rejected install request gives feedback next to its button and releases the starting state', async t => {
  const ui = await page(t, async method => {
    if (method === 'install') throw new Error('connection_failed');
    return initial();
  });
  await ui.click('安装托管版本');
  const card = [...ui.dom.window.document.querySelectorAll('article')].find(item => item.querySelector('h3')?.textContent === 'Codex')!;
  assert.match(card.textContent!, /安装请求未能确认/);
  assert.doesNotMatch(card.textContent!, /正在启动安装/);
  assert.equal((card.querySelector('footer button') as HTMLButtonElement).disabled, false);
});

test('download UI shows measured speed and bytes, unknown totals, cached data and a useful network failure', async t => {
  let view: CodersView = { ...initial(), install: { coder: 'codex', phase: 'installing', stage: 'downloading', startedAt: Date.now(),
    timeoutMs: 60 * 60_000, log: '', download: { package: '@openai/codex@0.155.1-win32-x64', state: 'downloading',
      bytes: 1024 * 1024, total: 4 * 1024 * 1024, bytesPerSecond: 64 * 1024, attempt: 1, source: 'https://registry.npmjs.org/@openai/codex' } } };
  const ui = await page(t, async () => structuredClone(view));
  const panel = () => ui.dom.window.document.querySelector('[aria-label="Codex 托管安装状态"]')!;
  assert.match(panel().textContent!, /下载速度：64.0 KB\/s/);
  assert.match(panel().textContent!, /已下载 1.0 MB \/ 4.0 MB · 25%/);
  assert.match(panel().textContent!, /下载来源：https:\/\/registry.npmjs.org/);
  assert.equal(panel().querySelector('progress')?.getAttribute('value'), String(1024 * 1024));
  view.install!.download = { ...view.install!.download!, total: undefined, bytesPerSecond: 0 };
  await act(async () => { await delay(1700); });
  assert.match(panel().textContent!, /0.0 KB\/s（等待数据）/);
  assert.match(panel().textContent!, /总大小暂未知/);
  assert.equal(panel().querySelector('progress')?.hasAttribute('value'), false);
  view.install!.download = { ...view.install!.download!, state: 'cached' };
  await act(async () => { await delay(1700); });
  assert.match(panel().textContent!, /读取本地缓存/);
  assert.doesNotMatch(panel().textContent!, /下载速度/);
  view.install = { ...view.install!, phase: 'failed', error: 'ECONNRESET', finishedAt: Date.now() };
  await act(async () => { await delay(1700); });
  assert.match(panel().textContent!, /下载连接被重置/);
  assert.doesNotMatch(panel().textContent!, /下载速度|ECONNRESET/);
});

test('a settings revision changed elsewhere blocks saving until the page reloads', async t => {
  let view = initial();
  let reads = 0;
  const api: CoderApi = async method => {
    // The first read seeds the draft; a later read reports a revision saved from another window.
    if (method === 'list' && ++reads >= 2) view = { ...view, settings: { ...view.settings, revision: 5 } };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  await ui.enter('codex-model', 'gpt-y');
  await act(async () => { await delay(1700); });
  assert.match(ui.text(), /配置已在其他窗口修改/);
  const save = [...ui.dom.window.document.querySelectorAll('button')].find(item => item.textContent === '保存设置') as HTMLButtonElement;
  assert.equal(save.disabled, true);
  await ui.click('重新载入');
  assert.equal(save.disabled, false);
});
