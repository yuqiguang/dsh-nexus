import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { DshChannelBridge } from '../src/dsh/bridge.js';
import { interruptedNotice, interruptedWork } from '../src/dsh/recovery.js';
import { BridgeRegistry } from '../src/channels/notify.js';
import { sessionIdFor, type ChannelTransport } from '../src/channels/protocol.js';
import { handleHealth, handleNotice, healthSnapshot, isLoopback, readBuildInfo } from '../src/service/health.js';
import { IDLE_MS, busyReason, failedTestCount, planUpdate, recoverDist, reportedTestCount, rollbackReason, updateFailureNotice } from '../src/service/update.js';
import { FAILURES_BEFORE_RESTART, RESTART_COOLDOWN_MS, decide } from '../src/service/healthcheck.js';
import { RESTART_REASON_FILE, RUN_FILE, recordStart, recordStop, restartNotice, startLifecycle, takeRestartReason } from '../src/service/lifecycle.js';

const T0 = Date.parse('2026-09-20T10:00:00+08:00');

test('npm test reports parseable counts through the updater pipe for passing and failing staged tests', async () => {
  const staged = await mkdtemp(join(tmpdir(), 'nexus-update-tests-'));
  try {
    await mkdir(join(staged, 'test'));
    const fixture = join(staged, 'test', 'reporter.test.js');
    const env: NodeJS.ProcessEnv = { ...process.env, NEXUS_DIST: staged, FORCE_COLOR: '0' };
    // A nested runner must execute its fixture instead of inheriting this test worker's context.
    delete env.NODE_TEST_CONTEXT;
    for (const failing of [false, true]) {
      await writeFile(fixture, `require('node:test')('fixture', () => { ${failing ? "throw new Error('fixture failure');" : ''} });\n`);
      const result = spawnSync('npm', ['test'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), env,
        encoding: 'utf8', stdio: 'pipe', timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, failing ? 1 : 0, result.stderr);
      assert.equal(reportedTestCount(result.stdout), 1, result.stdout);
      assert.equal(failedTestCount(result.stdout), failing ? 1 : 0, result.stdout);
    }
  } finally { await rm(staged, { recursive: true, force: true }); }
});

test('the health check restarts only after consecutive failures, only a managed unit, and not twice within the cooldown', () => {
  const ok = { ok: true as const, snapshot: { channels: [{ channel: 'wechat', phase: 'connected' }], coders: { active: ['ct-1'] }, heldPushes: 2, uptimeMs: 120_000 } };
  const down = { ok: false as const, error: 'ECONNREFUSED' };
  let state = decide({ failures: 0 }, ok, T0, true).state;
  assert.deepEqual(state, { failures: 0, lastOkAt: T0, lastError: undefined });
  assert.match(decide(state, ok, T0, true).line, /ok up=2m wechat=connected coders=1 held=2/);
  const lines: string[] = [];
  for (let index = 1; index < FAILURES_BEFORE_RESTART; index++) {
    const step = decide(state, down, T0 + index * 60_000, true);
    assert.equal(step.restart, undefined, `no restart after ${index} failures`);
    lines.push(step.line);
    state = step.state;
  }
  assert.match(lines[0]!, /FAIL 1\/3 ECONNREFUSED/);
  const unmanaged = decide(state, down, T0 + 3 * 60_000, false);
  assert.equal(unmanaged.restart, undefined);
  assert.match(unmanaged.line, /not managed by systemd/);
  const restart = decide(state, down, T0 + 3 * 60_000, true);
  assert.equal(restart.restart, '连续 3 次健康检查失败（ECONNREFUSED）');
  assert.deepEqual([restart.state.failures, restart.state.lastRestartAt], [0, T0 + 3 * 60_000]);
  // Still down right after the restart: count again, but do not restart inside the cooldown.
  state = restart.state;
  for (let index = 1; index <= FAILURES_BEFORE_RESTART; index++) state = decide(state, down, T0 + (3 + index) * 60_000, true).state;
  assert.match(decide(state, down, T0 + 7 * 60_000, true, true).line, /an update is in progress, not restarting/);
  assert.equal(decide(state, down, T0 + 7 * 60_000, true, true).restart, undefined);
  const waiting = decide(state, down, T0 + 7 * 60_000, true);
  assert.equal(waiting.restart, undefined);
  assert.match(waiting.line, /restarted 4m ago, waiting/);
  const again = decide(state, down, T0 + 3 * 60_000 + RESTART_COOLDOWN_MS, true);
  assert.ok(again.restart);
  assert.equal(decide(state, ok, T0 + 8 * 60_000, true).state.failures, 0, 'one good probe clears the count');
});

