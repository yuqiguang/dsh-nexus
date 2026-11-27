import { createInterface } from 'node:readline';
import { spawnTaskProcess, stopTaskProcess, taskProcessCleaned } from './process.js';
import { geminiAcpArgs, type GeminiLaunch } from './gemini-config.js';
import { createOutputDecoder } from './decode.js';
import { redact } from './normalize.js';

export interface GeminiProcess {
  write(line: string): void;
  readonly lines: AsyncIterable<string>;
  kill(): void;
  readonly exited: Promise<number | null>;
  readonly diagnostic?: string;
}
export type GeminiSpawn = (startupCwd: string, launch: GeminiLaunch) => GeminiProcess;

/** ACP uses newline-delimited JSON-RPC. The existing task process supervisor owns every descendant. */
export const spawnGeminiAcp: GeminiSpawn = (cwd, launch) => {
  const child = spawnTaskProcess(launch.command, geminiAcpArgs(launch), cwd, launch.env);
  let diagnostic = '';
  const decoder = createOutputDecoder();
  child.stderr.on('data', chunk => { diagnostic = (diagnostic + decoder.push(chunk)).slice(-8000); });
  child.stderr.on('error', () => stopTaskProcess(child));
  child.stdin.on('error', () => stopTaskProcess(child));
  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('error', () => stopTaskProcess(child));
  const exited = new Promise<number | null>(resolve => {
    child.once(process.platform === 'win32' ? 'close' : 'exit', code => { diagnostic += decoder.flush(); resolve(taskProcessCleaned(child) ? code : null); });
    child.once('error', error => { diagnostic += `\n${error.message}`; resolve(null); });
  });
  return { lines: reader, exited,
    get diagnostic() {
      let safe = diagnostic;
      for (const [name, value] of Object.entries(launch.env)) if (value && /KEY|TOKEN|SECRET|PASSWORD|AUTH/i.test(name)) safe = safe.split(value).join('***');
      return redact(safe).slice(-4000);
    },
    write(line) { if (child.stdin.destroyed) throw new Error('Gemini ACP 连接已关闭。'); child.stdin.write(line + '\n'); },
    kill() { stopTaskProcess(child); setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 5000).unref(); },
  };
};
