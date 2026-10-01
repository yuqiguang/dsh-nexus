/**
 * Install or remove the systemd user units: `node scripts/service.mjs install|uninstall|status`.
 * Install copies deploy/*.service and *.timer into ~/.config/systemd/user with the project path and
 * the current PATH filled in, reloads systemd, enables linger (so the service runs without a login
 * session), and starts the service, the health timer, and the update timer.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { projectRoot } from './setup.mjs';

const exec = promisify(execFile);
const units = ['nexus.service', 'nexus-health.service', 'nexus-health.timer', 'nexus-update.service', 'nexus-update.timer'];
const target = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
const command = process.argv[2] ?? 'status';

async function systemctl(...args) {
  const { stdout } = await exec('systemctl', ['--user', ...args]);
  return stdout.trim();
}

/** True when something already answers on the service port and it is not our unit: a hand-started `npm start` must be stopped first. */
async function portTaken() {
  const port = Number(process.env.NEXUS_PORT ?? 3080);
  try { await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(3000) }); return true; }
  catch (error) { return error?.name === 'TimeoutError'; }
}

if (command === 'install') {
  if (process.platform !== 'linux') throw new Error('systemd units are for Linux only.');
  await readFile(join(projectRoot, 'dist/client.js')).catch(() => { throw new Error('Run npm run build before installing the service.'); });
  const active = await systemctl('is-active', 'nexus.service').catch(error => error.stdout?.trim() ?? 'unknown');
  if (active !== 'active' && await portTaken()) {
    throw new Error('Something is already listening on the service port (a hand-started npm start?). Stop it first, then run this again.');
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const unit of units) {
    // The PATH sits inside a quoted Environment= value (WSL paths carry spaces); quotes and backslashes in it are escaped the systemd way.
    const path = (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const text = (await readFile(join(projectRoot, 'deploy', unit), 'utf8')).replaceAll('__PROJECT__', projectRoot).replaceAll('__PATH__', path);
    await writeFile(join(target, unit), text, { mode: 0o644 });
  }
  await systemctl('daemon-reload');
  try { await exec('loginctl', ['enable-linger', process.env.USER ?? '']); } catch { console.warn('Could not enable linger; the service will stop when you log out.'); }
  await systemctl('enable', '--now', 'nexus.service');
  await systemctl('enable', '--now', 'nexus-health.timer');
  await systemctl('enable', '--now', 'nexus-update.timer');
  console.log(`Installed ${units.join(', ')} into ${target} and started nexus.service.`);
} else if (command === 'uninstall') {
  for (const unit of ['nexus-update.timer', 'nexus-health.timer', 'nexus.service']) { try { await systemctl('disable', '--now', unit); } catch { /* not installed */ } }
  for (const unit of units) { try { await unlink(join(target, unit)); } catch { /* already gone */ } }
  await systemctl('daemon-reload');
  console.log('Removed the Nexus units. The service is stopped; start it by hand with npm start.');
} else if (command === 'status') {
  for (const unit of ['nexus.service', 'nexus-health.timer', 'nexus-update.timer']) {
    try { console.log(await systemctl('status', '--no-pager', '--lines=5', unit)); } catch (error) { console.log(error.stdout?.trim() || `${unit}: not installed`); }
  }
} else {
  throw new Error('Usage: node scripts/service.mjs install|uninstall|status');
}
