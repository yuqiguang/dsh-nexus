import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectPipEvidence } from '../src/coders/python-install.js';
import { hardRule } from '../src/coders/rules.js';
import { codexCommandRequest } from '../src/coders/normalize.js';

test('explicit project virtualenv pip reaches review, not automatic permission; unknown and redirected installs stay manual', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-pip-'));
  try {
    const cwd = join(root, 'project'), venv = join(cwd, '.venv');
    await mkdir(join(venv, 'bin'), { recursive: true });
    await mkdir(join(venv, 'Scripts'));
    await writeFile(join(venv, 'bin', 'python'), 'fixture executable, never executed');
    await writeFile(join(venv, 'Scripts', 'python.exe'), 'fixture executable, never executed');
    await writeFile(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\n');
    for (const command of ['.venv/bin/python -m pip install pypdf', '".venv/Scripts/python.exe" -m pip install pypdf', '.venv//Scripts//python.exe -m pip install pypdf']) {
      const evidence = await projectPipEvidence(command, cwd);
      assert.ok(evidence);
      const req = codexCommandRequest({ command, cwd }, cwd);
      const verdict = hardRule(req, [cwd], false, true, cwd, [], !!evidence);
      assert.equal(verdict?.verdict, 'escalate'); assert.equal(verdict?.manualOnly, false);
      assert.equal(hardRule(req, [cwd], false, false, cwd, [], true)?.manualOnly, true);
      assert.equal(hardRule(req, [cwd], false, true, cwd)?.manualOnly, true);
    }
    const command = '.venv/bin/python -m pip install pypdf';
    for (const other of ['python -m pip install pypdf', 'pip install pypdf', command + ' --target /tmp/shared', command + ' --user', command + ' -t /tmp/shared', command + ' -t/tmp/shared', command + ' --prefix=/usr', command + '; pip install other', 'PIP_TARGET=/tmp/shared ' + command]) assert.equal(await projectPipEvidence(other, cwd), undefined, other);
    assert.equal(await projectPipEvidence(command, cwd, { PIP_CONFIG_FILE: '/tmp/settings' }), undefined);
    const initial = await projectPipEvidence(command, cwd);
    await writeFile(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.12\n');
    assert.notDeepEqual(await projectPipEvidence(command, cwd), initial);
    await writeFile(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = true\n');
    assert.equal(await projectPipEvidence(command, cwd), undefined);
    await writeFile(join(venv, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\n');
    await mkdir(join(root, 'external'));
    await symlink(join(root, 'external'), join(venv, 'lib'));
    assert.equal(await projectPipEvidence(command, cwd), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('literal target installs resolve the task interpreter, actual cwd, source and local cache before review', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-pip-target-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'), cwd = join(project, 'pipeline'), bin = join(root, 'bin');
  await mkdir(cwd, { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'python'), 'fixture interpreter, never executed', { mode: 0o755 });
  const env = { PATH: bin, HOME: join(root, 'home'), XDG_CONFIG_DIRS: join(root, 'xdg') };
  const command = 'python -m pip install --target pydeps --cache-dir .pip-cache imageio-ffmpeg';
  const first = await projectPipEvidence(command, cwd, env, project);
  assert.ok(first);
  assert.match(first.join('\n'), new RegExp(cwd + '/pydeps'));
  assert.match(first.join('\n'), /pypi.org/);
  assert.equal(hardRule(codexCommandRequest({ command, cwd }, project), [project], false, true, project, [], !!first)?.manualOnly, false);
  assert.ok(await projectPipEvidence('python -m pip install --target ../shared --no-cache-dir av', cwd, env, project));
  assert.equal(await projectPipEvidence(command, cwd), undefined, 'bare interpreter needs a host resolution');
  for (const suffix of ['; python -m pip install other', ' --prefix /tmp/shared', ' --user', ' -r requirements.txt', ' --index-url https://example.test/simple/', ' local.whl']) {
    assert.equal(await projectPipEvidence(command + suffix, cwd, env, project), undefined, suffix);
  }
  for (const [key, value] of [['PIP_TARGET', '/tmp/shared'], ['PIP_CONFIG_FILE', '/tmp/config'], ['PYTHONPATH', '/tmp/code'], ['PIP_INDEX_URL', 'https://user:private@example.org/simple/']] as const) {
    assert.equal(await projectPipEvidence(command, cwd, { ...env, [key]: value }, project), undefined, key);
  }
  assert.equal(await projectPipEvidence(command, cwd, { ...env, PATH: '.' + ':' + bin }, project), undefined);
  await mkdir(join(env.HOME, '.pip'), { recursive: true });
  await writeFile(join(env.HOME, '.pip', 'pip.conf'), '[global]\nbreak-system-packages = true\n');
  const managed = await projectPipEvidence(command, cwd, env, project);
  assert.ok(managed); assert.match(managed.join('\n'), /break-system-packages=true/);
  assert.ok(await projectPipEvidence(command, cwd, { ...env, PIP_BREAK_SYSTEM_PACKAGES: '1' }, project));
  assert.equal(await projectPipEvidence(command, cwd, { ...env, PIP_BREAK_SYSTEM_PACKAGES: 'unknown' }, project), undefined);
  assert.equal(await projectPipEvidence(command, cwd, { ...env, PIP_TARGET: '/tmp/shared' }, project), undefined);
  assert.equal(await projectPipEvidence('python -m pip install imageio-ffmpeg', cwd, env, project), undefined, 'the compatibility flag does not admit a global installation');
  assert.equal(await projectPipEvidence('python -m pip install --target ../../outside --no-cache-dir av', cwd, env, project), undefined);
  await writeFile(join(env.HOME, '.pip', 'pip.conf'), '[global]\nindex-url = https://pypi.org/simple/\n');
  assert.notDeepEqual(await projectPipEvidence(command, cwd, env, project), first);
  await writeFile(join(env.HOME, '.pip', 'pip.conf'), '[install]\ntarget = /tmp/shared\n');
  assert.equal(await projectPipEvidence(command, cwd, env, project), undefined);
});

test('target evidence rejects outside, linked and shared installation trees', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-pip-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'); await mkdir(cwd); await mkdir(join(root, 'bin'));
  await writeFile(join(root, 'bin', 'python'), 'fixture', { mode: 0o755 });
  const env = { PATH: join(root, 'bin'), HOME: join(root, 'home'), XDG_CONFIG_DIRS: join(root, 'xdg') };
  const inspect = (target: string) => projectPipEvidence(`python -m pip install --target ${target} --no-cache-dir av`, cwd, env);
  assert.equal(await inspect('../outside'), undefined);
  assert.equal(await inspect('.'), undefined);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(cwd, 'redirect'));
  assert.equal(await inspect('redirect/new'), undefined);
  await mkdir(join(cwd, 'pydeps'));
  await symlink(join(root, 'outside'), join(cwd, 'pydeps', 'linked'));
  assert.equal(await inspect('pydeps'), undefined);
  await rm(join(cwd, 'pydeps', 'linked'));
  await writeFile(join(root, 'outside', 'shared'), 'shared');
  await link(join(root, 'outside', 'shared'), join(cwd, 'pydeps', 'shared'));
  assert.equal(await inspect('pydeps'), undefined);
});
