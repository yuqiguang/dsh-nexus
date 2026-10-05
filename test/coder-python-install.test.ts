import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
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