test('the health route answers loopback GETs with a snapshot and refuses anything else', async () => {
  const sources = { startedAt: T0, now: () => T0 + 90_000, async channels() { return [{ channel: 'wechat', enabled: true, phase: 'connected' }]; }, coders: () => ['ct-9'], heldPushes: () => 1 };
  const snapshot = await healthSnapshot(sources);
  assert.deepEqual(snapshot, { ok: true, startedAt: T0, now: T0 + 90_000, uptimeMs: 90_000, channels: [{ channel: 'wechat', enabled: true, phase: 'connected' }], coders: { active: ['ct-9'] }, heldPushes: 1,
    runningTurns: 0, idleMs: 90_000 });
  const detailed = await healthSnapshot({ ...sources, runningTurns: () => 2, lastActivityAt: () => T0 + 80_000, commit: 'abc1234def' });
  assert.deepEqual([detailed.runningTurns, detailed.idleMs, detailed.commit], [2, 10_000, 'abc1234def']);
  const call = async (method: string, remoteAddress: string) => {
    const headers: Record<string, string> = {};
    let status = 0;
    let body = '';
    const response = { set statusCode(value: number) { status = value; }, setHeader(name: string, value: string) { headers[name] = value; }, end(chunk: string) { body = chunk; } };
    await handleHealth(sources, { method, socket: { remoteAddress } } as never, response as never);
    return { status, headers, body: JSON.parse(body) };
  };
  const good = await call('GET', '127.0.0.1');
  assert.equal(good.status, 200);
  assert.equal(good.headers['cache-control'], 'no-store');
  assert.equal(good.body.ok, true);
  assert.equal((await call('GET', '::1')).status, 200);
  assert.equal((await call('GET', '10.0.0.5')).status, 403, 'the route is for the local health check only');
  assert.equal((await call('POST', '127.0.0.1')).status, 405);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback(undefined), false);
  const failing = { ...sources, async channels(): Promise<never> { throw new Error('view broke'); } };
  let status = 0;
  await handleHealth(failing, { method: 'GET', socket: { remoteAddress: '127.0.0.1' } } as never, { set statusCode(value: number) { status = value; }, setHeader() {}, end() {} } as never);
  assert.equal(status, 500);
});

test('the notice route relays a local updater message to the bound chats and refuses anything else', async () => {
  const sent: [string, string][] = [];
  const sources = { startedAt: T0, async channels() { return []; }, coders: () => [], heldPushes: () => 0, async notify(text: string, id: string) { sent.push([id, text]); return true; } };
  const call = async (method: string, remoteAddress: string, body: string, src: Omit<typeof sources, 'notify'> & Partial<Pick<typeof sources, 'notify'>> = sources) => {
    let status = 0;
    let out = '';
    const request = Object.assign(Readable.from([Buffer.from(body)]), { method, socket: { remoteAddress } });
    await handleNotice(src, request as never, { set statusCode(value: number) { status = value; }, setHeader() {}, end(chunk: string) { out = chunk; } } as never);
    return { status, body: JSON.parse(out) };
  };
  const ok = await call('POST', '127.0.0.1', JSON.stringify({ text: '自动更新失败', id: 'update-abc1234-test' }));
  assert.deepEqual([ok.status, ok.body, sent], [200, { delivered: true }, [['update-abc1234-test', '自动更新失败']]]);
  assert.equal((await call('POST', '10.0.0.5', '{}')).status, 403);
  assert.equal((await call('GET', '127.0.0.1', '')).status, 405);
  assert.equal((await call('POST', '127.0.0.1', 'not json')).status, 400);
  assert.equal((await call('POST', '127.0.0.1', JSON.stringify({ text: 'x', id: 'bad id!' }))).status, 400, 'ids are plain tokens');
  assert.equal((await call('POST', '127.0.0.1', JSON.stringify({ text: '', id: 'x' }))).status, 400);
  const { notify: _notify, ...silent } = sources;
  assert.equal((await call('POST', '127.0.0.1', JSON.stringify({ text: 'x', id: 'x' }), silent)).status, 501);
  assert.equal(sent.length, 1);
});

