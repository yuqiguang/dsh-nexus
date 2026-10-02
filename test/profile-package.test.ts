import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { bundleProfilePatch, ensureProfilePackage } = await import(new URL('../../scripts/profile-package.mjs', import.meta.url).href) as {
  bundleProfilePatch(patch: any[], root: string): { patch: any[]; converted: number };
  ensureProfilePackage(options: { root: string; home: string; install(args: any): Promise<void> }): Promise<{ status: string; converted: number }>;
};
const sourceRows = (root: string) => [{ insert: [
  { id: 'nexus-channels', name: pathToFileURL(join(root, 'dist/src/plugin.js')).href,
    config: { workspaceRoot: '/keep', coderRoots: ['/restricted'], configFile: '/private/env' } },
  { id: 'nexus-memory', name: pathToFileURL(join(root, 'dist/src/memory/plugin.js')).href, disabled: false },
  { id: 'nexus-mail', name: pathToFileURL(join(root, 'dist/src/connectors/mail/plugin.js')).href, disabled: true },
  { id: 'nexus-agenda', name: pathToFileURL(join(root, 'dist/src/connectors/agenda/plugin.js')).href, disabled: true },
] }];

test('source entries become native overrides without changing permissions, settings or override precedence', () => {
  const root = '/source with spaces';
  const input = [...sourceRows(root), { id: 'nexus-memory', name: pathToFileURL(join(root, 'dist/src/memory/plugin.js')).href, disabled: true },
    { id: 'unrelated', config: { value: 7 } }];
  const before = structuredClone(input);
  const result = bundleProfilePatch(input, root);
  assert.equal(result.converted, 4);
  assert.deepEqual(input, before);
  assert.deepEqual(result.patch[0], { id: 'nexus-channels', config: sourceRows(root)[0]!.insert[0]!.config });
  assert.deepEqual(result.patch[1], { id: 'nexus-memory', disabled: false });
  assert.deepEqual(result.patch[4], { id: 'nexus-memory', name: 'dsh-nexus/memory', disabled: true });
  assert.deepEqual(result.patch[5], before[2]);
  assert.deepEqual(bundleProfilePatch(result.patch, root), { patch: result.patch, converted: 0 });
});

test('foreign implementations of the same component id are refused; unrelated insertions survive', () => {
  const patch = sourceRows('/project');
  patch[0]!.insert.push({ id: 'foreign', name: 'some-package' } as any);
  const result = bundleProfilePatch(patch, '/project');
  assert.deepEqual(result.patch[0], { insert: [{ id: 'foreign', name: 'some-package' }] });
  assert.throws(() => bundleProfilePatch(sourceRows('/other'), '/project'), /conflicting_nexus_insertion/);
});

async function fixture(run: (value: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-profile-package-'));
  const home = join(root, 'runtime');
  const profile = join(home, 'profiles/nexus');
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }));
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(sourceRows(root)));
  const writeBuild = async (commit: string) => {
    await writeFile(join(root, 'dist/plugin.tgz'), commit);
    await writeFile(join(root, 'dist/build-info.json'), JSON.stringify({ commit, builtAt: commit === 'old' ? 1 : 2 }));
  };
  await writeBuild('old');
  const installed: string[] = [];
  const install = async () => {
    const info = JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8'));
    installed.push(info.commit);
    const path = join(profile, 'node_modules/dsh-nexus/dist');
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'build-info.json'), JSON.stringify(info));
    const file = join(profile, 'package.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    const existing = !!manifest.dependencies?.['dsh-nexus'];
    manifest.dependencies = { 'dsh-nexus': 'fixture' };
    if (!existing) manifest.dsh.profile.bundles.push('dsh-nexus');
    await writeFile(file, JSON.stringify(manifest));
  };
  try { await run({ root, home, profile, install, installed, writeBuild }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('failed install leaves original source entries and application data unchanged', async () => fixture(async ({ root, home, profile }) => {
  const patch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8');
  await writeFile(join(home, 'fixture-data'), 'retained');
  await assert.rejects(ensureProfilePackage({ root, home, install: async () => { throw new Error('offline_failure'); } }), /offline_failure/);
  assert.equal(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.equal(await readFile(join(home, 'fixture-data'), 'utf8'), 'retained');
}));

test('first install converts once; restart preserves component and bundle disablement', async () => fixture(async (f) => {
  assert.deepEqual(await ensureProfilePackage(f), { status: 'installed', converted: 4 });
  const file = join(f.profile, 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.dsh.profile.bundles = [];
  await writeFile(file, JSON.stringify(manifest));
  const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8');
  assert.deepEqual(await ensureProfilePackage(f), { status: 'current', converted: 0 });
  assert.deepEqual(f.installed, ['old']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).dsh.profile.bundles, []);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
}));

test('a changed build installs again; restoring the old build restores its packaged snapshot', async () => fixture(async (f) => {
  await ensureProfilePackage(f);
  const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8');
  await f.writeBuild('new');
  await ensureProfilePackage(f);
  await f.writeBuild('old');
  await ensureProfilePackage(f);
  assert.deepEqual(f.installed, ['old', 'new', 'old']);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
}));

test('explicit uninstall is not reversed by source startup', async () => fixture(async (f) => {
  await ensureProfilePackage(f);
  const file = join(f.profile, 'package.json');
  await writeFile(file, JSON.stringify({ dsh: { profile: { bundles: [] } } }));
  assert.deepEqual(await ensureProfilePackage(f), { status: 'uninstalled', converted: 0 });
  assert.deepEqual(f.installed, ['old']);
}));

test('a concurrent settings edit is never overwritten by the installer', async () => fixture(async (f) => {
  const changed = JSON.stringify([{ id: 'nexus-memory', disabled: true }]);
  await assert.rejects(ensureProfilePackage({ ...f, install: async () => {
    await f.install();
    await writeFile(join(f.profile, 'cordis.patch.yml'), changed);
  } }), /profile_changed_during_install/);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), changed);
}));
