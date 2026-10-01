/**
 * One health probe: GET the loopback health route, apply the pure decision in
 * dist/src/service/healthcheck.js against the state kept in .nexus/health-state.json,
 * and restart the systemd user unit when the service has stopped answering.
 * Exit code 0 when healthy, 1 when not; the line it prints goes to the journal.
 */
import { execFile } from 'node:child_process';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runtimeHome } from './setup.mjs';

const exec = promisify(execFile);
const port = Number(process.env.NEXUS_PORT ?? 3080);
const url = `http://127.0.0.1:${port}/nexus-health`;
const stateFile = join(runtimeHome, 'health-state.json');
const reasonFile = join(runtimeHome, 'restart-reason.json');
const lockFile = join(runtimeHome, 'update.lock');
const { decide } = await import('../dist/src/service/healthcheck.js');
// A build from before the updater existed has no update module; the lock is then judged by the same 30-minute limit.
const { LOCK_STALE_MS } = await import('../dist/src/service/update.js').catch(() => ({ LOCK_STALE_MS: 30 * 60_000 }));

/** True while scripts/update.mjs holds its lock (a lock older than its staleness limit is ignored). */
async function updating() {
  try { return Date.now() - (await stat(lockFile)).mtimeMs < LOCK_STALE_MS; } catch { return false; }
}

async function readState() {
  try { return JSON.parse(await readFile(stateFile, 'utf8')); } catch { return { failures: 0 }; }
}

async function writeJson(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  await rename(temp, path);
}

async function probe() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const snapshot = await response.json();
    return snapshot?.ok === true ? { ok: true, snapshot } : { ok: false, error: 'health body not ok' };
  } catch (error) {
    return { ok: false, error: error?.name === 'AbortError' ? 'timeout after 10s' : (error?.cause?.code ?? error?.code ?? error?.message ?? String(error)) };
  } finally { clearTimeout(timer); }
}

/**
 * Only a unit systemd knows, that is enabled, and that is not stopped on purpose is restarted: a hand-started service and a
 * `systemctl --user stop nexus` are left alone. A unit that hit its start limit (`failed`) is reset first so the restart can happen.
 */
async function unitState() {
  try {
    const { stdout } = await exec('systemctl', ['--user', 'show', 'nexus.service', '-p', 'LoadState', '-p', 'UnitFileState', '-p', 'ActiveState']);
    const field = name => new RegExp(`^${name}=(.*)$`, 'm').exec(stdout)?.[1] ?? '';
    return { loaded: field('LoadState') === 'loaded', enabled: field('UnitFileState') === 'enabled', active: field('ActiveState') };
  } catch { return { loaded: false, enabled: false, active: '' }; }
}

const now = Date.now();
const state = await readState();
const result = await probe();
const unit = result.ok ? undefined : await unitState();
const managed = unit !== undefined && unit.loaded && unit.enabled && unit.active !== 'inactive';
const decision = decide(state, result, now, managed, result.ok ? false : await updating());
await writeJson(stateFile, decision.state);
console.log(unit && !managed && unit.loaded ? `${decision.line} (unit ${unit.active || 'unknown'}, enabled=${unit.enabled})` : decision.line);
if (decision.restart) {
  await writeJson(reasonFile, { at: now, reason: decision.restart });
  if (unit?.active === 'failed') await exec('systemctl', ['--user', 'reset-failed', 'nexus.service']).catch(() => {});
  await exec('systemctl', ['--user', 'restart', 'nexus.service']);
}
process.exitCode = result.ok ? 0 : 1;
