import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import type { Context } from '@deepseek-ai/cordis';
import { packageFiles, resourceReferences, installCoderPackaging } from '../src/coders/package.js';
import { taskPermissions } from '../src/coders/permissions.js';
import type { TaskRecord } from '../src/coders/types.js';

test('explicit archive preserves browser resource layout and refuses missing resources and unsafe files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-package-')), cwd = join(root, 'game');
  try {
    await mkdir(join(cwd, 'assets'), { recursive: true });
    await writeFile(join(cwd, 'index.html'), '<link href="assets/style.css"><script src="app.js"></script>');
    await writeFile(join(cwd, 'app.js'), 'import "./assets/logic.js";');
    await writeFile(join(cwd, 'assets/logic.js'), 'export const score = 0;');
    await writeFile(join(cwd, 'assets/style.css'), 'body { background: url(bg.svg) }');
    await writeFile(join(cwd, 'assets/bg.svg'), '<svg/>');
    await assert.rejects(packageFiles(cwd, ['index.html']), /缺少关联资源/);
    const names = ['index.html', 'app.js', 'assets/logic.js', 'assets/style.css', 'assets/bg.svg'];
    const result = await packageFiles(cwd, names);
    const zip = await JSZip.loadAsync(await readFile(result.path));
    assert.deepEqual(Object.keys(zip.files).filter(name => !zip.files[name]!.dir).sort(), names.map(name => `game/${name}`).sort());
    assert.equal(await zip.file('game/app.js')!.async('string'), 'import "./assets/logic.js";');
    await writeFile(join(root, 'private.txt'), 'private');
    await writeFile(join(cwd, '.env'), 'fixture-secret');
    await symlink(join(root, 'private.txt'), join(cwd, 'alias.txt'));
    await link(join(cwd, '.env'), join(cwd, 'hard.txt'));
    for (const name of ['../private.txt', '.env', 'alias.txt', 'hard.txt']) await assert.rejects(packageFiles(cwd, [name]));
    for (const ref of ['../private.txt', 'file:///tmp/private.txt', '/etc/passwd']) {
      await writeFile(join(cwd, 'bad.html'), `<script src="${ref}"></script>`);
      await assert.rejects(packageFiles(cwd, ['bad.html']));
    }
    await symlink(join(cwd, 'app.js'), join(cwd, 'linked.js'));
    await writeFile(join(cwd, 'linked.html'), '<script src="linked.js"></script>');
    await assert.rejects(packageFiles(cwd, ['linked.html', 'app.js', 'assets/logic.js']), /链接重定向/);
    await rm(join(cwd, '.deliverables'), { recursive: true });
    await symlink(root, join(cwd, '.deliverables'));
    await assert.rejects(packageFiles(cwd, names), /重定向/);
    assert.deepEqual(resourceReferences('page.html', '<style>body{background:url(bg.svg)}</style><script>import "./app.js"</script>'), ['bg.svg', './app.js']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('native packaging tool and present hook preserve owner, current workspace, and explicit delivery boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-package-policy-')), cwd = join(root, 'game');
  try {
    await mkdir(cwd);
    await writeFile(join(cwd, 'index.html'), '<script src="app.js"></script>');
    await writeFile(join(cwd, 'app.js'), 'console.log("game");');
    await writeFile(join(cwd, 'single.html'), '<p>standalone</p>');
    const task: TaskRecord = { id: 'ct-package', coder: 'codex', ownerSession: 'owner', cwd, description: 'game', status: 'completed', createdAt: 1, updatedAt: 1, escalations: 0, decisions: [], permissions: await taskPermissions(cwd, [root], 'codex') };
    const registered: any[] = []; let hook: any, mode = 'workspace-write', workspaceRoot = root, configured = [root];
    const ctx = { effect(fn: () => void) { fn(); }, tools: { register(tool: unknown) { registered.push(tool); } },
      sandboxPolicy: { resolve() { return { mode, workspaceRoot }; } }, on(name: string, fn: unknown) { assert.equal(name, 'tools/pre-execute'); hook = fn; } } as unknown as Context;
    installCoderPackaging(ctx, () => [task], () => configured);
    const exec = { agent: { id: 'owner', session: { header: { cwd: root } } }, signal: AbortSignal.timeout(10000) };
    const args = { task_id: task.id, files: ['index.html', 'app.js'] };
    const tool = registered[0];
    await assert.rejects(tool.execute(args, { ...exec, agent: { ...exec.agent, id: 'other' } }), /本会话/);
    mode = 'read-only'; await assert.rejects(tool.execute(args, exec), /只读/); mode = 'workspace-write';
    workspaceRoot = join(root, 'other'); await assert.rejects(tool.execute(args, exec), /工作区/); workspaceRoot = root;
    configured = []; await assert.rejects(tool.execute(args, exec), /工作区/); configured = [root];
    const result = await tool.execute(args, exec); assert.match(result.path, /\.zip$/);
    const present = (path: string) => ({ ...exec, name: 'present', arguments: { files: [{ path }] } });
    assert.equal((await hook(present(join(cwd, 'index.html')), async () => ({ kind: 'allow' }))).kind, 'deny');
    assert.equal((await hook(present(join(cwd, 'single.html')), async () => ({ kind: 'allow' }))).kind, 'allow');
    const upstream = { kind: 'deny', reason: 'upstream policy' };
    assert.equal(await hook(present(join(cwd, 'single.html')), async () => upstream), upstream);
    assert.equal((await hook(present(result.path), async () => ({ kind: 'allow' }))).kind, 'allow');
    task.status = 'running'; await assert.rejects(tool.execute(args, exec), /已结束/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('resource parsing ignores import-shaped prose but retains executable imports and re-exports', () => {
  const source = `
    // import './comment.js';
    const text = "from './quoted.js';";
    const pattern = /from '.fake.js'/;
    const template = \`import './template-text.js'\`;
    import './real.js';
    export { value } from './export.js';
    export * from './all.js';
    const lazy = import('./lazy.js');
    const cjs = require('./cjs.js');
    const nested = \`text \${import('./nested.js')}\`;
  `;
  assert.deepEqual(resourceReferences('test.mjs', source), ['./real.js', './export.js', './all.js', './lazy.js', './cjs.js', './nested.js']);
  assert.deepEqual(resourceReferences('index.html', '<script type="importmap">{"imports":{"core":"./core.js"}}</script><script type="module">import "./app.js"</script>'), ['./app.js']);
  assert.throws(() => resourceReferences('broken.js', 'import {'), /无法解析/);
});
