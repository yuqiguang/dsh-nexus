import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadPolicyDrift } from '../src/coders/codex.js';
import { CODEX_KEY_ENV, CoderInstaller, MANAGED_PACKAGES, codexConfigToml, createNpmRunner, detectClaude, detectCodex, managedLayout, parseClaudeVersion,
  parseCodexVersion, platformPackage, readMarker, type HostPlatform, type NpmRunner } from '../src/coders/install.js';
import { CodersManager } from '../src/coders/manager.js';
import { CoderSettingsStore, defaultSettings, redact, rootsInput, endpointUrl, coderConcurrency } from '../src/coders/settings.js';
import { MemoryRecords } from './helpers.js';

test('coder settings validate input, keep secrets on empty fields, redact them in views, and check revisions', async () => {
  const store = new CoderSettingsStore(new MemoryRecords());
  assert.deepEqual(await store.read(), defaultSettings());
  const saved = await store.save(0, { defaultCoder: 'claude', roots: '/srv/a\n\n/srv/b\n',
    codex: { source: 'system', model: ' gpt-x ', baseUrl: 'https://relay.example/v1/', wireApi: 'chat', apiKey: 'codex-secret' },
    claude: { model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', authHeader: 'auth-token', token: 'claude-secret' } });
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.roots, ['/srv/a', '/srv/b']);
  assert.deepEqual(saved.codex, { source: 'system', model: 'gpt-x', baseUrl: 'https://relay.example/v1', wireApi: 'chat', apiKey: 'codex-secret' });
  assert.deepEqual(saved.claude, { source: 'managed', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', authHeader: 'auth-token', token: 'claude-secret' });
  const kept = await store.save(1, { codex: { source: 'managed', apiKey: '' }, claude: { token: '' } });
  assert.equal(kept.codex.apiKey, 'codex-secret');
  assert.equal(kept.claude.token, 'claude-secret');
  assert.equal(kept.codex.source, 'managed');
  assert.equal(kept.codex.model, undefined, 'omitted fields are cleared, only secrets persist');
  assert.equal(kept.roots, undefined);
  const view = redact(kept);
  assert.equal(JSON.stringify(view).includes('secret'), false);
  assert.deepEqual([view.codex.apiKeyConfigured, view.claude.tokenConfigured, view.revision], [true, true, 2]);
  await assert.rejects(store.save(1, {}), /configuration_changed/);
  await assert.rejects(store.save(2, { roots: 'relative/path' }), /invalid_root/);
  await assert.rejects(store.save(2, { claude: { baseUrl: 'ftp://x' } }), /invalid_endpoint/);
  await assert.rejects(store.save(2, { codex: { source: 'cloud' } }), /invalid_configuration/);
  await assert.rejects(store.save(2, { codex: { wireApi: 'grpc' } }), /invalid_configuration/);
  const cleared = await store.clearSecret(2, 'codex');
  assert.deepEqual([cleared.codex.apiKey, cleared.claude.token, cleared.revision], ['', 'claude-secret', 3]);
});

test('automatic safety review defaults on, can be disabled durably, and rejects non-boolean settings', async () => {
  const store = new CoderSettingsStore(new MemoryRecords());
  assert.equal(redact(await store.read()).autoApproveSafe, true);
  await store.save(0, { autoApproveSafe: false });
  assert.equal(redact(await store.read()).autoApproveSafe, false);
  assert.equal((await store.save(1, {})).autoApproveSafe, false);
  await assert.rejects(store.save(2, { autoApproveSafe: 'true' }), /invalid_configuration/);
  assert.equal((await store.save(2, { autoApproveSafe: true })).autoApproveSafe, true);
});

test('concurrency defaults to two, validates 1–4, and survives partial saves and store reopening', async () => {
  const records = new MemoryRecords(), store = new CoderSettingsStore(records);
  assert.equal(redact(await store.read()).maxConcurrent, 2);
  const old = { ...defaultSettings(), revision: 1 }; delete old.maxConcurrent;
  records.values.set('coders', old);
  assert.equal(redact(await store.read()).maxConcurrent, 2, 'old records inherit the new default');
  await store.save(1, { maxConcurrent: 1 });
  await store.save(2, { autoApproveSafe: false });
  assert.equal(redact(await new CoderSettingsStore(records).read()).maxConcurrent, 1);
  for (const value of [0, 5, -1, 1.5, '2', true, null, Infinity]) {
    assert.throws(() => coderConcurrency(value), /invalid_configuration/);
    await assert.rejects(store.save(3, { maxConcurrent: value }), /invalid_configuration/);
  }
  assert.equal((await store.save(3, { maxConcurrent: 4 })).maxConcurrent, 4);
});

test('saved concurrency changes notify the queue immediately, but failed revisions and invalid limits do not', async () => {
  const m = await manager();
  try {
    const limits: number[] = [];
    const dispose = m.manager.onConcurrencyChange(limit => limits.push(limit));
    const view = await m.manager.handle('save', { revision: 0, config: { maxConcurrent: 1 } });
    assert.equal(view.settings.maxConcurrent, 1); assert.deepEqual(limits, [1]);
    await assert.rejects(m.manager.handle('save', { revision: 0, config: { maxConcurrent: 4 } }), /configuration_changed/);
    await assert.rejects(m.manager.handle('save', { revision: 1, config: { maxConcurrent: 9 } }), /invalid_configuration/);
    assert.deepEqual(limits, [1]);
    await m.manager.handle('save', { revision: 1, config: { maxConcurrent: 2 } });
    assert.deepEqual(limits, [1, 2]);
    dispose(); await m.manager.handle('save', { revision: 2, config: { maxConcurrent: 3 } });
    assert.deepEqual(limits, [1, 2]);
  } finally { await rm(m.root, { recursive: true, force: true }); await rm(m.bin, { recursive: true, force: true }); }
});

test('endpoint and root parsing edge cases', () => {
  assert.equal(endpointUrl(''), undefined);
  assert.equal(endpointUrl('https://a.example/v1///'), 'https://a.example/v1');
  assert.throws(() => endpointUrl('https://u:p@a.example/'), /invalid_endpoint/);
  assert.throws(() => endpointUrl('https://a.example/?k=1'), /invalid_endpoint/);
  assert.deepEqual(rootsInput(['/a', '/a', '/b/../c']), ['/a', '/c']);
  assert.equal(rootsInput(''), undefined);
  assert.throws(() => rootsInput(42), /invalid_configuration/);
});

test('the managed Codex home config repeats the safe policies and names the key only by environment variable', () => {
  const toml = codexConfigToml({ model: 'gpt-x', baseUrl: 'https://relay.example/v1', wireApi: 'chat', apiKey: 'codex-secret' });
  assert.match(toml, /^approval_policy = "on-request"$/m);
  assert.match(toml, /^sandbox_mode = "workspace-write"$/m);
  assert.match(toml, /^model = "gpt-x"$/m);
  assert.match(toml, /^model_provider = "nexus"$/m);
  assert.match(toml, /^base_url = "https:\/\/relay.example\/v1"$/m);
  assert.match(toml, new RegExp(`^env_key = "${CODEX_KEY_ENV}"$`, 'm'));
  assert.match(toml, /^wire_api = "chat"$/m);
  assert.equal(toml.includes('codex-secret'), false);
  const official = codexConfigToml({ apiKey: 'k' });
  assert.match(official, /base_url = "https:\/\/api.openai.com\/v1"/);
  assert.match(official, /wire_api = "responses"/);
  assert.equal(codexConfigToml({ apiKey: '' }).includes('model_provider'), false);
  assert.equal(parseCodexVersion('codex-cli 0.155.0-alpha.12'), '0.155.0-alpha.12');
  assert.equal(parseCodexVersion('codex 1.2.3'), '1.2.3');
  assert.equal(parseCodexVersion('nope'), undefined);
  assert.equal(parseClaudeVersion('2.1.258 (Claude Code)'), '2.1.258');
  assert.equal(parseClaudeVersion('garbage'), undefined);
  const glibc: HostPlatform = { platform: 'linux', arch: 'x64', musl: false };
  assert.deepEqual(platformPackage('claude', glibc), { name: '@anthropic-ai/claude-agent-sdk-linux-x64', spec: '0.3.273', binary: 'claude' });
  assert.deepEqual(platformPackage('claude', { ...glibc, musl: true }).name, '@anthropic-ai/claude-agent-sdk-linux-x64-musl');
  assert.deepEqual(platformPackage('claude', { platform: 'win32', arch: 'x64', musl: false }).binary, 'claude.exe');
  assert.deepEqual(platformPackage('codex', glibc), { name: '@openai/codex-linux-x64', spec: 'npm:@openai/codex@0.155.1-linux-x64', binary: '' });
});

const host: HostPlatform = { platform: 'linux', arch: 'x64', musl: false };

/** Lay out what npm would leave behind; `complete` also writes the platform binary and the install marker. */
async function fakeManaged(root: string, coder: 'codex' | 'claude', options: { version?: string; complete?: boolean } = {}) {
  const version = options.version ?? MANAGED_PACKAGES[coder].version;
  const complete = options.complete ?? true;
  if (coder === 'codex') {
    await mkdir(join(root, 'node_modules', '@openai', 'codex'), { recursive: true });
    await writeFile(join(root, 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ name: '@openai/codex', version }));
    if (complete) {
      await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
      await writeFile(join(root, 'node_modules', '.bin', 'codex'), `#!/bin/sh\necho "codex-cli ${version}"\n`);
      await chmod(join(root, 'node_modules', '.bin', 'codex'), 0o755);
    }
  } else {
    await mkdir(join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
    await writeFile(join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), JSON.stringify({ version }));
    await writeFile(join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'), 'export const query = () => {};\n');
    if (complete) {
      const native = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-linux-x64');
      await mkdir(native, { recursive: true });
      await writeFile(join(native, 'claude'), '#!/bin/sh\necho "0.0.0 (Claude Code)"\n');
      await chmod(join(native, 'claude'), 0o755);
    }
  }
  if (complete) {
    await mkdir(join(root, 'installed'), { recursive: true });
    await writeFile(join(root, 'installed', `${coder}.json`), JSON.stringify({ coder, version, platformPackage: platformPackage(coder, host).name, at: 1 }));
  }
}

async function fakeCli(name: string, output: string): Promise<string> {
  const bin = await mkdtemp(join(tmpdir(), 'nexus-bin-'));
  await writeFile(join(bin, name), `#!/bin/sh\necho "${output}"\n`);
  await chmod(join(bin, name), 0o755);
  return bin;
}

test('detection trusts only complete managed installs and reads system installs from PATH', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-managed-'));
  const layout = managedLayout(root);
  const noPath = { PATH: '' };
  let detected = await detectCodex(layout, { env: noPath, host });
  assert.deepEqual(detected, { managed: { installed: false }, system: { installed: false } });
  await fakeManaged(root, 'codex', { complete: false });
  detected = await detectCodex(layout, { env: noPath, host });
  assert.deepEqual(detected.managed, { installed: false, problem: 'install_incomplete' }, 'a package without its marker is a half-finished install');
  await fakeManaged(root, 'codex', { version: '0.155.0' });
  detected = await detectCodex(layout, { env: noPath, host });
  assert.deepEqual(detected.managed, { installed: true, version: '0.155.0', path: join(root, 'node_modules', '.bin', 'codex') });
  const bin = await fakeCli('codex', 'codex-cli 9.9.9');
  detected = await detectCodex(layout, { env: { PATH: bin }, host });
  assert.deepEqual(detected.system, { installed: true, version: '9.9.9', path: join(bin, 'codex') });
  const broken = await detectCodex(layout, { env: { PATH: bin }, host, probe: async () => ({ ok: false, output: 'boom' }) });
  assert.deepEqual(broken.system, { installed: false, path: join(bin, 'codex'), problem: 'version_check_failed' });

  const none = async () => undefined;
  let claude = await detectClaude(layout, { env: noPath, host, pluginSdk: none });
  assert.deepEqual(claude, { managed: { installed: false }, system: { installed: false } });
  await fakeManaged(root, 'claude', { complete: false });
  claude = await detectClaude(layout, { env: noPath, host, pluginSdk: none });
  assert.deepEqual(claude.managed, { installed: false, problem: 'install_incomplete' });
  await fakeManaged(root, 'claude');
  claude = await detectClaude(layout, { env: noPath, host, pluginSdk: none });
  assert.deepEqual(claude.managed, { installed: true, version: '0.3.273', path: join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs') });
  const musl = await detectClaude(layout, { env: noPath, host: { ...host, musl: true }, pluginSdk: none });
  assert.deepEqual(musl.managed, { installed: false, version: '0.3.273', problem: 'platform_package_missing' }, 'a glibc binary does not count on a musl host');
  // System Claude Code: the plugin SDK drives the claude CLI on PATH, or its own binary when that matches the host.
  const sdkRoot = await mkdtemp(join(tmpdir(), 'nexus-plugin-sdk-'));
  await mkdir(join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk'), { recursive: true });
  const plugin = async () => ({ version: '0.3.273', path: join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs') });
  claude = await detectClaude(layout, { env: noPath, host, pluginSdk: plugin });
  assert.deepEqual(claude.system, { installed: false, version: 'SDK 0.3.273', path: join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'), problem: 'claude_cli_missing' });
  const cli = await fakeCli('claude', '2.1.258 (Claude Code)');
  claude = await detectClaude(layout, { env: { PATH: cli }, host, pluginSdk: plugin });
  assert.deepEqual(claude.system, { installed: true, version: 'claude 2.1.258（SDK 0.3.273）', path: join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs'), executable: join(cli, 'claude') });
  await mkdir(join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk-linux-x64'), { recursive: true });
  await writeFile(join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'), '#!/bin/sh\n');
  await chmod(join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk-linux-x64', 'claude'), 0o755);
  claude = await detectClaude(layout, { env: noPath, host, pluginSdk: plugin });
  assert.deepEqual(claude.system, { installed: true, version: 'SDK 0.3.273 内置', path: join(sdkRoot, '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs') });
});

test('the installer pins the package and its platform package, marks success only after the binary exists, and reports failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-install-'));
  const layout = managedLayout(root);
  const runs: { args: string[]; cwd: string }[] = [];
  const after: string[] = [];
  let clock = 1000;
  const npm: NpmRunner = async (args, cwd, onOutput) => { assert.equal(installer.progress()?.stage, 'packages'); runs.push({ args, cwd }); onOutput('added 1 package\n'); await fakeManaged(root, 'codex', { complete: false }); await fakeManaged(root, 'codex'); return { code: 0 }; };
  const installer: CoderInstaller = new CoderInstaller(layout, npm, async coder => { assert.equal(installer.progress()?.stage, 'configuring'); after.push(coder); }, () => clock++, host);
  assert.equal(installer.progress(), undefined);
  assert.equal(installer.installing(), undefined);
  const started = installer.start('codex');
  assert.equal(installer.progress()?.stage, 'preparing');
  assert.equal(installer.installing(), 'codex');
  assert.throws(() => installer.start('claude'), /install_in_progress/);
  await started;
  assert.deepEqual(installer.progress(), { coder: 'codex', phase: 'installed', stage: 'configuring', startedAt: 1000, lastOutputAt: 1001, finishedAt: 1003, log: 'added 1 package\n' });
  assert.equal(installer.installing(), undefined);
  assert.deepEqual(runs, [{ args: ['install', '--no-audit', '--no-fund', '--loglevel=http', '--omit=dev', '--omit=optional'], cwd: root }]);
  assert.deepEqual(after, ['codex']);
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { '@openai/codex': MANAGED_PACKAGES.codex.version, '@openai/codex-linux-x64': 'npm:@openai/codex@0.155.1-linux-x64' });
  assert.equal((await readMarker(layout, 'codex'))?.platformPackage, '@openai/codex-linux-x64');
  // npm "succeeds" but the platform binary is missing: not installed, no marker.
  const incomplete = new CoderInstaller(layout, async () => { await fakeManaged(root, 'claude', { complete: false }); return { code: 0 }; }, async () => { throw new Error('must not run'); }, () => clock++, host);
  await incomplete.start('claude');
  assert.equal(incomplete.progress()?.phase, 'failed');
  assert.equal(incomplete.progress()?.stage, 'verifying');
  assert.match(incomplete.progress()!.error!, /platform_package_missing/);
  assert.equal(await readMarker(layout, 'claude'), undefined);
  const failing = new CoderInstaller(layout, async () => ({ code: 1 }), async () => { throw new Error('must not run'); }, () => clock++, host);
  await failing.start('claude');
  assert.match(failing.progress()!.error!, /npm exited with 1/);
  const second = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(second.dependencies).sort(), ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/claude-agent-sdk-linux-x64', '@openai/codex', '@openai/codex-linux-x64']);
  // A reinstall removes the old marker first, so a task cannot pick up the half-written copy meanwhile.
  let sawMarker: boolean | undefined;
  const reinstall = new CoderInstaller(layout, async () => { sawMarker = (await readMarker(layout, 'codex')) !== undefined; return { code: 1 }; }, async () => {}, () => clock++, host);
  await reinstall.start('codex');
  assert.equal(sawMarker, false);
});

test('installation logs redact split credentials and URLs, bound long lines, and flush diagnostics on failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-install-log-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshots: string[] = [];
  const installer = new CoderInstaller(managedLayout(root), async (_args, _cwd, output) => {
    for (const chunk of ['npm http fetch GET 200 https://user:split', 'Password@registry.example/package?signature=hiddenQuery 25ms\n',
      'npm warn _authToken=split', 'Token\nAuthorization: Bearer hiddenBearer\n',
      'npm warn password: "hiddenPassword"\nnpm error API_KEY=hiddenKey\n']) {
      output(chunk); snapshots.push(installer.progress()!.log);
    }
    output('x'.repeat(20_000)); output('hiddenOversizedTail\n');
    snapshots.push(installer.progress()!.log);
    for (let i = 0; i < 1000; i++) output(`npm http fetch GET 200 https://registry.example/package${i} 25ms\n`);
    snapshots.push(installer.progress()!.log);
    output('npm error failed with npm_split'); output('Secret');
    throw new Error('failed https://user:hiddenError@registry.example/path?key=hiddenQueryError');
  }, async () => {}, Date.now, host);
  await installer.start('codex');
  assert.equal(snapshots[0], '', 'incomplete lines must not reach the page');
  assert.match(snapshots[1]!, /npm http fetch GET 200 https:\/\/registry\.example\/\[路径已隐藏\] \[参数已隐藏\] \[认证信息已隐藏\] 25ms/);
  assert.match(snapshots[5]!, /过长日志行已省略/);
  assert.equal(installer.progress()?.phase, 'failed');
  assert.ok(installer.progress()?.lastOutputAt);
  assert.match(installer.progress()!.log, /npm error failed with \*\*\*/);
  const published = [...snapshots, installer.progress()!.log, installer.progress()!.error!];
  for (const text of published) {
    assert.ok(text.length <= 4096);
    assert.doesNotMatch(text, /splitPassword|hidden\w+|splitToken|splitSecret/);
  }
});

test('installation logs keep public npm package URLs while hiding credentials, query values and custom signed paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-install-url-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    ['https://registry.npmjs.org/@openai/codex/-/codex-0.155.1-linux-x64.tgz', 'https://registry.npmjs.org/@openai/codex/-/codex-0.155.1-linux-x64.tgz'],
    ['https://registry.npmmirror.com/@anthropic-ai%2fclaude-agent-sdk', 'https://registry.npmmirror.com/@anthropic-ai/claude-agent-sdk'],
    ['https://registry.yarnpkg.com/zod/-/zod-4.4.3.tgz', 'https://registry.yarnpkg.com/zod/-/zod-4.4.3.tgz'],
    ['https://hiddenUser:hiddenPassword@registry.npmjs.org/@openai/codex?token=hiddenToken&X-Amz-Signature=hiddenSig#hiddenFragment',
      'https://registry.npmjs.org/@openai/codex [参数已隐藏] [认证信息已隐藏]'],
    ['https://registry.npmjs.org/zod?opaque=hiddenOpaque', 'https://registry.npmjs.org/zod [参数已隐藏]'],
    ['https://cdn.example/hiddenSignature/codex.tgz?download=hiddenDownload', 'https://cdn.example/[路径已隐藏] [参数已隐藏]'],
    ['https://registry.npmjs.org.evil.example/hiddenSignature', 'https://registry.npmjs.org.evil.example/[路径已隐藏]'],
    ['https://registry.npmjs.org@mirror.example/hiddenSignature', 'https://mirror.example/[路径已隐藏] [认证信息已隐藏]'],
    ['https://registry.npmjs.org:8443/hiddenSignature', 'https://registry.npmjs.org:8443/[路径已隐藏]'],
    ['https://registry.npmjs.org/download/hiddenSignature/codex.tgz', 'https://registry.npmjs.org/[路径已隐藏]'],
    ['https://hiddenUser:hiddenPassword@', '[下载地址已隐藏]'],
  ];
  const installer = new CoderInstaller(managedLayout(root), async (_args, _cwd, output) => {
    for (const [url] of cases) {
      // URLs may arrive in arbitrary chunks; only complete sanitized lines may be published.
      const line = `npm http fetch GET 200 ${url} 25ms\n`;
      for (let i = 0; i < line.length; i += 7) output(line.slice(i, i + 7));
    }
    return { code: 1, error: 'failed https://hiddenUser:hiddenPassword@registry.npmjs.org/@openai/codex?signature=hiddenSignature' };
  }, async () => {}, Date.now, host);
  await installer.start('codex');
  const progress = installer.progress()!;
  assert.equal(progress.log, cases.map(([, safe]) => `npm http fetch GET 200 ${safe} 25ms\n`).join(''));
  assert.equal(progress.error, 'failed https://registry.npmjs.org/@openai/codex [参数已隐藏] [认证信息已隐藏]');
  assert.doesNotMatch(progress.log + progress.error, /hidden\w+/);
});

test('a timed out installer cannot mark success even if npm exits with code zero', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-install-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installer = new CoderInstaller(managedLayout(root), async (_args, _cwd, _output, signal) => {
    await new Promise<void>(resolve => {
      const keepAlive = setTimeout(resolve, 1000);
      signal.addEventListener('abort', () => { clearTimeout(keepAlive); resolve(); }, { once: true });
    });
    return { code: 0 };
  }, async () => { throw new Error('must not configure a timed out install'); }, Date.now, host, 10);
  await installer.start('codex');
  assert.equal(installer.progress()?.phase, 'failed');
  assert.equal(installer.progress()?.error, 'install_timeout');
  assert.equal(await readMarker(managedLayout(root), 'codex'), undefined);
});

test('the npm runner ends the whole process group on timeout even when npm ignores SIGTERM', async () => {
  const runner = createNpmRunner('sh', 200);
  const controller = new AbortController();
  const output: string[] = [];
  const started = Date.now();
  const running = runner(['-c', 'trap "" TERM; echo started; sleep 30; echo late'], tmpdir(), chunk => output.push(chunk), controller.signal);
  await new Promise(resolve => setTimeout(resolve, 150));
  controller.abort(new Error('install_timeout'));
  const result = await running;
  assert.equal(result.error, 'install_timeout');
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 5000, 'the group must be killed within the grace period');
  assert.ok(output.join('').includes('started') && !output.join('').includes('late'));
  const missing = await createNpmRunner('definitely-not-a-program-xyz')([], tmpdir(), () => {}, new AbortController().signal);
  assert.equal(missing.code, null);
  assert.ok(missing.error);
  const slowBin = await mkdtemp(join(tmpdir(), 'nexus-slow-npm-'));
  await writeFile(join(slowBin, 'npm'), '#!/bin/sh\ntrap "" TERM\nsleep 30\n');
  await chmod(join(slowBin, 'npm'), 0o755);
  const timedOut = new CoderInstaller(managedLayout(await mkdtemp(join(tmpdir(), 'nexus-timeout-'))), createNpmRunner(join(slowBin, 'npm'), 100), async () => {}, Date.now, host, 100);
  await timedOut.start('codex');
  assert.equal(timedOut.progress()?.phase, 'failed');
  assert.match(timedOut.progress()!.error!, /install_timeout/);
});

async function manager(options: { codexOnPath?: boolean; claudeOnPath?: boolean; pluginSdk?: boolean; managedCodex?: boolean; managedClaude?: boolean; loginText?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-manager-'));
  const layout = managedLayout(root);
  if (options.managedCodex) await fakeManaged(root, 'codex');
  if (options.managedClaude) await fakeManaged(root, 'claude');
  const bin = await mkdtemp(join(tmpdir(), 'nexus-bin-'));
  if (options.codexOnPath) { await writeFile(join(bin, 'codex'), '#!/bin/sh\necho "codex-cli 0.154.0"\n'); await chmod(join(bin, 'codex'), 0o755); }
  if (options.claudeOnPath) { await writeFile(join(bin, 'claude'), '#!/bin/sh\necho "2.1.258 (Claude Code)"\n'); await chmod(join(bin, 'claude'), 0o755); }
  const npmCalls: string[] = [];
  const npm: NpmRunner = async args => { npmCalls.push(args.join(' ')); await fakeManaged(root, 'codex', { complete: false }); await fakeManaged(root, 'codex'); await rm(join(root, 'installed', 'codex.json')); return { code: 0 }; };
  let instance!: CodersManager;
  const installer = new CoderInstaller(layout, npm, coder => instance.afterInstall(coder), Date.now, host);
  const env = { PATH: bin, HOME: '/home/fixture' };
  instance = new CodersManager({ store: new CoderSettingsStore(new MemoryRecords()), layout, profileRoots: ['/srv/profile'], installer, env,
    detect: { host, pluginSdk: async () => options.pluginSdk ? { version: '0.3.273', path: '/plugin/sdk/sdk.mjs' } : undefined },
    loginStatus: async () => options.loginText ?? 'Logged in using an API key - sk-abc***xyz' });
  await instance.load();
  return { manager: instance, layout, root, bin, npmCalls, installer };
}

test('the manager falls back from the preferred source, explains what is missing, and builds isolated environments', async () => {
  const nothing = await manager();
  let view = await nothing.manager.view();
  assert.deepEqual([view.codex.active, view.codex.ready, view.claude.active, view.claude.ready], ['none', false, 'none', false]);
  assert.match(view.codex.problem!, /尚未安装/);
  assert.match(view.claude.problem!, /不可用/);
  assert.equal(view.claudeLogin, undefined, 'no command is offered before a runnable Claude installation is found');
  assert.deepEqual(view.effectiveRoots, ['/srv/profile']);
  const sdkOnly = await manager({ pluginSdk: true });
  assert.deepEqual([(await sdkOnly.manager.view()).claude.active, (await sdkOnly.manager.view()).claude.system.problem], ['none', 'claude_cli_missing'], 'an SDK without a usable binary is not a system install');
  const system = await manager({ codexOnPath: true, claudeOnPath: true, pluginSdk: true });
  view = await system.manager.view();
  assert.deepEqual([view.codex.active, view.codex.fallback, view.codex.ready, view.codex.login], ['system', true, true, 'Logged in using an API key - sk-abc***xyz']);
  assert.deepEqual([view.claude.active, view.claude.fallback, view.claude.ready], ['system', true, false]);
  assert.match(view.claude.problem!, /还没有凭据/);
  assert.equal(view.platform, 'linux');
  assert.equal(view.claudeLogin?.shell, 'Bash');
  assert.ok(view.claudeLogin?.command.includes(join(system.bin, 'claude')));
  assert.ok(view.claude.problem!.endsWith(view.claudeLogin!.command), 'dispatch and settings show the same login command');
  let runtime = await system.manager.runtime();
  assert.ok(!('error' in runtime.codex));
  if (!('error' in runtime.codex)) {
    assert.equal(runtime.codex.command, join(system.bin, 'codex'));
    assert.equal(runtime.codex.env.CODEX_HOME, undefined, 'system source keeps the user\'s own Codex home');
    assert.equal(runtime.codex.env[CODEX_KEY_ENV], undefined);
  }
  await system.manager.handle('save', { revision: 0, config: { defaultCoder: 'claude', roots: '/srv/tasks',
    claude: { source: 'system', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/anthropic', authHeader: 'auth-token', token: 'claude-secret' },
    codex: { source: 'system', model: 'gpt-x' } } });
  runtime = await system.manager.runtime();
  assert.deepEqual([runtime.defaultCoder, runtime.roots], ['claude', ['/srv/tasks']]);
  assert.ok(!('error' in runtime.claude));
  if (!('error' in runtime.claude)) {
    assert.equal(runtime.claude.sdkPath, undefined, 'the plugin SDK is imported by name');
    assert.equal(runtime.claude.executable, join(system.bin, 'claude'), 'the SDK drives the claude CLI on PATH');
    assert.equal(runtime.claude.env.CLAUDE_CONFIG_DIR, system.layout.claudeHome);
    assert.equal(runtime.claude.env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(runtime.claude.env.ANTHROPIC_AUTH_TOKEN, 'claude-secret');
    assert.equal(runtime.claude.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(runtime.claude.env.ANTHROPIC_MODEL, 'deepseek-flash');
    assert.equal(runtime.claude.env.PATH, system.bin, 'the process environment is inherited');
    assert.equal(runtime.claude.model, 'deepseek-flash');
  }
  if (!('error' in runtime.codex)) assert.equal(runtime.codex.model, 'gpt-x', 'system Codex gets the model per thread');
  view = await system.manager.view();
  assert.equal(JSON.stringify(view).includes('claude-secret'), false);
  assert.equal(view.claude.login, '使用设置里的 token，端点 https://api.deepseek.com/anthropic');
});

test('managed Claude login instructions use its native binary even without a system claude command', async () => {
  const m = await manager({ managedClaude: true });
  try {
    const view = await m.manager.view();
    assert.equal(view.claude.active, 'managed');
    assert.equal(view.claude.system.installed, false);
    const native = platformPackage('claude', host);
    assert.ok(view.claudeLogin?.command.includes(join(m.layout.nodeModules, native.name, native.binary)));
    assert.ok(view.claudeLogin?.command.includes(m.layout.claudeHome));
    assert.ok(view.claude.problem!.endsWith(view.claudeLogin!.command));
  } finally { await rm(m.root, { recursive: true, force: true }); await rm(m.bin, { recursive: true, force: true }); }
});

test('a managed Codex needs an API key, gets a generated home with the key only in the environment, and the install route refreshes detection', async () => {
  const m = await manager({ managedCodex: true });
  let view = await m.manager.view();
  assert.deepEqual([view.codex.active, view.codex.ready], ['managed', false]);
  assert.match(view.codex.problem!, /还没有 API key/);
  assert.equal(view.codex.login, '未配置 API key');
  await m.manager.handle('save', { revision: 0, config: { codex: { source: 'managed', baseUrl: 'https://relay.example/v1', wireApi: 'chat', apiKey: 'codex-secret' }, claude: {} } });
  view = await m.manager.view();
  assert.deepEqual([view.codex.ready, view.codex.login], [true, '使用设置里的 API key，端点 https://relay.example/v1']);
  const runtime = await m.manager.runtime();
  assert.ok(!('error' in runtime.codex));
  if (!('error' in runtime.codex)) {
    assert.equal(runtime.codex.command, join(m.root, 'node_modules', '.bin', 'codex'));
    assert.equal(runtime.codex.env.CODEX_HOME, m.layout.codexHome);
    assert.equal(runtime.codex.env[CODEX_KEY_ENV], 'codex-secret');
    assert.equal(runtime.codex.model, undefined, 'managed Codex takes the model from its config.toml');
  }
  const toml = await readFile(join(m.layout.codexHome, 'config.toml'), 'utf8');
  assert.match(toml, /base_url = "https:\/\/relay.example\/v1"/);
  assert.equal(toml.includes('codex-secret'), false);
  await assert.rejects(m.manager.handle('save', { revision: 0, config: {} }), /configuration_changed/);
  await assert.rejects(m.manager.handle('install', { coder: 'other' }), /invalid_configuration/);
  await assert.rejects(m.manager.handle('rules/remove', { id: 'cr-x' }), /invalid_configuration/);
  const fresh = await manager();
  assert.equal((await fresh.manager.view()).codex.active, 'none');
  await fresh.manager.handle('install', { coder: 'codex' });
  assert.equal((await fresh.manager.view()).codex.active, 'none', 'a running install is not a usable source');
  await fresh.installer.whenDone();
  assert.deepEqual(fresh.npmCalls, ['install --no-audit --no-fund --loglevel=http --omit=dev --omit=optional']);
  view = await fresh.manager.view();
  assert.equal(view.install?.phase, 'installed');
  assert.equal(view.codex.managed.installed, true);
  assert.equal((await readMarker(fresh.layout, 'codex'))?.coder, 'codex');
  assert.match(await readFile(join(fresh.layout.codexHome, 'config.toml'), 'utf8'), /approval_policy = "on-request"/);
  await fresh.manager.handle('clear-secret', { coder: 'claude', revision: 0 });
  assert.equal((await fresh.manager.view()).settings.revision, 1);
});

test('a Codex that reports different policies than requested is refused', () => {
  assert.equal(threadPolicyDrift({}), undefined);
  assert.equal(threadPolicyDrift({ approvalPolicy: 'untrusted', sandbox: 'workspace-write' }), undefined);
  assert.equal(threadPolicyDrift({ approvalPolicy: 'untrusted', sandbox: { type: 'workspace-write', networkAccess: false } }), undefined);
  // Real Codex 0.155 echoes camelCase: {"type":"workspaceWrite","writableRoots":[],...}
  assert.equal(threadPolicyDrift({ approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } }), undefined);
  assert.equal(threadPolicyDrift({ sandbox: { type: 'dangerFullAccess' } }), 'sandbox="dangerFullAccess"');
  assert.equal(threadPolicyDrift({ approvalPolicy: 'never' }), 'approvalPolicy="never"');
  assert.equal(threadPolicyDrift({ sandbox: 'danger-full-access' }), 'sandbox="danger-full-access"');
  assert.equal(threadPolicyDrift({ approvalPolicy: 'on-request', sandbox: { type: 'read-only' } }), 'approvalPolicy="on-request"，sandbox="read-only"');
});

test('security mode defaults to standard for new tasks, persists and rejects unknown modes', async () => {
  const store = new CoderSettingsStore(new MemoryRecords());
  assert.equal(redact(await store.read()).securityMode, 'standard');
  assert.equal((await store.save(0, { securityMode: 'strict' })).securityMode, 'strict');
  assert.equal((await store.save(1, {})).securityMode, 'strict');
  await assert.rejects(store.save(2, { securityMode: 'unrestricted' }), /invalid_configuration/);
});
