import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'yaml';
import { assistantPlugins, projectRoot, scheduleBundle } from './setup.mjs';

const exec = promisify(execFile);
const root = join(projectRoot, '.nexus', 'smoke');
await mkdir(root, { recursive: true, mode: 0o700 });
const runRoot = await mkdtemp(join(root, 'run-'));
const runtime = join(runRoot, 'runtime');
// Outside this repository, as the live assistant's is: DSH loads the AGENTS.md of every directory from the first
// `.git` above a session's cwd down to it, so a workspace in here would be told this repo's developer rules.
const workspace = await mkdtemp(join(tmpdir(), 'nexus-smoke-workspace-'));
const profile = join(runtime, 'profiles', 'nexus');
await mkdir(profile, { recursive: true, mode: 0o700 });
const require = createRequire(import.meta.url);
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.version, '0.2.0-rc.2');
const entry = join(dirname(manifestPath), manifest.bin.dsh);
await writeFile(join(profile, 'package.json'), JSON.stringify({
  private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'startup' } },
}));
const summaries = [];
let peakRssMiB = 0;
let minimumAvailableMiB = Infinity;
const pluginRuntime = join(runRoot, 'plugin-runtime');
const pluginOnly = process.argv.includes('--plugin-only');
const interactionOnly = process.argv.includes('--interaction-only');
// A fixture inside this repo would itself activate nexus-next's client manifest after uninstall.
const packageFixture = join(runRoot, 'package-fixture');
await mkdir(packageFixture);
await writeFile(join(packageFixture, 'package.json'), JSON.stringify({ name: 'nexus-install-fixture', private: true, type: 'module' }));
for (const name of ['pluginSmokePlugin.js', 'helpers.js']) await copyFile(join(projectRoot, 'dist/test', name), join(packageFixture, name));

async function availableMemory() {
  if (process.platform !== 'linux') return Infinity;
  const value = /MemAvailable:\s+(\d+)/.exec(await readFile('/proc/meminfo', 'utf8'));
  return Number(value?.[1] ?? 0) / 1024;
}

