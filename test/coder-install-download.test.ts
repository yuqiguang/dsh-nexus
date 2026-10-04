import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { downloadPackages, downloadTargets, npmDownloadOptions, type DownloadProgress } from '../src/coders/install-download.js';
import { createNpmRunner, onPath } from '../src/coders/install.js';

import { hermeticNpmConfig, registry } from './coder-download-fixture.js';

const require = createRequire(import.meta.url);
const dependencies = { '@openai/codex': '0.155.1' };

test('download targets preserve pinned npm aliases and skip unpinned or unrelated packages', () => {
  assert.deepEqual(downloadTargets({ ...dependencies, '@openai/codex-win32-x64': 'npm:@openai/codex@0.155.1-win32-x64',
    '@anthropic-ai/claude-agent-sdk': '^0.3.273', unrelated: '1.0.0' }), [
    { name: '@openai/codex', version: '0.155.1' }, { name: '@openai/codex', version: '0.155.1-win32-x64' },
  ]);
});

test('download reports actual bytes and rates, verifies the package and reuses npm digest caches without network speed', async t => {
  const r = await registry(t);
  const progress: DownloadProgress[] = [];
  await downloadPackages(dependencies, r.options, item => progress.push(item), undefined, Date.now, 20);
  assert.equal(r.tarRequests(), 1); assert.equal(r.authed(), true);
  assert.ok(progress.some(item => item.state === 'downloading' && item.bytesPerSecond > 0 && item.bytes > 0));
  assert.equal(progress.at(-1)?.state, 'verified');
  assert.equal(progress.at(-1)?.bytes, r.bytes.length);
  assert.equal(progress.at(-1)?.total, r.bytes.length);
  assert.doesNotMatch(JSON.stringify(progress), /fixture-secret/);
  const cached: DownloadProgress[] = [];
  await downloadPackages(dependencies, r.options, item => cached.push(item), undefined, Date.now, 20);
  assert.equal(r.tarRequests(), 1);
  assert.ok(cached.some(item => item.state === 'cached'));
  assert.ok(cached.every(item => item.bytesPerSecond === 0));
  // Stock npm's cache may contain a digest without an HTTP URL entry.
  const digestOnly = join(r.root, 'digest-cache');
  await require('cacache').put(digestOnly, 'pacote:tarball:fixture', r.bytes, { integrity: r.integrity });
  await downloadPackages(dependencies, { ...r.options, cache: digestOnly }, () => {});
  assert.equal(r.tarRequests(), 1);
});

test('unknown content length stays unknown and corrupted packages are not reported as verified', async t => {
  const unknown = await registry(t, 'unknown-size');
  const progress: DownloadProgress[] = [];
  await downloadPackages(dependencies, unknown.options, item => progress.push(item), undefined, Date.now, 20);
  assert.equal(progress.at(-1)?.bytes, unknown.bytes.length);
  assert.ok(progress.every(item => item.total === undefined));
  const corrupt = await registry(t, 'corrupt');
  const failed: DownloadProgress[] = [];
  await assert.rejects(downloadPackages(dependencies, corrupt.options, item => failed.push(item)), { code: 'EINTEGRITY' });
  assert.ok(failed.every(item => item.state !== 'verified'));
});

test('an interrupted body retries with reset counters and marks only the fully verified attempt complete', async t => {
  const r = await registry(t, 'reset-once');
  const progress: DownloadProgress[] = [];
  await downloadPackages(dependencies, r.options, item => progress.push(item), undefined, Date.now, 20);
  assert.equal(r.tarRequests(), 2);
  assert.ok(progress.some(item => item.state === 'retrying' && item.attempt === 2 && item.bytes === 0));
  assert.equal(progress.at(-1)?.bytes, r.bytes.length);
  assert.equal(progress.at(-1)?.state, 'verified');
});

test('the npm worker reports progress and stock npm installs from its verified cache', async t => {
  const r = await registry(t); await hermeticNpmConfig(t, r.root);
  const project = join(r.root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture-install', private: true, dependencies }));
  await writeFile(join(project, '.npmrc'), `registry=${r.url}\ncache=${dirname(r.cache)}\naudit=false\nfund=false\n`);
  const metrics: (DownloadProgress | undefined)[] = [], output: string[] = [];
  const result = await createNpmRunner()(['install', '--ignore-scripts', '--omit=optional', '--loglevel=error'], project,
    text => output.push(text), new AbortController().signal, item => metrics.push(item));
  assert.equal(result.code, 0, output.join(''));
  assert.ok(metrics.some(item => item?.state === 'verified'));
  assert.equal(metrics.at(-1), undefined, 'the install stage resumes after prefetch');
  assert.equal(r.tarRequests(), 1, 'npm must reuse the verified content instead of redownloading');
  assert.equal(JSON.parse(await readFile(join(project, 'node_modules/@openai/codex/package.json'), 'utf8')).version, '0.155.1');
});

test('aborting the npm worker stops a stalled download before npm can install it', async t => {
  const r = await registry(t, 'hanging'); await hermeticNpmConfig(t, r.root);
  const project = join(r.root, 'project'); await mkdir(project);
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'fixture-abort', private: true, dependencies }));
  await writeFile(join(project, '.npmrc'), `registry=${r.url}\ncache=${dirname(r.cache)}\n`);
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 5000); t.after(() => clearTimeout(guard));
  const result = await createNpmRunner('npm', 100)(['install', '--ignore-scripts'], project, () => {}, controller.signal,
    item => { if (item?.state === 'downloading') controller.abort(); });
  assert.equal(result.error, 'install_timeout');
  await assert.rejects(readFile(join(project, 'node_modules/@openai/codex/package.json')), { code: 'ENOENT' });
});

test('download config retains project registry, authenticated proxy, CA and scoped token settings without reporting them', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-npm-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await hermeticNpmConfig(t, root);
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}');
  await writeFile(join(root, '.npmrc'), `registry=https://registry.example/\nhttps-proxy=http://fixture:secret@127.0.0.1:1234\n//registry.example/:_authToken=fixture-secret\nstrict-ssl=true\ncache=${join(root, 'cache')}\n`);
  const npmPath = dirname(dirname(await realpath((await onPath('npm', process.env))!)));
  const options = await npmDownloadOptions(npmPath, ['install'], root);
  assert.equal(options.registry, 'https://registry.example/');
  assert.equal(options.httpsProxy, 'http://fixture:secret@127.0.0.1:1234');
  assert.equal(options['//registry.example/:_authToken'], 'fixture-secret');
  assert.equal(options.strictSSL, true);
  assert.equal(options.cache, join(root, 'cache/_cacache'));
});
