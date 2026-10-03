import { spawnTaskProcess, stopTaskProcess, taskProcessCleaned } from './process.js';
import { createInterface } from 'node:readline';

/** Minimal view of the `codex app-server` process; injected so tests never spawn Codex. */
export interface CodexProcess {
  write(line: string): void;
  readonly lines: AsyncIterable<string>;
  kill(): void;
  readonly exited: Promise<number | null>;
}

/** Which `codex` to run and with what environment; defaults to the one on PATH with the current environment. */
export interface CodexLaunch { command: string; env: NodeJS.ProcessEnv; fullAccess?: boolean }

export type CodexSpawn = (cwd: string, launch: CodexLaunch) => CodexProcess;

/**
 * Codex's `request_user_input` tool sits behind the `default_mode_request_user_input` feature (off by default in 0.155); without it
 * Codex writes its questions into the final message and ends the turn. The `-c features.…` form is used rather than `--enable`
 * because an unknown feature name makes `--enable` exit at once, while `-c` is ignored, so a Codex that renamed the flag still runs.
 */
export const CODEX_FEATURES = ['default_mode_request_user_input'];
export const APP_SERVER_ARGS = ['app-server', '-c', 'approval_policy="on-request"', ...CODEX_FEATURES.flatMap(feature => ['-c', `features.${feature}=true`])];
export const WINDOWS_CODEX_ARGS = ['-c', 'windows.sandbox="elevated"', '-c', 'windows.sandbox_private_desktop=true'];

export function codexAppServerArgs(fullAccess: boolean, platform = globalThis.process.platform): string[] {
  return fullAccess
    ? ['app-server', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"', ...CODEX_FEATURES.flatMap(feature => ['-c', `features.${feature}=true`])]
    : [...APP_SERVER_ARGS, ...(platform === 'win32' ? WINDOWS_CODEX_ARGS : [])];
}

/** The real process: newline-delimited JSON-RPC over stdio. */
export function spawnCodexAppServer(cwd: string, launch: CodexLaunch = { command: 'codex', env: process.env }): CodexProcess {
  const child = spawnTaskProcess(launch.command, codexAppServerArgs(launch.fullAccess === true), cwd, launch.env);
  const stderr: string[] = [];
  child.stderr.on('data', chunk => { stderr.push(chunk.toString()); if (stderr.length > 50) stderr.shift(); });
  child.stderr.on('error', () => stopTaskProcess(child));
  const exited = new Promise<number | null>(resolve => {
    child.on(process.platform === 'win32' ? 'close' : 'exit', code => resolve(taskProcessCleaned(child) ? code : null));
    child.on('error', () => resolve(null));
  });
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('error', () => stopTaskProcess(child));
  return {
    write(line) { if (!child.stdin.destroyed) child.stdin.write(line + '\n'); },
    lines: reader,
    kill() { stopTaskProcess(child); setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref(); },
    exited,
  };
}
