import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { FileLedger, LEDGER_LIMITS, filesDomain, findFiles, installFileFind, scanWorkspace, type FilesDomain } from '../src/files/index.js';
import { DshChannelBridge } from '../src/dsh/bridge.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';

const T0 = Date.parse('2026-09-21T10:00:00+08:00');
const DAY = 86_400_000;

function fakeOpener() {
  const records = new Map<string, unknown>();
  const table = {
    get: (key: string) => records.get(key), entries: () => [...records.entries()][Symbol.iterator](), keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size; },
    async put(key: string, value: unknown) { records.set(key, structuredClone(value)); },
    async delete(key: string) { return records.delete(key); },
  };
  const domain = { name: filesDomain.name, table: () => table, async close() {} } as unknown as FilesDomain;
  return { opener: { async open() { return domain; } }, records };
}

async function ledgerAt(clock: { now: number }) {
  return FileLedger.open(fakeOpener().opener, () => clock.now, () => 'Asia/Shanghai');
}

test('the ledger finds a file by what the user asked for, not only by name, newest first, and a date narrows it', async () => {
  const clock = { now: T0 };
  const ledger = await ledgerAt(clock);
  await ledger.record({ kind: 'inbound', path: 'inbox/2026-09-21/合同.pdf', name: '合同.pdf', bytes: 8, sessionId: 's1', request: '帮我看看这份租房合同有没有坑' });
  clock.now += DAY;
  await ledger.record({ kind: 'outbound', path: 'outputs/预算表.xlsx', name: '预算表.xlsx', bytes: 900, sessionId: 's1', request: '做一份预算表，房租 3000', note: '预算表已生成，合计是公式。' });
  clock.now += DAY;
  await ledger.record({ kind: 'outbound', path: 'outputs/作文.docx', name: '作文.docx', bytes: 1200, sessionId: 's1', request: '写一篇 500 字作文存成 Word', note: '已写好并发送。' });
  assert.deepEqual(ledger.find('租房', 10).map(r => r.path), ['inbox/2026-09-21/合同.pdf'], 'matched through the recorded request');
  assert.deepEqual(ledger.find('预算', 10).map(r => r.path), ['outputs/预算表.xlsx']);
  assert.deepEqual(ledger.find('', 10).map(r => r.path), ['outputs/作文.docx', 'outputs/预算表.xlsx', 'inbox/2026-09-21/合同.pdf'], 'an empty query lists newest first');
  assert.deepEqual(ledger.find('', 10, '2026-09-22').map(r => r.path), ['outputs/预算表.xlsx']);
  assert.deepEqual(ledger.find('', 10, '2026-09').length, 3);
  assert.deepEqual(ledger.find('房东', 10), [], 'no shared term means no hit rather than a guess');
});

test('recording the same file for the same request again updates instead of duplicating, and long texts are clipped', async () => {
  const clock = { now: T0 };
  const ledger = await ledgerAt(clock);
  const request = '看'.repeat(LEDGER_LIMITS.requestChars + 50);
  const first = await ledger.record({ kind: 'inbound', path: 'inbox/2026-09-21/a.pdf', name: 'a.pdf', bytes: 1, sessionId: 's1', request });
  clock.now += 1000;
  const second = await ledger.record({ kind: 'inbound', path: 'inbox/2026-09-21/a.pdf', name: 'a.pdf', bytes: 1, sessionId: 's1', request });
  assert.equal(second.id, first.id);
  assert.equal(second.at, T0, 'the original time is kept');
  assert.equal(ledger.list().length, 1);
  assert.equal(second.request!.length, LEDGER_LIMITS.requestChars + 1);
  assert.ok(second.request!.endsWith('…'));
  // The same path presented again in a different turn is a new event: the user got it twice.
  await ledger.record({ kind: 'outbound', path: 'outputs/x.docx', name: 'x.docx', bytes: 2, sessionId: 's1', request: '发我' });
  await ledger.record({ kind: 'outbound', path: 'outputs/x.docx', name: 'x.docx', bytes: 2, sessionId: 's1', request: '再发一次' });
  assert.equal(ledger.list().filter(r => r.path === 'outputs/x.docx').length, 2);
});

