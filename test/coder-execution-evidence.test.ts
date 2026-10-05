import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { executionObservations, javascriptObservations } from '../src/coders/execution-evidence.js';
import { reviewEnvelope, reviewFingerprint, ReviewCache } from '../src/coders/review.js';
import { taskPermissions } from '../src/coders/permissions.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import type { TaskRecord } from '../src/coders/types.js';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-execution-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const task: TaskRecord = { id: 'ct-generic', coder: 'codex', cwd, description: 'Review a local project check', ownerSession: 'owner', status: 'running', createdAt: 0, updatedAt: 0, decisions: [], escalations: 0,
    permissions: await taskPermissions(cwd, [cwd], 'codex', undefined, 60, [], true, 'standard') };
  const write = async (file: string, body: string) => { await mkdir(dirname(join(cwd, file)), { recursive: true }); await writeFile(join(cwd, file), body); };
  const inspect = async (command: string) => { const result = await reviewEnvelope(task, codexCommandRequest({ command, cwd }, cwd)); assert.ok(result); return result; };
  return { root, cwd, task, write, inspect };
}

test('inline Python and Node imports are collected through native shell wrappers', async t => {
  const f = await fixture(t);
  await f.write('scripts/check.py', '# PYTHON_INLINE_DEPENDENCY');
  await f.write('scripts/check.js', 'export const value = "NODE_INLINE_DEPENDENCY";');
  for (const command of [
    `python -c "from scripts.check import check"`,
    `powershell.exe -NoProfile -Command "python -c 'from scripts.check import check'"`,
    `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command 'python -c "from scripts.check import check"'`,
  ]) assert.match((await f.inspect(command)).evidence.join('\n'), /PYTHON_INLINE_DEPENDENCY/, command);
  for (const command of [`node -e "require('./scripts/check')"`, String.raw`bash -c 'node -e "require(\"./scripts/check\")"'`, `node --input-type=module -e "import './scripts/check.js'"`]) {
    assert.match((await f.inspect(command)).evidence.join('\n'), /NODE_INLINE_DEPENDENCY/, command);
  }
});

test('Windows native command display retains inline import evidence even when quoting is uncertain', async t => {
  const f = await fixture(t);
  await f.write('scripts/check.py', '# WINDOWS_INLINE_SOURCE');
  const command = String.raw`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command '$env:PYTHONIOENCODING='"'utf-8'; .venv\\Scripts\\python.exe -c \"from scripts.check import check; print(check)\""`;
  assert.match((await f.inspect(command)).evidence.join('\n'), /WINDOWS_INLINE_SOURCE/);
});

test('Node local imports resolve extensionless files, re-exports and cycles, invalidating changed dependencies', async t => {
  const f = await fixture(t);
  await f.write('check.mjs', "import './lib'; export { value } from './other.mjs';");
  await f.write('lib/index.js', "require('../check.mjs'); // INDEX_DEPENDENCY");
  await f.write('other.mjs', 'export const value = "BEFORE_CHANGE";');
  const before = await f.inspect('node check.mjs');
  assert.match(before.evidence.join('\n'), /INDEX_DEPENDENCY/);
  assert.equal(before.evidenceComplete, true);
  await f.write('other.mjs', 'export const value = "AFTER_CHANGE";');
  assert.notEqual(reviewFingerprint(before), reviewFingerprint(await f.inspect('node check.mjs')));
});

test('JavaScript comments and example strings are not module imports; dynamic and third-party loading remain gaps', async t => {
  assert.deepEqual(javascriptObservations(`// require('./secret')\nconst example = "import './missing'"; import fs from 'node:fs';`), { modules: [], dynamic: false });
  const f = await fixture(t);
  for (const source of ['require(name)', "import('unobserved-package')", "eval(require('fs').readFileSync('data.json', 'utf8'))", 'const x: string = "TypeScript"']) {
    await f.write('check.js', source);
    assert.equal((await f.inspect('node check.js')).evidenceComplete, false, source);
  }
});

