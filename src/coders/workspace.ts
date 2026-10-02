import { resolve } from 'node:path';
import { canonical } from './permissions.js';
import { isInside } from './rules.js';

/** The native session selects the workspace; configured roots can only restrict it. */
export async function coderWorkspace(input: {
  workspace?: string;
  mode?: string;
  roots: readonly string[];
  restrictRoots?: boolean;
}): Promise<{ workspace: string; roots: string[] }> {
  if (input.mode === 'read-only') throw new Error('只读会话不能派发可写的编码任务。');
  const configured = !input.workspace || input.restrictRoots ? await Promise.all(input.roots.map(canonical)) : [];
  // Embedded hosts without a session cwd retain their explicitly supplied roots.
  if (!input.workspace) {
    if (!configured.length) throw new Error('无法确定当前会话工作区，请先在 DSH 中选择项目目录。');
    return { workspace: configured[0]!, roots: configured };
  }
  const workspace = await canonical(input.workspace);
  const roots = !input.restrictRoots ? [workspace] : configured.flatMap(root =>
    isInside(root, workspace) ? [workspace] : isInside(workspace, root) ? [root] : []);
  if (!roots.length) throw new Error(`当前会话工作区 ${workspace} 不在编码工具设置允许的目录内；请调整目录限制或选择相应的项目会话。`);
  return { workspace, roots: [...new Set(roots)] };
}

export async function coderDirectory(scope: { workspace: string; roots: readonly string[] }, cwd?: string): Promise<string> {
  const directory = await canonical(resolve(scope.workspace, cwd ?? '.'));
  if (!scope.roots.some(root => isInside(root, directory))) throw new Error(`编码目录必须位于当前会话工作区及允许范围内：${scope.roots.join('、')}。省略 cwd 使用当前工作区，不要改到渠道默认目录。`);
  return directory;
}
