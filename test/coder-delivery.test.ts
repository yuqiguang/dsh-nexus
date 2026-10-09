import assert from 'node:assert/strict';
import { test } from 'node:test';
import { criterionEvidence, deliveryReport } from '../src/coders/delivery.js';
import { briefReport, type CoderBrief } from '../src/coders/brief.js';
import { taskReport } from '../src/coders/index.js';
import type { TaskRecord } from '../src/coders/types.js';
import { changeSummary } from '../src/coders/change-summary.js';
const brief: CoderBrief = { id: 'b', revision: 1, objective: 'goal', constraints: '', acceptance: [{ id: 'a1', text: 'works' }], ownerSession: 'owner', createdAt: 0, updatedAt: 0 };
const record: TaskRecord = { id: 't', ownerSession: 'owner', brief, description: 'work', coder: 'claude', cwd: '/work', verify: 'node check.cjs', status: 'completed', createdAt: 1, updatedAt: 2,
  escalations: 0, decisions: [], result: { summary: 'done', changedFiles: ['/work/out'], commits: ['a'.repeat(40)], outsideRoots: [], execution: 'completed', verification: 'passed', verifyOk: true,
    verifyChecks: [{ command: 'node check.cjs', ok: true, executed: true, output: 'observed pass' }] } };
test('delivery separates command checks from user acceptance and invalidates changed evidence', () => {
  assert.match(deliveryReport(brief, [record]), /业务验收待确认/);
  const accepted = { ...brief, reviews: [{ criterion: 'a1', evidence: criterionEvidence(brief, [record], 'a1').evidence, accepted: true, note: 'tested actual flow', at: 3 }] };
  assert.match(deliveryReport(accepted, [record]), /检查与业务验收均通过/);
  assert.match(deliveryReport(accepted, [record]), /\/work\/out/);
  assert.match(deliveryReport(accepted, [record]), new RegExp('a'.repeat(40)));
  assert.match(deliveryReport(accepted, [{ ...record, updatedAt: 4 }]), /业务验收待确认/);
  assert.match(deliveryReport(accepted, [{ ...record, ownerSession: 'foreign' }]), /任务 未安排/);
  assert.match(deliveryReport({ ...accepted, revision: 2 }, [record]), /尚未完成全部验收/);
});

test('multiple criteria do not inherit one task-wide pass, and individual failed or skipped checks remain visible', () => {
  const goal: CoderBrief = { ...brief, acceptance: [{ id: 'a1', text: 'output' }, { id: 'a2', text: 'updated documentation' }, { id: 'a3', text: 'reproduction variants' }] };
  const task: TaskRecord = { ...record, brief: goal, verify: 'node output.cjs', verifyCommands: ['node docs.cjs', 'node reproduce.cjs'] };
  assert.match(deliveryReport(goal, [task]), /检查通过 0\/3/);
  assert.match(deliveryReport(goal, [task]), /未登记本项对应的独立检查/);
  task.acceptanceChecks = goal.acceptance.map((item, index) => ({ criterion: item.id, commands: [['node output.cjs'], ['node docs.cjs'], ['node reproduce.cjs']][index]!, files: [] }));
  task.status = 'failed';
  task.result = { ...task.result!, verification: 'failed', verifyOk: false, verifyChecks: [
    { command: 'node output.cjs', ok: true, executed: true, output: 'output passed' },
    { command: 'node docs.cjs', ok: false, executed: true, output: 'README still describes v1' },
    { command: 'node reproduce.cjs', ok: false, executed: false, output: 'previous check failed' },
  ] };
  assert.equal(criterionEvidence(goal, [task], 'a1').checked, true);
  assert.equal(criterionEvidence(goal, [task], 'a2').checked, false);
  assert.equal(criterionEvidence(goal, [task], 'a3').checked, false);
  assert.match(deliveryReport(goal, [task]), /检查通过 1\/3/);
  const original = criterionEvidence(goal, [task], 'a1').evidence;
  task.acceptanceChecks[0]!.files.push('status.json');
  assert.equal(criterionEvidence(goal, [task], 'a1').checked, false);
  assert.notEqual(criterionEvidence(goal, [task], 'a1').evidence, original);
});

test('dependency caches and large image sequences cannot bury declared outputs, source or reports', () => {
  const frames = Array.from({ length: 150 }, (_, i) => `/work/frames/${i}.png`);
  const files = [...frames, '/work/pydeps/av/__init__.py', '/work/.pip-cache/cache', '/work/video.mp4', '/work/pipeline/narrate.py', '/work/README.md'];
  const summary = changeSummary(files, ['/work/video.mp4']);
  assert.deepEqual(summary.dependencies, ['/work/pydeps/av/__init__.py']);
  assert.deepEqual(summary.generated, ['/work/.pip-cache/cache']);
  assert.equal(summary.project[0], '/work/video.mp4');
  assert.ok(summary.project.indexOf('/work/README.md') < summary.project.indexOf(frames[0]!));
  assert.equal(summary.project.filter(file => file.includes('/frames/')).length, 150);
  assert.equal(files[0], frames[0], 'sorting never mutates the audit');
});

test('delivery counts project changes separately while retaining generated paths in boundary audits', () => {
  const files = ['/work/app/main.py', '/work/.venv/Lib/site-packages/pkg.py', '/work/node_modules/pkg/index.js',
    '/work/app/__pycache__/main.pyc', 'C:\\Temp\\pytest-of-user\\pytest-3\\test_x\\sample.txt', '/work/test_data/sample.txt'];
  const result = { ...record.result!, changedFiles: files, outsideRoots: [files[4]!] };
  const changed = { ...record, result };
  const report = deliveryReport(brief, [changed]);
  assert.match(report, /项目文件 2，依赖 2，测试\/缓存产物 2/);
  assert.match(report, /\/work\/test_data\/sample.txt/);
  assert.doesNotMatch(report, /site-packages|__pycache__/);
  assert.match(briefReport(brief, [changed]), /项目文件 2，依赖 2，测试\/缓存产物 2/);
  const taskText = taskReport(changed, { status: 'completed', result: 'done' }, result);
  assert.ok(taskText.includes(files[4]!), 'outside-root generated paths remain visible for review');
  assert.deepEqual(changed.result.changedFiles, files, 'presentation must not remove persisted audit paths');
});