test('build info is read from the file the build writes and ignored when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-build-'));
  assert.equal(readBuildInfo(new URL(`file://${join(dir, 'missing.json')}`)), undefined);
  await writeFile(join(dir, 'build-info.json'), JSON.stringify({ commit: 'abc', subject: 'feat: x', builtAt: T0, dirty: false, extra: 1 }));
  assert.deepEqual(readBuildInfo(new URL(`file://${join(dir, 'build-info.json')}`)), { commit: 'abc', subject: 'feat: x', builtAt: T0, dirty: false });
});

test('the updater builds only a clean, committed HEAD that differs from what runs, restarts only an idle managed service, and gives up on a commit that failed', () => {
  const quiet = { runningTurns: 0, idleMs: IDLE_MS + 1, coders: { active: [] }, channels: [{ channel: 'wechat', pendingDeliveries: 0 }] };
  assert.equal(busyReason(quiet), undefined);
  assert.equal(busyReason({ ...quiet, runningTurns: 1 }), '有 1 个回合正在执行');
  assert.equal(busyReason({ ...quiet, coders: { active: ['ct-1', 'ct-2'] } }), '有 2 个编码任务进行中');
  assert.equal(busyReason({ ...quiet, channels: [{ channel: 'wechat', pendingDeliveries: 3 }] }), '有 3 条消息等待投递');
  assert.equal(busyReason({ ...quiet, idleMs: 30_000 }), '30 秒前还有活动');
  assert.equal(busyReason({}), undefined, 'an old service without the fields counts as quiet');
  const base = { head: 'aaaaaaa1', dirty: false, built: 'aaaaaaa1', running: 'aaaaaaa1', healthy: true, managed: true, state: {} };
  assert.deepEqual(planUpdate(base), { action: 'none', reason: '已是 aaaaaaa' });
  assert.deepEqual(planUpdate({ ...base, head: '' }), { action: 'skip', reason: '不在 git 仓库里' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', dirty: true }), { action: 'skip', reason: '工作树有未提交的改动' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', state: { failedCommit: 'bbbbbbb2' } }), { action: 'skip', reason: 'bbbbbbb 上次更新失败，等新的提交' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', managed: false }), { action: 'skip', reason: '服务不是 systemd 管理的，请手动构建并重启' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', healthy: false, running: undefined }), { action: 'skip', reason: '服务没有响应健康检查，交给健康检查处理' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', busy: '有 1 个回合正在执行' }), { action: 'skip', reason: '有 1 个回合正在执行' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2' }), { action: 'build', reason: 'aaaaaaa → bbbbbbb' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', built: undefined }), { action: 'build', reason: '未知版本 → bbbbbbb' });
  assert.deepEqual(planUpdate({ ...base, head: 'bbbbbbb2', built: 'bbbbbbb2' }), { action: 'restart', reason: '已构建 bbbbbbb，运行中的是 aaaaaaa' });
  // A commit that already failed is still skipped when the tree is otherwise ready; a new commit clears the way.
  assert.equal(planUpdate({ ...base, head: 'ccccccc3', state: { failedCommit: 'bbbbbbb2' } }).action, 'build');
  assert.equal(failedTestCount('ℹ tests 167\nℹ pass 165\nℹ fail 2\n'), 2);
  assert.equal(failedTestCount('no summary'), undefined);
  assert.equal(reportedTestCount('ℹ tests 167\nℹ pass 165\n'), 167);
  assert.equal(reportedTestCount('ℹ tests 0\nℹ pass 0\n'), 0, 'a missing dist matches nothing and the runner still exits 0');
  assert.equal(reportedTestCount('no summary'), undefined);
  assert.equal(updateFailureNotice('test', 'bbbbbbb2', 'feat: voice', 'aaaaaaa1', '2 个测试失败'),
    '自动更新到 bbbbbbb「feat: voice」失败：单元测试未通过（2 个测试失败）。服务仍在运行 aaaaaaa。这个提交不会再自动尝试，修好后提交新版本即可。');
  assert.equal(updateFailureNotice('start', 'bbbbbbb2', undefined, undefined),
    '自动更新到 bbbbbbb 失败：新版本启动后没有恢复健康。已回退到上一版本。这个提交不会再自动尝试，修好后提交新版本即可。');
  assert.equal(rollbackReason('bbbbbbb2', 'aaaaaaa1'), '自动更新到 bbbbbbb 后服务没有在 90 秒内恢复健康，已回退到 aaaaaaa');
  assert.deepEqual(recoverDist({ previous: true, next: true }), ['restore-previous', 'drop-staged']);
  assert.deepEqual(recoverDist({ previous: true, next: false }), ['restore-previous']);
  assert.deepEqual(recoverDist({ previous: false, next: true }), ['drop-staged']);
  assert.deepEqual(recoverDist({ previous: false, next: false }), []);
  assert.match(restartNotice(T0, undefined, { at: T0, reason: '自动更新到 bbbbbbb', kind: 'update', version: 'bbbbbbb', subject: 'feat: voice' })!,
    /^Nexus 已在 9\/20 10:00 自动更新到 bbbbbbb「feat: voice」并重新启动。更新时没有进行中的任务。$/);
  assert.match(restartNotice(T0, undefined, { at: T0, reason: rollbackReason('bbbbbbb2', 'aaaaaaa1'), kind: 'rollback' })!,
    /^自动更新到 bbbbbbb 后服务没有在 90 秒内恢复健康，已回退到 aaaaaaa。服务已在 9\/20 10:00 重新启动，重启前未完成的任务和等待中的审批会另行通知。$/);
});