test('npm, pnpm and yarn inspect the selected script and lifecycle hooks without expanding unrelated scripts', async t => {
  const f = await fixture(t);
  await f.write('package.json', JSON.stringify({ scripts: { pretest: 'node setup.cjs', test: 'node check.cjs', posttest: 'node finish.cjs', deploy: 'node secret-deploy.cjs' } }));
  for (const [name, marker] of [['setup', 'PRETEST'], ['check', 'SELECTED_TEST'], ['finish', 'POSTTEST'], ['secret-deploy', 'UNRELATED_SCRIPT_BODY']]) await f.write(name + '.cjs', `console.log('${marker}');`);
  for (const command of ['npm test', 'pnpm run test', 'yarn test']) {
    const result = await f.inspect(command), evidence = result.evidence.join('\n');
    for (const marker of ['PRETEST', 'SELECTED_TEST', 'POSTTEST']) assert.match(evidence, new RegExp(marker), command);
    assert.doesNotMatch(evidence, /UNRELATED_SCRIPT_BODY/);
  }
});

test('nested package scripts terminate cycles and include newly requested script dependencies', async t => {
  const f = await fixture(t);
  await f.write('package.json', JSON.stringify({ scripts: { test: 'npm run check', check: 'node check.js && npm test' } }));
  await f.write('check.js', 'console.log("NESTED_CHECK");');
  assert.match((await f.inspect('npm test')).evidence.join('\n'), /NESTED_CHECK/);
});

test('Shell and PowerShell traverse extensionless sourced scripts and modules without executing them', async t => {
  const f = await fixture(t);
  await f.write('check.sh', '#!/bin/sh\nsource ./shared\n. ./other\ntouch must-not-exist\n');
  await f.write('shared', '# SOURCED_SHELL\nsource ./other\n');
  await f.write('other', '# OTHER_SHELL\n');
  await f.write('check.ps1', '. ./helper.ps1\nImport-Module ./module.psm1\n');
  await f.write('helper.ps1', '# SOURCED_POWERSHELL\n');
  await f.write('module.psm1', '# MODULE_POWERSHELL\n');
  const shell = (await f.inspect('bash check.sh')).evidence.join('\n');
  assert.match(shell, /SOURCED_SHELL/); assert.match(shell, /OTHER_SHELL/);
  const ps = (await f.inspect('pwsh -NoProfile -File check.ps1')).evidence.join('\n');
  assert.match(ps, /SOURCED_POWERSHELL/); assert.match(ps, /MODULE_POWERSHELL/);
  await assert.rejects(access(join(f.cwd, 'must-not-exist')));
});

test('large ordinary data does not displace executable evidence or become a reusable approval', async t => {
  const f = await fixture(t);
  await f.write('report.json', JSON.stringify({ body: 'D'.repeat(110_000), mention: 'unrelated.js' }));
  await f.write('unrelated.js', 'console.log("MUST_NOT_EXPAND_DATA_CONTENT");');
  await f.write('check.js', "const data = JSON.parse(require('fs').readFileSync('report.json', 'utf8')); require('./lib');");
  await f.write('lib.js', '// EXECUTABLE_FIRST\n');
  const input = await f.inspect('node check.js');
  const evidence = input.evidence.join('\n');
  assert.match(evidence, /EXECUTABLE_FIRST/); assert.match(evidence, /数据引用，内容未展开/);
  assert.doesNotMatch(evidence, /DDDDDD|MUST_NOT_EXPAND_DATA_CONTENT/);
  assert.equal(input.evidenceComplete, false);
  const cache = new ReviewCache(); cache.set(f.task, input, { safe: true, repeatable: true, reason: 'fixture' });
  assert.equal(cache.get(f.task, input), undefined);
  await f.write('report.json', JSON.stringify({ body: 'E'.repeat(110_001) }));
  assert.notEqual(reviewFingerprint(input), reviewFingerprint(await f.inspect('node check.js')));
});

