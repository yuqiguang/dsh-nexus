import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { realpathNormalize } from '@deepseek-ai/dsh-workspace';
import { baseSessionOf } from '../channels/protocol.js';

export type MemoryScope = { kind: 'global'; owner: string } | { kind: 'project'; owner: string; project: string };
export interface MemoryScopeChoice { id: string; kind: 'legacy' | MemoryScope['kind']; label: string; project?: string }
export const LOCAL_PREFERENCES: MemoryScope = { kind: 'global', owner: 'local' };
export const LEGACY_SCOPE = 'legacy';

export function scopeId(scope: MemoryScope): string {
  return `ms-${createHash('sha256').update(JSON.stringify([scope.kind, scope.owner, scope.kind === 'project' ? scope.project : ''])).digest('hex')}`;
}
export function sameScope(first: MemoryScope | undefined, second: MemoryScope | undefined): boolean {
  return first === undefined || second === undefined ? first === second : scopeId(first) === scopeId(second);
}
export function scopeChoice(scope: MemoryScope): MemoryScopeChoice {
  const channel = /^nexus-(wechat|feishu|wecom)-/.exec(scope.owner)?.[1];
  const who = channel ? `${({ wechat: '微信', feishu: '飞书', wecom: '企业微信' } as Record<string, string>)[channel]} ${scope.owner.slice(-6)}` : '本机';
  return { id: scopeId(scope), kind: scope.kind, label: scope.kind === 'global' ? `${who} · 全局个人偏好` : `${who} · ${scope.project}`,
    ...(scope.kind === 'project' ? { project: scope.project } : {}) };
}

export async function projectScope(path: string, owner = 'local'): Promise<MemoryScope> {
  const real = await realpathNormalize(path);
  if (!(await stat(real)).isDirectory()) throw new Error('memory_project_unavailable');
  return { kind: 'project', owner, project: real };
}

/** Only a native root session supplies identity and cwd. Tool arguments never select a scope.
 * Channel session IDs were created from the explicitly admitted account/owner/chat tuple;
 * generations share its base, while a different account or owner gets a separate namespace.
 */
export async function sessionMemoryScope(header: { id: string; cwd?: string; parentSession?: string } | undefined): Promise<MemoryScope | undefined> {
  if (!header?.cwd || header.parentSession !== undefined) return undefined;
  const base = baseSessionOf(header.id);
  const channel = /^nexus-(wechat|feishu|wecom)-[a-f0-9]{32}$/.test(base);
  if (header.id.startsWith('nexus-') && !channel) return undefined;
  try { return await projectScope(header.cwd, channel ? base : 'local'); }
  catch { return undefined; }
}
