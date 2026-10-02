import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coderDirectory, coderWorkspace } from '../src/coders/workspace.js';
import { preflightVerification, verificationNetwork } from '../src/coders/verification-policy.js';

test('native workspace wins over channel defaults and confines relative and absolute project paths', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nexus-workspace-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'desktop'), channel = join(root, 'channel');
  await mkdir(workspace); await mkdir(channel);
  const scope = await coderWorkspace({ workspace, roots: [channel] });
  assert.equal(await coderDirectory(scope), workspace);
  assert.equal(await coderDirectory(scope, 'new-project'), join(workspace, 'new-project'));
  await assert.rejects(coderDirectory(scope, '../channel'), /当前会话工作区/);
  await assert.rejects(coderDirectory(scope, channel), /当前会话工作区/);
  await symlink(channel, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(coderDirectory(scope, 'escape/new-project'), /当前会话工作区/);
});

test('explicit roots intersect the session workspace and read-only sessions cannot dispatch', async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'nexus-restricted-workspace-')));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const child = join(workspace, 'app');
  const scope = await coderWorkspace({ workspace, roots: [child, child], restrictRoots: true });
  assert.deepEqual(scope.roots, [child]);
  await assert.rejects(coderDirectory(scope), /允许范围/);
  assert.equal(await coderDirectory(scope, 'app'), child);
  assert.deepEqual((await coderWorkspace({ workspace, roots: [tmpdir()], restrictRoots: true })).roots, [workspace]);
  await assert.rejects(coderWorkspace({ workspace, roots: [join(workspace, '..', 'unrelated')], restrictRoots: true }), /不在编码工具设置允许/);
  await assert.rejects(coderWorkspace({ workspace, roots: [], mode: 'read-only' }), /只读/);
  await assert.rejects(coderWorkspace({ roots: [] }), /无法确定/);
  assert.deepEqual(await coderWorkspace({ roots: [workspace] }), { workspace, roots: [workspace] });
});

test('verification keeps saved network contracts and preflights unsupported Windows isolation', async () => {
  assert.equal(verificationNetwork(undefined, undefined, 'standard'), 'ask');
  assert.equal(verificationNetwork(undefined, undefined, 'strict'), 'offline');
  assert.equal(verificationNetwork(undefined, 'offline', 'standard'), 'offline');
  assert.equal(verificationNetwork('offline', undefined, 'standard'), 'offline');
  let checks = 0;
  const disabled = async () => { checks++; throw new Error('fixture firewall disabled'); };
  await preflightVerification('win32', 'codex', 'ask', disabled);
  await preflightVerification('linux', 'codex', 'offline', disabled);
  assert.equal(checks, 0);
  await assert.rejects(preflightVerification('win32', 'codex', 'offline', disabled), /任务尚未派发/);
  assert.equal(checks, 1);
  await assert.rejects(preflightVerification('win32', 'claude', 'offline', disabled), /不能强制断网/);
  await assert.rejects(preflightVerification('win32', 'codex', 'loopback', disabled), /隔离回环/);
  assert.equal(checks, 1);
  await preflightVerification('win32', 'codex', 'offline', async () => { checks++; });
  assert.equal(checks, 2);
});
