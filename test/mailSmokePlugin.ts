/**
 * Real DSH with a loopback IMAP/SMTP server: the mail tools appear only while the account is on, `mail_send` to an unlisted
 * recipient goes through the native approval to the channel and the mail leaves after “允许”, a listed recipient needs no
 * approval, under full access the same send is asked about in the chat and leaves after “回答 1”, a watched arrival enters the session as an external event and the model's report is pushed, and turning the
 * account off takes the tools out of the model's tool set. Then the assistant's own agenda: calendar and todo tools by default,
 * a reminder pushed to the chat before an event, and the tools gone when the agenda is turned off.
 */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-host-webserver';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import { BridgeRegistry } from '../src/channels/notify.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { installBridge } from '../src/dsh/bridge.js';
import { installAssistantPrompt } from '../src/assistant/prompt.js';
import * as mailComponent from '../src/connectors/mail/plugin.js';
import { installConnectors } from '../src/plugin.js';
import { mailFixture, rfc822 } from './mailFixture.js';
import { until } from './helpers.js';

export const name = 'nexus-mail-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'systemPrompt',
  'credentials', 'storageDomain', 'connection', 'webServer', 'userQuestions'];
const owner = { channel: 'wechat' as const, accountId: 'wx-mail-bot', ownerId: 'wx-mail-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });

class FixtureModel extends LlmAdapter {
  calls = 0;
  toolSets: string[][] = [];
  /** The local wall-clock the fixture uses for "明天下午三点", set by the test. */
  tomorrowAt = '';
  nowAt = '';
  /** Whether the agenda section the model saw files a fixed-time repeat in the calendar. */
  sawDailyRule = false;
  fridayAt = '';
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local mail fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
  }
  private *toolCall(id: string, name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
  private *text(text: string): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    this.calls++;
    this.sawDailyRule ||= options.messages.some(message => message.role === 'system' && message.content.some(block => block.type === 'text' && block.text.includes('repeat 选 daily、weekly 或 monthly') && block.text.includes('不要用 schedule_create 一次一次地排下一次')));
    this.toolSets.push((options.tools ?? []).map(tool => tool.name).filter(name => name.startsWith('mail_') || name === 'calendar' || name === 'todo').sort());
    const textOf = (message: GenerateOptions['messages'][number]): string => message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
    const answered = (callId: string) => options.messages.some(message => message.role === 'tool' && message.toolCallId === callId);
    const result = (callId: string) => options.messages.filter(message => message.role === 'tool' && message.toolCallId === callId).map(textOf).join('\n');
    const asked = options.messages.findLast(message => message.source?.kind === 'user');
    const askedText = asked ? textOf(asked) : '';
    if (askedText.startsWith('[外部事件] 来源：mail')) {
      const line = askedText.split('\n').find(item => /^\[\d+\] /.test(item));
      yield* this.text(`新邮件：${line ?? '（没有摘要行）'}`);
      return;
    }
    if (askedText === '有什么邮件') {
      if (!answered('list')) { yield* this.toolCall('list', 'mail_list', {}); return; }
      yield* this.text(`收件箱：${result('list').split('\n')[0]}`); return;
    }
    if (askedText === '测试停用后批准') {
      if (!answered('stale-send')) { yield* this.toolCall('stale-send', 'mail_send', { to: ['stale@example.com'], subject: '旧请求', text: '不得发送' }); return; }
      yield* this.text(result('stale-send').includes('已发送') ? '错误：旧请求发出了' : '旧请求没有发送'); return;
    }
    if (askedText === '给房东回信说周二可以') {
      if (!answered('send')) { yield* this.toolCall('send', 'mail_send', { to: ['landlord@example.com'], subject: '回复：修水管', text: '周二上午可以。', reply_to_uid: 1 }); return; }
      yield* this.text(result('send').includes('已发送') ? '已回信给房东。' : `发送失败：${result('send')}`); return;
    }
    if (askedText === '给张老师发一封问候') {
      if (!answered('send2')) { yield* this.toolCall('send2', 'mail_send', { to: ['zhang@school.edu'], subject: '问候', text: '张老师好。' }); return; }
      yield* this.text(result('send2').includes('已发送') ? '已发给张老师。' : `发送失败：${result('send2')}`); return;
    }
    if (askedText === '给王老板回信说报价收到了') {
      if (!answered('send3')) { yield* this.toolCall('send3', 'mail_send', { to: ['boss@example.com'], subject: '回复：报价', text: '报价收到，下周答复。', attachments: ['outputs/报价单.txt'] }); return; }
      yield* this.text(result('send3').includes('已发送') ? '已回信给王老板。' : `发送失败：${result('send3')}`); return;
    }
    if (askedText === '明天下午三点和张老师开会') {
      if (!answered('cal')) { yield* this.toolCall('cal', 'calendar', { action: 'add', title: '和张老师开会', start: this.tomorrowAt, location: '会议室' }); return; }
      yield* this.text(result('cal').startsWith('已安排') ? '记下了，明天下午三点和张老师开会。' : `没记上：${result('cal')}`); return;
    }
    if (askedText === '记个待办，周五前交报告') {
      if (!answered('todo')) { yield* this.toolCall('todo', 'todo', { action: 'add', title: '交报告', due: this.fridayAt }); return; }
      yield* this.text(result('todo').startsWith('已记下') ? '好，周五前交报告。' : `没记上：${result('todo')}`); return;
    }
    if (askedText === '每天这个时候叫我起床') {
      if (!answered('wake')) { yield* this.toolCall('wake', 'calendar', { action: 'add', title: '该起床了', start: this.nowAt, duration_minutes: 0, remind_minutes: 0, repeat: 'daily' }); return; }
      yield* this.text(result('wake').startsWith('已安排') ? '好，每天这个时候叫你。' : `没记上：${result('wake')}`); return;
    }
    if (askedText === '今天有什么安排') {
      if (!answered('agenda')) { yield* this.toolCall('agenda', 'calendar', { action: 'list' }); return; }
      yield* this.text(`今天：${result('agenda')}`); return;
    }
    if (askedText === '有房东的邮件时提醒我') {
      if (!answered('watch')) { yield* this.toolCall('watch', 'mail_watch', { action: 'add', description: '有房东的邮件时提醒我', keywords: ['房东', 'landlord'] }); return; }
      yield* this.text('好，房东来信我会告诉你。'); return;
    }
    yield* this.text('收到。');
  }
}

