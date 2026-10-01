import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { canonical } from './permissions.js';
import { isInside } from './rules.js';
import { redact } from './normalize.js';

/** Supply the one owner-managed instruction file without exposing the protected DSH directory to commands. */
export async function hostInstructions(cwd: string): Promise<string> {
  const home = await canonical(dshHomePath());
  if (!isInside(join(home, 'nexus-workspace'), await canonical(cwd))) return '';
  const path = join(home, 'AGENTS.md');
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const prefix = '\n[DSH 宿主指导文件]\n宿主已检查上级 .dsh/AGENTS.md；不要再通过命令扫描受保护的 .dsh 目录。任务目录内的指导文件仍按正常方式读取。\n';
  if (!info) return prefix + '宿主指导文件不存在。\n';
  if (!info.isFile() || info.nlink !== 1 || info.size > 48 * 1024) return prefix + '宿主指导文件不是可安全读取的普通小文件，未加载；不要绕过该限制。\n';
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || await canonical(path) !== path) throw new Error('宿主指导文件边界已变化。');
    const buffer = Buffer.alloc(48 * 1024 + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const part = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 || await canonical(path) !== path || bytesRead !== info.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('宿主指导文件读取期间发生变化。');
    return prefix + redact(buffer.subarray(0, bytesRead).toString('utf8')) + '\n';
  } finally { await file.close(); }
}