test('the run record tells a clean stop from a crash, and the restart notice says which it was', async () => {
  const home = await mkdtemp(join(tmpdir(), 'nexus-lifecycle-'));
  assert.equal(recordStart(home, T0, 100), undefined, 'the first start has no previous run');
  assert.deepEqual(JSON.parse(await readFile(join(home, RUN_FILE), 'utf8')), { startedAt: T0, pid: 100 });
  // A second start finds the first run never stopped: a crash.
  const crashed = recordStart(home, T0 + 60_000, 101);
  assert.deepEqual(crashed, { startedAt: T0, pid: 100 });
  assert.match(restartNotice(T0 + 60_000, crashed, undefined)!, /^服务在 9\/20 10:01 重新启动。上一次运行（9\/20 10:00 开始）没有正常停止的记录/);
  // recordStop only marks the run this process owns.
  recordStop(home, T0 + 120_000);
  assert.equal(JSON.parse(await readFile(join(home, RUN_FILE), 'utf8')).clean, undefined, 'another pid may not mark our run');
  await writeFile(join(home, RUN_FILE), JSON.stringify({ startedAt: T0 + 60_000, pid: process.pid }));
  recordStop(home, T0 + 120_000);
  const stopped = JSON.parse(await readFile(join(home, RUN_FILE), 'utf8'));
  assert.deepEqual(stopped, { startedAt: T0 + 60_000, pid: process.pid, stoppedAt: T0 + 120_000, clean: true });
  assert.equal(restartNotice(T0 + 180_000, stopped, undefined), undefined, 'a deploy restart is silent');
  // The health check's note wins and is consumed.
  await writeFile(join(home, RESTART_REASON_FILE), JSON.stringify({ at: T0, reason: '连续 3 次健康检查失败（timeout）' }));
  const reason = takeRestartReason(home);
  assert.equal(reason?.reason, '连续 3 次健康检查失败（timeout）');
  assert.equal(takeRestartReason(home), undefined, 'the note is removed once read');
  assert.match(restartNotice(T0, stopped, reason)!, /^服务在 9\/20 10:00 由健康检查重新启动：连续 3 次健康检查失败（timeout）。/);
  // End to end: a crash is announced to every bound session and the stop hook marks the run clean.
  await writeFile(join(home, RUN_FILE), JSON.stringify({ startedAt: T0, pid: 7 }));
  const sent: [string, string][] = [];
  let dispose: (() => void) | undefined;
  const notice = await startLifecycle({ home, notifier: { async notify(sessionId, text) { sent.push([sessionId, text]); return true; } }, sessions: () => ['s1', 's2'], now: () => T0 + 5000 }, fn => { dispose = fn; });
  assert.match(notice!, /没有正常停止的记录/);
  assert.deepEqual(sent.map(([id]) => id), ['s1', 's2']);
  dispose!();
  assert.equal(JSON.parse(await readFile(join(home, RUN_FILE), 'utf8')).clean, true);
  assert.equal(await startLifecycle({ home, notifier: { async notify() { return true; } }, sessions: () => ['s1'] }, () => {}), undefined, 'after a clean stop nothing is said');
});

