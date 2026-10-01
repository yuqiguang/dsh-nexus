import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { DownloadProgress } from '../src/coders/install-download.js';
import { registry } from './coder-download-fixture.js';

const require = createRequire(import.meta.url);

async function isolatedWorker(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-standalone-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, 'plugin');
  await cp(new URL('../src/', import.meta.url), join(plugin, 'src'), { recursive: true });
  await writeFile(join(plugin, 'package.json'), '{"type":"module"}');
  // Desktop supplies DSH modules in its own loader. The external Node worker
  // must run with only our download dependencies available, as on a clean install.
  for (const name of ['@npmcli/config', 'npm-registry-fetch', 'cacache']) {
    const target = join(plugin, 'node_modules', name);
    await mkdir(dirname(target), { recursive: true });
    await symlink(dirname(require.resolve(`${name}/package.json`)), target, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const cli = process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    : await (async () => {
      for (const dir of (process.env.PATH ?? '').split(delimiter)) {
        try { return await realpath(join(dir, 'npm')); } catch { /* next PATH entry */ }
      }
      throw new Error('npm CLI required');
    })();
  return { path: join(plugin, 'src/coders/install-worker.js'), cli, plugin };
}

async function runWorker(path: string, cli: string, cwd: string, command = process.execPath) {
  const child = spawn(process.execPath, [path, dirname(dirname(cli)), command, cli,
    'install', '--ignore-scripts', '--omit=optional', '--loglevel=error'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  let output = '', metrics = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { output += chunk; });
  child.stdio[3]!.on('data', chunk => { metrics += chunk; });
  const guard = setTimeout(() => child.kill(), 30_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject); child.on('close', resolve);
    });
    return { code, output, metrics: metrics.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) as (DownloadProgress | { error: string } | null)[] };
  } finally { clearTimeout(guard); }
}

test('standalone worker installs via stock npm without DSH host modules and reuses verified downloads', async t => {
  const r = await registry(t);
  const worker = await isolatedWorker(t);
  const project = join(r.root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture-install', private: true, dependencies: { '@openai/codex': '0.155.1' } }));
  await writeFile(join(project, '.npmrc'), `registry=${r.url}\ncache=${dirname(r.cache)}\naudit=false\nfund=false\n`);
  await assert.rejects(readFile(join(worker.plugin, 'node_modules/@deepseek-ai/dsh-home-paths/package.json')), { code: 'ENOENT' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runWorker(worker.path, worker.cli, project);
    assert.equal(result.code, 0, result.output);
    assert.ok(result.metrics.some(item => item && 'state' in item && item.state === 'verified' && item.bytes === r.bytes.length));
    if (attempt) assert.ok(result.metrics.some(item => item && 'state' in item && item.state === 'cached' && item.bytesPerSecond === 0));
    assert.equal(result.metrics.at(-1), null);
    assert.equal(r.tarRequests(), 1, 'npm and subsequent attempts must reuse the verified tarball');
    assert.equal(JSON.parse(await readFile(join(project, 'node_modules/@openai/codex/package.json'), 'utf8')).version, '0.155.1');
  }
});

test('worker reports missing modules and npm launch failures through safe diagnostics', async t => {
  const worker = await isolatedWorker(t);
  await writeFile(join(worker.plugin, 'package.json'), '{"type":"module","private":true}');
  const launch = await runWorker(worker.path, worker.cli, worker.plugin, join(worker.plugin, 'missing-node'));
  assert.equal(launch.code, 1);
  assert.deepEqual(launch.metrics, [null, { error: 'npm_start_failed' }]);
  await rm(join(worker.plugin, 'src/coders/install-download.js'));
  const missing = await runWorker(worker.path, worker.cli, worker.plugin);
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.metrics, [{ error: 'ERR_MODULE_NOT_FOUND' }]);
  assert.equal(missing.output.trim(), 'ERR_MODULE_NOT_FOUND', 'do not forward raw loader error messages');
});