test('file_find renders ledger hits with their context and adds workspace files the ledger never saw', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-ledger-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'inbox', '2026-09-20'), { recursive: true });
  await mkdir(join(workspace, 'outputs', 'deep', 'er'), { recursive: true });
  await writeFile(join(workspace, 'inbox', '2026-09-20', '合同-旧版.pdf'), 'old');
  await writeFile(join(workspace, 'outputs', 'deep', 'er', 'Report-Q3.xlsx'), 'q3');
  await writeFile(join(workspace, 'outputs', 'notes.txt'), 'n');
  await writeFile(join(workspace, 'secret.txt'), 'not scanned: outside inbox and outputs');
  await utimes(join(workspace, 'inbox', '2026-09-20', '合同-旧版.pdf'), new Date(T0 - DAY), new Date(T0 - DAY));
  await utimes(join(workspace, 'outputs', 'deep', 'er', 'Report-Q3.xlsx'), new Date(T0), new Date(T0));
  await utimes(join(workspace, 'outputs', 'notes.txt'), new Date(T0 - 2 * DAY), new Date(T0 - 2 * DAY));
  const clock = { now: T0 };
  const ledger = await ledgerAt(clock);
  await ledger.record({ kind: 'inbound', path: 'inbox/2026-09-21/合同.pdf', name: '合同.pdf', bytes: 8, sessionId: 's1', request: '帮我看看这份租房合同' });
  clock.now += DAY;
  const deps = { ctx: {} as Context, workspace, ledger, timeZone: () => 'Asia/Shanghai' };
  const text = await findFiles(deps, '合同');
  const lines = text.split('\n');
  assert.equal(lines.length, 2, text);
  assert.match(lines[0]!, /^9\/21 10:00 收到 inbox\/2026-09-21\/合同\.pdf（8 B），当时的事：帮我看看这份租房合同$/);
  assert.match(lines[1]!, /^9\/20 10:00 工作区 inbox\/2026-09-20\/合同-旧版\.pdf（3 B），没有收发记录$/);
  assert.match(await findFiles(deps, 'report q3'), /^9\/21 10:00 工作区 outputs\/deep\/er\/Report-Q3\.xlsx（2 B），没有收发记录$/, 'name match is case-insensitive');
  assert.match(await findFiles(deps, '合同', 10, '2026-09-20'), /^9\/20 10:00 工作区 inbox\/2026-09-20\/合同-旧版\.pdf/, 'date filters scanned files too');
  assert.match(await findFiles(deps, 'secret'), /没有找到和“secret”相关的文件/);
  assert.deepEqual((await scanWorkspace(workspace, '', 10)).map(f => f.path), ['outputs/deep/er/Report-Q3.xlsx', 'inbox/2026-09-20/合同-旧版.pdf', 'outputs/notes.txt'], 'newest first, only inbox/ and outputs/');
});

test('the tool registers as file_find, clamps limit, and treats a blank date as none', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-ledger-tool-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // A channel session works in its own directory, so the scan must follow it rather than the boot-time one.
  const channelWorkspace = await mkdtemp(join(tmpdir(), 'nexus-ledger-channel-'));
  t.after(() => rm(channelWorkspace, { recursive: true, force: true }));
  await mkdir(join(channelWorkspace, 'outputs'), { recursive: true });
  await writeFile(join(channelWorkspace, 'outputs', 'channel.txt'), 'c');
  await mkdir(join(workspace, 'outputs'), { recursive: true });
  await writeFile(join(workspace, 'outputs', 'boot.txt'), 'b');
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }>();
  const ctx = { effect(fn: () => unknown) { fn(); }, tools: { register(tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }) { tools.set(tool.name, tool); return () => {}; } } } as unknown as Context;
  const ledger = await ledgerAt({ now: T0 });
  for (let i = 0; i < 40; i++) await ledger.record({ kind: 'outbound', path: `outputs/f${i}.txt`, name: `f${i}.txt`, bytes: i, sessionId: 's1', request: '批量' });
  installFileFind({ ctx, workspace, ledger, timeZone: () => 'Asia/Shanghai' });
  const tool = tools.get('file_find')!;
  assert.ok(tool);
  const exec = { agent: { session: { header: { cwd: channelWorkspace } } } };
  assert.equal((await tool.execute({ query: '批量', limit: 100, date: ' ' }, exec)).text.split('\n').length, 30);
  assert.equal((await tool.execute({ query: '批量', limit: 0 }, exec)).text.split('\n').length, 1);
  assert.equal((await tool.execute({ query: '' }, exec)).text.split('\n').length, 10);
  assert.match((await tool.execute({ query: 'channel' }, exec)).text, /outputs\/channel\.txt/, 'files are scanned from the session directory');
  assert.match((await tool.execute({ query: 'boot' }, exec)).text, /没有找到/, 'not from the boot-time workspace');
});