type Ev = { type: string; data: any; seq: number; time: number };
const ev = (seq: number, type: string, data: any): Ev => ({ type, data, seq, time: T0 + seq * 1000 });

test('an interrupted turn is described by what it was waiting for: approvals, questions, and unfinished tool calls', () => {
  assert.equal(interruptedWork([ev(0, 'turn/start', { turn: 1 }), ev(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } })] as never), undefined);
  const open = [
    ev(0, 'turn/start', { turn: 4 }),
    ev(1, 'assistant/message', { turn: 4, step: 1, message: { content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"rm -rf dist","description":"清理构建产物"}' }] } }),
    ev(2, 'tool/call', { turn: 4, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"rm -rf dist","description":"清理构建产物"}' }),
    ev(3, 'approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }),
  ];
  const work = interruptedWork(open as never)!;
  assert.deepEqual([work.turn, work.startedAt, work.approvals, work.questions, work.inFlight], [4, T0, ['bash：清理构建产物'], [], []]);
  assert.equal(interruptedNotice(work), '服务重启打断了上一轮（9/20 10:00 开始）。\n当时在等你审批：bash：清理构建产物\n这些操作都没有完成。回复“继续”让我接着处理，或直接提出新的要求。');
  // Decided approvals, answered questions, and finished calls are not pending; crash repair's synthetic results do not count as outcomes.
  const repaired = [
    ev(0, 'turn/start', { turn: 5 }),
    ev(1, 'tool/call', { turn: 5, step: 1, callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'db', question: '用哪个数据库？' }] }) }),
    ev(2, 'tool/call', { turn: 5, step: 1, callId: 'r1', name: 'read', arguments: '{"path":"a.txt"}' }),
    ev(3, 'tool/result', { turn: 5, step: 1, message: { source: { kind: 'tool', callId: 'r1' }, content: [] } }),
    ev(4, 'approval/asked', { id: 'a2', toolName: 'bash', callId: 'x' }),
    ev(5, 'approval/decided', { id: 'a2', outcome: 'rejected' }),
    ev(6, 'tool/call', { turn: 5, step: 1, callId: 'w1', name: 'write', arguments: '{"path":"b.txt"}' }),
    ev(7, 'tool/result', { turn: 5, step: 1, message: { source: { kind: 'tool', callId: 'q1' }, content: [] }, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } }),
    ev(8, 'tool/result', { turn: 5, step: 1, message: { source: { kind: 'tool', callId: 'w1' }, content: [] }, error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' } }),
    ev(9, 'step/end', { turn: 5, step: 1 }),
    ev(10, 'turn/end', { turn: 5, reason: { kind: 'interrupted' } }),
  ];
  const later = interruptedWork(repaired as never)!;
  assert.deepEqual([later.turn, later.approvals, later.questions, later.inFlight], [5, [], ['用哪个数据库？'], ['write']]);
  assert.match(interruptedNotice(later, 'UTC'), /9\/20 02:00 开始/);
  assert.equal(interruptedWork([...repaired, ev(11, 'turn/start', { turn: 6 }), ev(12, 'turn/end', { turn: 6, reason: { kind: 'aborted', reason: 'x' } })] as never), undefined, 'a later turn that ended on its own means nothing is pending');
  const bare = interruptedWork([ev(0, 'turn/start', { turn: 7 })] as never)!;
  assert.equal(interruptedNotice(bare), '服务重启打断了上一轮（9/20 10:00 开始）。\n回复“继续”让我接着处理，或直接提出新的要求。');
});

function fixture() {
  const owner = { channel: 'wechat' as const, accountId: 'r-bot', ownerId: 'r-owner' };
  const sessionId = sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat');
  const texts: string[] = [];
  const events: Ev[] = [];
  const session = { id: sessionId, snapshotEvents: () => events };
  const ctx = {
    sessionController: { async create() {}, async resolveAgent(id: string) { return id === sessionId ? { agent: { id, session } } : { error: new Error('no') }; }, async prompt() {} },
    sessions: { async flush() { return true; }, get: () => session }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  const marks = new Map<string, number>();
  const ledger = { get: (id: string) => marks.get(id), async set(id: string, turn: number) { if ((marks.get(id) ?? -1) < turn) marks.set(id, turn); } };
  const failing = new Set<string>();
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { if (failing.has(text)) throw new Error('down'); texts.push(text); } };
  const reports: string[] = [];
  const bridge = new DshChannelBridge(ctx, transport, owner, '/fx', code => reports.push(code), { firstMs: 60_000, everyMs: 300_000 }, () => T0, { ledger });
  let seq = 0;
  const push = (type: string, data: unknown) => { events.push(ev(seq++, type, data)); return events.at(-1)!; };
  const turn = (n: number, reply: string, reason: unknown = { kind: 'completed' }) => {
    push('turn/start', { turn: n });
    push('user/message', { id: `u${n}`, role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } });
    push('assistant/message', { turn: n, message: { content: [{ type: 'text', text: reply }] } });
    return push('turn/end', { turn: n, reason });
  };
  return { bridge, texts, events, session, sessionId, push, turn, marks, failing, reports };
}

