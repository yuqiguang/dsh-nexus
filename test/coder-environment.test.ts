import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedCommandTemplates, checkedEnvironmentTemplates, checkedProjectEnvironments, environmentApprovalDisplay, safeEnvironmentTemplate, projectEnvironmentState } from '../src/coders/environment-files.js';
import { normalizeClaudeRequest, codexFileChangeRequest } from '../src/coders/normalize.js';
import { decideLayers } from '../src/coders/decide.js';
import { hardRule } from '../src/coders/rules.js';
import { packageFiles } from '../src/coders/package.js';
import { canonical } from '../src/coders/permissions.js';
import type { CoderRequest } from '../src/coders/types.js';

const template = '# Local configuration\nPORT=3000\nAPI_KEY=your_api_key\nBASE_URL=http://localhost:8080\n';
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-env-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const request = (name: string, content = template) => normalizeClaudeRequest('Write', { file_path: join(cwd, name), content }, {}, cwd);
  const decide = async (request: CoderRequest, standard = true) => {
    const projectEnvironments = await checkedProjectEnvironments(request, cwd, standard);
    request = { ...request, paths: await Promise.all(request.paths.map(canonical)) };
    const safeTemplates = await checkedEnvironmentTemplates(request, cwd, standard);
    // Mirrors src/coders/index.ts: a command that only names a verified template is treated as a file read of it.
    if (request.kind === 'command') safeTemplates.push(...await checkedCommandTemplates(request.detail, cwd, standard));
    return decideLayers(request, [cwd], [], cwd, false, standard, safeTemplates, false, projectEnvironments);
  };
  return { root, cwd, request, decide };
}

test('dotenv template classification permits placeholders and local defaults, not real secrets or shell evaluation', () => {
  assert.equal(safeEnvironmentTemplate(template), true);
  for (const content of ['TOKEN=""\nSECRET=<SECRET>\n', 'export DEBUG=true\nMODEL_KEY=${MODEL_KEY}\n']) assert.equal(safeEnvironmentTemplate(content), true);
  for (const content of ['TOKEN=live-value', 'PASSWORD = "real password"', 'PORT=$(curl example.com)', 'URL=https://user:password@localhost/db', 'URL=http://localhost/?token=secret', 'TOKEN=123456', 'KEY=sk-secret', 'A=1\u0000', 'A=' + 'x'.repeat(32769)]) assert.equal(safeEnvironmentTemplate(content), false, content.slice(0, 80));
});

test('project template creation, reading and editing are routine after inspecting existing and proposed content', async t => {
  const f = await fixture(t);
  for (const name of ['.env.example', '.env.sample', '.env.template']) {
    const request = f.request(name);
    assert.equal((await f.decide(request)).layer, 'auto');
    await writeFile(join(f.cwd, name), template);
    assert.equal((await f.decide(normalizeClaudeRequest('Read', { file_path: join(f.cwd, name) }, {}, f.cwd))).layer, 'auto');
    assert.equal((await f.decide(normalizeClaudeRequest('Edit', { file_path: join(f.cwd, name), old_string: '3000', new_string: '3001' }, {}, f.cwd))).layer, 'auto');
  }
});

test('standard project environment reads and writes are routine with hidden display values', async t => {
  const f = await fixture(t);
  for (const name of ['.env', '.env.local', '.env.example']) {
    const request = f.request(name, 'API_KEY=fixture-private-value');
    const decision = await f.decide(request);
    assert.equal(decision.layer, 'auto');
    const display = environmentApprovalDisplay(request);
    assert.doesNotMatch(display.detail + display.summary, /fixture-private-value/);
    assert.equal(request.raw.content, 'API_KEY=fixture-private-value', 'display masking must not change the actual write');
  }
  assert.equal((await f.decide(f.request('.env'), false)).layer, 'hard', 'strict tasks keep their credential restriction');
  await writeFile(join(f.cwd, '.env.example'), 'API_KEY=fixture-private-value');
  assert.equal((await f.decide(f.request('.env.example'))).layer, 'auto', 'standard mode permits project configuration updates');
  assert.equal((await f.decide(normalizeClaudeRequest('Read', { file_path: join(f.cwd, '.env.example') }, {}, f.cwd))).layer, 'auto');
  assert.equal(hardRule(normalizeClaudeRequest('Bash', { command: 'cat .env' }, {}, f.cwd), [f.cwd], false, true)?.verdict, 'deny');
});

test('standard project environment commands need review while strict commands only exempt verified templates', async t => {
  const f = await fixture(t), bash = (text: string) => normalizeClaudeRequest('Bash', { command: text }, {}, f.cwd);
  await writeFile(join(f.cwd, '.env.example'), template);
  for (const standard of [true, false]) {
    assert.notEqual((await f.decide(bash('git check-ignore -v .env.example'), standard)).layer, 'hard', `naming an approved template is not a credential denial (standard=${standard})`);
    assert.equal((await f.decide(bash('cat .env'), standard)).layer, standard ? 'user' : 'hard', 'standard commands need concrete review; strict mode keeps its restriction');
    assert.equal((await f.decide(bash('cp .env.example .env'), standard)).layer, standard ? 'user' : 'hard');
    assert.equal((await f.decide(bash('cat .env ~/.ssh/id_rsa'), standard)).layer, 'hard');
  }
  await writeFile(join(f.cwd, '.env.example'), 'API_KEY=fixture-private-value');
  assert.equal((await f.decide(bash('cat .env.example'), false)).layer, 'hard', 'a real secret saved as a template keeps the credential answer');
  await rm(join(f.cwd, '.env.example'));
  assert.equal((await f.decide(bash('cat .env.example'), false)).layer, 'hard', 'a missing file has no verified content to exempt');
});

