import { realpathNormalize } from '@deepseek-ai/dsh-workspace';
import { stat } from 'node:fs/promises';
import { ChannelError } from '../channels/types.js';
import { canonical } from './permissions.js';
import { isInside } from './rules.js';

export interface CodingWorkspace { id: string; title: string; path: string }
export interface CodingProject { path: string; allowed: boolean; problem?: string }

/** Use the host's public path normalizer and the same canonical boundary as dispatch. */
export async function inspectProject(value: unknown, roots: readonly string[]): Promise<CodingProject> {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || value.includes('\0')) throw new ChannelError('invalid_root');
  let path: string;
  try {
    path = await realpathNormalize(value.trim());
    if (!(await stat(path)).isDirectory()) throw new Error('not a directory');
  }
  catch { throw new ChannelError('project_directory_unavailable'); }
  // An unavailable root cannot grant access, but does not hide other valid roots.
  const allowed = await Promise.all(roots.map(root => canonical(root).catch(() => undefined)));
  return { path, allowed: allowed.some(root => root !== undefined && isInside(root, path)) };
}
