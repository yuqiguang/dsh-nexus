import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { taskPermissions } from '../src/coders/permissions.js';
import { reviewEnvelope, reviewFingerprint } from '../src/coders/review.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import { pythonImports } from '../src/coders/python-evidence.js';
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

test('pytest automatic discovery does not claim complete test source evidence', async t => {
  const f = await fixture(t);
  await f.write('tests/test_api.py', '# undiscovered source');
  const result = await f.inspect('python -m pytest tests');
  assert.equal(result.evidenceComplete, false);
  assert.match(result.evidence.join('\n'), /自动发现的测试范围未展开/);
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
  await f.write('check.py', Array.from({ length: 30 }, (_, i) => `import part${i}`).join('\n'));
  for (let i = 0; i < 30; i++) await f.write(`part${i}.py`, `# PART_${i}\n`);
  const many = await f.inspect('python check.py');
  assert.equal(many.evidenceComplete, false);
  assert.match(many.evidence.join('\n'), /上限/);
  assert.ok(many.evidence.filter(line => line.includes('完整内容')).length <= 24);
  await f.write('check.py', 'import importlib\nimportlib.import_module(module_name)');
  assert.equal((await f.inspect('python check.py')).evidenceComplete, false);
});
