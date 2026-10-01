import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { DownloadProgress } from './install-download.js';

// Runs in the same killable process tree as npm. Credentials stay in this child;
// fd 3 carries only byte counters and package names, never config or HTTP headers.
const [npmPath, command, ...args] = process.argv.slice(2);
let watchdog: NodeJS.Timeout | undefined;
let lastProgressAt = Date.now(), lastBytes = 0, lastPackage = '', lastAttempt = 0;
function report(progress: DownloadProgress) {
  if (progress.bytes !== lastBytes || progress.package !== lastPackage || progress.attempt !== lastAttempt || progress.state === 'verified') {
    lastProgressAt = Date.now(); lastBytes = progress.bytes; lastPackage = progress.package; lastAttempt = progress.attempt;
  }
  writeSync(3, JSON.stringify(progress) + '\n');
}
function failure(code: string) {
  const safe = /^(?:E[A-Z0-9_]+|ERR_[A-Z_]+|download_[a-z_]+|npm_launcher_missing|npm_start_failed|MODULE_NOT_FOUND)$/.test(code) ? code : 'download_failed';
  writeSync(3, JSON.stringify({ error: safe }) + '\n');
  console.error(safe);
}
try {
  if (!npmPath || !command) throw new Error('npm_launcher_missing');
  // Keep module loading inside the diagnostic boundary as well.
  const { downloadPackages, npmDownloadOptions } = await import('./install-download.js');
  const options = await npmDownloadOptions(npmPath, args);
  const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies?: Record<string, string> };
  watchdog = setInterval(() => {
    if (Date.now() - lastProgressAt < 120_000) return;
    failure('download_stalled');
    process.exit(1);
  }, 1000);
  watchdog.unref();
  await downloadPackages(manifest.dependencies ?? {}, options, report);
  clearInterval(watchdog); watchdog = undefined;
  writeSync(3, 'null\n');
  const npm = spawn(command, [...args, '--prefer-offline'], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
  npm.on('error', () => { failure('npm_start_failed'); process.exitCode = 1; });
  npm.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  if (watchdog) clearInterval(watchdog);
  // Error messages from registry clients can contain authenticated URLs; only
  // known diagnostic codes cross this boundary. Never print the config object.
  const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
  failure(code);
  process.exitCode = 1;
}
