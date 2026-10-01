import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cleaned = new WeakSet<object>();
export const taskProcessCleaned = (child: object): boolean => process.platform !== 'win32' || cleaned.has(child);

/** Linux PID 1 owns every descendant, including detached PTYs and double-forked servers.
 * When it exits the kernel kills the namespace; this is process lifetime containment,
 * not a replacement for the coder/DSH filesystem and network sandbox. */
export function taskProcessArgv(argv: string[], loopback = false): string[] {
  if (process.platform !== 'linux') {
    if (loopback) throw new Error('本地回环验证需要 Linux 隔离支持。');
    return argv;
  }
  return ['unshare', '--user', '--map-root-user', '--mount', '--pid', '--fork', '--kill-child=SIGKILL', '--mount-proc',
    ...(loopback ? ['--net'] : []), '--', ...(loopback ? ['sh', '-c', 'ip link set lo up && exec "$@"', 'nexus-local-check'] : []), ...argv];
}

export function spawnTaskProcess(command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./windows-runner.js', import.meta.url)),
      import.meta.resolve('@deepseek-ai/dsh-win32-process')], { cwd,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|KEY|AUTH|^DSH_/i.test(key))), ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    child.on('message', message => { if (message && typeof message === 'object' && 'type' in message && message.type === 'nexus-job-empty') cleaned.add(child); });
    child.once('spawn', () => child.send?.({ command, args, cwd: cwd ?? process.cwd(),
      env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)) }, error => {
      if (error) child.kill('SIGKILL');
    }));
    return child as ChildProcessWithoutNullStreams;
  }
  const argv = process.platform === 'linux' ? ['python3', '-c', SUBREAPER, command, ...args] : [command, ...args];
  return spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

export function stopTaskProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.connected) child.send({ stop: true }, error => { if (error) child.kill('SIGKILL'); });
  else child.kill('SIGTERM');
}

export async function closeTaskProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const event = process.platform === 'win32' ? 'close' : 'exit';
    const done = () => { clearTimeout(timer); child.removeListener(event, done); child.removeListener('error', done); resolve(); };
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    timer.unref(); child.once(event, done); child.once('error', done); stopTaskProcess(child);
  });
}

// Keep the caller's UID/user namespace: nesting another UID map breaks Claude's
// apply-seccomp launcher. Linux reparents detached descendants to this supervisor.
// Only its direct children are killed, using pidfds and a parent check to avoid PID reuse.
const SUBREAPER = `
import ctypes, os, signal, subprocess, sys, time
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'subreaper unavailable')
stopping = False
def stop(signum, frame):
    global stopping
    stopping = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
parent = os.getppid()
if libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'parent-death signal unavailable')
if os.getppid() != parent:
    sys.exit(1)
child = subprocess.Popen(sys.argv[1:])
while child.poll() is None and not stopping:
    time.sleep(0.02)
code = child.returncode
while True:
    with open('/proc/self/task/%s/children' % os.getpid()) as f:
        children = f.read().split()
    if not children:
        break
    for value in children:
        pid = int(value)
        fd = None
        try:
            fd = os.pidfd_open(pid)
            with open('/proc/%s/stat' % pid) as f:
                fields = f.read().rsplit(')', 1)[1].split()
            if int(fields[1]) == os.getpid():
                signal.pidfd_send_signal(fd, signal.SIGKILL)
        except (ProcessLookupError, FileNotFoundError):
            pass
        finally:
            if fd is not None: os.close(fd)
    try:
        while os.waitpid(-1, os.WNOHANG)[0] > 0: pass
    except ChildProcessError:
        pass
    time.sleep(0.01)
sys.exit(128 + signal.SIGTERM if stopping else code if code is not None and code >= 0 else 1)
`;