test('the bridge records every saved attachment with the user\'s text and every presented file with its request and reply', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-ledger-bridge-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const owner = { channel: 'wechat' as const, accountId: 'l-bot', ownerId: 'l-owner' };
  const sessionId = sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat');
  const events: any[] = [];
  const session = { id: sessionId, snapshotEvents: () => events };
  const ctx = {
    sessionController: { async create() {}, async resolveAgent() { return { agent: { id: sessionId, session } }; }, async prompt() {} },
    sessions: { async flush() { return true; }, get: () => session }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  const sent: string[] = [];
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile(_chat, file) { sent.push(file.name); }, async sendText() {} };
  const ledger = await ledgerAt({ now: T0 });
  const bridge = new DshChannelBridge(ctx, transport, owner, workspace, () => {}, undefined, () => T0, { files: ledger });
  t.after(() => bridge.close());
  const inbound: InboundMessage = { messageId: 'm1', text: '这份合同帮我看看', chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p',
    attachments: [{ kind: 'file', name: '合同.pdf', bytes: Buffer.from('%PDF-1.4') }] };
  await bridge.receive(inbound);
  const [saved] = ledger.list();
  assert.equal(saved!.kind, 'inbound');
  assert.match(saved!.path, /^inbox\/\d{4}-\d{2}-\d{2}\/合同\.pdf$/);
  assert.equal(saved!.request, '这份合同帮我看看');
  assert.equal(saved!.sessionId, sessionId);
  // The model presents a workspace file at the end of a turn the user started.
  await mkdir(join(workspace, 'outputs'), { recursive: true });
  await writeFile(join(workspace, 'outputs', '预算表.xlsx'), 'xlsx-bytes');
  let seq = 0;
  const push = (type: string, data: unknown) => { events.push({ type, data, seq: seq++ }); return events.at(-1); };
  push('turn/start', { turn: 1 });
  push('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '做一份预算表发我' }], source: { kind: 'user' } });
  push('deliverables/presented', { turn: 1, files: [{ path: 'outputs/预算表.xlsx' }] });
  push('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '预算表做好了，合计是公式。' }] } });
  bridge.onEvent(session as never, push('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await bridge.drain();
  assert.deepEqual(sent, ['预算表.xlsx']);
  const out = ledger.list().find(r => r.kind === 'outbound')!;
  assert.equal(out.path, 'outputs/预算表.xlsx');
  assert.equal(out.bytes, 10);
  assert.equal(out.request, '做一份预算表发我');
  assert.equal(out.note, '预算表做好了，合计是公式。');
  assert.equal(ledger.find('预算', 5)[0]!.id, out.id);
  // A push turn (reminder) that presents nothing and a failed delivery record nothing.
  push('turn/start', { turn: 2 });
  push('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: '[提醒]' }], source: { kind: 'plugin', pluginId: 'schedule' } });
  push('deliverables/presented', { turn: 2, files: [{ path: 'outputs/missing.xlsx' }] });
  push('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '发你。' }] } });
  bridge.onEvent(session as never, push('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await bridge.drain();
  assert.equal(ledger.list().length, 2, 'a file that could not be delivered is not recorded as sent');
});
