import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { taskPermissions } from '../src/coders/permissions.js';
import { reviewEnvelope, reviewFingerprint } from '../src/coders/review.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import { pythonImports } from '../src/coders/python-evidence.js';
import { commandEvidence } from '../src/coders/review-evidence.js';
import type { TaskRecord } from '../src/coders/types.js';

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-python-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const task: TaskRecord = { id: 'ct-python', coder: 'codex', cwd, description: 'Verify the local service', ownerSession: 'owner', status: 'running', createdAt: 0, updatedAt: 0, decisions: [], escalations: 0,
    permissions: await taskPermissions(cwd, [cwd], 'codex', undefined, 60, [], true, 'standard') };
  const write = async (file: string, body: string) => { await mkdir(dirname(join(cwd, file)), { recursive: true }); await writeFile(join(cwd, file), body); };
  const inspect = async (command: string) => { const result = await reviewEnvelope(task, codexCommandRequest({ command, cwd }, cwd)); assert.ok(result); return result; };
  return { cwd, root, write, inspect };
}

test('Python pytest review includes local imports, initializers, conftest and configuration without executing them', async t => {
  const f = await fixture(t);
  await f.write('tests/test_api.py', 'from app.main import create_app\nfrom app import retrieval\nimport pytest\n');
  await f.write('tests/conftest.py', 'from app.db import Database\n# FIXTURE_SETUP\n');
  await f.write('pyproject.toml', '[tool.pytest.ini_options]\naddopts = "-q"\n');
  await f.write('app/__init__.py', '# PACKAGE_INITIALIZER\n');
  await f.write('app/main.py', 'from .db import Database\nfrom . import llm\n# API_SOURCE\n');
  await f.write('app/db.py', '# DATABASE_SOURCE\n');
  await f.write('app/llm.py', '# MODEL_SOURCE\n');
  await f.write('app/retrieval.py', '# RETRIEVAL_SOURCE\n');
  const first = await f.inspect('.venv/Scripts/python.exe -m pytest -q tests/test_api.py::test_chat');
  for (const marker of ['PACKAGE_INITIALIZER', 'API_SOURCE', 'DATABASE_SOURCE', 'MODEL_SOURCE', 'RETRIEVAL_SOURCE', 'FIXTURE_SETUP', '[tool.pytest.ini_options]']) assert.ok(first.evidence.some(line => line.includes(marker)), marker);
  assert.equal(first.evidenceComplete, true);
  await f.write('app/db.py', '# DATABASE_CHANGED\n');
  assert.notEqual(reviewFingerprint(first), reviewFingerprint(await f.inspect('.venv/Scripts/python.exe -m pytest -q tests/test_api.py::test_chat')));
});

test('targeted pytest preserves dependency budget and parent fixtures through PowerShell wrappers', async t => {
  const f = await fixture(t);
  await f.write('tests/test_selected.py', 'from app.db import check\n# SELECTED_TEST');
  await f.write('tests/conftest.py', '# PARENT_FIXTURE');
  await f.write('app/db.py', '# REQUIRED_DATABASE');
  await f.write('pytest.ini', '[pytest]\ntestpaths = tests');
  for (let i = 0; i < 12; i++) await f.write(`tests/test_unrelated${i}.py`, '# UNRELATED\n' + '# padding\n'.repeat(3000));
  const command = 'powershell.exe -NoProfile -Command "python -X utf8 -m pytest -q tests/test_selected.py::test_check -k selected"';
  const result = await f.inspect(command);
  assert.equal(result.evidenceComplete, true);
  const evidence = result.evidence.join('\n');
  for (const marker of ['SELECTED_TEST', 'PARENT_FIXTURE', 'REQUIRED_DATABASE']) assert.ok(evidence.includes(marker), marker);
  assert.doesNotMatch(evidence, /UNRELATED|未读取完整内容/);
  await f.write('app/db.py', '# REQUIRED_DATABASE_CHANGED');
  assert.notEqual(reviewFingerprint(result), reviewFingerprint(await f.inspect(command)));
});

test('pytest collects every explicit target and falls back for default or unknown discovery arguments', async t => {
  const f = await fixture(t);
  await f.write('tests/test_one.py', '# FIRST_TARGET');
  await f.write('other/test_two.py', '# SECOND_TARGET');
  await f.write('other/conftest.py', '# OTHER_FIXTURE');
  const selected = await f.inspect('pytest tests/test_one.py; python -m pytest other');
  for (const marker of ['FIRST_TARGET', 'SECOND_TARGET', 'OTHER_FIXTURE']) assert.ok(selected.evidence.join('\n').includes(marker));
  for (const command of ['pytest', 'python -m pytest -c custom.ini tests/test_one.py', 'pytest "$TARGET"', 'cd other; pytest tests/test_one.py', 'pwsh -WorkingDirectory other -Command "pytest tests/test_one.py"']) {
    const result = await f.inspect(command);
    assert.match(result.evidence.join('\n'), /SECOND_TARGET/);
    if (command !== 'pytest') assert.equal(result.evidenceComplete, false);
  }
  await f.write('pytest.ini', '[pytest]\naddopts = other');
  assert.match((await f.inspect('pytest tests/test_one.py')).evidence.join('\n'), /SECOND_TARGET/);
  await f.write('tests/pytest.ini', '[pytest]\npythonpath = elsewhere');
  assert.equal((await f.inspect('pytest tests/test_one.py')).evidenceComplete, false);
});

