import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodersManager } from '../src/coders/manager.js';
import { CoderInstaller, managedLayout } from '../src/coders/install.js';
import { CoderSettingsStore } from '../src/coders/settings.js';
import { inspectProject } from '../src/coders/projects.js';
import { taskPermissions } from '../src/coders/permissions.js';
import type { CoderStore } from '../src/coders/store.js';
import type { TaskRecord } from '../src/coders/types.js';
import { MemoryRecords } from './helpers.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'), other = join(root, 'other');
  await mkdir(allowed); await mkdir(other);
  const records = new MemoryRecords(), store = new CoderSettingsStore(records), layout = managedLayout(join(root, 'coders'));
  const make = () => new CodersManager({ store, layout, profileRoots: [allowed], env: { PATH: '', HOME: root },
    installer: new CoderInstaller(layout, async () => { throw new Error('must not install'); }, async () => {}),
    detect: { host: { platform: 'linux', arch: 'x64', musl: false }, pluginSdk: async () => undefined },
    workspaces: () => [{ id: 'workspace-a', title: '已有项目', path: allowed }] });
  return { root, allowed, other, records, store, make, manager: make() };
}

test('project selection works without channel credentials and preserves settings, secrets, and existing task permissions', async t => {
  const f = await fixture(t);
  const initial = await f.store.save(0, { maxConcurrent: 1, securityMode: 'strict', codex: { apiKey: 'project-test-key', model: 'test-model' }, claude: { token: 'project-test-token' } });
  const policy = await taskPermissions(f.allowed, [f.allowed], 'codex');
  const view = await f.manager.handle('project/select', { path: f.allowed, revision: initial.revision });
  assert.equal(view.project?.path, f.allowed); assert.equal(view.project?.allowed, true);
  assert.equal(view.settings.projectRoot, f.allowed);
  assert.equal(view.workspaces?.[0]?.title, '已有项目');
  const saved = await f.store.read();
  assert.deepEqual(saved.codex, initial.codex); assert.deepEqual(saved.claude, initial.claude);
  assert.equal(saved.maxConcurrent, 1); assert.equal(saved.securityMode, 'strict');
  assert.equal(saved.roots, undefined, 'selection within the profile must not freeze or widen its roots');
  assert.equal(JSON.stringify(view).includes('project-test-'), false);
  assert.equal((await f.make().view()).project?.path, f.allowed, 'selected project survives reopening');
  await f.manager.handle('project/select', { path: f.other, revision: saved.revision, allow: true });
  assert.deepEqual(await taskPermissions(f.allowed, [f.allowed, f.other], 'codex', policy), policy, 'a resumed task retains its original policy');
});

test('a new root requires explicit consent and rejects stale writes without changing other configuration', async t => {
  const f = await fixture(t);
  await assert.rejects(f.manager.handle('project/select', { path: f.other, revision: 0 }), /project_permission_required/);
  assert.equal((await f.store.read()).revision, 0);
  const selected = await f.manager.handle('project/select', { path: f.other, revision: 0, allow: true });
  assert.deepEqual(selected.effectiveRoots, [f.allowed, f.other]);
  await assert.rejects(f.manager.handle('project/select', { path: f.allowed, revision: 0, allow: true }), /configuration_changed/);
  assert.equal((await f.store.read()).projectRoot, f.other);
  await f.manager.handle('save', { revision: 1, config: { roots: [f.allowed] } });
  assert.equal((await f.manager.view()).project?.allowed, false, 'revoking access does not silently restore it');
  assert.equal((await f.store.read()).projectRoot, f.other, 'advanced settings preserve project choice');
});

test('recent task navigation is scoped to the selected project, including subdirectories but not sibling prefixes', async t => {
  const f = await fixture(t);
  const tasks: TaskRecord[] = [f.allowed, join(f.allowed, 'app'), f.allowed + '-other'].map((cwd, index) => ({
    id: `task-${index}`, coder: 'codex', status: 'completed', cwd, ownerSession: `session-${index}`, description: 'fixture',
    createdAt: index, updatedAt: index, escalations: 0, decisions: [],
  }));
  f.manager.attach({ list: () => tasks, rules: () => [] } as unknown as CoderStore);
  const view = await f.manager.handle('project/select', { revision: 0, path: f.allowed });
  assert.deepEqual(view.recentTasks.map(task => [task.id, task.ownerSession]), [['task-0', 'session-0'], ['task-1', 'session-1']]);
  assert.match(view.recentTasks[0]!.statusLabel!, /尚未独立验证/);
});

test('canonical directory checks reject links outside the grant, wrong-platform paths, files, and missing directories', async t => {
  const f = await fixture(t);
  const link = join(f.allowed, 'link');
  await symlink(f.other, link, 'dir');
  assert.deepEqual(await inspectProject(link, [f.allowed]), { path: f.other, allowed: false });
  await assert.rejects(f.manager.handle('project/select', { path: link, revision: 0 }), /project_permission_required/);
  const file = join(f.allowed, 'file.txt'); await writeFile(file, 'fixture');
  for (const path of ['relative', 'C:\\Projects\\demo', join(f.root, 'missing'), file]) {
    await assert.rejects(f.manager.handle('project/select', { path, revision: 0, allow: true }), /project_directory_unavailable/);
  }
  const view = await f.manager.handle('project/select', { path: link, revision: 0, allow: true });
  assert.equal(view.project?.path, f.other, 'persist and show the actual directory');
  await rm(f.other, { recursive: true });
  const unavailable = await f.manager.view();
  assert.equal(unavailable.project?.problem, 'project_directory_unavailable');
  assert.equal(unavailable.project?.allowed, false);
});