const codersOnly = process.argv.includes('--coders-only');
const wechatOnly = process.argv.includes('--wechat-only');
const remindersOnly = process.argv.includes('--reminders-only');
const mediaOnly = process.argv.includes('--media-only');
const memoryOnly = process.argv.includes('--memory-only');
const serviceOnly = process.argv.includes('--service-only');
const mailOnly = process.argv.includes('--mail-only');
const documentsOnly = process.argv.includes('--documents-only');
const nativeOnly = process.argv.includes('--native-only');
const rebindOnly = process.argv.includes('--rebind-only');
const dataOnly = process.argv.includes('--data-only');
for (const phase of pluginOnly ? [7, 8, 9, 10] : interactionOnly ? [11, 12] : codersOnly ? [12] : wechatOnly ? [5, 6] : remindersOnly ? [13, 14] : mediaOnly ? [15, 16] : memoryOnly ? [17, 18] : serviceOnly ? [19, 20] : mailOnly ? [21] : documentsOnly ? [22] : nativeOnly ? [1, 2] : rebindOnly ? [23, 24] : dataOnly ? [25, 26]
  : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]) {
  if (await availableMemory() < 800) throw new Error('Not enough available RAM to start the smoke check (800 MiB required).');
  // What scripts/start.mjs does before DSH starts, and before this runner writes the phase's profile patch: swap in the import phase 25 staged.
  if (phase === 26) {
    const { applyPendingImport } = await import(pathToFileURL(join(projectRoot, 'dist/src/data/archive.js')).href);
    const imported = await applyPendingImport(runtime);
    assert.ok(imported, 'phase 25 left an import staged');
    console.log(`Native DSH phase 26: import swapped in (${imported.summary.sessions} sessions, ${imported.summary.records} records, ${imported.summary.credentials} credentials).`);
  }
  const triggerFile = join(runRoot, `phase-${phase}.go`);
  const reportFile = join(runRoot, `phase-${phase}.json`);
  const installedPlugin = phase >= 7 && phase <= 10;
  const activeRuntime = installedPlugin ? pluginRuntime : runtime;
  const activeProfile = installedPlugin ? join(activeRuntime, 'profiles', 'nexus') : profile;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(KEY|SECRET|TOKEN|PASSWORD)/i.test(key) || key.startsWith('NEXUS_FEISHU_') || key.startsWith('DSH_')) delete env[key];
  }
  Object.assign(env, { DSH_HOME: activeRuntime, DSH_TELEMETRY_DISABLED: '1', NEXUS_FEISHU_ENABLED: '0', NODE_OPTIONS: '--max-old-space-size=384' });
  if (phase === 7) {
    const packed = JSON.parse((await exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', runRoot], { cwd: projectRoot, env })).stdout)[0];
    assert.ok(packed.files.some(file => file.path === 'cordis.patch.yml'));
    assert.ok(packed.files.every(file => !/^(?:\.nexus|workspace|src|test|node_modules)\//.test(file.path)));
    await mkdir(activeProfile, { recursive: true });
    await writeFile(join(activeProfile, 'package.json'), JSON.stringify({ private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', scheduleBundle], patchReload: 'startup' } } }));
    await writeFile(join(activeProfile, 'pnpm-workspace.yaml'), 'autoInstallPeers: false\nnodeLinker: hoisted\n');
    await exec(process.execPath, ['--max-old-space-size=384', entry, 'plugin', '--profile', 'nexus', 'add', join(runRoot, packed.filename),
      // The first run after a dependency change must fetch it into pnpm's store through a slow mirror; later runs reuse the store.
      '--ignore-scripts', '--network-concurrency=1', '--child-concurrency=1', ...(process.env.NEXUS_SMOKE_OFFLINE === '1' ? ['--offline'] : [])], { cwd: projectRoot, env, timeout: 900_000 });
    const installed = JSON.parse(await readFile(join(activeProfile, 'package.json'), 'utf8'));
    assert.ok(installed.dsh.profile.bundles.includes('nexus-next'), 'official plugin add must activate the bundle');
  }
  if (phase === 10) {
    await exec(process.execPath, ['--max-old-space-size=384', entry, 'plugin', '--profile', 'nexus', 'remove', 'nexus-next', '--config.ignore-scripts=true'],
      { cwd: projectRoot, env, timeout: 60_000 });
    const removed = JSON.parse(await readFile(join(activeProfile, 'package.json'), 'utf8'));
    assert.ok(!removed.dsh.profile.bundles.includes('nexus-next'));
  }
  const previousPatch = installedPlugin ? parse(await readFile(join(activeProfile, 'cordis.patch.yml'), 'utf8').catch(() => '[]')) ?? [] : [];
  const componentOverrides = previousPatch.filter(row => ['nexus-documents', 'nexus-memory', 'nexus-mail', 'nexus-agenda'].includes(row.id) && !row.insert);
  await writeFile(join(activeProfile, 'cordis.patch.yml'), JSON.stringify([
    ...componentOverrides,
    { id: 'session-title-llm', disabled: true },
    ...(phase === 12 ? [{ id: 'web', config: { searchProvider: 'nexus-research-fixture', fetchProvider: 'nexus-research-fixture' } }] : []),
    { id: 'agent-default-model', config: { provider: 'nexus-fixture', model: 'fixture' } },
    // Development phases load the reminder plugins the way the dev profile does; the installed tarball brings them through its own patch.
    ...(installedPlugin ? [] : [{ insert: assistantPlugins }]),
    { insert: [{ id: 'nexus-native-smoke',
      name: pathToFileURL(installedPlugin ? join(packageFixture, 'pluginSmokePlugin.js') : join(projectRoot,
        phase >= 25 ? 'dist/test/dataSmokePlugin.js' : phase >= 23 ? 'dist/test/rebindSmokePlugin.js' : phase === 22 ? 'dist/test/documentSmokePlugin.js' : phase === 21 ? 'dist/test/mailSmokePlugin.js' : phase >= 19 ? 'dist/test/serviceSmokePlugin.js' : phase >= 17 ? 'dist/test/memorySmokePlugin.js' : phase >= 15 ? 'dist/test/mediaSmokePlugin.js' : phase >= 13 ? 'dist/test/reminderSmokePlugin.js' : phase === 12 ? 'dist/test/coderSmokePlugin.js' : phase === 11 ? 'dist/test/questionSmokePlugin.js' : phase < 3 ? 'dist/test/nativeSmokePlugin.js'
          : phase < 5 ? 'dist/test/settingsSmokePlugin.js' : 'dist/test/wechatSmokePlugin.js')).href,
      config: { phase, workspace, triggerFile, reportFile, packageDir: join(activeProfile, 'node_modules/nexus-next') } }] },
    // Supplemental shared-Fetch-only host. Current Desktop uses an HTTP Host; this is not an Electron test.
    ...(phase === 9 ? ['web-startup', 'webserver', 'web-runtime', 'client-hmr', 'open-in-app', 'ui-open-in-app', 'directory-picker', 'hmr']
      .map(id => ({ id, disabled: true })).concat([{ id: 'connection', inject: ['credentials'], config: {} }]) : []),
  ]));
  const child = spawn(process.execPath, ['--max-old-space-size=384', entry, '--profile', 'nexus', ...(phase === 9 ? [] : ['--no-open', '--port', '0'])], {
    cwd: workspace, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  let ready = false;
  let diagnostics = '';
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  // Never persist or print the authenticated startup URL.
  child.stdout.on('data', chunk => { if (chunk.toString().includes(phase === 9 ? 'Nexus package fixture ready.' : 'dsh web:')) ready = true; });
  child.stderr.on('data', chunk => {
    diagnostics = (diagnostics + chunk.toString().replace(/https?:\/\/\S+/g, '[URL redacted]')).slice(-12000);
  });
  const kill = signal => {
    try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {}
  };
  let guardFailure;
  let monitoring = false;
  const monitor = setInterval(async () => {
    if (monitoring || exited || process.platform !== 'linux') return;
    monitoring = true;
    try {
      const available = await availableMemory();
      minimumAvailableMiB = Math.min(minimumAvailableMiB, available);
      const { stdout } = await exec('ps', ['-eo', 'pid=,ppid=,rss=']);
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const pids = new Set([child.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows) if (pids.has(parent) && !pids.has(pid)) { pids.add(pid); changed = true; }
      }
      const rss = rows.reduce((total, [pid, , memory]) => total + (pids.has(pid) ? memory : 0), 0) / 1024;
      peakRssMiB = Math.max(peakRssMiB, rss);
      if (available < 512 || rss > 768) { guardFailure = 'Smoke process exceeded the memory guard.'; kill('SIGTERM'); }
    } finally { monitoring = false; }
  }, 1000);
  try {
    const deadline = Date.now() + 60_000;
    while (!ready) {
      if (guardFailure) throw new Error(guardFailure);
      if (exited || Date.now() > deadline) throw new Error(`DSH did not start. ${diagnostics}`);
      await delay(100);
    }
    await writeFile(triggerFile, 'run\n');
    let report;
    while (!report) {
      if (guardFailure) throw new Error(guardFailure);
      try { report = JSON.parse(await readFile(reportFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
      if (report) break;
      // A phase may end by killing its own process right after writing the report (the crash phase does), so the report is read first.
      if (exited || Date.now() > deadline) throw new Error(`Native integration timed out. ${diagnostics}`);
      await delay(100);
    }
    assert.equal(report.passed, true, JSON.stringify(report));
    summaries.push(report);
    console.log(`Native DSH phase ${phase}: ${report.checks.length} checks passed.`);
  } finally {
    clearInterval(monitor);
    kill('SIGTERM');
    for (let count = 0; count < 100 && !exited; count++) await delay(100);
    if (!exited) { kill('SIGKILL'); await delay(200); }
    assert.ok(exited, 'smoke child must exit');
  }
  // Phase 19 kills itself, so its run record must lack the clean mark; phase 20 stops on SIGTERM and must have set it in the disposer.
  if (phase === 19 || phase === 20) {
    const run = JSON.parse(await readFile(join(activeRuntime, 'service-run.json'), 'utf8'));
    assert.equal(run.clean === true, phase === 20, `service-run.json after phase ${phase}: ${JSON.stringify(run)}`);
    if (phase === 20) console.log('Native DSH phase 20: clean stop recorded on SIGTERM.');
  }
}
if (!pluginOnly && !interactionOnly && !codersOnly && !wechatOnly && !remindersOnly && !mediaOnly && !memoryOnly && !serviceOnly && !mailOnly && !documentsOnly && !rebindOnly && !dataOnly) {
  assert.equal(summaries[0].sessionId, summaries[1].sessionId);
  assert.equal(summaries[1].completedTurns, 2);
}
if (!pluginOnly && !interactionOnly && !codersOnly && !wechatOnly && !remindersOnly && !mediaOnly && !memoryOnly && !serviceOnly && !mailOnly && !documentsOnly && !nativeOnly && !rebindOnly && !dataOnly) {
  assert.equal(summaries[4].sessionId, summaries[5].sessionId);
  assert.equal(summaries[5].recoveryModelCalls, 0);
}
if (wechatOnly) {
  assert.equal(summaries[0].sessionId, summaries[1].sessionId);
  assert.equal(summaries[1].recoveryModelCalls, 0);
}
const summary = { passed: true, dshVersion: manifest.version, model: 'local scripted fixture',
  channels: 'local channel fixtures and fault-injected loopback WeChat HTTP', checks: summaries.flatMap(item => item.checks),
  peakRssMiB: Math.round(peakRssMiB), minimumAvailableMiB: Math.round(minimumAvailableMiB),
  phases: summaries, evidence: runRoot };
await writeFile(join(root, pluginOnly ? 'latest-plugin.json' : interactionOnly ? 'latest-interaction.json' : codersOnly ? 'latest-coders.json' : wechatOnly ? 'latest-wechat.json' : remindersOnly ? 'latest-reminders.json' : mediaOnly ? 'latest-media.json' : memoryOnly ? 'latest-memory.json' : serviceOnly ? 'latest-service.json' : mailOnly ? 'latest-mail.json' : documentsOnly ? 'latest-documents.json' : nativeOnly ? 'latest-native.json' : rebindOnly ? 'latest-rebind.json' : dataOnly ? 'latest-data.json' : 'latest.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`${pluginOnly ? 'Installed plugin lifecycle' : 'Native session restart'} verified. Peak DSH RSS: ${summary.peakRssMiB} MiB.`);
