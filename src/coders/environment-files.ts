import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonical } from './permissions.js';
import { commandPath } from './command-path.js';
import { commandPathTokens, isEnvironmentFile, isEnvironmentTemplate, isProjectEnvironment } from './rules.js';
import type { CoderRequest } from './types.js';

const LIMIT = 32 * 1024;
const PLACEHOLDER = /^(?:|<[A-Z_][A-Z0-9_]*>|\$\{[A-Z_][A-Z0-9_]*\}|(?:your|replace|change|example|sample|dummy|placeholder)(?:[-_][a-z0-9]+)*)$/i;

/** Conservative template validation. Unrecognized values go to the owner, never into review evidence. */
export function safeEnvironmentTemplate(content: string): boolean {
  if (Buffer.byteLength(content) > LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) return false;
  return content.split(/\r?\n/).every(line => {
    if (!line.trim()) return true;
    // Comments may contain pasted credentials too; only plain explanatory text is routine.
    if (/^\s*#/.test(line)) return !/(?:https?:|[=:]|\b(?:sk|ghp|github_pat)[-_])/i.test(line);
    const assignment = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!assignment) return false;
    let value = assignment[2]!;
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (PLACEHOLDER.test(value)) return true;
    if (/KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE/i.test(assignment[1]!)) return false;
    if (/^(?:true|false|development|production|test|local|localhost|[\d.]+)$/i.test(value)) return true;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); }
    catch { return false; }
  });
}

/** Bounded local read used only for classification; the contents never enter an audit or model prompt. */
export async function readEnvironmentTemplate(path: string): Promise<string | undefined> {
  const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return undefined;
  if (!info.isFile() || info.nlink !== 1 || info.size > LIMIT) throw new Error('template not inspectable');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > LIMIT || before.ino !== info.ino || before.dev !== info.dev) throw new Error('template not inspectable');
    const buffer = Buffer.alloc(LIMIT + 1); let used = 0;
    while (used < buffer.length) { const read = await file.read(buffer, used, buffer.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
    const after = await file.stat();
    if (used !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('template changed');
    return buffer.subarray(0, used).toString('utf8');
  } finally { await file.close(); }
}

function safeDiff(diff: string): boolean {
  if (!diff || Buffer.byteLength(diff) > LIMIT) return false;
  const content: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (!line || /^(?:@@ |--- |\+\+\+ |\\ No newline)/.test(line)) continue;
    if (!/^[ +\-]/.test(line)) return false;
    content.push(line.slice(1));
  }
  return content.length > 0 && safeEnvironmentTemplate(content.join('\n'));
}

export async function checkedEnvironmentTemplates(request: CoderRequest, cwd: string, standard: boolean): Promise<string[]> {
  if (!['file-read', 'file-write'].includes(request.kind) || request.raw.grantRoot || request.raw.additionalPermissions) return [];
  const approved: string[] = [];
  for (const path of request.paths) {
    if (!isEnvironmentTemplate(path) || !isProjectEnvironment(path, cwd, standard)) continue;
    try {
      if (await canonical(path) !== path) continue;
      const before = await readEnvironmentTemplate(path);
      if (before !== undefined && !safeEnvironmentTemplate(before)) continue;
      let safe = false;
      if (request.kind === 'file-read' && request.tool === 'Read') safe = before !== undefined;
      else if (request.tool === 'Write') safe = typeof request.raw.content === 'string' && safeEnvironmentTemplate(request.raw.content);
      else if (request.tool === 'Edit' && before !== undefined && typeof request.raw.old_string === 'string' && request.raw.old_string
        && typeof request.raw.new_string === 'string' && before.includes(request.raw.old_string))
        safe = safeEnvironmentTemplate(before.split(request.raw.old_string).join(request.raw.new_string));
      else if (request.tool === 'codex.fileChange') {
        const change = request.fileChanges?.find(change => change.path === path);
        safe = !!change && safeDiff(change.diff);
      }
      if (safe && await canonical(path) === path) approved.push(path);
    } catch { /* Unknown state keeps the normal credential decision. */ }
  }
  return approved;
}

/**
 * The same content check `checkedEnvironmentTemplates` applies to file tools, for a command that only names a template.
 * Nothing here trusts the name: a real secret saved as `.env.example`, a symlink to one, or a hard link all keep the
 * credential answer, because the file's own readable content has to be placeholder-only. Only that exact path is exempt;
 * any other token in the command is still matched by the credential rule on its own.
 */
export async function checkedCommandTemplates(detail: string, cwd: string, standard: boolean): Promise<string[]> {
  const approved: string[] = [];
  for (const token of commandPathTokens(detail)) {
    if (!isEnvironmentTemplate(token)) continue;
    const path = resolve(cwd, commandPath(token));
    if (!isProjectEnvironment(path, cwd, standard)) continue;
    try {
      if (await canonical(path) !== path) continue;
      const content = await readEnvironmentTemplate(path);
      if (content === undefined || !safeEnvironmentTemplate(content)) continue;
      if (await canonical(path) === path) approved.push(path);
    } catch { /* Unknown state keeps the normal credential decision. */ }
  }
  return [...new Set(approved)];
}

/** Owner approvals name the file and operation; never put dotenv values into messages or stored decisions. */
export function environmentApprovalDisplay(request: CoderRequest): CoderRequest {
  if (!request.paths.some(isEnvironmentFile) && !(typeof request.raw.file_path === 'string' && isEnvironmentFile(request.raw.file_path))
    && !request.fileChanges?.some(change => isEnvironmentFile(change.path))) return request;
  return { ...request, summary: `环境配置${request.kind === 'file-write' ? '写入' : '访问'}：${request.paths.join('，')}`,
    detail: '环境配置内容已隐藏。批准仅对本次所列文件操作有效，不授权后续操作或整个目录。' };
}
