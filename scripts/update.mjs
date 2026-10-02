/**
 * One update pass, run by nexus-update.timer every five minutes (or by hand with `npm run update`):
 * when the committed HEAD differs from what the service runs and the service is idle, build it,
 * run the unit tests, and restart. The build is written to dist.next and swapped into dist only
 * after the tests pass, so a restart during the build still finds a complete dist. When the tests
 * or the restart fail, put the previous build back and tell the user through the still-running
 * service. A commit that failed is not tried
 * again until HEAD moves. Nothing here touches the working tree: a dirty tree is skipped, and the
 * only git write is a fast-forward to the upstream branch when there is one and the tree is clean.
 */
import { execFile } from 'node:child_process';
import { access, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { projectRoot, runtimeHome } from './setup.mjs';

const exec = promisify(execFile);
const port = Number(process.env.NEXUS_PORT ?? 3080);
/** Rehearsals point this at a stand-in that answers `show` and `restart` without systemd. */
const systemctl = process.env.NEXUS_SYSTEMCTL ?? 'systemctl';
const healthUrl = `http://127.0.0.1:${port}/nexus-health`;
const stateFile = join(runtimeHome, 'update-state.json');
const lockFile = join(runtimeHome, 'update.lock');
const reasonFile = join(runtimeHome, 'restart-reason.json');
const dist = join(projectRoot, 'dist');
const previousDist = join(projectRoot, 'dist.previous');
const stagedDist = join(projectRoot, 'dist.next');
const log = line => console.log(`nexus-update: ${line}`);

const exists = path => access(path).then(() => true, () => false);
async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } }

/**
 * A run that died before confirming the new build leaves `dist.previous` (what was serving)
 * and maybe `dist.next` (a staged build that was never swapped in). Same decision as
 * `recoverDist` in src/service/update.ts; it lives here because that module is inside the
 * build this function may have to restore, so it cannot be imported yet.
 */
async function recoverBuilds() {
  if (await exists(previousDist)) {
    if (await exists(dist)) await rm(dist, { recursive: true, force: true });
    await rename(previousDist, dist);
    log('restored dist.previous left by an interrupted run');
  }
  if (await exists(stagedDist)) {
    await rm(stagedDist, { recursive: true, force: true });
    log('removed dist.next left by an interrupted build');
  }
}

async function discardStaged() {
  await rm(stagedDist, { recursive: true, force: true });
}

async function run(file, args, { timeoutMs, env } = {}) {
  try {
    const { stdout, stderr } = await exec(file, args, { cwd: projectRoot, timeout: timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: error.killed ? 'timeout' : (error.message ?? String(error)) };
  }
}
const git = async (...args) => { const result = await run('git', args); return result.ok ? result.stdout.trim() : undefined; };

async function probe() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return { ok: false };
    const snapshot = await response.json();
    return snapshot?.ok === true ? { ok: true, snapshot } : { ok: false };
  } catch { return { ok: false }; }
}

async function unitManaged() {
  const result = await run(systemctl, ['--user', 'show', 'nexus.service', '-p', 'LoadState', '-p', 'UnitFileState', '-p', 'ActiveState']);
  if (!result.ok) return false;
  const field = name => new RegExp(`^${name}=(.*)$`, 'm').exec(result.stdout)?.[1] ?? '';
  return field('LoadState') === 'loaded' && field('UnitFileState') === 'enabled' && field('ActiveState') !== 'inactive';
}

