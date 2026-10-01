import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, taskPermissions } from '../src/coders/permissions.js';
import { taskMinutes, networkDomains } from '../src/coders/settings.js';
import { taskSchema } from '../src/coders/store.js';
import { threadPolicyDrift } from '../src/coders/codex.js';
import { decideLayers } from '../src/coders/decide.js';

test('task scopes use real paths, reject symlink escapes and keep their budget when resumed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-scope-'));
  try {
    const project = join(root, 'project'), outside = join(root, 'other');
    await mkdir(project); await mkdir(outside); await symlink(outside, join(project, 'escape'));
    await assert.rejects(taskPermissions(join(project, 'escape'), [project], 'codex'), /真实路径/);
    assert.equal(await canonical(join(project, 'escape', 'new.txt')), join(outside, 'new.txt'));
    const original = await taskPermissions(project, [root], 'codex', undefined, 10);
    const resumed = await taskPermissions(project, [root], 'codex', original, 240);
    assert.deepEqual(resumed, original);
    assert.equal(resumed.maxDurationMs, 600_000);
    await assert.rejects(taskPermissions(outside, [root], 'codex', original), /不能扩大权限/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Codex must confirm the requested boundary, not just echo workspace-write', async () => {
  const policy = await taskPermissions(process.cwd(), [process.cwd()], 'codex');
  const response = { approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
  assert.equal(threadPolicyDrift(response, policy), undefined);
  assert.ok(threadPolicyDrift({}, policy));
  assert.ok(threadPolicyDrift({ ...response, sandbox: { ...response.sandbox, networkAccess: true } }, policy));
  assert.ok(threadPolicyDrift({ ...response, sandbox: { ...response.sandbox, writableRoots: ['/'] } }, policy));
});

test('task persistence retains permission snapshots, stop reasons, verification and block identities', async () => {
  const policy = await taskPermissions(process.cwd(), [process.cwd()], 'claude');
  const task = taskSchema.parse({ id: 'ct-1', coder: 'claude', description: 'task', cwd: process.cwd(), permissions: policy,
    status: 'interrupted', stopReason: 'budget', ownerSession: 'owner', createdAt: 1, updatedAt: 2, escalations: 0,
    decisions: [{ at: 1, kind: 'command', summary: 'no', layer: 'hard', outcome: 'deny', blockKey: 'same' }],
    result: { summary: 'saved', changedFiles: [], outsideRoots: [], execution: 'stopped', verification: 'not-run' } });
  assert.deepEqual(task.permissions, policy);
  assert.equal(task.decisions[0]!.blockKey, 'same');
  assert.equal(task.stopReason, 'budget');
  assert.equal(task.result!.verification, 'not-run');
});

test('an otherwise routine command cannot auto-approve a network or additional-permission request', () => {
  for (const raw of [{ networkApprovalContext: { host: 'example.test' } }, { additionalPermissions: { network: true } }, { reason: 'retry outside sandbox' }]) {
    assert.equal(decideLayers({ kind: 'command', tool: 'codex.command', summary: 'test', detail: 'npm test', paths: [], raw }, [process.cwd()], [], process.cwd()).layer, 'user');
  }
  assert.equal(taskMinutes(undefined), 60);
  for (const value of [0, 241, 1.5, '60', Infinity]) assert.throws(() => taskMinutes(value));
});


test('network grants accept exact domains only and never credentials or authenticated URLs', () => {
  assert.deepEqual(networkDomains(undefined), ['registry.npmjs.org']);
  assert.deepEqual(networkDomains('EXAMPLE.COM\nexample.com\n'), ['example.com']);
  assert.deepEqual(networkDomains([]), []);
  for (const input of ['https://example.com', '*.example.com', 'user:secret@example.com', 'example.com/path', 'example.com?token=secret'])
    assert.throws(() => networkDomains(input));
});


test('whole-turn permission grants cannot bypass the fixed task policy', () => {
  assert.equal(decideLayers({ kind: 'network', tool: 'codex.permissions', summary: 'grant', detail: '', paths: [], raw: { permissions: { network: { enabled: true } } } }, [process.cwd()], [], process.cwd()).layer, 'hard');
});

test('native research is separate from command networking and old permission snapshots', async () => {
  const cwd = process.cwd();
  const policy = await taskPermissions(cwd, [cwd], 'claude');
  assert.equal(policy.webResearch, true);
  const legacy = { ...policy }; delete legacy.webResearch;
  assert.equal((await taskPermissions(cwd, [cwd], 'claude', legacy)).webResearch, undefined);
  const request = (tool: string, raw: Record<string, unknown>) => ({ kind: 'network' as const, tool, raw, summary: 'research', detail: '', paths: [] });
  const search = request('WebSearch', { query: 'Python pathlib documentation' });
  assert.equal(decideLayers(search, [cwd], [], cwd, true).layer, 'auto');
  assert.equal(decideLayers(search, [cwd], [], cwd).layer, 'user');
  assert.equal(decideLayers(request('WebFetch', { url: 'https://docs.python.org/3/' }), [cwd], [], cwd, true).layer, 'auto');
  for (const url of ['http://localhost/', 'http://127.1/', 'http://[::1]/', 'http://192.168.1.2/', 'http://metadata.google.internal/', 'file:///etc/passwd', 'https://user:secret@example.com/', 'http://example.com:8080/', 'not a url'])
    assert.equal(decideLayers(request('WebFetch', { url }), [cwd], [], cwd, true).layer, 'user', url);
  assert.equal(decideLayers(request('unknown-network-tool', { url: 'https://example.com' }), [cwd], [], cwd, true).layer, 'user');
  assert.equal(decideLayers({ ...search, kind: 'command', tool: 'codex.command', raw: { networkApprovalContext: { host: 'docs.python.org' } } }, [cwd], [], cwd, true).layer, 'user');
  assert.equal(decideLayers({ ...search, tool: 'codex.permissions' }, [cwd], [], cwd, true).layer, 'hard');
});

test('built-in routine-command rules cannot approve extra network or sandbox permissions', () => {
  for (const raw of [{ additionalPermissions: { network: true } }, { reason: 'retry outside sandbox' }]) {
    const request = { kind: 'command' as const, tool: 'codex.command', command: 'true', summary: 'true', detail: 'true', paths: [], raw };
    assert.equal(decideLayers(request, [process.cwd()], [], process.cwd()).layer, 'user');
  }
});

test('standard mode is snapshotted, confirmed by Codex, and never added to a legacy resume', async () => {
  const cwd = process.cwd();
  const standard = await taskPermissions(cwd, [cwd], 'codex', undefined, 60, [], true, 'standard');
  const response = { approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: true } };
  assert.equal(threadPolicyDrift(response, standard), undefined);
  assert.ok(threadPolicyDrift({ ...response, sandbox: { ...response.sandbox, networkAccess: false } }, standard));
  const legacy = await taskPermissions(cwd, [cwd], 'claude'); delete legacy.securityMode;
  assert.deepEqual(await taskPermissions(cwd, [cwd], 'claude', legacy, 60, [], true, 'standard'), legacy);
  assert.deepEqual(await taskPermissions(cwd, [cwd], 'codex', standard, 60, [], true, 'strict'), standard);
  const persisted = taskSchema.parse({ id: 'ct-standard', coder: 'claude', cwd, description: 'test', status: 'running', ownerSession: 'owner', createdAt: 0, updatedAt: 0,
    permissions: await taskPermissions(cwd, [cwd], 'claude', undefined, 60, [], true, 'standard'), escalations: 0, decisions: [] });
  assert.equal(persisted.permissions!.isolation, 'dsh-supervised');
  assert.equal(persisted.permissions!.securityMode, 'standard');
});

test('standard commands reach DSH review; strict Claude cannot escape and high-impact actions need the owner', () => {
  const cwd = process.cwd();
  const request = { kind: 'command' as const, tool: 'Bash', command: 'npm install --ignore-scripts', summary: 'install', detail: 'npm install --ignore-scripts', paths: [], raw: { dangerouslyDisableSandbox: true } };
  assert.equal(decideLayers(request, [cwd], [], cwd, true).layer, 'hard');
  assert.equal(decideLayers(request, [cwd], [], cwd, true, true).layer, 'user');
  const dangerous = decideLayers({ ...request, command: 'git push', detail: 'git push' }, [cwd], [], cwd, true, true);
  assert.equal(dangerous.layer, 'user');
  assert.equal(dangerous.layer === 'user' && dangerous.manualOnly, true);
  assert.equal(decideLayers({ ...request, detail: 'cat ~/.ssh/id_rsa' }, [cwd], [], cwd, true, true).layer, 'hard');
});
