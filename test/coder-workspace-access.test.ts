import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { WorkspaceAccess } from '../src/coders/workspace-access.js';

const call = (cwd: string, name = 'write', args: object = { file_path: 'new.txt' }, signal = new AbortController().signal) =>
  ({ name, arguments: args, signal, agent: { id: 'owner', session: { header: { cwd } } } }) as ToolExecution;
const job = (type: string, id = 'bash-1') => ({ type, job: { id, owner: 'owner' } }) as never;

test('direct mutators and coders exclude each other across a Git worktree; readers and controls remain available', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-direct-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = join(root, 'child'); await mkdir(child);
  execFileSync('git', ['init', '-q', root]);
  const access = new WorkspaceAccess(); t.after(() => access.close());
  const held = await access.acquire(root, new AbortController().signal);
  for (const [name, args] of [['write', { file_path: 'new.txt' }], ['edit', { file_path: 'new.txt' }], ['str_replace_editor', { command: 'create', path: join(child, 'new.txt') }], ['bash', { command: 'echo fixture' }], ['pwsh', { command: 'echo fixture' }], ['load_workspace_dependencies', {}]] as const) {
    await assert.rejects(access.withTool(call(child, name, args), async () => assert.fail('conflicting operation executed')), /工作区正在执行|另一个会话/);
  }
  for (const name of ['read', 'coder_status', 'coder_steer', 'coder_task', 'run_code', 'job_output']) assert.equal(await access.withTool(call(child, name), async () => 'available'), 'available');
  assert.equal(await access.withTool(call(child, 'str_replace_editor', { command: 'view' }), async () => 'read'), 'read');
  held();
  let finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const direct = access.withTool(call(child), async () => { entered(); await new Promise<void>(resolve => { finish = resolve; }); });
  await started;
  let coderStarted = false;
  const coder = access.acquire(root, new AbortController().signal).then(release => { coderStarted = true; return release; });
  await Promise.resolve(); assert.equal(coderStarted, false);
  finish(); await direct; (await coder)();
  await assert.rejects(access.withTool(call(child), async () => { throw new Error('fixture failure'); }), /fixture failure/);
  (await access.acquire(root, new AbortController().signal))();
});

test('native background leases survive the tool receipt, allow independent projects and release after settlement/cancellation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-direct-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = join(root, 'a'), b = join(root, 'b'); await mkdir(a); await mkdir(b);
  const access = new WorkspaceAccess(); t.after(() => access.close());
  await access.withTool(call(a, 'bash', { command: 'fixture', run_in_background: true }), async () => {
    access.jobEvent(job('registered'));
    // A nested native mutation under the same execution does not deadlock.
    await access.withTool(call(a), async () => {});
    return { job_id: 'bash-1' };
  });
  const other = { ...call(a), agent: { id: 'other', session: { header: { cwd: a } } } } as ToolExecution;
  await assert.rejects(access.withTool(other, async () => {}), /另一个会话/);
  await access.withTool(call(b), async () => {});
  const cancelled = new AbortController();
  const queued = assert.rejects(access.acquire(a, cancelled.signal), /cancelled/);
  cancelled.abort(); await queued;
  access.jobEvent(job('settled'));
  await access.withTool(call(a), async () => {});
  const held = await access.acquire(b, new AbortController().signal);
  await assert.rejects(access.withTool(call(a, 'bash', { command: 'fixture', workdir: b }), async () => {}), /工作区正在执行|另一个会话/);
  await symlink(b, join(a, 'linked'));
  await assert.rejects(access.withTool(call(a, 'write', { file_path: 'linked/new.txt' }), async () => {}), /工作区正在执行|另一个会话/);
  held();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(access.withTool(call(a, 'write', { file_path: 'new.txt' }, aborted.signal), async () => assert.fail('aborted call ran')));
  (await access.acquire(a, new AbortController().signal))();
});

test('a session and its subagents keep working beside their own background jobs; coders and other sessions stay excluded', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-direct-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const access = new WorkspaceAccess(); t.after(() => access.close());
  const as = (agent: { id: string; parent?: string }, name = 'bash', args: object = { command: 'fixture' }) =>
    ({ name, arguments: args, signal: new AbortController().signal, agent: { id: agent.id, session: { header: { cwd: root, parentSession: agent.parent } } } }) as ToolExecution;
  const owner = { id: 'owner' };
  await access.withTool(as(owner, 'bash', { command: 'uvicorn', run_in_background: true }), async () => { access.jobEvent(job('registered')); return {}; });
  assert.equal(await access.withTool(as(owner, 'edit', { file_path: 'a.txt' }), async () => 'own edit'), 'own edit');
  assert.equal(await access.withTool(as({ id: 'sub', parent: 'owner' }, 'pwsh'), async () => 'subagent'), 'subagent');
  // A nested subagent is known through the delegating call its parent made.
  await access.withTool(as({ id: 'sub', parent: 'owner' }, 'agent', {}), async () => {});
  assert.equal(await access.withTool(as({ id: 'nested', parent: 'sub' }, 'edit', { file_path: 'b.txt' }), async () => 'nested'), 'nested');
  await assert.rejects(access.withTool(as({ id: 'other' }), async () => assert.fail('other session ran')), /另一个会话/);
  // A job started beside the shared lease keeps it alive after the first job settles.
  await access.withTool(as(owner, 'bash', { command: 'pytest', run_in_background: true }), async () => { access.jobEvent(job('registered', 'bash-2')); return {}; });
  access.jobEvent(job('settled'));
  await assert.rejects(access.withTool(as({ id: 'other' }), async () => {}), /另一个会话/);
  access.jobEvent(job('settled', 'bash-2'));
  const coder = await access.acquire(root, new AbortController().signal);
  await assert.rejects(access.withTool(as(owner), async () => assert.fail('ran beside coder')), /编码任务/);
  coder();
});

test('the dispatcher runtime lookup is not blocked by a running coder in the same workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-direct-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const access = new WorkspaceAccess(); t.after(() => access.close());
  const held = await access.acquire(root, new AbortController().signal);
  const lookup = { ...call(root, 'load_workspace_dependencies', {}), callId: 'call-1:coder-runtime' } as ToolExecution;
  assert.equal(await access.withTool(lookup, async () => 'loaded'), 'loaded');
  await assert.rejects(access.withTool({ ...lookup, callId: 'call-1' } as ToolExecution, async () => assert.fail('model call ran')), /编码任务/);
  held();
});
