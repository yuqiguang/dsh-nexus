import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runtimeEnvironment, verificationEnvironment, verificationReviewCommand, commandRuntimeEvidence } from '../src/coders/runtime.js';
import { hardRule } from '../src/coders/rules.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import { onPath } from '../src/coders/install.js';

test('task runtime skips Store aliases, preserves real system interpreters and leaves host PATH unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-runtime-'));
  try {
    const alias = join(root, 'Microsoft', 'WindowsApps'), bundled = join(root, 'bundled'), system = join(root, 'system');
    for (const dir of [alias, bundled, system]) await mkdir(dir, { recursive: true });
    for (const dir of [alias, bundled, system]) await writeFile(join(dir, 'python.exe'), 'fixture', { mode: 0o700 });
    const env = { Path: alias, NEXUS_FIXTURE_TOKEN: 'retained-only-for-coder' };
    const runtime = { python: join(bundled, 'python.exe') };
    const result = await runtimeEnvironment(env, runtime, 'win32');
    assert.equal(await onPath('python', result, 'win32'), runtime.python);
    assert.equal(env.Path, alias);
    assert.equal(result.NEXUS_FIXTURE_TOKEN, env.NEXUS_FIXTURE_TOKEN);
    assert.deepEqual(verificationEnvironment({ ...result, ANTHROPIC_BASE_URL: 'fixture-endpoint', CLAUDE_CONFIG_DIR: '/account', CODEX_HOME: '/sandbox', LOCALAPPDATA: '/cache' }),
      { Path: result.Path, CODEX_HOME: '/sandbox', LOCALAPPDATA: '/cache' });
    assert.equal(await onPath('python', { Path: alias }, 'win32'), undefined);
    const installed = await runtimeEnvironment({ Path: `${alias};${system}` }, runtime, 'win32');
    assert.equal(await onPath('python', installed, 'win32'), join(system, 'python.exe'));
    const duplicates = await runtimeEnvironment({ Path: alias, PATH: system }, runtime, 'win32');
    assert.equal(Object.keys(duplicates).filter(key => key.toLowerCase() === 'path').length, 1);
    await assert.rejects(runtimeEnvironment(env, { python: bundled }, 'win32'), /不可用/);
    await assert.rejects(runtimeEnvironment(env, { python: 'relative.exe' }, 'win32'), /不可用/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verification recognizes only the native runtime executable and still checks every argument for credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-verify-runtime-'));
  try {
    const runtime = join(root, '.dsh', 'dsh-runtimes', 'python.exe');
    await mkdir(join(root, '.dsh', 'dsh-runtimes'), { recursive: true });
    await writeFile(runtime, 'fixture');
    const command = `"${runtime}" hello.py`, argv = [runtime, 'hello.py'];
    const known = { python: runtime };
    assert.equal(hardRule(codexCommandRequest({ command }, root), [root], true, true)?.verdict, 'deny');
    const reviewed = await verificationReviewCommand(command, argv, known);
    assert.equal(reviewed, 'python hello.py');
    assert.equal(hardRule(codexCommandRequest({ command: reviewed }, root), [root], true, true), undefined);
    assert.equal(await verificationReviewCommand(command, argv), command, 'untrusted paths cannot claim to be host executables');
    const secrets = `${command} "${join(root, '.dsh', 'credentials', 'saved.json')}"`;
    const withSecret = await verificationReviewCommand(secrets, [...argv, join(root, '.dsh', 'credentials', 'saved.json')], known);
    assert.equal(hardRule(codexCommandRequest({ command: withSecret }, root), [root], true, true)?.verdict, 'deny');
    await rm(runtime);
    assert.equal(await verificationReviewCommand(command, argv, known), command, 'a missing runtime is not exempt');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('review identifies the host runtime and names startup hooks without disclosing their values', async () => {
  const evidence = (await commandRuntimeEvidence('node --version', process.cwd(), { PATH: process.env.PATH, NODE_OPTIONS: 'fixture-secret-value' })).join('\n');
  assert.match(evidence, /宿主任务 PATH 解析：node/);
  assert.match(evidence, /文件身份/);
  assert.match(evidence, /NODE_OPTIONS/);
  assert.doesNotMatch(evidence, /fixture-secret-value/);
  assert.deepEqual(await commandRuntimeEvidence('node --version', process.cwd()), []);
});
