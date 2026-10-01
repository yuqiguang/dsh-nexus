import { randomUUID } from 'node:crypto';
import { spawnCodexAppServer, WINDOWS_CODEX_ARGS, type CodexLaunch, type CodexSpawn } from './codex-process.js';
import { npmInvocation, onPath } from './install.js';
import { isAbsolute, resolve } from 'node:path';

export type WindowsSandboxStatus = 'ready' | 'notConfigured' | 'updateRequired' | 'firewallDisabled';

/** No model request or credentials are needed to check/configure Codex's OS sandbox. */
export async function windowsSandbox(launch: CodexLaunch, cwd: string, setup = false, spawn: CodexSpawn = spawnCodexAppServer): Promise<WindowsSandboxStatus> {
  const child = spawn(cwd, launch);
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Windows 沙箱配置检查超时。')), setup ? 180_000 : 15_000); });
  const request = (id: number, method: string, params: object) => child.write(JSON.stringify({ id, method, params }));
  try {
    request(1, 'initialize', { clientInfo: { name: 'nexus-sandbox', version: '0.2.1' }, capabilities: {} });
    return await Promise.race([expired, (async () => {
      for await (const line of child.lines) {
        let message: { id?: number; method?: string; result?: { status?: string; started?: boolean }; error?: unknown; params?: { success?: boolean; mode?: string } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.error) throw new Error('Codex 不支持所需的 Windows 沙箱接口，请使用托管版本。');
        if (message.id === 1) {
          child.write(JSON.stringify({ method: 'initialized' }));
          request(2, setup ? 'windowsSandbox/setupStart' : 'windowsSandbox/readiness', setup ? { mode: 'elevated', cwd } : {});
        } else if (setup && message.id === 2 && message.result?.started !== true) {
          throw new Error('Windows 增强沙箱配置未启动。');
        } else if (setup && message.method === 'windowsSandbox/setupCompleted') {
          if (!message.params?.success || message.params.mode !== 'elevated') throw new Error('Windows 增强沙箱配置失败或已取消。');
          request(3, 'windowsSandbox/readiness', {});
        } else if ((!setup && message.id === 2) || (setup && message.id === 3)) {
          const status = message.result?.status;
          if (status !== 'ready' && status !== 'notConfigured' && status !== 'updateRequired') throw new Error('Codex 未确认 Windows 沙箱状态。');
          return status;
        }
      }
      throw new Error('Codex 沙箱检查进程提前退出，请检查安装和配置。');
    })()]);
  } finally {
    clearTimeout(timeout); child.kill();
    await child.exited;
  }
}

/** Native argv only. npm's known Node entry avoids passing arguments to cmd.exe. */
export async function windowsVerifyExecutable(argv: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const command = argv[0]!;
  const npm = await npmInvocation(command, env);
  if (npm.args.length) return [npm.command, ...npm.args, ...argv.slice(1)];
  const path = isAbsolute(command) ? command : /[\\/]/.test(command) ? resolve(cwd, command) : await onPath(command, env);
  if (!path) throw new Error(`找不到可用的验证程序 ${command}。请检查任务 PATH 或 DSH 内置运行环境；Microsoft Store 别名不作为解释器。`);
  if (!/\.(exe|com)$/i.test(path)) throw new Error(`验证程序 ${command} 是不支持的脚本包装器；请使用原生程序或 npm，脚本请用 node、python 或 powershell 显式启动。`);
  return [path, ...argv.slice(1)];
}

/** A fresh, fully specified profile cannot inherit writable paths from a user-defined profile. */
export function windowsVerifyArgv(command: string, argv: string[], root: string, cwd: string, network: 'offline' | 'ask' | 'loopback' = 'offline'): string[] {
  if (network === 'loopback') throw new Error('Windows 暂不支持与宿主隔离的回环网络；请使用离线验证，或明确申请本次联网验证。');
  const profile = `nexus_verify_${randomUUID().replaceAll('-', '')}`;
  const filesystem = `{":root"="read",${JSON.stringify(root)}="write"}`;
  const policy = `{filesystem=${filesystem},network={enabled=${network === 'ask'}}}`;
  return [command, 'sandbox', ...WINDOWS_CODEX_ARGS, '-c', 'approval_policy="on-request"', '-C', cwd, '--include-managed-config', '-P', profile,
    '-c', `permissions.${profile}=${policy}`, '--', ...argv];
}
