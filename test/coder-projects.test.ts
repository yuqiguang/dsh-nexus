import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodersManager } from '../src/coders/manager.js';
import { CoderInstaller, managedLayout } from '../src/coders/install.js';
import { CoderSettingsStore, SETTINGS_KEY } from '../src/coders/settings.js';
import type { CoderStore } from '../src/coders/store.js';
import type { TaskRecord } from '../src/coders/types.js';
import { MemoryRecords } from './helpers.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-projects-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = join(root, 'allowed'); await mkdir(allowed);
  const records = new MemoryRecords(), store = new CoderSettingsStore(records), layout = managedLayout(join(root, 'coders'));
  const manager = new CodersManager({ store, layout, profileRoots: [allowed], env: { PATH: '', HOME: root },
    installer: new CoderInstaller(layout, async () => { throw new Error('must not install'); }),
    detect: { host: { platform: 'linux', arch: 'x64', musl: false }, pluginSdk: async () => undefined } });
  return { root, allowed, records, store, manager };
}

test('retiring the project picker preserves legacy secrets and grants without requiring the old directory', async t => {
  const f = await fixture(t);
  const saved = await f.store.save(0, { roots: [f.allowed], maxConcurrent: 1,
    codex: { apiKey: 'legacy-codex-secret', model: 'test-model' }, claude: { token: 'legacy-claude-secret' } });
  f.records.values.set(SETTINGS_KEY, { ...saved, projectRoot: join(f.root, 'no-longer-exists') });
  const view = await f.manager.handle('list', {});
  assert.equal('project' in view, false); assert.equal('workspaces' in view, false);
  assert.equal('projectRoot' in view.settings, false);
  assert.deepEqual(view.effectiveRoots, [f.allowed]);
  assert.equal(view.restrictRoots, true);
  assert.doesNotMatch(JSON.stringify(view), /legacy-.*-secret|no-longer-exists/);
  await assert.rejects(f.manager.handle('project/select', { revision: 1, path: f.root, allow: true }), /unknown_action/);
  const after = await f.manager.handle('save', { revision: 1, config: { roots: [f.allowed], maxConcurrent: 2, codex: { model: saved.codex.model } } });
  assert.deepEqual(after.effectiveRoots, [f.allowed]);
  const stored = await f.store.read();
  assert.deepEqual(stored.codex, saved.codex); assert.deepEqual(stored.claude, saved.claude);
  assert.equal(stored.projectRoot, join(f.root, 'no-longer-exists'));
});

test('recent tasks include every workspace with original session links and a ten-item limit despite a legacy project filter', async t => {
  const f = await fixture(t);
  const saved = await f.store.save(0, {});
  f.records.values.set(SETTINGS_KEY, { ...saved, projectRoot: f.allowed });
  const tasks: TaskRecord[] = Array.from({ length: 12 }, (_, index) => ({
    id: `task-${index}`, coder: 'codex', status: 'completed', cwd: index % 2 ? join(f.root, 'other') : f.allowed,
    ownerSession: `session-${index}`, description: 'fixture', createdAt: index, updatedAt: index, escalations: 0, decisions: [],
  }));
  f.manager.attach({ list: () => tasks, rules: () => [] } as unknown as CoderStore);
  const view = await f.manager.handle('list', {});
  assert.equal(view.restrictRoots, false);
  assert.deepEqual(view.recentTasks.map(task => [task.id, task.ownerSession, task.cwd]), tasks.slice(0, 10).map(task => [task.id, task.ownerSession, task.cwd]));
  assert.match(view.recentTasks[0]!.statusLabel!, /尚未独立验证/);
});