test('pytest unknown environment options and linked targets cannot produce reusable complete evidence', async t => {
  const f = await fixture(t);
  await f.write('tests/test_one.py', '# FIRST_TARGET');
  await f.write('other/test_two.py', '# SECOND_TARGET');
  const result = await commandEvidence('pytest tests/test_one.py', f.cwd, async path => path, { PYTEST_ADDOPTS: 'private-option-value' });
  assert.equal(result.complete, false);
  assert.match(result.evidence.join('\n'), /SECOND_TARGET/);
  assert.doesNotMatch(result.evidence.join('\n'), /private-option-value/);
  await symlink(join(f.cwd, 'tests/test_one.py'), join(f.cwd, 'linked.py'));
  assert.equal((await f.inspect('pytest linked.py')).evidenceComplete, false);
});

test('python -m resolves package entry points and relative imports without launching the application', async t => {
  const f = await fixture(t);
  await f.write('app/__init__.py', '# INIT\n');
  await f.write('app/__main__.py', 'from .main import run\nopen("must-not-exist", "w").write("executed")\n');
  await f.write('app/main.py', '# ENTRY_SOURCE\n');
  const result = await f.inspect('python -m app');
  assert.ok(result.evidence.some(line => line.includes('ENTRY_SOURCE')));
  assert.ok(result.evidence.some(line => line.includes('must-not-exist')));
  await assert.rejects(access(join(f.cwd, 'must-not-exist')));
});

test('static imports ignore comments and multiline strings, and flag dynamic execution', () => {
  const source = `"""\nfrom imaginary import hidden\n"""\n# import secret\nfrom .db import (\n Database as DB,\n connect,\n)\nimport app.main as server, json\n`;
  assert.deepEqual(pythonImports(source), { imports: [{ module: '.db', names: ['Database', 'connect'] }, { module: 'app.main', names: [] }, { module: 'json', names: [] }], dynamic: false });
  assert.equal(pythonImports('import importlib\nimportlib.import_module(name)').dynamic, true);
  assert.equal(pythonImports('from importlib import import_module as load\nload(name)').dynamic, true);
  assert.deepEqual(pythonImports('if ready: import app.db').imports, [{ module: 'app.db', names: [] }]);
});

test('pytest directory discovery includes test bodies, conftest and imported application modules', async t => {
  const f = await fixture(t);
  await f.write('tests/test_api.py', 'from app.main import run\n# DISCOVERED_TEST');
  await f.write('tests/conftest.py', '# DISCOVERED_CONFTEST');
  await f.write('app/main.py', '# DISCOVERED_APP');
  await f.write('pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]');
  const result = await f.inspect('python -X utf8 -m pytest tests');
  assert.equal(result.evidenceComplete, true);
  for (const marker of ['DISCOVERED_TEST', 'DISCOVERED_CONFTEST', 'DISCOVERED_APP']) assert.match(result.evidence.join('\n'), new RegExp(marker));
  await f.write('tests/test_added.py', '# ADDED_TEST');
  assert.notEqual(reviewFingerprint(result), reviewFingerprint(await f.inspect('python -X utf8 -m pytest tests')));
  await f.write('pyproject.toml', '[tool.pytest.ini_options]\npython_files = "check_*.py"');
  assert.equal((await f.inspect('python -m pytest tests')).evidenceComplete, false, 'custom discovery is not mistaken for the default');
});

test('self-check subprocess module entry is included without running the application', async t => {
  const f = await fixture(t);
  await f.write('scripts/check.py', 'import subprocess, sys\nsubprocess.run([sys.executable, "-m", "app"])');
  await f.write('app/__init__.py', '# SUBPROCESS_INIT');
  await f.write('app/__main__.py', 'from .main import run\n# SUBPROCESS_ENTRY');
  await f.write('app/main.py', '# SUBPROCESS_SOURCE');
  const result = await f.inspect('python scripts/check.py');
  for (const marker of ['SUBPROCESS_INIT', 'SUBPROCESS_ENTRY', 'SUBPROCESS_SOURCE']) assert.match(result.evidence.join('\n'), new RegExp(marker));
});

