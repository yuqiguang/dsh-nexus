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

async function page(t: TestContext, api: CoderApi) {
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
  await act(async () => root.render(createElement(CoderSettings, { api })));
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
  assert.deepEqual([...ui.dom.window.document.querySelectorAll('h3')].map(item => item.textContent), ['通用', 'Codex', 'Claude Code', '习惯规则', '最近任务']);
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
