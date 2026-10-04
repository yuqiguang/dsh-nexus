import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CoderQueue } from '../src/coders/queue.js';
import { changedFiles, snapshotWorkTree, verifyTask, workspaceScope } from '../src/coders/verify.js';
import { hasUserNamespaces } from './helpers.js';

// The verification tests below run the real confined command pipeline, which needs
// `unshare --user`; skip with a reason where the kernel refuses it. See test/helpers.ts.
const noNamespaces = hasUserNamespaces() ? undefined : 'unprivileged user namespaces are disabled';

test('overlapping workspace leases serialize while independent work advances', async () => {
  const queue = new CoderQueue(3), signal = new AbortController().signal;
  const release = await queue.acquire(signal, '/tmp/project');
  let entered = false;
  const blocked = queue.acquire(signal, '/tmp/project/sub').then(done => { entered = true; return done; });
  const independent = await queue.acquire(signal, '/tmp/other');
  assert.equal(entered, false);
  independent(); release(); (await blocked)(); queue.close();
});

test('workspace queue survives 500 cancellation, release and shutdown cycles', async () => {
  for (let round = 0; round < 500; round++) {
    const queue = new CoderQueue(2), controller = new AbortController();
    const release = await queue.acquire(controller.signal, '/tmp/project');
    const cancelled = queue.acquire(controller.signal, '/tmp/project/child');
    const rejected = assert.rejects(cancelled, /cancelled/);
    controller.abort(); await rejected;
    release(); release();
    const done = await queue.acquire(new AbortController().signal, '/tmp/project');
    const closed = assert.rejects(queue.acquire(new AbortController().signal, '/tmp/project'), /cancelled/);
    queue.close(); await closed; done();
  }
});

test('content hashes detect same-size edits with restored timestamps; limits fail explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-hash-'));
  try {
    const path = join(root, 'file.txt'); await writeFile(path, 'before');
    const info = await stat(path), baseline = await snapshotWorkTree(root);
    await writeFile(path, 'after!'); await utimes(path, info.atime, info.mtime);
    assert.deepEqual(await changedFiles(root, baseline), [path]);
    await writeFile(join(root, 'second'), 'x');
    await assert.rejects(snapshotWorkTree(root, undefined, 1), /超过 1/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repository subdirectories share a scope and restoring preexisting dirty files is reported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-git-scope-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  try {
    git('init'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
    const path = join(root, 'file.txt'); await writeFile(path, 'original'); git('add', '.'); git('commit', '-m', 'initial');
    await mkdir(join(root, 'sub')); assert.equal(await workspaceScope(join(root, 'sub')), root);
    await writeFile(path, 'dirty'); const baseline = await snapshotWorkTree(root);
    git('restore', 'file.txt'); assert.deepEqual(await changedFiles(root, baseline), [path]);
    await writeFile(path, 'committed'); git('add', '.'); git('commit', '-m', 'change');
    const result = await verifyTask({ cwd: root }, [root], baseline);
    assert.equal(result.commits?.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verification artifacts are included in the final change report', { skip: noNamespaces }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-verify-output-'));
  try {
    await writeFile(join(root, 'verify.cjs'), "require('fs').writeFileSync('artifact.txt','checked')");
    const baseline = await snapshotWorkTree(root);
    const result = await verifyTask({ cwd: root, verify: `${process.execPath} verify.cjs` }, [root], baseline);
    assert.equal(result.verifyOk, true);
    assert.deepEqual(result.changedFiles, [join(root, 'artifact.txt')]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a workspace exceeding the former 5000-file limit is fully scanned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-large-'));
  try {
    for (let index = 0; index < 5100; index++) await writeFile(join(root, `file-${index}`), 'fixture');
    const baseline = await snapshotWorkTree(root);
    assert.equal(baseline.files.size, 5100);
    const last = join(root, 'file-5099'); await writeFile(last, 'changed');
    assert.deepEqual(await changedFiles(root, baseline), [last]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