export async function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): Promise<void> {
  const model = new FixtureModel();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  installAssistantPrompt(ctx);
  const texts: string[] = [];
  const failures: string[] = [];
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const registry = new BridgeRegistry();
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  registry.add(bridge);
  const fixture = await mailFixture();
  ctx.effect(() => () => { void fixture.close(); });
  const connectors = await installConnectors(ctx, registry, { notifier: registry, timeZone: () => 'Asia/Shanghai', report: message => failures.push(`mail: ${message}`), imap: { insecure: true, timeoutMs: 5000 } });
  ctx.provide('nexusConnectors', connectors);
  let mailFiber = ctx.plugin(mailComponent);
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts, toolSets: model.toolSets, sent: fixture.sent.map(item => item.to) }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    await until(() => connectors.view().modules?.mail === true, 'native mail component did not activate');
    const origin = `http://127.0.0.1:${ctx.webServer.port}`;
    const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' });
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const rpc = async (method: string, payload: object = {}) => {
      const response = await fetch(`${origin}/api/nexus-connectors/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify({ type: 'client-request', rpcId: 'mail-smoke', method, payload }) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.result.ok, true, body.result.error?.code);
      return body.result.value as { settings: { revision: number; mail: { enabled: boolean; passwordConfigured: boolean } }; mail: { phase: string; toolsRegistered: boolean; lastUid?: number; watches: { id: string }[] }; mailTest?: { exists: number } };
    };
    const anonymous = await fetch(`${origin}/api/nexus-connectors/list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'list', payload: {} }) });
    assert.equal(anonymous.status, 401);
    const turn = async (messageId: string, text: string) => {
      await bridge.receive(inbound(messageId, text));
      await ctx.agents.get(sessionId)!.whenIdle();
      await bridge.drain();
    };
    // Before the account exists the model has no mail tools; the agenda is on by default, and its prompt section tells the model what time it is.
    await turn('m0', '你好');
    assert.deepEqual(model.toolSets.at(-1), ['calendar', 'todo']);
    fixture.add(rfc822({ from: '房东 <landlord@example.com>', subject: '修水管', body: '周二上午来修，行吗？' }));
    const draft = { address: 'user@example.com', imapHost: '127.0.0.1', imapPort: fixture.imapPort, imapSecure: false, smtpHost: '127.0.0.1', smtpPort: fixture.smtpPort, smtpSecure: false, password: 'app-password', pollSeconds: 30, allowRecipients: '@school.edu' };
    let view = await rpc('mail/test', { revision: 0, config: { mail: draft } });
    assert.equal(view.mailTest?.exists, 1);
    view = await rpc('save', { revision: 0, config: { mail: { ...draft, enabled: true } } });
    assert.deepEqual([view.settings.revision, view.settings.mail.passwordConfigured, view.mail.toolsRegistered], [1, true, true]);
    await until(async () => (await rpc('list')).mail.phase === 'connected', 'mailbox poller did not connect', 10_000);
    assert.equal((await rpc('list')).mail.lastUid, 1, 'the existing mail is only marked');
    // The tools are in the model's set now, and mail_list reads the fixture.
    await turn('m1', '有什么邮件');
    assert.deepEqual(model.toolSets.at(-1), ['calendar', 'mail_allow', 'mail_list', 'mail_read', 'mail_search', 'mail_send', 'mail_watch', 'todo']);
    assert.match(texts.at(-1)!, /^收件箱：\[1\] .*房东 <landlord@example.com>｜修水管｜周二上午来修，行吗？/);
    // Sending to the landlord is not on the allow list: the native approval reaches the channel; the mail only leaves after 允许.
    void bridge.receive(inbound('m2', '给房东回信说周二可以')).catch(() => {});
    await until(() => texts.some(text => text.includes('需要你确认后继续') && text.includes('发邮件给 landlord@example.com，主题「回复：修水管」')), 'send approval was not sent to the channel', 10_000);
    assert.equal(fixture.sent.length, 0, 'nothing leaves before approval');
    await new Promise<void>(resolve => setImmediate(resolve));
    await bridge.receive(inbound('m3', '允许'));
    await ctx.agents.get(sessionId)!.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '已回信给房东。');
    assert.equal(fixture.sent.length, 1);
    assert.deepEqual(fixture.sent[0]!.to, ['landlord@example.com']);
    assert.match(fixture.sent[0]!.data, /^In-Reply-To: <[^>]+>$/m);
    const events = ctx.agents.get(sessionId)!.session.snapshotEvents();
    assert.ok(events.some(event => event.type === 'approval/asked' && event.data.toolName === 'mail_send'));
    assert.ok(events.some(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once'));
    // A listed recipient needs no approval.
    const prompts = texts.filter(text => text.includes('需要你确认后继续')).length;
    await turn('m4', '给张老师发一封问候');
    assert.equal(texts.at(-1), '已发给张老师。');
    assert.equal(texts.filter(text => text.includes('需要你确认后继续')).length, prompts);
    assert.equal(fixture.sent.length, 2);
    // Full access: under `never` DSH rejects an approval without asking anyone, so the gate asks in the chat instead,
    // and the mail leaves only after the answer.
    const agent = ctx.agents.get(sessionId)!;
    setApprovalPolicy(agent.session, 'never');
    // With an attachment from the session's workspace, which the confirmation names.
    await mkdir(join(config.workspace, 'outputs'), { recursive: true });
    await writeFile(join(config.workspace, 'outputs', '报价单.txt'), '单价 12 元');
    void bridge.receive(inbound('m4b', '给王老板回信说报价收到了')).catch(() => {});
    await until(() => texts.some(text => text.includes('发邮件前确认') && text.includes('发邮件给 boss@example.com，主题「回复：报价」，附件 报价单.txt（13 B）？')),
      'the full-access send confirmation was not asked in the channel', 10_000);
    assert.ok(texts.at(-1)!.includes('3. 允许并记住'), texts.at(-1));
    assert.equal(fixture.sent.length, 2, 'nothing leaves before the answer');
    assert.equal(texts.filter(text => text.includes('需要你确认后继续')).length, prompts, 'no native approval prompt under never');
    await new Promise<void>(resolve => setImmediate(resolve));
    await bridge.receive(inbound('m4c', '回答 1'));
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(texts.at(-1), '已回信给王老板。');
    assert.equal(fixture.sent.length, 3);
    assert.deepEqual(fixture.sent[2]!.to, ['boss@example.com']);
    const withAttachment = await simpleParser(fixture.sent[2]!.data);
    assert.deepEqual(withAttachment.attachments.map(file => [file.filename, file.content.toString()]), [['报价单.txt', '单价 12 元']]);
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'approval/asked').length, 1, 'only the first send went through DSH approval');
    setApprovalPolicy(agent.session, 'ask');
    // A watch, then an arrival that matches: the poller injects it as an external event and the model's report is pushed.
    await turn('m5', '有房东的邮件时提醒我');
    assert.equal(texts.at(-1), '好，房东来信我会告诉你。');
    assert.equal((await rpc('list')).mail.watches.length, 1);
    fixture.add(rfc822({ from: 'Alice <alice@example.com>', subject: '不相关', body: 'x' }));
    fixture.add(rfc822({ from: '房东 <landlord@example.com>', subject: '改到周三', body: '周三上午来。' }));
    // Ask the poller now rather than waiting for its interval: the same path the timer takes.
    const connector = (connectors as unknown as { mail: { checkOnce(): Promise<{ notified: number }> } }).mail;
    const pass = await connector.checkOnce();
    assert.equal(pass.notified, 1, 'only the watched arrival becomes an event');
    await until(() => texts.some(text => text.startsWith('新邮件：[3] ')), 'arrival report was not pushed', 15_000);
    assert.match(texts.at(-1)!, /^新邮件：\[3\] .*房东 <landlord@example.com>｜改到周三/);
    assert.ok(!texts.some(text => text.includes('不相关')));
    assert.equal((await rpc('list')).mail.lastUid, 3);
    // DSH's native approval can outlive component disposal. Re-resolving the newly
    // registered tool after approval must not send the old request.
    setApprovalPolicy(agent.session, 'ask');
    const askedBefore = texts.filter(text => text.includes('需要你确认后继续')).length;
    void bridge.receive(inbound('mail-stale', '测试停用后批准')).catch(() => {});
    await until(() => texts.filter(text => text.includes('需要你确认后继续')).length > askedBefore, 'stale send approval missing');
    const sentBefore = fixture.sent.length;
    const savedBefore = (await rpc('list')).settings;
    await mailFiber.dispose();
    assert.equal(connectors.view().modules?.mail, false);
    assert.ok(!ctx.tools.get('mail_send'));
    assert.deepEqual((await rpc('list')).settings, savedBefore);
    assert.equal((await rpc('list')).mail.watches.length, 1);
    mailFiber = ctx.plugin(mailComponent);
    await until(() => !!ctx.tools.get('mail_send'), 'mail component did not reactivate');
    await bridge.receive(inbound('mail-stale-approve', '允许'));
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(fixture.sent.length, sentBefore);
    assert.match(texts.at(-1)!, /旧请求没有发送/);
    assert.equal((await rpc('list')).mail.watches.length, 1);
    // Off: the tools leave the model's set on the next call.
    view = await rpc('clear-secret', { revision: (await rpc('list')).settings.revision });
    assert.deepEqual([view.settings.mail.enabled, view.mail.toolsRegistered], [false, false]);
    await turn('m6', '你好');
    assert.deepEqual(model.toolSets.at(-1), ['calendar', 'todo']);
    // The agenda: an event for tomorrow, a todo for Friday, the day's list, and a reminder pushed to the chat before an event.
    const local = (at: number) => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at); const g = (t: string) => p.find(x => x.type === t)!.value; return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`; };
    const tomorrow = local(Date.now() + 24 * 3_600_000).slice(0, 10);
    model.tomorrowAt = `${tomorrow} 15:00`;
    model.fridayAt = local(Date.now() + 4 * 24 * 3_600_000).slice(0, 10);
    await turn('m7', '明天下午三点和张老师开会');
    assert.equal(texts.at(-1), '记下了，明天下午三点和张老师开会。');
    await turn('m8', '记个待办，周五前交报告');
    assert.equal(texts.at(-1), '好，周五前交报告。');
    const agendaView = await rpc('list') as unknown as { agenda: { events: number; openTodos: number; upcoming: { title: string }[]; todos: { title: string }[] } };
    assert.deepEqual([agendaView.agenda.events, agendaView.agenda.openTodos, agendaView.agenda.upcoming[0]?.title, agendaView.agenda.todos[0]?.title], [1, 1, '和张老师开会', '交报告']);
    // An event starting in ten minutes with the default 15-minute lead is due now; one tick pushes it to the chat, a second does not repeat it.
    const agenda = (connectors as unknown as { agenda: { addEvent(input: object): Promise<unknown>; tick(): Promise<number> } }).agenda;
    await agenda.addEvent({ title: '十分钟后的事', start: local(Date.now() + 10 * 60_000) });
    assert.equal(await agenda.tick(), 1);
    assert.match(texts.at(-1)!, /^日程提醒：(9|10) 分钟后（.*）十分钟后的事。$/);
    assert.equal(await agenda.tick(), 0);
    // A fixed-time daily reminder goes into the calendar as a point in time reminded at the moment itself; the loop pushes it, once.
    model.nowAt = local(Date.now());
    await turn('m8b', '每天这个时候叫我起床');
    assert.equal(texts.at(-1), '好，每天这个时候叫你。');
    assert.ok(model.sawDailyRule, 'the agenda section tells the model to file a fixed-time repeat in the calendar');
    assert.equal(await agenda.tick(), 1);
    assert.match(texts.at(-1)!, /^日程提醒：现在（.*）该起床了。$/);
    assert.equal(await agenda.tick(), 0);
    await turn('m9', '今天有什么安排');
    assert.match(texts.at(-1)!, /^今天：[\s\S]*十分钟后的事/);
    assert.doesNotMatch(texts.at(-1)!, /和张老师开会/, 'tomorrow is not in today');
    // Turning the agenda off removes its tools too.
    view = await rpc('save', { revision: (await rpc('list')).settings.revision, config: { agenda: { enabled: false } } });
    await turn('m10', '你好');
    assert.deepEqual(model.toolSets.at(-1), []);
    assert.equal(await ctx.sessions.flush(ctx.agents.get(sessionId)!.session), true);
    assert.deepEqual(failures, []);
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
      checks: ['connector_settings_requires_login', 'mail_tools_absent_until_enabled', 'mail_test_and_save_through_routes', 'mail_list_reads_inbox',
        'mail_send_to_unlisted_recipient_asks_on_channel', 'approval_releases_smtp_send_in_thread', 'listed_recipient_sends_without_approval', 'full_access_send_asks_in_chat_and_sends_after_answer', 'attachment_named_in_confirmation_and_sent_from_workspace',
        'watched_arrival_enters_session_as_event', 'unwatched_arrival_stays_silent', 'clearing_secret_removes_tools', 'native_mail_dispose_preserves_account_and_watches', 'old_native_approval_cannot_send_after_reenable',
        'agenda_tools_present_by_default', 'calendar_add_and_todo_add_through_model', 'agenda_view_through_routes', 'event_reminder_pushed_once', 'daily_point_reminder_filed_by_model_and_pushed_at_its_moment', 'calendar_list_today', 'disabling_agenda_removes_tools'] }, null, 2));
  }
}
