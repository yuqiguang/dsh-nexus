import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { setup, projectRoot, runtimeHome } from './setup.mjs';
import { networkNodeOptions } from './netflags.mjs';
import { saveWebUrl, splitWebUrl } from './weburl.mjs';
import { ensureProfilePackage } from './profile-package.mjs';

await access(join(projectRoot, 'dist/client.js')).catch(() => {
  throw new Error('Run npm run build before starting Nexus.');
});
// A data import staged from the settings page is swapped in here, before DSH opens any of it and before setup
// back-fills the profile. A failure part-way leaves the note in place for the next start, and DSH is not started
// on half-swapped data.
const { applyPendingImport, importedReason } = await import(pathToFileURL(join(projectRoot, 'dist/src/data/archive.js')).href);
try {
  const imported = await applyPendingImport(runtimeHome);
  if (imported) {
    const reason = importedReason(imported, Date.now());
    await writeFile(join(runtimeHome, 'restart-reason.json'), JSON.stringify(reason), { mode: 0o600 });
    console.log(`nexus: ${reason.reason}`);
  }
} catch (error) {
  console.error(`nexus: the staged data import could not be applied: ${error?.message ?? error}`);
  process.exit(1);
}
const paths = await setup();
const prepared = await ensureProfilePackage({ root: projectRoot, home: runtimeHome,
  offline: process.env.NEXUS_PACKAGE_OFFLINE === '1' });
console.log(`nexus: profile package ${prepared.status}; converted ${prepared.converted} source entries`);
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.version !== '0.2.0-rc.2') throw new Error('Unexpected DSH version; review the lockfile.');
const entry = join(dirname(manifestPath), typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.dsh);
// In a terminal the login address is shown as DSH prints it. Anywhere else (systemd's journal keeps it for weeks)
// the output is passed through except that line, which is split: the bare origin is printed, the address saved.
const interactive = process.stdout.isTTY === true;
const child = spawn(process.execPath, [entry, '--profile', 'nexus', ...process.argv.slice(2)], {
  cwd: paths.workspace,
  env: { ...process.env, DSH_HOME: paths.runtimeHome, NEXUS_IMPORT_HOME: paths.runtimeHome, NODE_OPTIONS: networkNodeOptions() },
  stdio: ['inherit', interactive ? 'inherit' : 'pipe', 'inherit'],
});
if (!interactive) {
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    const web = splitWebUrl(line);
    if (!web) { process.stdout.write(`${line}\n`); return; }
    process.stdout.write(`${web.shown}\n`);
    saveWebUrl(join(paths.runtimeHome, 'web-url'), web.saved).catch(() => { console.error('Could not save the web address to .nexus/web-url.'); });
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('error', () => { console.error('Could not start the DSH application.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
