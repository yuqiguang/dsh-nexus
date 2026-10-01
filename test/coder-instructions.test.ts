import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostInstructions } from '../src/coders/instructions.js';
import { hardRule } from '../src/coders/rules.js';
import { normalizeClaudeRequest } from '../src/coders/normalize.js';

test('host supplies only its ordinary ancestor instruction file without granting protected directory access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-instructions-')), saved = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, '.dsh');
  const cwd = join(process.env.DSH_HOME, 'nexus-workspace', 'game'), path = join(process.env.DSH_HOME, 'AGENTS.md');
  try {
    await mkdir(cwd, { recursive: true });
    assert.match(await hostInstructions(cwd), /不存在/);
    await writeFile(path, 'Run tests before reporting completion.');
    assert.match(await hostInstructions(cwd), /Run tests before/);
    assert.equal(await hostInstructions(root), '');
    assert.equal(hardRule(normalizeClaudeRequest('Read', { file_path: path }, {}, cwd), [cwd], true, true)?.verdict, 'deny');
    await rm(path); await writeFile(join(root, 'private'), 'DO_NOT_EXPOSE');
    await symlink(join(root, 'private'), path); assert.doesNotMatch(await hostInstructions(cwd), /DO_NOT_EXPOSE/);
    await rm(path); await link(join(root, 'private'), path); assert.doesNotMatch(await hostInstructions(cwd), /DO_NOT_EXPOSE/);
    await rm(path); await writeFile(path, 'X'.repeat(49 * 1024)); assert.match(await hostInstructions(cwd), /未加载/);
  } finally { if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved; await rm(root, { recursive: true, force: true }); }
});
