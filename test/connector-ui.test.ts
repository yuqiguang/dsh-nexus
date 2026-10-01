import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { ConnectorSettings, type ConnectorApi } from '../src/client/ConnectorSettings.js';
import type { ConnectorsView } from '../src/connectors/index.js';

const initial = (): ConnectorsView => ({
  settings: { revision: 0, mail: { enabled: false, address: '', imapHost: '', imapPort: 993, imapSecure: true, smtpHost: '', smtpPort: 465, smtpSecure: true, pollSeconds: 60, allowRecipients: [], passwordConfigured: false },
    agenda: { enabled: true, remindMinutes: 15, todoReminderTime: '09:00' } },
  mail: { phase: 'disabled', toolsRegistered: false, watches: [] },
  agenda: { toolsRegistered: true, events: 0, openTodos: 0, upcoming: [], todos: [] },
});

async function page(t: TestContext, api: ConnectorApi) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  await act(async () => root.render(createElement(ConnectorSettings, { api })));
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
  const toggle = async (id: string) => { await act(async () => { (field(id) as HTMLInputElement).click(); }); };
  const click = async (label: string) => {
    const button = [...dom.window.document.querySelectorAll('button')].find(item => item.textContent === label);
    assert.ok(button, `button ${label} missing`);
    await act(async () => { button.click(); });
  };
  return { dom, field, enter, toggle, click, text: () => dom.window.document.body.textContent ?? '' };
}

