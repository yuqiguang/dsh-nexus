import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CoderInstaller, MANAGED_PACKAGES, detectCodex, managedCodexBinary, managedLayout, npmInvocation, onPath, platformPackage, readMarker, type HostPlatform } from '../src/coders/install.js';
import { CodersManager } from '../src/coders/manager.js';
import { CoderSettingsStore } from '../src/coders/settings.js';
import { MemoryRecords } from './helpers.js';

const windows: HostPlatform = { platform: 'win32', arch: 'x64', musl: false };
async function temp(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-windows-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function file(path: string, content = 'fixture') {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

test('Windows discovery ignores POSIX wrappers, directories and relative PATH entries and accepts Path casing', async t => {
  const root = await temp(t);
  await file(join(root, 'codex'));
  await mkdir(join(root, 'codex.exe'));
  assert.equal(await onPath('codex', { Path: `.;"${root}"` }, 'win32'), undefined);
  await file(join(root, 'codex.cmd'));
  assert.equal(await onPath('codex', { Path: `.;"${root}"` }, 'win32'), join(root, 'codex.cmd'));
  await rm(join(root, 'codex.exe'), { recursive: true });
  await file(join(root, 'codex.exe'));
  assert.equal(await onPath('codex', { PATH: root }, 'win32'), join(root, 'codex.exe'));
});

test('Windows npm uses its Node entry with paths kept as argv, never a batch command', async t => {
  const root = join(await temp(t), '空 格 & %nexus%');
  const npm = join(root, 'npm.cmd');
  const node = join(root, 'node.exe');
  const cli = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await file(npm); await file(node); await file(cli);
  assert.deepEqual(await npmInvocation('npm', { Path: root }, 'win32'), { command: node, args: [cli] });
  await rm(cli);
  await assert.rejects(npmInvocation('npm', { Path: root }, 'win32'), /npm_launcher_missing/);
  await assert.rejects(npmInvocation('npm', { Path: '' }, 'win32'), /npm_not_found/);
  assert.deepEqual(await npmInvocation('npm', {}, 'linux'), { command: 'npm', args: [] });
});

test('Windows managed installs require the native executable; an npm shim alone never marks success', async t => {
  const layout = managedLayout(await temp(t));
  const binary = managedCodexBinary(layout, windows);
  const installer = new CoderInstaller(layout, async () => {
    await file(join(layout.nodeModules, '.bin', 'codex'));
    await file(join(layout.nodeModules, '.bin', 'codex.cmd'));
    return { code: 0 };
  }, async () => {}, Date.now, windows);
  await installer.start('codex');
  assert.equal(installer.progress()?.phase, 'failed');
  assert.equal(await readMarker(layout, 'codex'), undefined);
  await file(binary);
  await installer.start('codex');
  assert.equal(installer.progress()?.phase, 'installed');
  const detected = await detectCodex(layout, { host: windows, env: { Path: '' } });
  assert.deepEqual(detected.managed, { installed: true, version: MANAGED_PACKAGES.codex.version, path: binary });
  const manifest = JSON.parse(await readFile(join(layout.root, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@openai/codex-win32-x64'], 'npm:@openai/codex@0.155.1-win32-x64');
  assert.match(managedCodexBinary(layout, { ...windows, arch: 'arm64' }), /aarch64-pc-windows-msvc/);
  assert.throws(() => managedCodexBinary(layout, { ...windows, arch: 'ia32' }), /unsupported_codex_arch/);
});

test('Windows system Codex resolves a known npm shim to its native binary without executing the shim', async t => {
  const root = await temp(t);
  const layout = managedLayout(join(root, 'managed'));
  await file(join(root, 'codex.cmd'), 'exit /b 99');
  const npmLayout = managedLayout(root);
  await file(join(npmLayout.nodeModules, '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.155.1' }));
  await file(join(npmLayout.nodeModules, '@openai', 'codex-win32-x64', 'package.json'), JSON.stringify({ name: '@openai/codex-win32-x64', version: '0.155.1-win32-x64' }));
  const binary = managedCodexBinary(npmLayout, windows);
  await file(binary);
  const detection = await detectCodex(layout, { host: windows, env: { Path: root }, probe: async (command, args) => {
    assert.equal(command, binary); assert.deepEqual(args, ['--version']); return { ok: true, output: 'codex-cli 0.155.1' };
  } });
  assert.equal(detection.system.installed, true);
  assert.equal(detection.system.path, binary);
  await rm(binary);
  const broken = await detectCodex(layout, { host: windows, env: { Path: root }, probe: async () => { throw new Error('must not run batch files'); } });
  assert.equal(broken.system.problem, 'windows_launcher_unsupported');
});

test('Windows standard mode permits Claude; Codex keeps readiness and strict Claude remains blocked', async t => {
  const layout = managedLayout(await temp(t));
  await file(managedCodexBinary(layout, windows));
  await file(join(layout.nodeModules, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'));
  const claude = platformPackage('claude', windows);
  await file(join(layout.nodeModules, claude.name, claude.binary));
  for (const coder of ['codex', 'claude'] as const) {
    await file(join(layout.markers, coder + '.json'), JSON.stringify({ coder, version: MANAGED_PACKAGES[coder].version, platformPackage: platformPackage(coder, windows).name, at: 1 }));
  }
  const store = new CoderSettingsStore(new MemoryRecords());
  await store.save(0, { codex: { source: 'managed', apiKey: 'fixture-key' }, claude: { source: 'managed', token: 'fixture-token' } });
  let configured = false;
  const manager = new CodersManager({ store, layout, profileRoots: [layout.root], installer: new CoderInstaller(layout), env: { Path: '' },
    windowsSandbox: async (_launch, _cwd, setup) => { if (setup) configured = true; return configured ? 'ready' : 'notConfigured'; },
    detect: { host: windows, pluginSdk: async () => undefined } });
  const view = await manager.view();
  for (const coder of ['codex', 'claude'] as const) {
    assert.equal(view[coder].managed.installed, true);
    assert.equal(view[coder].ready, coder === 'claude');
    assert.equal('error' in (await manager.runtime())[coder], coder === 'codex');
  }
  assert.equal(view.codex.windowsSandbox, 'notConfigured');
  assert.equal(view.claude.platformProblem, undefined);
  assert.ok('error' in (await manager.runtime('strict')).claude);
  const ready = await manager.handle('windows-sandbox/setup', {});
  assert.equal(ready.codex.windowsSandbox, 'ready');
  assert.equal(ready.codex.ready, true);
  assert.equal(ready.claude.ready, true);
  assert.equal(JSON.stringify(view).includes('fixture-token'), false);
});