test('pytest discovery does not follow links and stops at a bounded number of directory entries', async t => {
  const f = await fixture(t);
  await mkdir(join(f.cwd, 'tests'));
  await writeFile(join(f.root, 'outside.py'), '# OUTSIDE_TEST_SECRET');
  await symlink(join(f.root, 'outside.py'), join(f.cwd, 'tests', 'test_link.py'));
  const linked = await f.inspect('python -m pytest');
  assert.equal(linked.evidenceComplete, false);
  assert.doesNotMatch(linked.evidence.join('\n'), /OUTSIDE_TEST_SECRET/);
  for (let i = 0; i < 270; i++) await f.write(`tests/entry${i}`, '');
  const many = await f.inspect('pytest tests');
  assert.equal(many.evidenceComplete, false);
  assert.match(many.evidence.join('\n'), /上限/);
});

test('a generated pytest tmp_path tree does not spend the discovery budget before the project tests', async t => {
  const f = await fixture(t);
  await f.write('pytest.ini', '[pytest]\ntestpaths = tests\n');
  await f.write('tests/test_api.py', 'from app.main import run\n# BUDGET_TEST');
  await f.write('app/main.py', '# BUDGET_APP');
  // pytest keeps tmp_path fixtures under <basetemp>/pytest-of-<user>; a project whose TEMP points inside itself grows this on
  // every run, and it sorts before `tests`. It is never a project test, so it must not use up the entry budget (ct-4c671559).
  await mkdir(join(f.cwd, 'pytest-of-Administrator'), { recursive: true });
  for (let i = 0; i < 300; i++) await writeFile(join(f.cwd, 'pytest-of-Administrator', `tmp${i}`), '');
  const result = await f.inspect('python -m pytest -q tests');
  assert.equal(result.evidenceComplete, true);
  assert.doesNotMatch(result.evidence.join('\n'), /未找到默认命名的测试文件/);
  for (const marker of ['BUDGET_TEST', 'BUDGET_APP']) assert.match(result.evidence.join('\n'), new RegExp(marker));
});

test('flags, globs and bare extensions are not reported as missing project files', async t => {
  const f = await fixture(t);
  await f.write('app/main.py', '# GREP_TARGET');
  const result = await f.inspect('grep -rn --include=*.py load_dotenv .');
  const text = result.evidence.join('\n');
  assert.doesNotMatch(text, /\*\.py/, 'a glob is a word that ends in an extension, not a file the command named');
  assert.doesNotMatch(text, /: 不存在/);
  assert.match(text, /未找到的可选配置文件/);
});

test('a filename quoted in source that does not exist is not missing evidence', async t => {
  const f = await fixture(t);
  await f.write('pytest.ini', '[pytest]\ntestpaths = tests\n');
  await f.write('tests/test_upload.py', 'import pytest\nCASES = [("程序.py", b"hello", 400), ("坏文件.md", b"\\xff", 400)]\n# UPLOAD_TEST');
  const result = await f.inspect('python -m pytest -q');
  assert.equal(result.evidenceComplete, true, 'a test fixture name is a string, not a claim that the file exists');
  assert.match(result.evidence.join('\n'), /UPLOAD_TEST/);
});

test('many import statements are located without being mistaken for unreadable evidence', async t => {
  const f = await fixture(t);
  await f.write('many.py', Array.from({ length: 150 }, (_, i) => `import module${i}`).join('\n'));
  const result = await f.inspect('python many.py');
  assert.equal(result.evidenceComplete, true, 'module location is bounded by the read budget, not by a small probe count');
});

test('Python imports cannot disclose protected files or follow symlinks outside the review root', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'private.py'), '# OUTSIDE_SECRET_CONTENT');
  await f.write('credentials.py', '# PROTECTED_SECRET_CONTENT');
  await symlink(join(f.root, 'private.py'), join(f.cwd, 'linked.py'));
  await f.write('check.py', 'import linked\nimport credentials\n');
  const result = await f.inspect('python check.py');
  assert.equal(result.evidenceComplete, false);
  assert.doesNotMatch(result.evidence.join('\n'), /OUTSIDE_SECRET_CONTENT|PROTECTED_SECRET_CONTENT/);
});

test('Python import traversal remains bounded and dynamic imports never claim complete evidence', async t => {
  const f = await fixture(t);
  await f.write('check.py', Array.from({ length: 70 }, (_, i) => `import part${i}`).join('\n'));
  for (let i = 0; i < 70; i++) await f.write(`part${i}.py`, `# PART_${i}\n`);
  const many = await f.inspect('python check.py');
  assert.equal(many.evidenceComplete, false);
  assert.match(many.evidence.join('\n'), /上限/);
  assert.ok(many.evidence.filter(line => line.includes('完整内容')).length <= 64);
  await f.write('check.py', 'import importlib\nimportlib.import_module(module_name)');
  assert.equal((await f.inspect('python check.py')).evidenceComplete, false);
});
