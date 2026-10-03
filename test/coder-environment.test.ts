import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkedEnvironmentTemplates, environmentApprovalDisplay, safeEnvironmentTemplate } from '../src/coders/environment-files.js';
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
    request = { ...request, paths: await Promise.all(request.paths.map(canonical)) };
    return decideLayers(request, [cwd], [], cwd, false, standard, await checkedEnvironmentTemplates(request, cwd, standard));
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

test('unknown template values and real environment writes require the owner, with hidden approval content', async t => {
  const f = await fixture(t);
  for (const name of ['.env', '.env.local', '.env.example']) {
    const request = f.request(name, 'API_KEY=fixture-private-value');
    const decision = await f.decide(request);
    assert.equal(decision.layer, 'user'); assert.equal(decision.layer === 'user' && decision.manualOnly, true);
    const display = environmentApprovalDisplay(request);
    assert.doesNotMatch(display.detail + display.summary, /fixture-private-value/);
    assert.equal(request.raw.content, 'API_KEY=fixture-private-value', 'display masking must not change the actual write');
  }
  assert.equal((await f.decide(f.request('.env'), false)).layer, 'hard', 'strict tasks keep their credential restriction');
  await writeFile(join(f.cwd, '.env.example'), 'API_KEY=fixture-private-value');
  assert.equal((await f.decide(f.request('.env.example'))).layer, 'user', 'do not overwrite an existing secret as a routine template update');
  assert.equal((await f.decide(normalizeClaudeRequest('Read', { file_path: join(f.cwd, '.env.example') }, {}, f.cwd))).layer, 'hard');
  assert.equal(hardRule(normalizeClaudeRequest('Bash', { command: 'cat .env' }, {}, f.cwd), [f.cwd], false, true)?.verdict, 'deny');
});

test('Codex uses full per-file native diffs and cannot infer safe templates from a truncated display or directory grant', async t => {
  const f = await fixture(t), path = join(f.cwd, '.env.example');
  const diff = '@@ -0,0 +1,2 @@\n+PORT=3000\n+API_KEY=\n';
  const request = codexFileChangeRequest({}, ['.env.example', 'app.py'], 'display only', f.cwd, [{ path: '.env.example', diff }, { path: 'app.py', diff: '+pass' }]);
  assert.equal((await f.decide(request)).layer, 'auto');
  assert.equal((await f.decide(codexFileChangeRequest({}, ['.env.example'], diff, f.cwd))).layer, 'user');
  const full = diff + '+SECRET=fixture-private-value\n';
  assert.equal((await f.decide(codexFileChangeRequest({}, ['.env.example'], diff, f.cwd, [{ path, diff: full }]))).layer, 'user');
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