test('sourced shell paths resolve from the working directory rather than the entry script directory', async t => {
  const f = await fixture(t);
  await f.write('scripts/check.sh', 'source ./shared');
  await f.write('scripts/check.ps1', '. ./shared.ps1');
  await f.write('shared', '# ACTUAL_SHELL_DEPENDENCY');
  await f.write('shared.ps1', '# ACTUAL_PS_DEPENDENCY');
  await f.write('scripts/shared', '# WRONG_SHELL_DEPENDENCY');
  await f.write('scripts/shared.ps1', '# WRONG_PS_DEPENDENCY');
  for (const [command, marker] of [['bash scripts/check.sh', 'ACTUAL_SHELL_DEPENDENCY'], ['pwsh -File scripts/check.ps1', 'ACTUAL_PS_DEPENDENCY']]) {
    const evidence = (await f.inspect(command!)).evidence.join('\n');
    assert.match(evidence, new RegExp(marker!));
    assert.doesNotMatch(evidence, /WRONG_(?:SHELL|PS)_DEPENDENCY/);
  }
});

test('an executable with a data extension stays subject to the code evidence limit', async t => {
  const f = await fixture(t);
  await f.write('payload.json', ' '.repeat(110_000));
  const result = await f.inspect('node payload.json');
  assert.equal(result.evidenceComplete, false);
  assert.match(result.evidence.join('\n'), /超出审核上限/);
  assert.doesNotMatch(result.evidence.join('\n'), /数据引用，内容未展开/);
});

test('duplicate Python dependency edges do not exhaust the unique path budget', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 12; i++) await f.write(`tests/test_${i}.py`, Array.from({ length: 8 }, (_, j) => `from app.part${j} import value`).join('\n'));
  for (let i = 0; i < 8; i++) await f.write(`app/part${i}.py`, `value = ${i} # SHARED_${i}`);
  await f.write('app/__init__.py', '# INITIALIZER');
  const result = await f.inspect('python -m pytest');
  assert.equal(result.evidenceComplete, true);
  for (let i = 0; i < 8; i++) assert.match(result.evidence.join('\n'), new RegExp(`SHARED_${i}`));
  assert.ok(result.evidence.filter(item => item.includes('完整内容')).length <= 24);
});

test('many small modules fit the shared byte budget without the old 24-file cutoff', async t => {
  const f = await fixture(t);
  await f.write('check.js', Array.from({ length: 40 }, (_, i) => `require('./part${i}.js');`).join('\n'));
  for (let i = 0; i < 40; i++) await f.write(`part${i}.js`, `module.exports = ${i}; // SMALL_MODULE_${i}`);
  const result = await f.inspect('node check.js');
  assert.equal(result.evidenceComplete, true);
  assert.match(result.evidence.join('\n'), /SMALL_MODULE_39/);
});

test('unresolved wrappers, workspaces and compiled build chains are explicit gaps', async t => {
  const f = await fixture(t);
  await f.write('Cargo.toml', '[package]\nname = "fixture"\n');
  await f.write('build.rs', '// BUILD_HOOK');
  await f.write('go.mod', 'module fixture');
  await f.write('pom.xml', '<project><!-- JAVA_MANIFEST --></project>');
  for (const command of ['cargo test', 'go test ./...', 'mvn test', 'node --test', 'npm --prefix other test', 'pwsh -EncodedCommand Zg==', 'bash -c "source $MODULE"', 'cd other; node check.js']) {
    assert.equal((await f.inspect(command)).evidenceComplete, false, command);
  }
  assert.match((await f.inspect('cargo test')).evidence.join('\n'), /BUILD_HOOK/);
  assert.match((await f.inspect('mvn test')).evidence.join('\n'), /JAVA_MANIFEST/);
  assert.ok(executionObservations('bash -c "unterminated').gaps.length);
});

test('new dependency adapters preserve canonical boundaries, including extensionless scripts and protected modules', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'private.js'), '// MUST_NOT_READ_OUTSIDE');
  await symlink(join(f.root, 'private.js'), join(f.cwd, 'linked.js'));
  await f.write('credentials.py', '# MUST_NOT_READ_CREDENTIALS');
  for (const command of [`node -e "require('./linked')"`, `bash -c 'source ../private.js'`, `python -c "import credentials"`]) {
    const result = await f.inspect(command);
    assert.equal(result.evidenceComplete, false);
    assert.doesNotMatch(result.evidence.join('\n'), /MUST_NOT_READ_OUTSIDE|MUST_NOT_READ_CREDENTIALS/);
  }
});
