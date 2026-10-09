import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAcceptanceChecks } from '../src/coders/acceptance-checks.js';
import { inspectArtifact, currentArtifactEvidence } from '../src/coders/artifacts.js';
import { verifyCommandWords, verifyTask } from '../src/coders/verify.js';
import { deliveryReport } from '../src/coders/delivery.js';
import type { TaskRecord } from '../src/coders/types.js';
import type { CoderBrief } from '../src/coders/brief.js';

const brief: CoderBrief = { id: 'brief', revision: 1, objective: 'deliver a reproducible result', constraints: '', ownerSession: 'owner', createdAt: 0, updatedAt: 0,
  acceptance: [{ id: 'a1', text: 'current documentation and its declared files' }, { id: 'a2', text: 'changed input can be reproduced' }] };

test('per-criterion registrations reference real checks and cannot discard the existing contract on resume', () => {
  const prior = [{ criterion: 'a1', commands: ['node docs.cjs'], files: ['README.md'] }];
  assert.throws(() => resolveAcceptanceChecks([{ criterion: 'a1', commands: ['node absent.cjs'] }], brief, ['node docs.cjs']), /未列入/);
  assert.throws(() => resolveAcceptanceChecks([{ criterion: 'missing', files: ['result'] }], brief, []), /未负责/);
  assert.throws(() => resolveAcceptanceChecks([], brief, ['node docs.cjs'], prior), /保留/);
  assert.throws(() => resolveAcceptanceChecks([{ criterion: 'a1', commands: ['node docs.cjs'] }], brief, ['node docs.cjs'], prior), /保留/);
  assert.deepEqual(resolveAcceptanceChecks(undefined, brief, ['node docs.cjs'], prior), prior);
});

test('shell receipts cannot mask native verification failure or run later checks', async t => {
  for (const command of ['pwsh -NoProfile -Command "python verify.py; echo EXIT=$LASTEXITCODE"', 'cmd /c "python verify.py & echo done"', 'bash -lc "false; true"']) {
    assert.throws(() => verifyCommandWords(command, 'win32'), /内联 shell 包装/, command);
  }
  assert.deepEqual(verifyCommandWords('"C:\\Program Files\\Python\\python.exe" verify.py', 'win32'), ['C:\\Program Files\\Python\\python.exe', 'verify.py']);
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-exit-checks-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'fail.cjs'), 'console.log("EXIT=0 is just text"); process.exit(7);');
  await writeFile(join(cwd, 'later.cjs'), 'require("fs").writeFileSync("should-not-exist", "ran");');
  const result = await verifyTask({ cwd, verify: 'node fail.cjs', verifyCommands: ['node later.cjs'] }, [cwd]);
  assert.equal(result.verifyOk, false); assert.match(result.verifyOutput!, /exit 7/);
  assert.deepEqual(result.verifyChecks?.map(check => [check.ok, check.executed]), [[false, true], [false, false]]);
  await assert.rejects(stat(join(cwd, 'should-not-exist')));
});

test('stale documentation, a claimed but absent file and an unrun reproduction branch cannot become delivery success', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-artifact-checks-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'README.md'), 'version 1');
  await writeFile(join(cwd, 'docs.cjs'), 'const fs = require("fs"); if (fs.readFileSync("README.md", "utf8") !== "version 2") process.exit(1);');
  await writeFile(join(cwd, 'reproduce.cjs'), 'const fs = require("fs"); const variant = process.argv[2]; if (!variant) process.exit(2); fs.writeFileSync(variant + ".txt", "verified " + variant);');
  const task: TaskRecord = { id: 'task', coder: 'claude', ownerSession: 'owner', cwd, brief, description: 'prepare delivery', status: 'completed', createdAt: 0, updatedAt: 1, decisions: [], escalations: 0,
    verify: 'node docs.cjs', verifyCommands: ['node reproduce.cjs changed-text', 'node reproduce.cjs changed-rate'], outputs: ['README.md', 'status.json'],
    acceptanceChecks: [{ criterion: 'a1', commands: ['node docs.cjs'], files: ['README.md', 'status.json'] },
      { criterion: 'a2', commands: ['node reproduce.cjs changed-text', 'node reproduce.cjs changed-rate'], files: ['changed-text.txt', 'changed-rate.txt'] }] };
  const check = async () => {
    const result = await verifyTask(task, [cwd]);
    task.status = result.verifyOk ? 'completed' : 'failed';
    task.result = { ...result, summary: 'coder claimed done', execution: 'completed', verification: result.verifyOk ? 'passed' : 'failed' };
    return result;
  };
  const first = await check();
  assert.equal(first.verifyChecks?.[0]?.ok, false); assert.equal(first.verifyChecks?.[1]?.executed, false);
  assert.match(deliveryReport(brief, [task]), /检查通过 0\/2/);
  assert.match(deliveryReport(brief, [task]), /status.json.*不存在/);
  await writeFile(join(cwd, 'README.md'), 'version 2');
  const second = await check();
  assert.equal(second.verifyChecks?.every(check => check.ok && check.executed), true);
  assert.equal(second.verifyOk, false, 'passing commands cannot prove an absent declared artifact exists');
  assert.match(deliveryReport(brief, [task]), /检查通过 1\/2/);
  await writeFile(join(cwd, 'status.json'), '{"complete":true}');
  assert.equal((await check()).verifyOk, true);
  assert.equal(await readFile(join(cwd, 'changed-rate.txt'), 'utf8'), 'verified changed-rate');
  assert.match(deliveryReport(brief, [task]), /检查通过 2\/2，用户验收 0\/2/);
  const saved = structuredClone(task);
  const original = await stat(join(cwd, 'README.md'));
  await writeFile(join(cwd, 'README.md'), 'version 1'); await utimes(join(cwd, 'README.md'), original.atime, original.mtime);
  const view = await currentArtifactEvidence([task]);
  assert.match(deliveryReport(brief, view), /独立验证后已变化/);
  assert.match(deliveryReport(brief, view), /检查通过 1\/2/);
  assert.deepEqual(task, saved, 'delivery inspection must not rewrite the persisted task');
});

test('declared files cannot redirect inspection through a link, or convert a missing file into not-run', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'nexus-artifact-boundary-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'real'), 'fixture'); await symlink(join(cwd, 'real'), join(cwd, 'linked'));
  assert.equal((await inspectArtifact(join(cwd, 'linked'), cwd)).ok, false);
  assert.equal((await inspectArtifact(join(cwd, '..', 'outside'), cwd)).ok, false);
  const missing = await verifyTask({ cwd, outputs: ['missing'] }, [cwd]);
  assert.equal(missing.verifyOk, false); assert.equal(missing.verifyExecuted, true);
});
