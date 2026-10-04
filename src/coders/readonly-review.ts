import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { credentialPaths, canonical } from './permissions.js';
import { isInside, isProtectedPath } from './rules.js';
import type { CoderRequest, TaskRecord } from './types.js';
import type { ReviewResult } from './review.js';

/** Deliberately not a shell parser. Only direct OS utilities with explicit regular-file
 * operands qualify. Wrappers, PATH lookup, recursion, config and unknown grants keep model review. */
export async function readonlyReview(task: TaskRecord, request: CoderRequest, env?: NodeJS.ProcessEnv): Promise<ReviewResult | undefined> {
  if (process.platform === 'win32' || !env || task.permissions?.securityMode !== 'standard'
    || task.permissions.reviewPolicy?.instructions.trim() || request.kind !== 'command'
    || !['codex.command', 'verify.command'].includes(request.tool) || !request.command) return;
  const known = new Set(['command', 'cwd', 'threadId', 'turnId', 'itemId', 'approvalId', 'commandActions', 'availableDecisions', 'proposedExecpolicyAmendment']);
  if (Object.keys(request.raw).some(key => !known.has(key)) || request.raw.command !== undefined && request.raw.command !== request.command) return;
  if (Object.entries(env).some(([key, value]) => value && /^(?:LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|BASH_FUNC_.*)$/i.test(key))) return;
  const command = request.command.trim();
  if (/[\x00-\x1f;&|><`$\\*?{}~()\[\]]/.test(command)
    || !/^(?:[^\s'"]+|'[^']*'|"[^"]*")(?:\s+(?:[^\s'"]+|'[^']*'|"[^"]*"))*$/.test(command)) return;
  const words = command.match(/[^\s'"]+|'[^']*'|"[^"]*"/g)!.map(word => /^['"]/.test(word) ? word.slice(1, -1) : word);
  const program = words.shift()!;
  if (!/^\/(?:usr\/)?bin\/(?:cat|head|tail|wc|rg)$/.test(program)) return;
  const name = program.split('/').at(-1)!;
  const cwd = typeof request.raw.cwd === 'string' ? request.raw.cwd : task.cwd;
  if (!isAbsolute(cwd)) return;
  const paths: string[] = [];
  if (name === 'rg') {
    // No user config, stdin, preprocessor, glob expansion or recursive directory traversal.
    if (words.shift() !== '--no-config') return;
    while (['-n', '-F', '-i', '--max-columns=300'].includes(words[0] ?? '')) words.shift();
    if (words.shift() !== '--' || !words.shift()) return;
  } else if (['head', 'tail'].includes(name) && words[0] === '-n') {
    words.shift(); if (!/^\d{1,5}$/.test(words.shift() ?? '')) return;
  }
  if (name !== 'rg' && words[0] === '--') words.shift();
  if (!words.length) return;
  for (const word of words) {
    if (!word || word.startsWith('-')) return;
    paths.push(resolve(cwd, word));
  }
  try {
    const binary = await realpath(program), info = await lstat(binary);
    if (!/^\/(?:usr\/)?bin\/(?:cat|head|tail|wc|rg)$/.test(binary) || !info.isFile() || info.uid !== 0 || (info.mode & 0o022)) return;
    const roots = task.permissions.reviewRoots ?? [task.cwd];
    const credentials = await Promise.all(credentialPaths().map(canonical));
    for (const path of [cwd, ...request.paths, ...paths]) {
      const real = await canonical(path);
      if (![path, real].every(value => isInside(task.cwd, value) && roots.some(root => isInside(root, value))
        && !isProtectedPath(value, [task.cwd], true)) || credentials.some(root => isInside(root, real))) return;
    }
    for (const path of paths) if (!(await lstat(await realpath(path))).isFile()) return;
    return { safe: true, reason: '确定性只读检查通过：系统程序、显式项目文件，无 shell 组合、配置加载、写入或联网', repeatable: false };
  } catch { return; }
}
