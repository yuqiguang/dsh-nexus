import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_DELIVERY_BYTES, readDelivery } from '../src/channels/files.js';

test('file delivery preserves bytes and rejects outside paths, symlinks, and directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const bytes = Buffer.from([0, 1, 2, 254, 255]);
  await writeFile(join(workspace, 'report.bin'), bytes);
  const file = await readDelivery(workspace, 'report.bin');
  assert.deepEqual(file.bytes, bytes);
  assert.equal(file.name, 'report.bin');
  await writeFile(join(root, 'outside.txt'), 'private');
  await symlink(join(root, 'outside.txt'), join(workspace, 'link.txt'));
  await assert.rejects(readDelivery(workspace, '../outside.txt'), /outside_workspace/);
  await assert.rejects(readDelivery(workspace, 'link.txt'), /outside_workspace/);
  await assert.rejects(readDelivery(workspace, '.'), /outside_workspace/);
  await assert.rejects(readDelivery(workspace, 'missing.txt'), /ENOENT/);
});

test('oversized files are refused before reading their contents', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-size-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = join(workspace, 'large.bin');
  await writeFile(file, '');
  await truncate(file, MAX_DELIVERY_BYTES + 1);
  await assert.rejects(readDelivery(workspace, 'large.bin'), /file_unsupported/);
});