test('the connector page fills a provider preset, tests the draft, saves without resending an untouched password, and lists watches', async t => {
  let view = initial();
  const calls: { method: string; payload: any }[] = [];
  const api: ConnectorApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'mail/test') return { ...view, mailTest: { at: 1, exists: 12, unseen: 3 } };
    if (method === 'save') view = { ...view, settings: { ...view.settings, revision: view.settings.revision + 1, mail: { ...view.settings.mail, ...payload.config.mail, imapPort: Number(payload.config.mail.imapPort), smtpPort: Number(payload.config.mail.smtpPort), pollSeconds: Number(payload.config.mail.pollSeconds), allowRecipients: payload.config.mail.allowRecipients.split('\n').filter(Boolean), passwordConfigured: true } },
      mail: { phase: 'connecting', toolsRegistered: true, watches: [{ id: 'mw-1', description: '有房东的邮件时提醒我', keywords: ['房东'], createdAt: 1 }] } };
    if (method === 'mail/watch/remove') view = { ...view, mail: { ...view.mail, watches: [] } };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  assert.match(ui.text(), /未启用/);
  await ui.enter('mail-preset', 'qq');
  assert.equal((ui.field('mail-imap-host') as HTMLInputElement).value, 'imap.qq.com');
  assert.equal((ui.field('mail-smtp-port') as HTMLInputElement).value, '465');
  assert.match(ui.text(), /授权码/);
  await ui.enter('mail-address', 'me@qq.com');
  await ui.enter('mail-password', 'code123');
  await ui.toggle('mail-enabled');
  await ui.click('测试连接');
  assert.equal(calls.at(-1)!.method, 'mail/test');
  assert.deepEqual([calls.at(-1)!.payload.config.mail.address, calls.at(-1)!.payload.config.mail.password, calls.at(-1)!.payload.config.mail.enabled], ['me@qq.com', 'code123', true]);
  assert.match(ui.text(), /测试连接成功.*收件箱 12 封，未读 3/);
  await act(async () => { ui.field('mail-address').closest('form')!.dispatchEvent(new ui.dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
  assert.equal(calls.at(-1)!.method, 'save');
  assert.deepEqual([calls.at(-1)!.payload.revision, calls.at(-1)!.payload.config.mail.password, calls.at(-1)!.payload.config.mail.imapHost], [0, 'code123', 'imap.qq.com']);
  assert.match(ui.text(), /连接中/);
  assert.match(ui.text(), /邮件工具已加入模型的工具集/);
  assert.match(ui.text(), /mw-1 有房东的邮件时提醒我（关键词：房东）/);
  assert.equal((ui.field('mail-password') as HTMLInputElement).placeholder, '已保存，留空保留当前密码');
  // A second save without touching the password does not send one.
  await ui.enter('mail-name', '老于');
  await act(async () => { ui.field('mail-address').closest('form')!.dispatchEvent(new ui.dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
  assert.equal(calls.at(-1)!.payload.config.mail.password, undefined);
  assert.equal(calls.at(-1)!.payload.config.mail.name, '老于');
  await ui.click('删除');
  assert.deepEqual(calls.at(-1), { method: 'mail/watch/remove', payload: { id: 'mw-1' } });
  assert.match(ui.text(), /还没有邮件提醒/);
  await ui.click('清除密码并停用');
  assert.equal(calls.at(-1)!.method, 'clear-secret');
});

test('a failed test explains the error and keeps the draft', async t => {
  const api: ConnectorApi = async method => { if (method === 'mail/test') throw new Error('mail_auth_failed'); return initial(); };
  const ui = await page(t, api);
  await ui.enter('mail-address', 'me@qq.com');
  await ui.click('测试连接');
  assert.match(ui.text(), /邮箱拒绝了登录/);
  assert.equal((ui.field('mail-address') as HTMLInputElement).value, 'me@qq.com');
});

test('the agenda section saves its settings with the mail ones and lists, completes and removes what the assistant keeps', async t => {
  let view = initial();
  view = { ...view, agenda: { ...view.agenda, events: 2, openTodos: 1, nextReminderAt: Date.parse('2026-09-22T14:45:00+08:00'),
    upcoming: [{ id: 'ev-1', title: '和张老师开会', start: Date.parse('2026-09-22T15:00:00+08:00'), end: Date.parse('2026-09-22T16:00:00+08:00'), location: '会议室' }],
    todos: [{ id: 'td-1', title: '交报告', due: Date.parse('2026-09-25T00:00:00+08:00'), dueAllDay: true, createdAt: 1 }] } };
  const calls: { method: string; payload: any }[] = [];
  const api: ConnectorApi = async (method, payload: any) => {
    calls.push({ method, payload });
    if (method === 'agenda/todo/done') view = { ...view, agenda: { ...view.agenda, openTodos: 0, todos: [{ ...view.agenda.todos[0]!, doneAt: 5 }] } };
    if (method === 'agenda/event/remove') view = { ...view, agenda: { ...view.agenda, events: 1, upcoming: [] } };
    if (method === 'save') view = { ...view, settings: { ...view.settings, revision: 1, agenda: { enabled: payload.config.agenda.enabled, remindMinutes: Number(payload.config.agenda.remindMinutes), todoReminderTime: payload.config.agenda.todoReminderTime } } };
    return structuredClone(view);
  };
  const ui = await page(t, api);
  assert.match(ui.text(), /日程 2 条，未完成待办 1 条/);
  assert.match(ui.text(), /和张老师开会 @ 会议室/);
  assert.match(ui.text(), /交报告（9\/25 前）/);
  await ui.click('完成');
  assert.deepEqual(calls.at(-1), { method: 'agenda/todo/done', payload: { id: 'td-1', done: true } });
  assert.match(ui.text(), /撤销完成/);
  await ui.click('删除');
  assert.deepEqual(calls.at(-1), { method: 'agenda/event/remove', payload: { id: 'ev-1' } });
  assert.match(ui.text(), /没有日程/);
  await ui.enter('agenda-remind', '30');
  await ui.enter('agenda-todo-time', '08:30');
  await act(async () => { ui.field('agenda-remind').closest('form')!.dispatchEvent(new ui.dom.window.SubmitEvent('submit', { bubbles: true, cancelable: true })); });
  assert.equal(calls.at(-1)!.method, 'save');
  assert.deepEqual(calls.at(-1)!.payload.config.agenda, { enabled: true, remindMinutes: '30', todoReminderTime: '08:30' });
  assert.ok(calls.at(-1)!.payload.config.mail, 'the mail settings travel in the same save');
});
