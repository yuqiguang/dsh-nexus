/** Private pipe runner; process ownership is implemented by DSH's public Win32 API.
 * The target starts suspended and enters a kill-on-close Job before any user code runs.
 * Closing the host's IPC channel, cancellation and normal root exit all drain the Job.
 */
import type * as Win32 from '@deepseek-ai/dsh-win32-process';

type Request = { command: string; args: string[]; cwd: string; env: Record<string, string> };
let api: ReturnType<typeof Win32.loadWin32ProcessBindings>;
let native: typeof Win32;
let owned: Win32.SpawnedJobProcess | undefined;
let stopping = false;
let result: number | undefined;
let failed = false;
let timer: NodeJS.Timeout | undefined;

function close(): void {
  if (timer) clearInterval(timer);
  if (owned) {
    // Closing the sole Job handle also kills members after an unexpected JS exit.
    const handles = owned; owned = undefined;
    try { native.closeHandleChecked(api, handles.job, 'Nexus Job'); }
    finally { native.closeHandleChecked(api, handles.process, 'Nexus process'); }
  }
}
process.on('exit', close);
function stop(): void {
  stopping = true;
  if (owned) native.terminateJob(api, owned.job, 1);
  else if (!timer) process.exit(1);
}
function poll(): void {
  try {
    if (!owned) return;
    const code = native.pollProcessExit(api, owned.process);
    if (code !== undefined && result === undefined) { result = code; stop(); }
    if ((stopping || result !== undefined) && native.isJobEmpty(api, owned.job)) {
      close();
      const code = failed ? 1 : result ?? 1;
      if (process.connected) process.send?.({ type: 'nexus-job-empty' }, () => process.exit(code));
      else process.exit(code);
    }
  } catch { fail(); }
}
function fail(): void {
  failed = true;
  try { stop(); } catch { /* closing the Job is the final cleanup */ }
  close(); process.exit(1);
}
process.on('disconnect', () => { try { stop(); if (!owned) process.exit(1); } catch { fail(); } });
process.on('SIGTERM', () => { try { stop(); } catch { fail(); } });
process.on('SIGINT', () => { try { stop(); } catch { fail(); } });
const startup = setTimeout(() => process.exit(1), 10_000);
process.on('message', async (message: unknown) => {
  if (message && typeof message === 'object' && 'stop' in message) {
    try { stop(); } catch { fail(); } return;
  }
  if (owned || timer || stopping) return;
  // Only the parent owns this private channel. No task-controlled input is decoded here.
  timer = setInterval(poll, 25);
  clearTimeout(startup);
  try {
    native = await import(process.argv[2]!) as typeof Win32;
    api = native.loadWin32ProcessBindings();
    native.probeCurrentTokenJobSupport(api);
    if (stopping || !process.connected) return process.exit(1);
    const spec = message as Request;
    owned = native.spawnCurrentTokenJobProcess(api, { ...spec, applicationName: spec.command,
      stdio: { stdin: 0, stdout: 1, stderr: 2 } });
  } catch { fail(); }
});
