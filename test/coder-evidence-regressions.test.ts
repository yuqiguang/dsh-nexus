import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { commandPath } from '../src/coders/command-path.js';
import { executionObservations } from '../src/coders/execution-evidence.js';
import { mediaEvidence } from '../src/coders/media-evidence.js';
import { reviewEnvelope, reviewFingerprint, ReviewCache } from '../src/coders/review.js';
import { taskPermissions } from '../src/coders/permissions.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import type { TaskRecord } from '../src/coders/types.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'nexus-evidence-regression-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const cwd = join(root, 'project'); await mkdir(cwd);
  const task: TaskRecord = { id: 'fixture', coder: 'codex', ownerSession: 'owner', description: 'verify local app', cwd,
    createdAt: 0, updatedAt: 0, escalations: 0, decisions: [], status: 'running',
    permissions: await taskPermissions(cwd, [cwd], 'codex', undefined, 60, [], true, 'standard') };
  const review = (command: string, directory = cwd) => reviewEnvelope(task, codexCommandRequest({ command, cwd: directory }, directory));
  return { root, cwd, task, review };
}

test('WSL drive spelling is contextual; file URL fragments never become filesystem names', () => {
  assert.equal(executionObservations('powershell.exe -NoProfile -Command "wsl -d Ubuntu -- bash /mnt/c/work/check.sh"').wsl, true);
  assert.equal(executionObservations("node -e \"console.log('wsl -d Ubuntu /mnt/c/work/check.sh')\"").wsl, undefined);
  assert.equal(commandPath('/mnt/c/work/check.sh', 'win32', true), 'c:/work/check.sh');
  assert.equal(commandPath('/mnt/c/work/check.sh', 'win32'), '/mnt/c/work/check.sh');
  assert.equal(commandPath('/mnt/c/work/check.sh', 'linux', true), '/mnt/c/work/check.sh');
  assert.equal(commandPath('/mnt/custom/check.sh', 'win32', true), '/mnt/custom/check.sh');
  assert.equal(commandPath('file:///C:/work/app.html?x=1#frame=3', 'win32'), 'C:\\work\\app.html');
  assert.equal(commandPath('file://remote/share/app.html#frame=3', 'win32'), 'file://remote/share/app.html#frame=3');
});

test('browser file URL with query and fragment includes the page and its local script in review', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'render.mjs'), 'console.log("render fixture")');
  await writeFile(join(f.cwd, 'app.html'), '<script src="./game.js"></script><p>LOCAL_PAGE_EVIDENCE</p>');
  await writeFile(join(f.cwd, 'game.js'), 'globalThis.GAME_DEPENDENCY = 1;');
  const url = pathToFileURL(join(f.cwd, 'app.html')).href + '?mode=offline#frame=3&support=1';
  const result = await f.review(`node render.mjs --url '${url}'`);
  assert.ok(result);
  assert.match(result.evidence.join('\n'), /LOCAL_PAGE_EVIDENCE/);
  assert.match(result.evidence.join('\n'), /GAME_DEPENDENCY/);
});

test('nested cwd can import task-root code, but outside and symlinked modules remain unread', async t => {
  const f = await fixture(t); const nested = join(f.cwd, 'outputs', 'app'); await mkdir(nested, { recursive: true });
  await writeFile(join(f.cwd, 'verify.mjs'), 'console.log("ROOT_EXECUTION_EVIDENCE")');
  await writeFile(join(nested, 'verify.mjs'), "import '../../verify.mjs';");
  let result = await f.review('node verify.mjs', nested);
  assert.match(result!.evidence.join('\n'), /ROOT_EXECUTION_EVIDENCE/);
  assert.equal(result!.evidenceComplete, true);
  await writeFile(join(f.root, 'outside.mjs'), 'console.log("OUTSIDE_CONTENT_MUST_STAY_PRIVATE")');
  await writeFile(join(nested, 'verify.mjs'), "import '../../../outside.mjs';");
  result = await f.review('node verify.mjs', nested);
  assert.equal(result!.evidenceComplete, false);
  assert.doesNotMatch(result!.evidence.join('\n'), /OUTSIDE_CONTENT_MUST_STAY_PRIVATE/);
  await symlink(join(f.root, 'outside.mjs'), join(f.cwd, 'alias.mjs'));
  await writeFile(join(nested, 'verify.mjs'), "import '../../alias.mjs';");
  result = await f.review('node verify.mjs', nested);
  assert.equal(result!.evidenceComplete, false);
  assert.doesNotMatch(result!.evidence.join('\n'), /OUTSIDE_CONTENT_MUST_STAY_PRIVATE/);
});

test('large embedded media preserves surrounding executable evidence and invalidates cached review', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'render.mjs'), 'console.log("fixture")');
  const audio = Buffer.alloc(160_000, 7).toString('base64');
  const page = (value: string) => `<script>window.audio="data:audio/mpeg;base64,${value}";fetch('https://example.invalid/changed');</script>`;
  await writeFile(join(f.cwd, 'app.html'), page(audio));
  const command = `node render.mjs --url '${pathToFileURL(join(f.cwd, 'app.html')).href}#frame=0'`;
  const first = await f.review(command); assert.ok(first);
  const text = first.evidence.join('\n');
  assert.match(text, /omitted payload: chars=/);
  assert.match(text, /fetch\('https:\/\/example.invalid\/changed'\)/);
  assert.doesNotMatch(text, new RegExp(audio.slice(0, 100)));
  assert.equal(first.evidenceComplete, false, 'media MIME and decoder behavior are not proven by a projection');
  const cache = new ReviewCache(); cache.set(f.task, first, { safe: true, repeatable: true, reason: 'fixture' });
  assert.equal(cache.get(f.task, first), undefined);
  await writeFile(join(f.cwd, 'app.html'), page(Buffer.alloc(160_000, 8).toString('base64')));
  assert.notEqual(reviewFingerprint(first), reviewFingerprint((await f.review(command))!));
});

test('media projection never removes active types, malformed payloads or decoding code', () => {
  const payload = 'A'.repeat(2048);
  for (const type of ['text/html', 'application/javascript', 'image/svg+xml']) assert.equal(mediaEvidence(`"data:${type};base64,${payload}"`), undefined);
  assert.equal(mediaEvidence(`"data:audio/mpeg;base64,${payload}!"`), undefined);
  const result = mediaEvidence(`const a="data:audio/mpeg;base64,${payload}";eval(atob(a.split(',')[1]));`);
  assert.ok(result); assert.match(result.text, /eval\(atob/);
});

test('oversized media files and oversized executable remainder retain bounded incomplete evidence', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'huge.html'), 'x'.repeat(8 * 1024 * 1024 + 1));
  const input = await f.review(`node -e "require('fs').readFileSync('huge.html')"`);
  assert.equal(input!.evidenceComplete, false);
  assert.match(input!.evidence.join('\n'), /超出审核上限/);
  assert.ok(input!.evidence.join('\n').length < 5000);
  await writeFile(join(f.cwd, 'large.js'), `const media="data:audio/mpeg;base64,${'A'.repeat(2048)}";` + '//'.repeat(55_000));
  const code = await f.review('node large.js');
  assert.equal(code!.evidenceComplete, false);
  assert.match(code!.evidence.join('\n'), /超出审核上限/);
});
