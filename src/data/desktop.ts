import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile, rename, rm, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DataError, PENDING_FILE, STAGING_DIR, type PendingImport } from './archive.js';

export const DESKTOP_RESTORE_DIR = 'nexus-restore';
export type DesktopRestorePhase = 'waiting' | 'restoring' | 'completed' | 'rolled-back' | 'cancelled' | 'failed';
export interface DesktopRestoreStatus { id: string; phase: DesktopRestorePhase; code?: string; replacedDir: string; recoveryPath: string; canCancel?: boolean }
export interface DesktopRestore {
  status(): Promise<DesktopRestoreStatus | undefined>;
  prepare(pending: PendingImport): Promise<DesktopRestoreStatus>;
  cancel(id: string): Promise<void>;
}

/** Electron runs the Host in Node mode. Recovery itself runs in system PowerShell,
 * so an exclusive handle on the Electron executable can exclude new launches.
 * No private Electron IPC, application patch, or runtime replacement is used. */
export async function desktopRestore(home: string, dshVersion?: string): Promise<DesktopRestore | undefined> {
  if (process.platform !== 'win32' || !process.versions.electron || !dshVersion) return undefined;
  const executable = process.execPath;
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    await access(join(dirname(executable), 'resources', 'app.asar'));
    await access(join(home, 'profiles', 'desktop', 'package.json'));
    await access(shell);
  } catch { return undefined; }
  return createDesktopRestore({ home, executable, shell, hostPid: process.pid, dshVersion,
    async launch(script, plan) {
      await new Promise<void>((done, reject) => {
        const child = spawn(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-PlanPath', plan], {
          detached: true, stdio: 'ignore', windowsHide: false,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
        });
        child.once('error', reject); child.once('spawn', () => { child.unref(); done(); });
      });
    } });
}

export interface DesktopRestoreDeps {
  home: string; executable: string; shell: string; hostPid: number; dshVersion: string;
  launch(script: string, plan: string): Promise<void>;
}
export function createDesktopRestore(deps: DesktopRestoreDeps): DesktopRestore {
  const directory = join(deps.home, DESKTOP_RESTORE_DIR);
  const active = join(directory, 'active.json');
  const readActive = async (): Promise<{ id: string } | undefined> => {
    try {
      const value = JSON.parse(await readFile(active, 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(value?.id)) throw new DataError('restore_state_invalid');
      return value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const atomic = async (path: string, value: unknown) => {
    await writeFile(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); await rename(path + '.tmp', path);
  };
  const hasJournal = async (id: string) => {
    try { await access(join(directory, id, 'journal.json')); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  };
  const status = async (): Promise<DesktopRestoreStatus | undefined> => {
    const current = await readActive(); if (!current) return undefined;
    const value = JSON.parse(await readFile(join(directory, current.id, 'status.json'), 'utf8'));
    if (value.id !== current.id || !['waiting', 'restoring', 'completed', 'rolled-back', 'cancelled', 'failed'].includes(value.phase)
      || !/^replaced-[0-9a-z-]+$/.test(value.replacedDir)) throw new DataError('restore_state_invalid');
    const journal = await hasJournal(current.id);
    return { id: current.id, phase: value.phase, replacedDir: value.replacedDir, recoveryPath: join(directory, 'continue.cmd'),
      canCancel: value.phase === 'waiting' || value.phase === 'failed' && !journal,
      ...(typeof value.code === 'string' ? { code: value.code } : {}) };
  };
  return {
    status,
    async prepare(pending) {
      if (!pending.files || pending.summary.dshVersion !== deps.dshVersion) throw new DataError('desktop_restore_version_mismatch');
      // A source profile is never installed over the Desktop profile. Its configuration stays in the archive.
      if (pending.files.some(file => file.path.startsWith('profiles/'))) throw new DataError('desktop_restore_profile_mismatch');
      const previous = await status();
      if (previous && !['completed', 'rolled-back', 'cancelled'].includes(previous.phase)) throw new DataError('import_in_progress');
      const id = randomBytes(16).toString('hex'), task = join(directory, id);
      await mkdir(task, { recursive: true, mode: 0o700 });
      const script = join(task, 'restore.ps1'), plan = join(task, 'plan.json');
      await copyFile(fileURLToPath(new URL('./desktop-restore.ps1', import.meta.url)), script);
      await atomic(plan, { version: 1, id, home: resolve(deps.home), executable: deps.executable, hostPid: deps.hostPid, pending, createdAt: Date.now() });
      await atomic(join(task, 'status.json'), { id, phase: 'waiting', replacedDir: pending.replacedDir });
      // Fixed task paths are batch-quoted; reject cmd metacharacters which expand even inside quotes.
      if ([deps.shell, script, plan].some(value => /[%!\r\n"]/.test(value))) throw new DataError('desktop_restore_path_unsupported');
      await writeFile(join(directory, 'continue.cmd'), `@echo off\r\n"${deps.shell}" -NoProfile -ExecutionPolicy Bypass -File "${script}" -PlanPath "${plan}"\r\n`, { mode: 0o600 });
      await atomic(active, { id });
      try {
        await deps.launch(script, plan);
        // A successful spawn is not enough: the worker must read and accept this plan.
        const deadline = Date.now() + 10_000;
        while (!await access(join(task, 'ready')).then(() => true, () => false)) {
          if (Date.now() >= deadline) throw new Error('worker_not_ready');
          await new Promise(done => setTimeout(done, 100));
        }
      }
      catch {
        await writeFile(join(task, 'cancel'), '', { mode: 0o600 });
        await atomic(join(task, 'status.json'), { id, phase: 'cancelled', code: 'restore_launch_failed', replacedDir: pending.replacedDir });
        throw new DataError('restore_launch_failed');
      }
      return (await status())!;
    },
    async cancel(id) {
      const current = await status();
      if (!current || current.id !== id || !current.canCancel) throw new DataError('restore_not_waiting');
      await writeFile(join(directory, id, 'cancel'), '', { mode: 0o600 });
      // A live PowerShell worker holds FileShare.None and handles the cancel marker.
      // Holding this handle excludes a retry while an abandoned plan is discarded.
      let handle;
      try { handle = await open(join(directory, id, 'worker.lock'), 'a+'); }
      catch { return; }
      try {
        if (await hasJournal(id)) throw new DataError('restore_not_waiting');
        await discardStagedImport(deps.home);
        await atomic(join(directory, id, 'status.json'), { id, phase: 'cancelled', replacedDir: current.replacedDir });
      } finally { await handle.close(); }
    },
  };
}

/** Only preparation failures before an offline worker owns the operation may discard staging. */
export async function discardStagedImport(home: string): Promise<void> {
  await rm(join(home, PENDING_FILE), { force: true });
  await rm(join(home, STAGING_DIR), { recursive: true, force: true });
}
