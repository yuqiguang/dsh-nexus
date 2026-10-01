import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-sandbox';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { credentialPaths, canonical } from './permissions.js';
import { isInside } from './rules.js';
import { VERIFY_SHELL_SYNTAX } from './plan.js';
import { runVerifyCommand } from './verify.js';
import { taskProcessArgv } from './process.js';
import type { SessionId } from '@deepseek-ai/dsh-session';

/** A self-contained check owns its servers and clients in one private loopback namespace. */
export async function localCheck(ctx: Context, root: string, owner: string, command: string, directory: string | undefined, signal: AbortSignal): Promise<string> {
  if (process.platform !== 'linux' || !ctx.sandbox) throw new Error('本地检查需要 Linux 和 DSH 完整沙箱。');
  if (!command.trim() || command.length > 2000 || VERIFY_SHELL_SYNTAX.test(command)) throw new Error('请使用一条命令和参数；复杂验证请写入项目脚本。');
  const cwd = await canonical(resolve(root, directory ?? '.'));
  if (!isInside(await canonical(root), cwd) || !(await stat(cwd)).isDirectory()) throw new Error('本地检查目录必须位于任务目录内。');
  const active = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const result = await runVerifyCommand(command, cwd, active, async argv => {
    const confined = await ctx.sandbox.confine(argv, { mode: 'workspace-write', workspaceRoot: root, sessionId: owner as SessionId }, active);
    if (confined.enforcement !== 'full') throw new Error('本地检查需要完整文件写入隔离。');
    // Hide common host credential locations as well as filtering the child environment.
    const masks: string[] = [];
    for (const path of credentialPaths()) {
      const info = await stat(path).catch(() => undefined);
      if (info) masks.push(...(info.isDirectory() ? ['--tmpfs', path] : ['--ro-bind', '/dev/null', path]));
    }
    return taskProcessArgv(['bwrap', '--die-with-parent', '--ro-bind', '/', '/',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--bind', root, root, ...masks, '--', ...confined.argv], true);
  });
  if (!result.ok) throw new Error(`本地检查${result.executed === false ? '未执行' : '失败'}：${result.output}`);
  return `本地检查通过（独立回环网络；子进程已回收）：\n${result.output}`;
}