test('Codex allows scoped environment changes but retains strict template checks and refuses directory grants', async t => {
  const f = await fixture(t), path = join(f.cwd, '.env.example');
  const diff = '@@ -0,0 +1,2 @@\n+PORT=3000\n+API_KEY=\n';
  const request = codexFileChangeRequest({}, ['.env.example', 'app.py'], 'display only', f.cwd, [{ path: '.env.example', diff }, { path: 'app.py', diff: '+pass' }]);
  assert.equal((await f.decide(request)).layer, 'auto');
  assert.equal((await f.decide(request, false)).layer, 'auto');
  assert.equal((await f.decide(codexFileChangeRequest({}, ['.env.example'], diff, f.cwd), false)).layer, 'hard');
  assert.equal((await f.decide(codexFileChangeRequest({}, ['.env.example'], diff, f.cwd))).layer, 'auto');
  const full = diff + '+SECRET=fixture-private-value\n';
  assert.equal((await f.decide(codexFileChangeRequest({}, ['.env.example'], diff, f.cwd, [{ path, diff: full }]))).layer, 'auto');
  assert.equal((await f.decide({ ...request, raw: { grantRoot: f.cwd } })).layer, 'hard');
  assert.equal((await f.decide({ ...request, raw: { additionalPermissions: { network: true } } })).layer, 'hard');
});

test('template classification cannot exempt symlinks, hard links, protected ancestors or sibling projects', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'private'), 'API_KEY=fixture-private-value');
  await symlink(join(f.root, 'private'), join(f.cwd, '.env.example'));
  assert.equal((await f.decide(f.request('.env.example'))).layer, 'user', 'canonical outside writes still require a decision');
  await link(join(f.root, 'private'), join(f.cwd, '.env.sample'));
  assert.equal((await f.decide(f.request('.env.sample'))).layer, 'user');
  await mkdir(join(f.cwd, '.ssh'));
  assert.equal((await f.decide(f.request('.ssh/.env.template'))).layer, 'hard');
  assert.equal((await f.decide(f.request('../.env.template'))).layer, 'hard');
  const request = f.request('.env.template'), safe = await checkedEnvironmentTemplates(request, f.cwd, true);
  const deny = decideLayers(request, [f.cwd], [{ id: 'deny', source: 'user', kind: 'file-write', pattern: '.env.template', decision: 'deny', createdAt: 0 }], f.cwd, false, true, safe);
  assert.equal(deny.layer, 'habit', 'user deny is never overridden');
});

test('selected safe templates can be packaged but secrets and true environment files cannot', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, '.env.example'), template);
  assert.deepEqual((await packageFiles(f.cwd, ['.env.example'])).files, ['.env.example']);
  await writeFile(join(f.cwd, '.env.example'), 'TOKEN=fixture-private-value');
  await assert.rejects(packageFiles(f.cwd, ['.env.example']), /非占位/);
  await writeFile(join(f.cwd, '.env'), template);
  await assert.rejects(packageFiles(f.cwd, ['.env']), /受保护/);
});

test('environment exceptions are exact, checked paths and never grant directories or other credential access', async t => {
  const f = await fixture(t), path = join(f.cwd, '.env');
  await writeFile(path, 'VALUE=fixture-private-value');
  assert.equal((await f.decide(normalizeClaudeRequest('Read', { file_path: path }, {}, f.cwd))).layer, 'auto');
  assert.equal((await f.decide(normalizeClaudeRequest('Edit', { file_path: path, old_string: 'fixture-private-value', new_string: 'new-private-value' }, {}, f.cwd))).layer, 'auto');
  assert.deepEqual(await checkedProjectEnvironments(f.request('.env'), f.cwd, true), [path]);
  assert.deepEqual(await checkedProjectEnvironments(f.request('.env'), f.cwd, false), []);
  const before = await projectEnvironmentState(path, f.cwd, true);
  assert.ok(before); assert.doesNotMatch(before, /fixture-private-value/);
  await writeFile(path, 'VALUE=changed-private-value-longer');
  assert.notEqual(await projectEnvironmentState(path, f.cwd, true), before);
  for (const raw of [{ grantRoot: f.cwd }, { additionalPermissions: { network: true } }]) {
    assert.deepEqual(await checkedProjectEnvironments({ ...f.request('.env'), raw }, f.cwd, true), []);
  }
  await symlink(path, join(f.cwd, '.env.link'));
  await link(path, join(f.cwd, '.env.hard'));
  for (const name of ['.env', '.env.link', '.env.hard', '../.env', '.ssh/.env']) {
    assert.deepEqual(await checkedProjectEnvironments(f.request(name), f.cwd, true), [], name);
  }
  await rm(join(f.cwd, '.env.hard'));
  const request = f.request('.env');
  const checked = await checkedProjectEnvironments(request, f.cwd, true);
  const deny = decideLayers(request, [f.cwd], [{ id: 'deny-env', source: 'user', kind: 'file-write', pattern: '.env', decision: 'deny', createdAt: 0 }], f.cwd, false, true, [], false, checked);
  assert.equal(deny.layer, 'habit');
  const mixed = normalizeClaudeRequest('Bash', { command: 'cat .env ../.env' }, {}, f.cwd);
  assert.equal((await f.decide(mixed)).layer, 'hard');
  const extraRoot = await checkedProjectEnvironments(normalizeClaudeRequest('Bash', { command: 'cat .env', cwd: f.root }, {}, f.cwd), f.cwd, true);
  assert.deepEqual(extraRoot, []);
});