test('catch-up delivers the turns nobody sent, reports the turn a crash left open, and never replays a session seen for the first time', async () => {
  const f = fixture();
  // Existing history before the ledger existed: only a mark, nothing sent.
  f.turn(1, '旧回复一');
  f.turn(2, '旧回复二');
  await f.bridge.catchUp();
  assert.deepEqual(f.texts, []);
  assert.equal(f.marks.get(f.sessionId), 2);
  // A live delivery marks the turn; a failed one does not.
  const three = f.turn(3, '正常送达');
  f.bridge.onEvent(f.session as never, three as never);
  await f.bridge.drain();
  assert.deepEqual(f.texts, ['正常送达']);
  assert.equal(f.marks.get(f.sessionId), 3);
  f.failing.add('发送失败的那条');
  const four = f.turn(4, '发送失败的那条');
  f.bridge.onEvent(f.session as never, four as never);
  await f.bridge.drain();
  assert.deepEqual(f.reports, ['channel_delivery_failed']);
  assert.equal(f.marks.get(f.sessionId), 3);
  // A turn the crash left open, closed by repair, with an approval that never got its answer.
  f.push('turn/start', { turn: 5 });
  f.push('tool/call', { turn: 5, step: 1, callId: 'c5', name: 'bash', arguments: '{"command":"npm publish","description":"发布"}' });
  f.push('approval/asked', { id: 'a5', toolName: 'bash', callId: 'c5' });
  f.push('turn/end', { turn: 5, reason: { kind: 'interrupted' } });
  f.failing.clear();
  await f.bridge.catchUp();
  assert.deepEqual(f.texts, ['正常送达', '发送失败的那条', '服务重启打断了上一轮（9/20 10:00 开始）。\n当时在等你审批：bash：发布\n这些操作都没有完成。回复“继续”让我接着处理，或直接提出新的要求。']);
  assert.equal(f.marks.get(f.sessionId), 5);
  // Catching up again sends nothing; a late live event for a caught-up turn is ignored.
  await f.bridge.catchUp();
  f.bridge.onEvent(f.session as never, four as never);
  await f.bridge.drain();
  assert.equal(f.texts.length, 3);
  // A turn that ends live while a first-seen session is being marked is still delivered: the mark alone never suppresses a live reply.
  const g = fixture();
  g.turn(1, '历史');
  const live = g.turn(2, '刚好在标记时结束');
  const marking = g.bridge.catchUp();
  g.bridge.onEvent(g.session as never, live as never);
  await marking;
  await g.bridge.drain();
  assert.deepEqual(g.texts, ['刚好在标记时结束']);
  assert.equal(g.marks.get(g.sessionId), 2);
  // A log that still ends inside a turn (the session could not be resumed and repaired) is reported once.
  f.push('turn/start', { turn: 6 });
  f.push('tool/call', { turn: 6, step: 1, callId: 'q6', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'x', question: '要继续吗？' }] }) });
  await f.bridge.catchUp();
  await f.bridge.catchUp();
  assert.equal(f.texts.length, 4);
  assert.match(f.texts[3]!, /当时在等你回答：要继续吗？/);
  assert.equal(f.marks.get(f.sessionId), 6);
});

test('a bridge mounted after startup catches up at once', async () => {
  const registry = new BridgeRegistry();
  const calls: string[] = [];
  const stub = (name: string) => ({ bound: () => [] as string[], async inject() { return false; }, setPushGate() {}, async notify() { return false; }, async catchUp() { calls.push(name); } });
  registry.add(stub('early'));
  assert.deepEqual(calls, [], 'before startup ends, mounting does not catch up');
  await registry.catchUp();
  assert.deepEqual(calls, ['early']);
  registry.add(stub('late'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['early', 'late']);
});
