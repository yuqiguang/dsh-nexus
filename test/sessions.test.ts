import { channelWorkFixture } from './channel-work-fixture.js';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import { DshChannelBridge } from '../src/dsh/bridge.js';
import { baseSessionOf, parseCommand, sessionIdAt, sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { AssistantSettingsStore } from '../src/assistant/settings.js';
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import { MemoryRecords } from './helpers.js';
import { DEFAULT_ROTATION, DIGEST_LIMITS, ROTATION_NOTICES, SessionRoster, adoptionNotice, conversationDay, contextGrowthTokens, rotationDue, sessionDigest, sessionsDomain, userTurns, type SessionsDomain } from '../src/sessions/index.js';

const ZONE = 'Asia/Shanghai';
const T0 = Date.parse('2026-09-21T10:00:00+08:00');
const HOUR = 3_600_000;

function fakeRoster() {
  const records = new Map<string, unknown>();
  const table = { get: (key: string) => records.get(key), async put(key: string, value: unknown) { records.set(key, structuredClone(value)); } };
  const domain = { name: sessionsDomain.name, table: () => table, async close() {} } as unknown as SessionsDomain;
  return { opener: { async open() { return domain; } }, records };
}

let seq = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ev = (type: string, data: unknown, time = T0): any => ({ type, data, seq: seq++, time });
const userTurn = (turn: number, text: string, reply: string, time: number, usage?: { inputTokens: number; cacheReadTokens?: number }) => [
  ev('turn/start', { turn }, time),
  ev('user/message', { id: `u${turn}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, time),
  ev('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: reply }] }, ...(usage ? { usage: { outputTokens: 10, ...usage } } : {}) }, time + 1000),
  ev('turn/end', { turn, reason: { kind: 'completed' } }, time + 1000),
];

const pushedTurn = (turn: number, text: string, reply: string, time: number) =>
  userTurn(turn, text, reply, time).map(event => event.type === 'user/message'
    ? { ...event, data: { ...event.data, source: { kind: 'plugin', plugin: 'jobs' } } } : event);

test('session ids carry a generation and fold back to their base; /new is a command', () => {
  const base = sessionIdFor('acc', 'owner', 'owner', 'wechat');
  assert.equal(sessionIdAt(base, 0), base);
  assert.equal(sessionIdAt(base, 3), `${base}-3`);
  assert.equal(baseSessionOf(`${base}-3`), base);
  assert.equal(baseSessionOf(base), base);
  assert.equal(baseSessionOf('session-abc-3'), 'session-abc-3', 'local sessions are not touched');
  assert.deepEqual(parseCommand('/new'), { kind: 'new' });
  assert.equal(parseCommand('新会话'), undefined);
  assert.equal(parseCommand('新会话是什么'), undefined);
});

test('rotation is due on a new conversation day (04:00 boundary) or when the conversation grew past the token limit', () => {
  assert.equal(conversationDay(Date.parse('2026-09-22T03:59:00+08:00'), ZONE), '2026-09-21', 'a chat at 3 am still belongs to the evening before');
  assert.equal(conversationDay(Date.parse('2026-09-22T04:00:00+08:00'), ZONE), '2026-09-22');
  const settings = DEFAULT_ROTATION;
  assert.equal(rotationDue([], T0 + 48 * HOUR, ZONE, settings), undefined, 'a session without a user turn is kept');
  const yesterday = userTurn(1, '你好', '你好', T0);
  assert.equal(rotationDue(yesterday, T0 + 2 * HOUR, ZONE, settings), undefined);
  assert.equal(rotationDue(yesterday, Date.parse('2026-09-22T03:00:00+08:00'), ZONE, settings), undefined, 'still the same conversation day before 04:00');
  assert.equal(rotationDue(yesterday, Date.parse('2026-09-22T09:00:00+08:00'), ZONE, settings), 'day');
  assert.equal(rotationDue(yesterday, Date.parse('2026-09-22T09:00:00+08:00'), ZONE, { daily: false, contextTokens: 60_000 }), undefined);
  // The fixed overhead — system prompt and tool schemas, re-sent every turn — is what the opening turn measures, so it is the baseline.
  const opening = { inputTokens: 500, cacheReadTokens: 16_000 };
  const grown = [...userTurn(1, '看看', '好', T0, opening), ...userTurn(2, '然后呢', '好', T0 + HOUR, { inputTokens: 500, cacheReadTokens: 76_000 })];
  assert.equal(contextGrowthTokens(grown), 60_000, 'growth is the last prompt minus the opening one');
  assert.equal(rotationDue(grown, T0 + 2 * HOUR, ZONE, settings), 'context');
  assert.equal(rotationDue(grown, T0 + 2 * HOUR, ZONE, { daily: true, contextTokens: 0 }), undefined, '0 disables the token rule');
  assert.equal(rotationDue(grown, T0 + 2 * HOUR, ZONE, { daily: true, contextTokens: 80_000 }), undefined);
  // Six short turns on 2026-09-22 reached a 64,864-token prompt and rotated a session that had barely been used; the growth, not the total, is what should count.
  const overhead = [...userTurn(1, '两分钟后提醒我喝水', '好', T0, { inputTokens: 500, cacheReadTokens: 16_380 }), ...userTurn(2, '永泰的天气怎么样', '多云', T0 + HOUR, { inputTokens: 13_024, cacheReadTokens: 51_840 })];
  assert.equal(contextGrowthTokens(overhead), 47_984);
  assert.equal(rotationDue(overhead, T0 + 2 * HOUR, ZONE, settings), undefined, 'a prompt over the limit is not itself a reason to rotate');
  assert.equal(rotationDue(overhead, T0 + 2 * HOUR, ZONE, { daily: true, contextTokens: 40_000 }), 'context');
  // One turn cannot have grown: the first prompt is also the last.
  assert.equal(contextGrowthTokens(userTurn(1, '你好', '你好', T0, { inputTokens: 90_000 })), 0);
  assert.equal(rotationDue(userTurn(1, '你好', '你好', T0, { inputTokens: 90_000 }), T0 + HOUR, ZONE, settings), undefined);
  // A reminder-started turn after the user's last message does not count as the user writing today.
  const withReminder = [...yesterday, ev('turn/start', { turn: 2 }, T0 + 20 * HOUR),
    ev('user/message', { id: 'r', role: 'user', content: [{ type: 'text', text: 'reminder' }], source: { kind: 'plugin', plugin: 'schedule' } }, T0 + 20 * HOUR)];
  assert.equal(userTurns(withReminder), 1);
  assert.equal(rotationDue(withReminder, Date.parse('2026-09-22T09:00:00+08:00'), ZONE, settings), 'day');
});

test('the digest names the day, counts the user\'s requests and pairs each with the start of the reply, dropping the oldest past the budget', () => {
  const events = [
    ...userTurn(1, '帮我看看这份租房合同有没有坑\n[附件] 文件 合同.pdf（8 B）已保存到 inbox/x.pdf', '合同第 3 条押金退还条件写得模糊，建议改成……', T0),
    ev('turn/start', { turn: 2 }, T0 + HOUR),
    ev('user/message', { id: 'r', role: 'user', content: [{ type: 'text', text: '[SCHEDULE REMINDER]' }], source: { kind: 'plugin', plugin: 'schedule' } }, T0 + HOUR),
    ev('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: '静默' }] } }, T0 + HOUR),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, T0 + HOUR),
    ev('turn/start', { turn: 3 }, T0 + 90 * 60_000),
    ev('user/message', { id: 'h', role: 'user', content: [{ type: 'text', text: '[外部事件] 来源：mail' }], source: { kind: 'user', rpcId: 'wechat-hook-abc' } }, T0 + 90 * 60_000),
    ev('assistant/message', { turn: 3, step: 1, message: { content: [{ type: 'text', text: '外部事件已处理' }] } }, T0 + 90 * 60_000),
    ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, T0 + 90 * 60_000),
    ev('turn/start', { turn: 4 }, T0 + 2 * HOUR),
    ev('user/message', { id: 'u4', role: 'user', content: [{ type: 'text', text: '做个预算表' }], source: { kind: 'user' } }, T0 + 2 * HOUR),
    ev('user/message', { id: 't4', role: 'user', content: [{ type: 'text', text: 'Time sampled…' }], source: { kind: 'plugin', plugin: 'time-context' } }, T0 + 2 * HOUR),
    ev('assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'tool-call', id: 'c1' }] } }, T0 + 2 * HOUR),
    ev('user/message', { id: 't4b', role: 'user', content: [{ type: 'text', text: 'Time sampled…' }], source: { kind: 'plugin', plugin: 'time-context' } }, T0 + 2 * HOUR),
    ev('assistant/message', { turn: 4, step: 2, message: { content: [{ type: 'text', text: '已生成 outputs/预算.xlsx' }] } }, T0 + 2 * HOUR),
    ev('turn/end', { turn: 4, reason: { kind: 'completed' } }, T0 + 2 * HOUR),
  ];
  const digest = sessionDigest(events, ZONE)!;
  assert.equal(digest, '9/21 微信对话（2 件事）：帮我看看这份租房合同有没有坑→合同第 3 条押金退还条件写得模糊，建议改成……；做个预算表→已生成 outputs/预算.xlsx');
  assert.ok(digest.length <= 500, 'fits a memory event');
  assert.equal(sessionDigest([], ZONE), undefined);
  const many = Array.from({ length: 40 }, (_, i) => userTurn(i + 1, `第${i + 1}件事：${'字'.repeat(30)}`, `结论${i + 1}`, T0 + i * 60_000)).flat();
  const long = sessionDigest(many, ZONE)!;
  assert.ok(long.length <= DIGEST_LIMITS.chars + 40, `digest too long: ${long.length}`);
  assert.match(long, /^9\/21 微信对话（40 件事）：（更早的 \d+ 件略）/);
  assert.match(long, /第40件事/);
  assert.doesNotMatch(long, /第1件事：/);
});

test('the roster starts at the base and advances one generation per rotation, remembering the previous one', async () => {
  const roster = await SessionRoster.open(fakeRoster().opener);
  const base = sessionIdFor('acc', 'owner', 'owner', 'wechat');
  assert.equal(roster.activeFor(base), base);
  const first = await roster.rotate(base, 'day', T0);
  assert.deepEqual(first, { base, generation: 1, sessionId: `${base}-1`, previous: base, rotatedAt: T0, reason: 'day' });
  const second = await roster.rotate(base, 'user', T0 + 1);
  assert.equal(second.sessionId, `${base}-2`);
  assert.equal(second.previous, `${base}-1`);
  assert.equal(roster.activeFor(base), `${base}-2`);
});

test('assistant settings keep rotation with validation and expose it in the view', async () => {
  const store = new AssistantSettingsStore(new MemoryRecords());
  const saved = await store.save(0, { rotation: { daily: false, contextTokens: '90000' } });
  assert.deepEqual(saved.rotation, { daily: false, contextTokens: 90_000 });
  const kept = await store.save(1, { timeZone: 'Asia/Shanghai' });
  assert.deepEqual(kept.rotation, { daily: false, contextTokens: 90_000 }, 'a save without the field keeps the value');
  await assert.rejects(store.save(2, { rotation: { daily: 'yes' } }), /invalid_rotation/);
  await assert.rejects(store.save(2, { rotation: { contextTokens: -1 } }), /invalid_rotation/);
  await assert.rejects(store.save(2, { rotation: { contextTokens: 5_000_000 } }), /invalid_rotation/);
  assert.deepEqual((await store.read()).rotation, { daily: false, contextTokens: 90_000 });
});

/** A bridge over fake sessions whose logs the test controls, with a roster and a memory sink. */
function bridgeFixture(options: { channel?: 'wechat' | 'feishu' | 'wecom'; knownChats?: () => Promise<readonly string[]>; rotation?: { daily: boolean; contextTokens: number }; roster?: boolean; failCreate?: (sessionId: string) => boolean; failFlush?: (sessionId: string) => boolean; failAttach?: (sessionId: string) => boolean; failList?: boolean; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  heartbeatMs?: number; busy?: (sessions: readonly string[]) => Promise<boolean>;
  formerBases?: () => Promise<string[]>; onResolve?: (id: string, session: { append(type: string, data: unknown): unknown }) => void } = {}) {
  let clock = T0;
  const owner = { channel: options.channel ?? 'wechat', accountId: 'rot-bot', ownerId: 'rot-owner' };
  const base = sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, owner.channel);
  const workFixture = channelWorkFixture();
  const logs = new Map<string, any[]>();
  const created: string[] = [];
  // Every session this process resumed: resuming one starts its native reminder runtime.
  const resolved: string[] = [];
  // Sessions whose running turn the bridge stopped.
  const cancelled: string[] = [];
  const prompts: { sessionId: string; text: string }[] = [];
  // A real directory, because the sweep reads a session's stored cwd through the same `realpath` canon an
  // attach validates with, and the workspace record holds the canonical path.
  const dir = process.cwd();
  const elsewhere = tmpdir();
  // The directory each session was created in, as its stored header keeps it; the channel's own by default.
  const cwds = new Map<string, string>();
  const cwdOf = (id: string) => cwds.get(id) ?? dir;
  const sessionOf = (id: string) => {
    if (!logs.has(id)) logs.set(id, []);
    const events = logs.get(id)!;
    return { id, header: { cwd: cwdOf(id) }, snapshotEvents: () => events, append(type: string, data: unknown) { const event = ev(type, data, clock); events.push(event); return event; } };
  };
  // The registry-global archive set, as the native workspace registry exposes it: the test archives by pushing.
  const archivedSessionIds: string[] = [];
  // What `workspaceRegistry.create` hands back for the channel's directory; attaching is the only thing
  // that puts a session in a group, and the real registry refuses an attach whose session is elsewhere.
  const attached: string[] = [];
  const workspace = {
    id: 'workspace-1', path: dir, title: '微信工作区',
    async attachSession(sessionId: string) {
      if (options.failAttach?.(sessionId)) throw new Error('attach failed');
      if (cwdOf(sessionId) !== dir) throw new Error(`cannot attach session '${sessionId}': its cwd resolves to '${cwdOf(sessionId)}'`);
      if (!attached.includes(sessionId)) attached.push(sessionId);
    },
  } as unknown as Workspace;
  const tasks: any[] = [];
  const schedule = (sessionId: string, prompt = '开会') => {
    const task = { sessionId, id: `schedule-${tasks.length + 1}`, title: prompt, prompt, kind: 'at', scheduledAt: '2026-09-25T06:00:00.000Z', status: 'active' };
    tasks.push(task); return task;
  };
  const running = new Set<string>();
  const selections: { sessionId: string; provider: string; model: string }[] = [];
  const catalog = { default: { provider: 'first', model: 'chat' }, routableProviders: ['first', 'second'], failures: [],
    groups: [{ id: 'first', name: 'First', models: [{ id: 'chat', name: 'Chat' }] }, { id: 'second', name: 'Second', models: [{ id: 'chat', name: 'Chat' }] }] };
  const ctx = {
    schedule: { async catalog() { return structuredClone(tasks); } },
    sessionController: {
      async list() { return { items: [...logs.keys()].map(sessionId => ({ sessionId, cwd: cwdOf(sessionId), updatedAt: T0, running: running.has(sessionId),
        projections: { values: { modelSelection: { next: selections.findLast(item => item.sessionId === sessionId) ?? null } } } })) }; },
      async inspect(id: string) { if (!logs.has(id)) throw new Error('not found'); return { meta: { id, cwd: cwdOf(id) }, events: logs.get(id)! }; },
      async modelCatalog() { return structuredClone(catalog); },
      async selectModel(selection: { sessionId: string; provider: string; model: string }) { selections.push(selection); return { selected: selection }; },
      async create({ sessionId, cwd }: { sessionId: string; cwd: string }) {
        if (options.failCreate?.(sessionId)) throw new Error('create failed');
        // Like DSH's ensureSession: a session is resumed only under the cwd it was created with.
        if (logs.has(sessionId) && cwdOf(sessionId) !== cwd) throw new Error(`session "${sessionId}" belongs to "${cwdOf(sessionId)}", not "${cwd}"`);
        if (!logs.has(sessionId)) cwds.set(sessionId, cwd);
        created.push(sessionId); sessionOf(sessionId);
      },
      async resolveAgent(id: string) {
        resolved.push(id);
        if (!logs.has(id)) return { error: new Error('not found') };
        options.onResolve?.(id, sessionOf(id));
        return { agent: { id, session: sessionOf(id), inbox: { nextTurn: [], nextStep: [] }, async runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>) { if (running.has(id)) throw new Error('busy'); return job(new AbortController().signal); }, cancel() { cancelled.push(id); } } };
      },
      async prompt({ sessionId, content }: { sessionId: string; content: { type: string; text?: string }[] }) { prompts.push({ sessionId, text: content.map(part => part.text ?? '').join('') }); },
    },
    sessions: { async flush(session?: { id: string }) { if (session && options.failFlush?.(session.id)) throw new Error('flush failed'); return true; }, get: (id: string) => logs.has(id) ? sessionOf(id) : undefined },
    // The store's own view: every stored header, whether or not this process has loaded the session — which
    // is what makes a restart heal. It lists this channel's sessions, another channel's, one DSH opened
    // itself, and one this channel once had while working in another directory.
    sessionPersistence: {
      async open(id: string) {
        if (!logs.has(id)) throw new SessionPersistenceNotFoundError(id as never);
        return { async close() {}, async read() { return { events: logs.get(id)! } } };
      },
      async list() {
        if (options.failList) throw new Error('list failed');
        return [...logs.keys()].map(id => ({ header: { id, cwd: cwdOf(id) } })).concat([
          { header: { id: 'nexus-feishu-11111111111111111111111111111111', cwd: dir } },
          { header: { id: 'session-native-1', cwd: dir } },
          { header: { id: 'nexus-wechat-moved', cwd: elsewhere } }]);
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: options.sandbox ?? 'workspace-write' }) },
    workspaceRegistry: { archivedSessionIds, create: async () => workspace },
  } as unknown as Context;
  const texts: string[] = [];
  const transport: ChannelTransport = { ...(options.knownChats ? { knownChats: options.knownChats } : {}), async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const remembered: { text: string; sessionId: string }[] = [];
  const marks = new Map<string, number>();
  const ledger = { get: (id: string) => marks.get(id), async set(id: string, turn: number) { marks.set(id, turn); } };
  const codes: string[] = [];
  const rosterPromise = SessionRoster.open(fakeRoster().opener);
  const make = async () => {
    const roster = await rosterPromise;
    const bridge = new DshChannelBridge(ctx, transport, owner, dir, code => codes.push(code), { firstMs: options.heartbeatMs ?? 60_000, everyMs: 300_000 }, () => clock, {
      ledger, channelWork: workFixture.work, timeZone: () => ZONE, ...(options.roster === false ? {} : { sessions: roster }), rotation: () => options.rotation ?? DEFAULT_ROTATION,
      ...(options.busy ? { busy: options.busy } : {}),
      memory: { async remember(text, sessionId) { remembered.push({ text, sessionId }); } }, ...(options.formerBases ? { formerBases: options.formerBases } : {}) });
    return bridge;
  };
  const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });
  return { make, channelWork: workFixture.work, owner, base, logs, sessionOf, created, resolved, cancelled, roster: rosterPromise, prompts, texts, remembered, codes, marks, inbound, advance: (ms: number) => { clock += ms; }, now: () => clock,
    workspace, attached, dir, elsewhere, cwds, tasks, schedule, running, selections, catalog,
    archive: (sessionId: string) => { archivedSessionIds.push(sessionId); } };
}

test('legacy daily rotation settings keep native history and tasks across days and restart, without memory', async t => {
  const f = bridgeFixture({ rotation: { daily: true, contextTokens: 60_000 } });
  const bridge = await f.make();
  const old = f.sessionOf(f.base);
  old.snapshotEvents().push(...userTurn(1, '把 I:\\资料\\书籍 导入 kb-service，保留原文件', '先确认去重规则', T0));
  const history = structuredClone(old.snapshotEvents());
  const reminder = f.schedule(f.base);
  f.advance(48 * HOUR);
  await bridge.receive(f.inbound('m1', '把刚才的文档复制到知识库'));
  assert.deepEqual(f.prompts.at(-1), { sessionId: f.base, text: '把刚才的文档复制到知识库' });
  assert.deepEqual(old.snapshotEvents(), history, 'the native log, including exact paths and constraints, is preserved');
  assert.deepEqual(f.tasks, [reminder]);
  assert.deepEqual(f.texts, []);
  assert.deepEqual(f.remembered, [], 'continuity does not require writing or approving long-term memory');
  assert.equal((await f.roster).get(f.base), undefined);
  await bridge.close();
  const restarted = await f.make();
  t.after(() => restarted.close());
  await restarted.receive(f.inbound('m2', '继续完善项目代码'));
  assert.equal(f.prompts.at(-1)!.sessionId, f.base);
  assert.deepEqual(f.sessionOf(f.base).snapshotEvents(), history);
  assert.deepEqual(f.codes, []);
});

test('an oversized context retains native history; /new rotates on demand and refuses an empty session; without a roster nothing rotates', async t => {
  const f = bridgeFixture({ rotation: { daily: false, contextTokens: 50_000 } });
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.receive(f.inbound('n0', '/new'));
  assert.equal(f.texts.at(-1), '当前会话还没有聊过什么，不用换新。');
  const old = f.sessionOf(f.base);
  for (const event of userTurn(1, '读这本书', '读完了', T0, { inputTokens: 1_000, cacheReadTokens: 16_000 })) old.snapshotEvents().push(event);
  for (const event of userTurn(2, '继续', '好', T0 + 60_000, { inputTokens: 1_000, cacheReadTokens: 70_000 })) old.snapshotEvents().push(event);
  await bridge.receive(f.inbound('m1', '总结一下'));
  assert.equal(f.prompts.at(-1)!.sessionId, f.base);
  assert.equal(f.texts.includes(ROTATION_NOTICES.context), false);
  assert.equal(old.snapshotEvents().filter(event => event.type === 'user/message').length, 2);
  await bridge.receive(f.inbound('n1', '/new'));
  assert.equal(f.texts.at(-1), ROTATION_NOTICES.user);
  await bridge.receive(f.inbound('m2', '新的事'));
  assert.equal(f.prompts.at(-1)!.sessionId, `${f.base}-1`);
  assert.equal(f.remembered.length, 1);
  assert.deepEqual(f.sessionOf(`${f.base}-1`).snapshotEvents(), [], 'explicit /new creates an independent conversation');
  const plain = bridgeFixture({ roster: false });
  const fixed = await plain.make();
  t.after(() => fixed.close());
  for (const event of userTurn(1, '昨天', '好', T0)) plain.sessionOf(plain.base).snapshotEvents().push(event);
  plain.advance(30 * HOUR);
  await fixed.receive(plain.inbound('m1', '今天'));
  assert.equal(plain.prompts.at(-1)!.sessionId, plain.base);
  await fixed.receive(plain.inbound('n1', '/new'));
  assert.equal(plain.texts.at(-1), '这个渠道没有开启会话换新。');
});

test('context growth retains the same session during work, after completion and on the next day', async t => {
  let busy = true;
  const f = bridgeFixture({ rotation: { daily: true, contextTokens: 50_000 }, busy: async () => busy });
  const bridge = await f.make();
  t.after(() => bridge.close());
  const old = f.sessionOf(f.base);
  old.snapshotEvents().push(...userTurn(1, '完善项目', '正在执行', T0, { inputTokens: 17_000 }));
  old.snapshotEvents().push(...userTurn(2, '继续', '好', T0 + 60_000, { inputTokens: 71_000 }));
  await bridge.receive(f.inbound('m1', '有结果了吗'));
  busy = false;
  await bridge.receive(f.inbound('m2', '按刚才的方案继续'));
  busy = true;
  f.advance(30 * HOUR);
  await bridge.receive(f.inbound('m3', '昨天的任务怎么样了'));
  assert.deepEqual(f.prompts.map(p => p.sessionId), [f.base, f.base, f.base]);
  assert.deepEqual(f.texts, []);
  assert.deepEqual(f.remembered, []);
  assert.ok(!f.created.includes(`${f.base}-1`));
});

test('after a restart the previous generation is still routed: its late turn is delivered once and the status reply reads the active one', async t => {
  const f = bridgeFixture();
  const first = await f.make();
  const old = f.sessionOf(f.base);
  for (const event of userTurn(1, '昨天的事', '好', T0)) old.snapshotEvents().push(event);
  await first.receive(f.inbound('m0', '记一下'));
  await first.catchUp();
  f.advance(24 * HOUR);
  await first.receive(f.inbound('new', '/new'));
  await first.receive(f.inbound('m1', '今天'));
  const next = `${f.base}-1`;
  assert.equal(f.prompts.at(-1)!.sessionId, next);
  await first.close();
  // A turn of the old generation ends while no bridge is mounted (a job the old session started).
  for (const event of pushedTurn(2, 'late', '旧会话的任务结束了', f.now())) old.snapshotEvents().push(event);
  const second = await f.make();
  t.after(() => second.close());
  await second.catchUp();
  assert.ok(f.texts.some(text => text.includes('旧会话的任务结束了')), `late turn delivered: ${JSON.stringify(f.texts)}`);
  assert.deepEqual(second.bound(), [next]);
  await second.receive(f.inbound('s', '状态'));
  assert.match(f.texts.at(-1)!, /当前没有任务记录|上一轮已完成/);
  await second.catchUp();
  assert.equal(f.texts.filter(text => text.includes('旧会话的任务结束了')).length, 1, 'never delivered twice');
});

test('an explicit rotation that cannot create the next session answers in the current one instead of dropping the message', async t => {
  const f = bridgeFixture({ failCreate: id => /-\d+$/.test(id) });
  const bridge = await f.make();
  t.after(() => bridge.close());
  for (const event of userTurn(1, '昨天的事', '好', T0)) f.sessionOf(f.base).snapshotEvents().push(event);
  f.advance(24 * HOUR);
  await bridge.receive(f.inbound('new', '/new'));
  await bridge.receive(f.inbound('m1', '今天呢'));
  assert.deepEqual(f.prompts.at(-1), { sessionId: f.base, text: '今天呢' });
  assert.equal(f.texts.some(text => text.includes('任务未能提交')), false);
  assert.equal(f.texts.includes(ROTATION_NOTICES.day), false, 'no rotation notice when it did not happen');
  assert.ok(f.codes.some(code => code.startsWith('channel_rotation_failed')), JSON.stringify(f.codes));
  assert.equal(f.created.includes(`${f.base}-1`), false);
});

test('rotation never needs to flush the old session to preserve its native reminders', async t => {
  let oldId = '';
  const f = bridgeFixture({ failFlush: id => id === oldId });
  oldId = f.base;
  const bridge = await f.make();
  t.after(() => bridge.close());
  const old = f.sessionOf(f.base);
  for (const event of userTurn(1, '提醒我', '好', T0)) old.snapshotEvents().push(event);
  const reminder = f.schedule(f.base);
  f.advance(24 * HOUR);
  await bridge.receive(f.inbound('new', '/new'));
  await bridge.receive(f.inbound('m1', '早'));
  assert.equal(f.prompts.at(-1)!.sessionId, `${f.base}-1`);
  assert.equal(f.texts[0], ROTATION_NOTICES.user);
  assert.deepEqual(f.tasks, [reminder]);
  assert.deepEqual(f.codes, []);
  assert.equal(f.texts.some(text => text.includes('任务未能提交')), false);
});

test('a session the user archived is left behind: the next message opens a new generation even before anything was said', async t => {
  const f = bridgeFixture();
  const bridge = await f.make();
  t.after(() => bridge.close());
  // An archived session runs no step at all (DSH's archive gate rejects every one), so nothing else holds the chat back:
  // a rotation is due however empty the log is, and the reason is reported as its own kind.
  await bridge.receive(f.inbound('m1', '第一条'));
  assert.equal(f.prompts.at(-1)!.sessionId, f.base, 'a session nothing archived joins the chat as usual');
  f.archive(f.base);
  await bridge.receive(f.inbound('m2', '第二条'));
  const next = `${f.base}-1`;
  assert.deepEqual(f.texts, [ROTATION_NOTICES.archived]);
  assert.deepEqual(f.prompts.at(-1), { sessionId: next, text: '第二条' });
  assert.deepEqual(f.created.at(-1), next);
  // The archived session is never written into again, whatever the calendar says next.
  for (const event of userTurn(1, '第二条', '好', f.now())) f.sessionOf(next).snapshotEvents().push(event);
  f.advance(30 * HOUR);
  await bridge.receive(f.inbound('m3', '第三条'));
  assert.equal(f.prompts.at(-1)!.sessionId, `${f.base}-1`);
  assert.equal(f.prompts.some(prompt => prompt.sessionId === f.base), true, 'only the message before the archive ever went there');
  assert.deepEqual(f.codes, []);
});

test('every session is attached to the workspace its directory was registered as, so it shows up in that group instead of 未分组', async t => {
  const f = bridgeFixture();
  const bridge = await f.make();
  t.after(() => bridge.close());
  // A generation the chat already has before its directory is registered: nothing else will ever join it
  // to a group, so the bridge attaches it the moment the mount hands the workspace over.
  const previous = f.sessionOf(`${f.base}-1`);
  for (const event of userTurn(1, '昨天', '好', T0)) previous.snapshotEvents().push(event);
  await bridge.adoptWorkspace(f.workspace);
  assert.deepEqual(f.attached, [`${f.base}-1`]);
  assert.equal(f.attached.some(id => id.startsWith('nexus-feishu-') || id === 'session-native-1'), false,
    'another channel\'s session and a native one stay in their own groups');
  assert.equal(f.attached.includes('nexus-wechat-moved'), false,
    'a session whose cwd is another directory stays out: an attach refuses it and the workspace filters it out');
  assert.deepEqual(f.codes, [], 'leaving it where it is, is not a failure');
  // A session created with a cwd is joined to the workspace by whoever created it: DSH attaches only what
  // `sessionController.create` was asked to create inside one, by workspaceId, which these never name.
  await bridge.receive(f.inbound('m1', '第一条'));
  assert.deepEqual(f.attached, [`${f.base}-1`, f.base]);
});

test('after a restart every generation the store holds is attached, before any message arrives', async t => {
  // A fresh process has nothing live and knows no chat: only the store still names the sessions. The sweep
  // walks its listing, so a generation the roster has already rotated past is healed too — nothing else
  // would ever join it to a group.
  const f = bridgeFixture({ roster: false });
  const bridge = await f.make();
  t.after(() => bridge.close());
  for (const id of [f.base, `${f.base}-1`, `${f.base}-2`]) {
    for (const event of userTurn(1, '以前', '好', T0)) f.sessionOf(id).snapshotEvents().push(event);
  }
  await bridge.adoptWorkspace(f.workspace);
  assert.deepEqual(f.attached, [f.base, `${f.base}-1`, `${f.base}-2`]);
  assert.deepEqual(f.codes, []);
  const restarted = await f.make();
  t.after(() => restarted.close());
  f.attached.length = 0;
  await restarted.adoptWorkspace(f.workspace);
  assert.deepEqual(f.attached, [f.base, `${f.base}-1`, `${f.base}-2`], 'the same listing, with nothing loaded');
});

test('a store that cannot be listed leaves the sessions where they are and says so once', async t => {
  const f = bridgeFixture({ failList: true, roster: false });
  const bridge = await f.make();
  t.after(() => bridge.close());
  for (const event of userTurn(1, '以前', '好', T0)) f.sessionOf(f.base).snapshotEvents().push(event);
  await bridge.adoptWorkspace(f.workspace);
  assert.deepEqual(f.attached, []);
  assert.ok(f.codes.includes('channel_session_list_failed'), JSON.stringify(f.codes));
  // The message path does not need the listing: the session a message lands in is attached anyway.
  await bridge.receive(f.inbound('m1', '第一条'));
  assert.deepEqual(f.prompts.at(-1), { sessionId: f.base, text: '第一条' });
  assert.deepEqual(f.texts.some(text => text.includes('任务未能提交')), false, 'the user hears nothing about the group');
});

test('a channel session runs with the permission it has: nothing is written to it before a message is prompted', async t => {
  // Full access is what the system gave it; until 2026-09-24 the bridge lowered it to read-only right here.
  const f = bridgeFixture({ sandbox: 'danger-full-access' });
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.receive(f.inbound('m1', '帮我看看桌面有哪些文件'));
  assert.deepEqual(f.prompts.at(-1), { sessionId: f.base, text: '帮我看看桌面有哪些文件' });
  assert.deepEqual(f.logs.get(f.base)!.filter(event => event.type === 'sandbox/mode'), []);
});

test('a generation the bridge once lowered gets its full access back at mount, before any message', async t => {
  const f = bridgeFixture();
  const lowered = f.sessionOf(f.base);
  for (const [type, data] of [['permission/preset', { preset: 'danger-full-access' }], ['sandbox/mode', { mode: 'danger-full-access' }],
    ['approval/policy', { policy: 'never' }], ['sandbox/mode', { mode: 'read-only' }]] as const) lowered.append(type, data);
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.resumeBound();
  assert.deepEqual(f.logs.get(f.base)!.at(-1).data, { mode: 'danger-full-access' }, 'the Web UI shows 完全权限 again instead of Custom');
  assert.deepEqual(f.prompts, []);
});

test('after the channel\'s directory changed, the user\'s next message moves the chat there and says so', async t => {
  const f = bridgeFixture();
  const bridge = await f.make();
  t.after(() => bridge.close());
  // Today's generation, created in the directory the channel worked in before.
  const old = f.sessionOf(f.base);
  f.cwds.set(f.base, f.elsewhere);
  for (const event of userTurn(1, '上一件事', '好', T0)) old.snapshotEvents().push(event);
  await bridge.adoptWorkspace(f.workspace);
  await bridge.receive(f.inbound('m1', '接着干活'));
  assert.deepEqual(f.prompts.at(-1), { sessionId: `${f.base}-1`, text: '接着干活' }, 'answered, in the next generation');
  assert.equal(f.cwds.get(`${f.base}-1`), f.dir, 'created in the directory the channel works in now');
  assert.ok(f.texts.includes(ROTATION_NOTICES.moved), JSON.stringify(f.texts));
  assert.equal(f.remembered.length, 1, 'what the old generation was about is kept in memory');
  assert.deepEqual(f.attached, [`${f.base}-1`], 'the new generation joins the new directory\'s group; the old one cannot');
  assert.deepEqual(f.codes, []);
});

test('an event that arrives before the user writes again is answered in the generation it lands in, in that session\'s own directory', async t => {
  const f = bridgeFixture();
  const bridge = await f.make();
  t.after(() => bridge.close());
  f.sessionOf(f.base);
  f.cwds.set(f.base, f.elsewhere);
  await bridge.adoptWorkspace(f.workspace);
  assert.equal(await bridge.inject(f.base, '[外部事件] 新邮件', 'hook-1'), true);
  assert.deepEqual(f.prompts.at(-1), { sessionId: f.base, text: '[外部事件] 新邮件' });
  assert.deepEqual(f.codes, [], 'no directory conflict, and no attempt to put it in a group it cannot join');
});

test('a workspace that refuses an attach is reported without costing the reply', async t => {
  let refusing = '';
  const f = bridgeFixture({ failAttach: id => id === refusing });
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.adoptWorkspace(f.workspace);
  refusing = f.base;
  await bridge.receive(f.inbound('m1', '第一条'));
  assert.deepEqual(f.prompts.at(-1), { sessionId: f.base, text: '第一条' });
  assert.equal(f.texts.some(text => text.includes('任务未能提交')), false, 'the user hears nothing about the group');
  assert.ok(f.codes.includes('channel_session_group_failed'), JSON.stringify(f.codes));
  assert.deepEqual(f.attached, []);
});

test('a QR rebind routes native reminders from all earlier generations without moving tasks or resuming them', async t => {
  const earlier = sessionIdFor('old-bot', 'rot-owner', 'rot-owner', 'wechat');
  const other = sessionIdFor('other-bot', 'someone-else', 'someone-else', 'wechat');
  const f = bridgeFixture({ formerBases: async () => [earlier] });
  const old = f.sessionOf(`${earlier}-2`);
  for (const event of userTurn(1, '喝水', '好的', T0)) old.snapshotEvents().push(event);
  const roster = await f.roster;
  await roster.rotate(earlier, 'day', T0);
  await roster.rotate(earlier, 'day', T0);
  const task = f.schedule(`${earlier}-1`, '喝水');
  f.schedule(other, '别人的提醒');
  const before = structuredClone(f.tasks);
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.resumeBound();
  assert.equal(bridge.sameChat(f.base, task.sessionId), true);
  assert.equal(await bridge.notify(task.sessionId, '提醒：喝水', 'first'), true, 'delivery works before the next inbound message');
  assert.equal(await bridge.notify(other, '秘密', 'foreign'), false);
  await bridge.receive(f.inbound('m1', '早'));
  assert.equal(roster.get(earlier)?.supersededBy, f.base);
  assert.equal(f.remembered[0]?.sessionId, old.id);
  assert.equal(f.resolved.some(id => id.startsWith(earlier)), false, 'DSH alone resumes the source when due');
  assert.deepEqual(f.tasks, before);
  await bridge.receive(f.inbound('s1', '状态'));
  assert.match(f.texts.at(-1)!, /待触发的提醒（1）/);
  assert.match(f.texts.at(-1)!, /喝水/);
  assert.doesNotMatch(f.texts.at(-1)!, /别人的提醒/);
  const notices = f.texts.filter(text => text.startsWith('重新扫码连接后')).length;
  await bridge.receive(f.inbound('m2', '在吗'));
  assert.equal(f.texts.filter(text => text.startsWith('重新扫码连接后')).length, notices);
  await bridge.close();
  const restarted = await f.make();
  t.after(() => restarted.close());
  await restarted.resumeBound();
  assert.equal(await restarted.notify(task.sessionId, '重启后提醒', 'second'), true);
  assert.deepEqual(f.tasks, before, 'restart does not recreate or delete native tasks');
});

test('a former binding superseded by a different destination is never admitted', async t => {
  const earlier = sessionIdFor('old-bot', 'rot-owner', 'rot-owner', 'wechat');
  const f = bridgeFixture({ formerBases: async () => [earlier] });
  await (await f.roster).supersede(earlier, 'another-destination', T0);
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.resumeBound();
  assert.equal(await bridge.notify(earlier, 'private', 'foreign'), false);
});

test('legacy reminders are diagnosed as inactive instead of being advertised as scheduled', async t => {
  const f = bridgeFixture();
  f.sessionOf(f.base).append('schedule/change', { version: 1, operation: 'create', schedule: {
    id: 'schedule-1', kind: 'at', prompt: '旧提醒', scheduledAt: '2026-09-25T06:00:00.000Z' } });
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.receive(f.inbound('s1', '状态'));
  assert.match(f.texts.at(-1)!, /1 条旧版提醒尚未迁移/);
  assert.doesNotMatch(f.texts.at(-1)!, /待触发的提醒/);
  assert.deepEqual(f.tasks, []);
});

test('a store that cannot list earlier bindings is reported once and costs the messages nothing', async t => {
  const f = bridgeFixture({ formerBases: async () => { throw new Error('listing failed'); } });
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.receive(f.inbound('m1', '早'));
  await bridge.receive(f.inbound('m2', '在吗'));
  assert.deepEqual(f.prompts.map(item => item.text), ['早', '在吗']);
  assert.deepEqual(f.codes, ['channel_former_sessions_unreadable']);
  assert.deepEqual(f.texts, []);
});


test('restart catches up a native result from a generation older than the active pair without rerunning it', async t => {
  const f = bridgeFixture();
  const roster = await f.roster;
  for (let i = 0; i < 4; i++) await roster.rotate(f.base, 'day', T0 + i);
  const source = `${f.base}-1`;
  f.sessionOf(source).snapshotEvents().push(...pushedTurn(1, '提醒', '原会话完成的提醒', T0));
  f.marks.set(source, 0);
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.catchUp();
  await bridge.catchUp();
  assert.equal(f.texts.length, 1);
  assert.match(f.texts[0]!, /历史微信会话[\s\S]*原会话完成的提醒/);
  assert.deepEqual(f.prompts, [], 'delivery recovery must not submit a task');
  assert.equal(f.marks.get(source), 1);
});


test('multiple QR rebinds retain routes to the original task session through owner-verified bindings', async t => {
  const oldest = sessionIdFor('oldest-bot', 'rot-owner', 'rot-owner', 'wechat');
  const prior = sessionIdFor('prior-bot', 'rot-owner', 'rot-owner', 'wechat');
  const f = bridgeFixture({ formerBases: async () => [oldest, prior] });
  const roster = await f.roster;
  await roster.supersede(oldest, prior, T0);
  await roster.supersede(prior, f.base, T0 + 1);
  const bridge = await f.make();
  t.after(() => bridge.close());
  await bridge.resumeBound();
  assert.equal(await bridge.notify(`${oldest}-2`, '最初会话的提醒', 'original'), true);
  assert.equal(f.texts.length, 1);
  assert.match(f.texts[0]!, /历史微信会话[\s\S]*最初会话的提醒/);
  await roster.supersede(prior, oldest, T0 + 2);
  const restarted = await f.make();
  t.after(() => restarted.close());
  await restarted.resumeBound();
  assert.equal(await restarted.notify(oldest, 'cycle', 'cycle'), false);
});


test('desktop turns in historical WeChat sessions stay local, including recovery and files', async t => {
  const f = bridgeFixture();
  const bridge = await f.make(); t.after(() => bridge.close());
  const old = f.sessionOf(f.base);
  old.snapshotEvents().push(...userTurn(1, 'before', 'current desktop reply', T0));
  bridge.onEvent(old as never, old.snapshotEvents().at(-1));
  await bridge.drain();
  assert.equal(f.texts.at(-1), 'current desktop reply');
  await bridge.receive(f.inbound('new', '/new'));
  const next = `${f.base}-1`;
  const before = f.texts.length;
  const local = userTurn(2, 'run it', 'LOCAL-ONLY', T0 + HOUR);
  local.splice(-1, 0, ev('deliverables/presented', { turn: 2, files: [{ path: 'missing-local-only.txt' }] }));
  old.snapshotEvents().push(...local);
  bridge.onEvent(old as never, old.snapshotEvents().at(-1));
  await bridge.drain();
  assert.equal(f.texts.length, before, 'neither reply nor file error reaches WeChat');
  assert.equal(f.marks.get(f.base), 2, 'the skipped turn is accounted for');
  old.snapshotEvents().push(...userTurn(3, 'offline desktop work', 'OFFLINE-LOCAL', T0 + HOUR));
  await bridge.close();
  const restarted = await f.make(); t.after(() => restarted.close());
  await restarted.catchUp();
  assert.equal(f.texts.length, before, 'restart does not replay a local turn');
  assert.equal(f.marks.get(f.base), 3);
  await restarted.receive(f.inbound('reply', '好的'));
  assert.equal(f.prompts.at(-1)!.sessionId, next);
});

test('old WeChat turns, native job notices and explicit notifications retain labeled delivery', async t => {
  const f = bridgeFixture();
  const bridge = await f.make(); t.after(() => bridge.close());
  const old = f.sessionOf(f.base);
  old.snapshotEvents().push(...userTurn(1, 'before', 'before', T0));
  await bridge.receive(f.inbound('new', '/new'));
  const remote = userTurn(2, 'remote work', 'REMOTE-RESULT', T0);
  remote.find(event => event.type === 'user/message')!.data.source.rpcId = 'wechat-fixture';
  old.snapshotEvents().push(...remote);
  bridge.onEvent(old as never, remote.at(-1)); await bridge.drain();
  assert.match(f.texts.at(-1)!, /历史微信会话[\s\S]*REMOTE-RESULT/);
  old.snapshotEvents().push(...pushedTurn(3, 'job notice', 'JOB-RESULT', T0));
  bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
  assert.match(f.texts.at(-1)!, /历史微信会话[\s\S]*JOB-RESULT/);
  await bridge.notify(f.base, 'SCHEDULE-RESULT', 'schedule');
  assert.match(f.texts.at(-1)!, /历史微信会话[\s\S]*SCHEDULE-RESULT/);
  const local = userTurn(4, 'desktop plus context', 'MIXED-LOCAL', T0);
  local.splice(2, 0, ev('user/message', { source: { kind: 'plugin' }, content: [] }));
  old.snapshotEvents().push(...local);
  bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
  assert.ok(!f.texts.some(text => text.includes('MIXED-LOCAL')));
});

test('historical approval stays bound to its request without changing the current chat', async t => {
  const f = bridgeFixture();
  const bridge = await f.make(); t.after(() => bridge.close());
  const old = f.sessionOf(f.base);
  old.snapshotEvents().push(...userTurn(1, 'before', 'before', T0));
  await bridge.receive(f.inbound('new', '/new'));
  old.append('turn/start', { turn: 2 });
  old.append('user/message', { source: { kind: 'user', rpcId: 'wechat-admitted' }, content: [] });
  old.append('tool/call', { turn: 2, callId: 'old-call', name: 'bash', arguments: '{"command":"echo fixture"}' });
  const outcome = bridge.approve({ agent: { id: f.base, session: old }, callId: 'old-call', toolName: 'bash' } as never,
    () => new Promise(() => {}));
  await new Promise(resolve => setImmediate(resolve));
  const prompt = f.texts.at(-1)!;
  assert.match(prompt, /历史微信会话/);
  assert.doesNotMatch(prompt, /\/cancel/);
  const token = /允许 ([a-f0-9]{32})/.exec(prompt)![1];
  await bridge.receive(f.inbound('pending-switch', '/s 0'));
  assert.match(f.texts.at(-1)!, /等待审批或回答/);
  await bridge.receive(f.inbound('pending-model', '/m first/chat'));
  assert.match(f.texts.at(-1)!, /等待审批或回答/);
  assert.deepEqual(f.selections, []);
  await bridge.receive(f.inbound('approve', `允许 ${token}`));
  assert.equal(await outcome, 'allowed-once');
  assert.deepEqual(bridge.bound(), [`${f.base}-1`]);
  await bridge.receive(f.inbound('reply', '好的'));
  assert.equal(f.prompts.at(-1)!.sessionId, `${f.base}-1`);
});


test('historical desktop heartbeats and interrupted recovery remain local', async t => {
  const f = bridgeFixture({ heartbeatMs: 1 });
  const bridge = await f.make(); t.after(() => bridge.close());
  const old = f.sessionOf(f.base);
  old.snapshotEvents().push(...userTurn(1, 'before', 'before', T0));
  f.marks.set(f.base, 1);
  await bridge.receive(f.inbound('new', '/new'));
  const before = f.texts.length;
  const pending = userTurn(2, 'desktop work', '', T0).slice(0, 2);
  pending.push(ev('step/start', { turn: 2, step: 1 }));
  old.snapshotEvents().push(...pending);
  bridge.onEvent(old as never, pending.at(-1));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.texts.length, before, 'no progress reminder for the local turn');
  await bridge.close();
  const restarted = await f.make(); t.after(() => restarted.close());
  await restarted.catchUp();
  assert.equal(f.texts.length, before, 'no open-turn interruption notice after restart');
  assert.equal(f.marks.get(f.base), 2);
  const repaired = userTurn(3, 'desktop repaired turn', '', T0);
  repaired.at(-1)!.data.reason.kind = 'interrupted';
  old.snapshotEvents().push(...repaired);
  await restarted.catchUp();
  assert.equal(f.texts.length, before, 'no repaired-turn interruption notice either');
  assert.equal(f.marks.get(f.base), 3);
});

test('navigation commands require explicit syntax, not requests mentioning models or sessions', () => {
  for (const text of ['/s', '/sessions']) assert.deepEqual(parseCommand(text), { kind: 'sessions' });
  assert.deepEqual(parseCommand('/s 0'), { kind: 'switch-session', value: '0' });
  assert.deepEqual(parseCommand('/model first/chat'), { kind: 'switch-model', value: 'first/chat' });
  assert.deepEqual(parseCommand('/m'), { kind: 'model' });
  assert.deepEqual(parseCommand('/models'), { kind: 'models' });
  for (const text of ['会话列表', '切换会话 0', '查看模型', '模型列表', '切换模型 2', '新会话', '切换模型 会影响上下文吗？', 's', 's 0', 'm 2', 'ml']) {
    assert.equal(parseCommand(text), undefined, text);
  }
  assert.deepEqual(parseCommand('/s 0'), { kind: 'switch-session', value: '0' });
  assert.deepEqual(parseCommand('/m 2'), { kind: 'switch-model', value: '2' });
  assert.equal(parseCommand('/s\n普通聊天'), undefined);
  assert.equal(parseCommand('帮我实现切换模型功能'), undefined);
  assert.equal(parseCommand('会话列表中发生了什么'), undefined);
});

test('switching uses original native history, persists across restart and never reuses allocated generation ids', async t => {
  const f = bridgeFixture();
  const bridge = await f.make();
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, '保留项目上下文', '好', T0));
  const task = f.schedule(f.base);
  await bridge.receive(f.inbound('n1', '/new'));
  f.sessionOf(`${f.base}-1`).snapshotEvents().push(...userTurn(1, '另一个问题', '好', T0));
  const before = structuredClone([...f.logs]);
  const resolved = f.resolved.length;
  await bridge.receive(f.inbound('list', '/s'));
  assert.match(f.texts.at(-1)!, /0.*\n1 \[当前\]/);
  await Promise.all([bridge.receive(f.inbound('switch', '/s 0')), bridge.receive(f.inbound('follow', '继续之前的项目'))]);
  assert.equal(f.prompts.at(-1)?.sessionId, f.base);
  assert.deepEqual([...f.logs], before, 'navigation does not copy, reconstruct, or append to history');
  assert.deepEqual(f.tasks, [task]);
  assert.ok(f.resolved.slice(resolved).every(id => id === f.base), 'list and switch do not activate other sessions');
  await bridge.close();
  const restarted = await f.make(); t.after(() => restarted.close());
  await restarted.receive(f.inbound('after-restart', '继续'));
  assert.equal(f.prompts.at(-1)?.sessionId, f.base);
  await restarted.receive(f.inbound('n2', '/new'));
  assert.equal((await f.roster).activeFor(f.base), `${f.base}-2`);
  assert.deepEqual(f.sessionOf(`${f.base}-1`).snapshotEvents(), before.find(([id]) => id === `${f.base}-1`)![1]);
  await restarted.receive(f.inbound('n2', '/new'));
  assert.equal((await f.roster).get(f.base)?.generation, 2, 'duplicate control cannot create another session');
});

test('session lists and selectors exclude other owners, directories, archives and missing ids without activating agents', async t => {
  const f = bridgeFixture(); const bridge = await f.make(); t.after(() => bridge.close());
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, 'hello', 'hi', T0));
  await bridge.receive(f.inbound('new', '/new'));
  f.sessionOf(`${f.base}-2`); f.cwds.set(`${f.base}-2`, f.elsewhere);
  f.sessionOf(`${f.base}-3`); f.archive(`${f.base}-3`);
  const other = sessionIdFor('someone-else', 'owner', 'owner', 'wechat'); f.sessionOf(other);
  f.resolved.length = 0;
  await bridge.receive(f.inbound('list', '/s'));
  assert.doesNotMatch(f.texts.at(-1)!, /\n[23] |someone-else/);
  for (const target of ['2', '3', '99', other, '-1', '01']) {
    await bridge.receive(f.inbound(`switch-${target}`, `/s ${target}`));
    assert.equal((await f.roster).activeFor(f.base), `${f.base}-1`);
  }
  assert.deepEqual(f.resolved, []);
  f.running.add(f.base);
  await bridge.receive(f.inbound('busy', '/s 0'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  f.running.clear();
  f.sessionOf(f.base).snapshotEvents().push(ev('turn/start', { turn: 2 }));
  await bridge.receive(f.inbound('interrupted', '/s 0'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  assert.equal((await f.roster).activeFor(f.base), `${f.base}-1`);
});

test('native model selectors preserve history and distinguish providers; menu numbering expires and removed routes cannot be selected', async t => {
  const f = bridgeFixture(); const bridge = await f.make(); t.after(() => bridge.close());
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, 'context', 'reply', T0));
  const before = structuredClone(f.sessionOf(f.base).snapshotEvents());
  await bridge.receive(f.inbound('list', '/ml'));
  assert.match(f.texts.at(-1)!, /1\. first\/chat\n2\. second\/chat/);
  assert.match(f.texts.at(-1)!, /默认模型/);
  f.catalog.groups.reverse();
  await bridge.receive(f.inbound('select', '/m 2'));
  assert.deepEqual(f.selections, [{ sessionId: f.base, provider: 'second', model: 'chat' }], 'number refers to displayed catalog even if native order changes');
  await bridge.receive(f.inbound('select', '/m 2'));
  assert.equal(f.selections.length, 1, 'duplicate command does not mutate model twice');
  await bridge.receive(f.inbound('current', '/m'));
  assert.match(f.texts.at(-1)!, /当前会话下一轮模型：second\/chat/);
  assert.deepEqual(f.sessionOf(f.base).snapshotEvents(), before);
  assert.deepEqual(f.prompts, [], 'controls never dispatch model prompts');
  f.advance(10 * 60_000);
  await bridge.receive(f.inbound('expired', '/m 1'));
  assert.match(f.texts.at(-1)!, /已失效/);
  await bridge.receive(f.inbound('list2', '/ml'));
  f.catalog.routableProviders = ['second'];
  await bridge.receive(f.inbound('gone', '/m first/chat'));
  assert.match(f.texts.at(-1)!, /不可用/);
  assert.equal(f.selections.length, 1);
  f.running.add(f.base);
  await bridge.receive(f.inbound('busy', '/m second/chat'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  assert.equal(f.selections.length, 1);
});

test('active background work blocks both selectors, while a first model selection can initialize an empty session', async t => {
  let busy = false;
  const f = bridgeFixture({ busy: async () => busy }); const bridge = await f.make(); t.after(() => bridge.close());
  await bridge.receive(f.inbound('initial', '/m first/chat'));
  assert.deepEqual(f.selections, [{ sessionId: f.base, provider: 'first', model: 'chat' }]);
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, 'hello', 'hi', T0));
  await bridge.receive(f.inbound('new', '/new'));
  busy = true;
  await bridge.receive(f.inbound('switch', '/s 0'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  await bridge.receive(f.inbound('model', '/m first/chat'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  assert.equal(f.selections.length, 1);
  assert.equal((await f.roster).activeFor(f.base), `${f.base}-1`);
});

test('selectors check only current and target task owners, not an unrelated historical session', async t => {
  const active = new Set<string>();
  const f = bridgeFixture({ busy: async sessions => sessions.some(id => active.has(id)) });
  const bridge = await f.make(); t.after(() => bridge.close());
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, 'first', 'done', T0));
  await bridge.receive(f.inbound('new-one', '/new'));
  f.sessionOf(`${f.base}-1`).snapshotEvents().push(...userTurn(1, 'second', 'done', T0));
  await bridge.receive(f.inbound('new-two', '/new'));
  active.add(f.base);
  await bridge.receive(f.inbound('switch-idle', '/s 1'));
  assert.equal((await f.roster).activeFor(f.base), `${f.base}-1`);
  await bridge.receive(f.inbound('model-idle', '/m first/chat'));
  assert.equal(f.selections.length, 1);
  await bridge.receive(f.inbound('target-busy', '/s 0'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  active.add(`${f.base}-1`);
  await bridge.receive(f.inbound('current-busy', '/s 2'));
  assert.match(f.texts.at(-1)!, /仍在执行/);
  await bridge.receive(f.inbound('model-busy', '/m second/chat'));
  assert.equal(f.selections.length, 1);
});

test('failed routing persistence keeps the old active session; an execution starting during model resolution prevents selection', async t => {
  const f = bridgeFixture(); const bridge = await f.make(); t.after(() => bridge.close());
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, 'first', 'done', T0));
  await bridge.receive(f.inbound('new', '/new'));
  (await f.roster).select = async () => { throw new Error('storage unavailable'); };
  await bridge.receive(f.inbound('switch', '/s 0'));
  assert.match(f.texts.at(-1)!, /未能完成/);
  assert.equal((await f.roster).activeFor(f.base), `${f.base}-1`);
  await bridge.receive(f.inbound('next', '继续'));
  assert.equal(f.prompts.at(-1)?.sessionId, `${f.base}-1`);

  const race = bridgeFixture({ onResolve: id => { race.running.add(id); } });
  const modelBridge = await race.make(); t.after(() => modelBridge.close());
  race.sessionOf(race.base);
  await modelBridge.receive(race.inbound('model', '/m first/chat'));
  assert.match(race.texts.at(-1)!, /未能完成/);
  assert.deepEqual(race.selections, []);
});


test('Chinese navigation phrases are admitted as chat and never change session or model', async t => {
  const f = bridgeFixture(); const bridge = await f.make(); t.after(() => bridge.close());
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, '原会话', '收到', T0));
  const messages = ['会话列表', '切换会话 0', '模型列表', '查看模型', '切换模型 2', '切换模型 会影响上下文吗？', '新会话'];
  for (const [index, text] of messages.entries()) await bridge.receive(f.inbound(`ordinary-${index}`, text));
  assert.deepEqual(f.prompts.map(prompt => prompt.text), messages);
  assert.ok(f.prompts.every(prompt => prompt.sessionId === f.base));
  assert.equal((await f.roster).get(f.base), undefined);
  assert.deepEqual(f.selections, []);
  assert.deepEqual(f.texts, []);
});


test('/help is local, owner-scoped and does not activate a session or consume a chat request', async t => {
  assert.deepEqual(parseCommand('  /help  '), { kind: 'help' });
  for (const text of ['help', '帮助', '请解释 /help', '/help me']) assert.equal(parseCommand(text), undefined);
  const f = bridgeFixture(); const bridge = await f.make(); t.after(() => bridge.close());
  await bridge.receive({ ...f.inbound('foreign', '/help'), senderId: 'other-owner' });
  assert.equal(f.texts.length, 0);
  await bridge.receive(f.inbound('help', '/help'));
  const help = f.texts.at(-1)!;
  for (const command of ['/help', '/s 0', '/new', '/m 2', '/ml', '/status', '/cancel', '/approve 审批编号', '/deny 审批编号', '/answer 1']) assert.ok(help.includes(command), command);
  assert.equal(f.prompts.length, 0);
  assert.deepEqual(f.created, []);
  assert.deepEqual(f.resolved, []);
  assert.deepEqual(f.selections, []);
  assert.equal((await f.roster).get(f.base), undefined);
  await bridge.receive(f.inbound('ordinary', '帮助'));
  assert.equal(f.prompts.at(-1)?.text, '帮助');
});


for (const channel of ['wechat', 'feishu', 'wecom'] as const) {
  test(`${channel}: historical desktop turns stay local, channel results are labeled, approvals keep their original session`, async t => {
    const f = bridgeFixture({ channel }); const bridge = await f.make(); t.after(() => bridge.close());
    const old = f.sessionOf(f.base); old.snapshotEvents().push(...userTurn(1, 'before', 'done', T0));
    await bridge.receive(f.inbound('prime', 'before'));
    await bridge.receive(f.inbound('new', '/new'));
    f.marks.set(f.base, 1);
    old.snapshotEvents().push(...userTurn(2, 'desktop follow-up', 'PRIVATE-DESKTOP', T0));
    bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
    assert.ok(!f.texts.some(text => text.includes('PRIVATE-DESKTOP')));
    const result = userTurn(3, 'remote turn', 'REMOTE-RESULT', T0).map(event => event.type === 'user/message'
      ? { ...event, data: { ...event.data, source: { kind: 'user', rpcId: `${channel}-original-request` } } } : event);
    old.snapshotEvents().push(...result);
    bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
    const title = { wechat: '微信', feishu: '飞书', wecom: '企业微信' }[channel];
    assert.ok(f.texts.some(text => text.startsWith(`[历史${title}会话 ${f.base}]`) && text.includes('REMOTE-RESULT')));
    old.append('turn/start', { turn: 4 });
    old.append('user/message', { source: { kind: 'user', rpcId: `${channel}-admitted` }, content: [] });
    old.append('tool/call', { turn: 4, callId: 'historical-call', name: 'bash', arguments: '{}' });
    const outcome = bridge.approve({ agent: { id: f.base, session: old }, callId: 'historical-call', toolName: 'bash' } as never, () => new Promise(() => {}));
    await new Promise(resolve => setImmediate(resolve));
    const prompt = f.texts.at(-1)!;
    assert.ok(prompt.startsWith(`[历史${title}会话 ${f.base}]`));
    assert.doesNotMatch(prompt, /停止当前执行：\/cancel/);
    const token = /允许 ([a-f0-9]{32})/.exec(prompt)![1];
    await bridge.receive(f.inbound('approve', `/approve ${token}`));
    assert.equal(await outcome, 'allowed-once');
    await bridge.receive(f.inbound('follow', '普通回复'));
    assert.equal(f.prompts.at(-1)?.sessionId, `${f.base}-1`);
  });
}

test('Feishu restores owner-admitted chat routes before a new message without reconstructing history', async t => {
  const f = bridgeFixture({ channel: 'feishu', knownChats: async () => ['rot-owner'] });
  f.sessionOf(f.base).snapshotEvents().push(...userTurn(1, 'old', 'done', T0));
  await (await f.roster).rotate(f.base, 'user', T0);
  f.sessionOf(`${f.base}-1`);
  const before = structuredClone([...f.logs]);
  const bridge = await f.make(); t.after(() => bridge.close());
  await bridge.resumeBound();
  assert.deepEqual(bridge.bound(), [`${f.base}-1`]);
  assert.deepEqual(f.prompts, []);
  assert.deepEqual([...f.logs], before);
  assert.equal(await bridge.notify(f.base, 'OLD-TASK-RESULT', 'result'), true);
  assert.match(f.texts.at(-1)!, /^\[历史飞书会话/);
});

for (const channel of ['wechat', 'feishu', 'wecom'] as const) {
  test(`${channel}: native bash completion follows its original source after /new`, async t => {
    const f = bridgeFixture({ channel }); const bridge = await f.make(); t.after(() => bridge.close());
    const old = f.sessionOf(f.base), agent = { id: f.base, session: old };
    old.append('turn/start', { turn: 1 });
    old.append('user/message', { source: { kind: 'user', rpcId: `${channel}-admitted` }, content: [] });
    old.append('tool/call', { turn: 1, callId: 'remote-bash', name: 'bash', arguments: '{}' });
    await f.channelWork.withCall({ agent, callId: 'remote-bash', rootCallId: 'remote-bash' } as never, async () => {
      f.channelWork.jobEvent({ type: 'registered', job: { id: 'bash-1', owner: f.base } } as never);
    });
    old.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await bridge.receive(f.inbound('prime-bash', 'before'));
    await bridge.receive(f.inbound('new-bash', '/new'));
    old.append('turn/start', { turn: 2 });
    old.append('user/message', { source: { kind: 'user' }, content: [] });
    old.append('tool/call', { turn: 2, callId: 'desktop-bash', name: 'bash', arguments: '{}' });
    await f.channelWork.withCall({ agent, callId: 'desktop-bash', rootCallId: 'desktop-bash' } as never, async () => {
      f.channelWork.jobEvent({ type: 'registered', job: { id: 'bash-2', owner: f.base } } as never);
    });
    old.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    for (const [turn, jobId, marker] of [[3, 'bash-1', 'REMOTE-BASH-RESULT'], [4, 'bash-2', 'DESKTOP-BASH-RESULT']] as const) {
      const result = pushedTurn(turn, `background job ${jobId} (bash: fixture) finished completed`, marker, T0);
      for (const event of result) if (event.type === 'user/message') {
        event.data = { ...event.data, id: `notice-${jobId}`, source: { kind: 'tool-jobs', form: 'notice' } };
        f.channelWork.noticeMessage(f.base, event.data);
      }
      old.snapshotEvents().push(...result); f.marks.set(f.base, turn - 1);
      bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
    }
    assert.ok(f.texts.some(text => text.includes('REMOTE-BASH-RESULT')));
    assert.ok(!f.texts.some(text => text.includes('DESKTOP-BASH-RESULT')));
    await bridge.receive(f.inbound('after-bash', 'ordinary reply'));
    assert.equal(f.prompts.at(-1)?.sessionId, `${f.base}-1`);
  });

  test(`${channel}: desktop work after /new keeps its approvals, questions, receipts and completion local`, async t => {
    const f = bridgeFixture({ channel }); const bridge = await f.make(); t.after(() => bridge.close());
    const old = f.sessionOf(f.base);
    old.snapshotEvents().push(...userTurn(1, 'before', 'done', T0));
    await bridge.receive(f.inbound('prime', 'before'));
    await bridge.receive(f.inbound('new', '/new'));
    old.append('turn/start', { turn: 2 });
    old.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'desktop task' }] });
    old.append('tool/call', { turn: 2, callId: 'desktop-task', name: 'coder_task', arguments: '{}' });
    await f.channelWork.record('ct-11111111', old as never, 'desktop-task', f.dir);
    await f.channelWork.bindJob('ct-11111111', 'coder-1');
    const before = f.texts.length;
    const agent = { id: f.base, session: old };
    let desktopApprovals = 0, desktopQuestions = 0;
    assert.equal(await bridge.approve({ agent, callId: 'desktop-task', toolName: 'bash' } as never, async () => { desktopApprovals++; return 'allowed-once'; }), 'allowed-once');
    const questions = [{ id: 'q', question: 'Local question', options: [{ label: 'OK' }] }];
    const answer = { answers: [{ id: 'q', selected: ['OK'] }] };
    assert.deepEqual(await f.channelWork.withQuestions('ct-11111111', questions, () => bridge.ask({ agent, questions } as never, async () => { desktopQuestions++; return answer; })), answer);
    assert.equal(desktopApprovals, 1); assert.equal(desktopQuestions, 1);
    assert.deepEqual(await bridge.ask({ agent, questions, wait: { callId: 'desktop-task' } } as never, async () => answer), answer);
    const result = pushedTurn(3, 'background job coder-1 (coder: Codex [ct-11111111]: build) completed', 'LOCAL-JOB-RESULT', T0);
    for (const event of result) if (event.type === 'user/message') event.data.source = { kind: 'tool-jobs', form: 'notice' };
    old.snapshotEvents().push(...result); f.marks.set(f.base, 2);
    bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
    assert.equal(f.texts.length, before, 'no remote prompt, receipt, or result for the desktop job');
    await bridge.catchUp(); await bridge.drain();
    assert.ok(!f.texts.some(text => text.includes('LOCAL-JOB-RESULT')));
  });

  test(`${channel}: original channel task still asks and reports after later desktop activity`, async t => {
    const f = bridgeFixture({ channel }); const bridge = await f.make(); t.after(() => bridge.close());
    const old = f.sessionOf(f.base);
    old.append('turn/start', { turn: 1 });
    old.append('user/message', { source: { kind: 'user', rpcId: `${channel}-admitted` }, content: [] });
    old.append('tool/call', { turn: 1, callId: 'remote-task', name: 'coder_task', arguments: '{}' });
    await f.channelWork.record('ct-22222222', old as never, 'remote-task', f.dir);
    await f.channelWork.bindJob('ct-22222222', 'coder-2');
    old.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await bridge.receive(f.inbound('prime', 'before'));
    await bridge.receive(f.inbound('new', '/new'));
    old.snapshotEvents().push(...userTurn(2, 'desktop followup', 'local', T0));
    const questions = [{ id: 'q', question: 'Original task approval', options: [{ label: 'OK' }] }];
    const pending = f.channelWork.withQuestions('ct-22222222', questions, () => bridge.ask({ agent: { id: f.base, session: old }, questions } as never, () => new Promise(() => {})));
    await new Promise(resolve => setImmediate(resolve));
    const prompt = f.texts.at(-1)!; assert.match(prompt, /历史.*会话/);
    const token = /回答 ([a-f0-9]{32}) 内容/.exec(prompt)![1];
    await bridge.receive(f.inbound('answer', `/answer ${token} 1`));
    assert.deepEqual((await pending).answers[0]!.selected, ['OK']);
    const acceptance = bridge.ask({ agent: { id: f.base, session: old }, questions, wait: { callId: 'remote-task' } } as never, () => new Promise(() => {}));
    await new Promise(resolve => setImmediate(resolve));
    const acceptanceToken = /回答 ([a-f0-9]{32}) 内容/.exec(f.texts.at(-1)!)![1];
    await bridge.receive(f.inbound('acceptance', `/answer ${acceptanceToken} 1`));
    assert.deepEqual((await acceptance).answers[0]!.selected, ['OK']);
    const result = pushedTurn(3, 'background job coder-2 (coder: Codex [ct-22222222]: build) completed', 'ORIGINAL-REMOTE-JOB', T0);
    for (const event of result) if (event.type === 'user/message') event.data.source = { kind: 'tool-jobs', form: 'notice' };
    old.snapshotEvents().push(...result); f.marks.set(f.base, 2);
    bridge.onEvent(old as never, old.snapshotEvents().at(-1)); await bridge.drain();
    assert.ok(f.texts.some(text => text.includes('ORIGINAL-REMOTE-JOB')));
    await bridge.receive(f.inbound('followup', 'ordinary'));
    assert.equal(f.prompts.at(-1)?.sessionId, `${f.base}-1`);
  });
}