/** Tell the user through the running service; a service that is down cannot relay, so the journal keeps the line either way. */
async function notify(text, id) {
  try {
    const response = await fetch(`${healthUrl}/notice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, id }), signal: AbortSignal.timeout(15_000) });
    log(`notice ${id}: ${response.ok ? 'delivered' : `HTTP ${response.status}`}`);
  } catch (error) { log(`notice ${id} not delivered: ${error?.message ?? error}`); }
}

// Recovery comes before the import: the decision module lives in the very build this script may have to restore.
await recoverBuilds();
if (!await exists(join(dist, 'src/service/update.js'))) { log('no build in dist; run npm run build first'); process.exit(0); }
const { busyReason, failedTestCount, planUpdate, reportedTestCount, rollbackReason, short, START_TIMEOUT_MS, LOCK_STALE_MS, updateFailureNotice } = await import('../dist/src/service/update.js');

// One pass at a time; a lock left by a run that died is taken over after its staleness limit.
try {
  const held = await stat(lockFile);
  if (Date.now() - held.mtimeMs < LOCK_STALE_MS) { log('another update pass is running'); process.exit(0); }
} catch { /* no lock */ }
await writeFile(lockFile, String(process.pid), { mode: 0o600 });

class Done extends Error { constructor(code) { super('done'); this.code = code; } }
const exit = code => { throw new Done(code); };
const state = (await readJson(stateFile)) ?? {};
const now = Date.now();
state.lastCheckAt = now;
const finish = async (result, reason, extra = {}) => {
  Object.assign(state, { lastResult: result, lastReason: reason }, extra);
  await writeJson(stateFile, state);
  log(`${result}: ${reason}`);
};

try {
  // Take the upstream branch when it is strictly ahead and the tree is clean; anything else is left to the developer.
  let head = await git('rev-parse', 'HEAD') ?? '';
  const dirty = head ? ((await git('status', '--porcelain', '--untracked-files=no')) ?? 'unknown').length > 0 : false;
  if (head && !dirty && process.env.NEXUS_UPDATE_NO_FETCH !== '1' && await git('rev-parse', '--abbrev-ref', '@{u}')) {
    const fetched = await run('git', ['fetch', '--quiet'], { timeoutMs: 60_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    if (!fetched.ok) log(`fetch skipped: ${fetched.error}`);
    else {
      const upstream = await git('rev-parse', '@{u}');
      if (upstream && upstream !== head && (await run('git', ['merge-base', '--is-ancestor', head, upstream])).ok) {
        const merged = await run('git', ['merge', '--ff-only', '--quiet', upstream]);
        if (merged.ok) { head = upstream; log(`fast-forwarded to ${short(head)}`); } else log(`fast-forward failed: ${merged.stderr.trim() || merged.error}`);
      }
    }
  }
  const subject = head ? await git('log', '-1', '--format=%s') : undefined;
  const built = (await readJson(join(dist, 'build-info.json')))?.commit;
  const health = await probe();
  const running = health.ok ? health.snapshot.commit : undefined;
  const managed = await unitManaged();
  const plan = planUpdate({ head, dirty, built, running, healthy: health.ok, managed, busy: health.ok ? busyReason(health.snapshot) : undefined, state });
  if (plan.action === 'none') { await finish('up-to-date', plan.reason); exit(0); }
  if (plan.action === 'skip') { await finish('skipped', plan.reason); exit(0); }

  const fail = async (stage, detail, rolledBack = false) => {
    await finish(rolledBack ? 'rolled-back' : 'failed', `${stage} ${short(head)}${detail ? `: ${detail}` : ''}`, { failedCommit: head, lastError: `${stage}${detail ? `: ${detail}` : ''}` });
    if (!rolledBack) await notify(updateFailureNotice(stage, head, subject, running, detail), `update-${short(head)}-${stage}`);
    exit(1);
  };
  const restoreBuild = async () => {
    if (!await exists(previousDist)) return false;
    await rm(dist, { recursive: true, force: true });
    await rename(previousDist, dist);
    return true;
  };

  // Build beside dist, including its immutable plugin.tgz. The source launcher installs
  // that snapshot through DSH before starting the host; restoring dist.previous restores
  // the package snapshot too. No package installation occurs before these tests pass.
  const staging = plan.action === 'build';
  if (staging) {
    log(`building ${plan.reason}`);
    const lockChanged = !built || ((await git('diff', '--name-only', `${built}..${head}`, '--', 'package-lock.json')) ?? 'package-lock.json').length > 0;
    if (lockChanged) {
      const installed = await run('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], { timeoutMs: 300_000 });
      if (!installed.ok) await fail('deps', installed.error === 'timeout' ? '超时' : installed.stderr.trim().split('\n').at(-1));
      log('dependencies installed');
    }
    await discardStaged();
    const build = await run('npm', ['run', 'build'], { timeoutMs: 300_000, env: { NEXUS_DIST: 'dist.next' } });
    if (!build.ok) { await discardStaged(); await fail('build', build.error === 'timeout' ? '超时' : (build.stderr + build.stdout).trim().split('\n').filter(line => /error/i.test(line)).at(0)?.slice(0, 200)); }
    log('built');
  }
  const tests = await run('npm', ['test'], { timeoutMs: 600_000, ...(staging ? { env: { NEXUS_DIST: 'dist.next' } } : {}) });
  const ran = reportedTestCount(tests.stdout);
  // node:test exits 0 when the glob matches nothing, so a missing dist.next would look like success.
  if (!tests.ok || ran === undefined || ran === 0) {
    const failed = failedTestCount(tests.stdout);
    // A staged build never touched dist. A restart-only pass already swapped dist in and
    // left the serving build in dist.previous; put that back so a crash cannot boot untested code.
    if (staging) await discardStaged(); else await restoreBuild();
    const detail = tests.error === 'timeout' ? '超时' : !tests.ok && failed !== undefined ? `${failed} 个测试失败` : ran === 0 ? '没有跑到测试' : undefined;
    await fail('test', detail);
  }
  log('tests passed');
  if (staging) {
    await rm(previousDist, { recursive: true, force: true });
    if (await exists(dist)) await rename(dist, previousDist);
    try { await rename(stagedDist, dist); }
    catch (error) {
      if (!await exists(dist) && await exists(previousDist)) await rename(previousDist, dist);
      throw error;
    }
  }

  await writeJson(reasonFile, { at: Date.now(), reason: `自动更新到 ${short(head)}`, kind: 'update', version: short(head), subject });
  const restarted = await run(systemctl, ['--user', 'restart', 'nexus.service'], { timeoutMs: 60_000 });
  if (!restarted.ok) { await unlink(reasonFile).catch(() => {}); await restoreBuild(); await fail('start', `systemctl restart 失败：${restarted.stderr.trim() || restarted.error}`); }
  const deadline = Date.now() + START_TIMEOUT_MS;
  let up = false;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const check = await probe();
    if (check.ok && check.snapshot.commit === head) { up = true; break; }
  }
  if (!up) {
    const restored = await restoreBuild();
    if (restored) {
      await writeJson(reasonFile, { at: Date.now(), reason: rollbackReason(head, built), kind: 'rollback' });
      await run(systemctl, ['--user', 'restart', 'nexus.service'], { timeoutMs: 60_000 });
      await fail('start', undefined, true);
    }
    await fail('start', '没有上一版本的构建可回退');
  }
  await rm(previousDist, { recursive: true, force: true });
  await finish('updated', `${short(head)}${subject ? ` ${subject}` : ''}`, { updatedTo: head, lastUpdateAt: Date.now(), failedCommit: undefined, lastError: undefined });
} catch (error) {
  if (!(error instanceof Done)) {
    if (!await exists(dist) && await exists(previousDist)) await rename(previousDist, dist).catch(() => {});
    await finish('failed', `脚本出错：${error?.message ?? error}`, { lastError: String(error?.message ?? error) });
    process.exitCode = 1;
  }
  else process.exitCode = error.code;
} finally {
  await unlink(lockFile).catch(() => {});
}
