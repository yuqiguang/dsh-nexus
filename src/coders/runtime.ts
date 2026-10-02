import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { dirname, isAbsolute, join } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { onPath } from './install.js';

/** A task-local PATH; do not change the Desktop host or overwrite a real system interpreter. */
export async function runtimeEnvironment(env: NodeJS.ProcessEnv, value: unknown, platform = process.platform): Promise<NodeJS.ProcessEnv> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH 运行环境返回了无效的路径。');
  const entries = value as Record<string, unknown>;
  const directories: string[] = [];
  for (const name of ['python', 'node']) {
    const path = entries[name];
    if (path === undefined) continue;
    if (typeof path !== 'string' || !isAbsolute(path) || !(await stat(path)).isFile()
      || (platform === 'win32' && !/\.exe$/i.test(path))) throw new Error(`DSH ${name} 运行环境不可用。`);
    const installed = await onPath(name, env, platform);
    // Even a real interpreter after WindowsApps must precede its broken alias at spawn time.
    directories.push(dirname(installed ?? path));
  }
  const key = Object.keys(env).find(key => platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH') ?? 'PATH';
  const result = { ...env };
  if (platform === 'win32') for (const name of Object.keys(result)) if (name.toLowerCase() === 'path' && name !== key) delete result[name];
  result[key] = [...new Set(directories), env[key] ?? ''].filter(Boolean).join(platform === 'win32' ? ';' : ':');
  return result;
}

export interface CoderRuntimeEnvironment { env: NodeJS.ProcessEnv; executables: Record<string, string> }

/** Keep the host-resolved executable identities separate from the command's untrusted arguments. */
export async function loadCoderRuntime(ctx: Context, exec: ToolRunContext, env: NodeJS.ProcessEnv): Promise<CoderRuntimeEnvironment> {
  if (process.platform !== 'win32' || !ctx.tools.get('load_workspace_dependencies', exec.agent?.id)) return { env, executables: {} };
  const result = await ctx.tools.execute({ name: 'load_workspace_dependencies', arguments: {}, agent: exec.agent,
    callId: ToolCallId(`${exec.callId}:coder-runtime`), rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal });
  for (const context of result.additionalContexts ?? []) exec.deferContext(context);
  if (result.isError) throw new Error('DSH 内置运行环境加载失败，请先检查 load_workspace_dependencies 的结果。');
  const prepared = await runtimeEnvironment(env, result.value);
  const entries = result.value as Record<string, unknown>;
  const executables: Record<string, string> = {};
  for (const name of ['python', 'node']) if (typeof entries[name] === 'string') executables[name] = await realpath(entries[name]);
  return { env: prepared, executables };
}

/** Use the registered public tool, including its policy pipeline and native lazy installation. */
export async function loadCoderEnvironment(ctx: Context, exec: ToolRunContext, env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  return (await loadCoderRuntime(ctx, exec, env)).env;
}

/** Only argv[0] from the native dependency service may be described by its runtime name. Arguments stay unchanged. */
export async function verificationReviewCommand(command: string, argv: readonly string[], executables: Readonly<Record<string, string>> = {}): Promise<string> {
  if (!argv[0] || !isAbsolute(argv[0])) return command;
  const first = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/.exec(command.trimStart());
  if (!first || (first[1] ?? first[2] ?? first[3]) !== argv[0]) return command;
  const actual = await realpath(argv[0]).catch(() => undefined);
  for (const name of ['python', 'node']) {
    const expected = executables[name];
    if (expected && actual === expected && await realpath(expected).catch(() => undefined) === expected) {
      return name + command.trimStart().slice(first[0].length);
    }
  }
  return command;
}

/** Verification needs runtime discovery and the Codex sandbox cache, never coder account configuration. */
export function verificationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:path|codex_home|localappdata)$/i.test(key)));
}

/** Host observations, never a grant: keep PATH resolution and startup hooks visible to the reviewer. */
export async function commandRuntimeEvidence(command: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  if (!env) return [];
  const facts: string[] = [];
  for (const name of ['python', 'node']) {
    if (!new RegExp(`\\b${name}(?:\\.exe)?\\b`, 'i').test(command)) continue;
    const path = await onPath(name, env);
    if (!path) { facts.push(`宿主未解析到 ${name}；不能假定命令可用或可信。`); continue; }
    const actual = await realpath(path);
    const info = await stat(actual);
    facts.push(`宿主任务 PATH 解析：${name} = ${actual}；文件身份 ${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}。此信息不授权其他程序或参数。`);
    if (process.platform === 'win32') for (const suffix of ['.exe', '.com', '.cmd', '.bat', '.ps1']) {
      if (await stat(join(cwd, name + suffix)).then(() => true, () => false)) facts.push(`当前目录有 ${name + suffix}，可能遮蔽 PATH 结果，必须检查。`);
    }
  }
  if (facts.length) {
    const hooks = Object.keys(env).filter(key => /^(NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP)$/i.test(key) && env[key]);
    facts.push(`解释器启动环境变量名称：${hooks.join('、') || '无'}。仅 --version 不运行项目脚本；仍须检查完整 shell、profile、重定向及后续命令。`);
  }
  return facts;
}

export const WINDOWS_CODER_GUIDANCE = '\n[Windows 执行环境]\n任务优先保留系统解释器；宿主提供内置运行环境时，缺少的解释器已加入任务 PATH。只检查当前任务实际需要且尚未确认的解释器；续接时复用本会话已确认的路径与版本，除非执行失败或环境变化，不要每轮例行查询 python/node。不要仅凭 Microsoft Store 别名或浅层磁盘搜索断言未安装。通过 shell 工具执行 PowerShell 命令时设置 login=false（工具支持时），或显式使用 -NoProfile，减少用户 profile 的隐式执行；不要为减少审批而扩大权限。PowerShell 可能是 5.1，不支持 utf8NoBOM；Codex 沙箱还可能使用 ConstrainedLanguage，不能依赖 .NET 构造函数。需要无 BOM UTF-8 时优先用原生文件工具，或通过 Python 的 pathlib.write_text(encoding="utf-8") 写入；接受 BOM 的文件可用 Set-Content -Encoding utf8。修改文件优先用原生文件工具或 apply_patch 工具，不要通过 apply_patch.bat 传递多行补丁；没有原生补丁工具时，使用经过审批的文件写入命令。每次写入后读取核对内容；启动错误不等于业务测试失败，也不能报告未观察到的输出。';
