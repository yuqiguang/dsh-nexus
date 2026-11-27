import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const GEMINI_MCP_NAMES = ['nexus_coder', 'nexus_web'];
export const GEMINI_ALLOWED_TOOLS = [
  ...['read_file', 'write_file', 'replace_text', 'command', 'ask_question', 'report_result'].map(name => `mcp_nexus_coder_${name}`),
  ...['search', 'fetch', 'local_check'].map(name => `mcp_nexus_web_${name}`),
];
export const GEMINI_STRICT_PROBLEM = 'Gemini CLI 尚未接入可靠的严格沙箱；请选择标准模式由 DSH 审核具体操作，或使用已支持严格模式的编码工具。';
export type GeminiAuthMethod = 'gemini-api-key' | 'oauth-personal' | 'gateway';

export interface GeminiLaunch {
  command: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  /** A Nexus-owned directory, independent of the project and the user's default Gemini configuration. */
  home: string;
  authMethod: GeminiAuthMethod;
  model?: string;
}

/** Used only in a private home/workspace, so project settings cannot re-enable native execution or hooks. */
export function geminiTaskSettings(authMethod: GeminiAuthMethod): Record<string, unknown> {
  return {
    // core=[] also creates an upstream deny-all policy. Narrow bridge allows must
    // outrank it; the bridge still reviews each complete operation with Nexus.
    // Use exact names: 0.71.1 supplies different server-name forms to static and
    // runtime policy checks, so its server wildcard rules cannot authorize both.
    tools: { core: [], allowed: GEMINI_ALLOWED_TOOLS, discoveryCommand: '', callCommand: '', sandbox: false },
    hooksConfig: { enabled: false },
    admin: { extensions: { enabled: false }, skills: { enabled: false } },
    skills: { enabled: false },
    experimental: { enableAgents: false, autoMemory: false, worktrees: false },
    agents: { enabled: false },
    general: { plan: { enabled: false } },
    context: { includeDirectoryTree: false },
    advanced: { ignoreLocalEnv: true, autoConfigureMemory: false },
    security: { auth: { selectedType: authMethod }, enablePermanentToolApproval: false, folderTrust: { enabled: false } },
    mcp: { allowed: GEMINI_MCP_NAMES },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
  };
}

/** ACP's workspace is stable session storage. The MCP bridge always operates in the actual task directory. */
export function geminiSessionWorkspace(home: string, taskCwd: string): string {
  return join(resolve(home), 'workspaces', createHash('sha256').update(taskCwd).digest('hex'));
}

export function geminiAcpArgs(launch: Pick<GeminiLaunch, 'args' | 'model'>): string[] {
  return [...(launch.args ?? []), '--acp', '--approval-mode', 'default',
    '--allowed-mcp-server-names', GEMINI_MCP_NAMES.join(','), ...(launch.model ? ['--model', launch.model] : [])];
}

const CREDENTIAL_FILES = ['oauth_creds.json', 'google_accounts.json'];
const credentialWrites = new Map<string, Promise<void>>();
async function credential(path: string): Promise<Buffer | undefined> {
  let file;
  try { file = await open(path, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 64_000) throw new Error('Gemini 登录文件无效或过大。');
    const value = await file.readFile();
    const parsed = JSON.parse(value.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Gemini 登录文件必须是 JSON 对象。');
    return value;
  } finally { await file.close(); }
}

/** A delayed refresh cannot replace a newer login or another run's refreshed account. */
async function persistCredentials(persistent: string, settingsHome: string, directory: string, originals: Map<string, Buffer>): Promise<void> {
  const writing = (credentialWrites.get(persistent) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const refreshed = new Map<string, Buffer>();
    for (const name of CREDENTIAL_FILES) {
      const value = await credential(join(settingsHome, name));
      if (value && !originals.get(name)?.equals(value)) refreshed.set(name, value);
    }
    if (!refreshed.size) return;
    for (const name of CREDENTIAL_FILES) {
      const current = await credential(join(persistent, name)), original = originals.get(name);
      if (current ? !original?.equals(current) : original !== undefined) return;
    }
    for (const [name, value] of refreshed) {
      const temporary = join(persistent, `.${name}.${basename(directory)}.tmp`);
      try { await writeFile(temporary, value, { mode: 0o600 }); await rename(temporary, join(persistent, name)); }
      finally { await rm(temporary, { force: true }); }
    }
  });
  credentialWrites.set(persistent, writing);
  try { await writing; }
  finally { if (credentialWrites.get(persistent) === writing) credentialWrites.delete(persistent); }
}

/** Each run has immutable user settings; only native sessions and refreshed OAuth credentials persist. */
export async function prepareGeminiLaunch(launch: GeminiLaunch, taskCwd: string): Promise<{ launch: GeminiLaunch; cwd: string; workspace: string; close(): Promise<void> }> {
  const persistent = join(launch.home, '.gemini'), workspace = geminiSessionWorkspace(launch.home, taskCwd);
  await mkdir(join(persistent, 'tmp'), { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(launch.home, '.nexus-run-'));
  try {
    const settingsHome = join(directory, '.gemini');
    await mkdir(settingsHome, { mode: 0o700 });
    await writeFile(join(settingsHome, 'settings.json'), JSON.stringify(geminiTaskSettings(launch.authMethod)), { mode: 0o600 });
    // Directory junctions on Windows do not require file-symlink privileges.
    await symlink(resolve(persistent, 'tmp'), join(settingsHome, 'tmp'), process.platform === 'win32' ? 'junction' : 'dir');
    const originals = new Map<string, Buffer>();
    if (launch.authMethod === 'oauth-personal') for (const name of CREDENTIAL_FILES) {
      const value = await credential(join(persistent, name));
      if (value) { originals.set(name, value); await writeFile(join(settingsHome, name), value, { mode: 0o600 }); }
    }
    let closing: Promise<void> | undefined;
    return { cwd: directory, workspace, launch: { ...launch, env: { ...launch.env,
      GEMINI_CLI_HOME: directory,
      // Native system files require administrator ownership; absent private paths keep unrelated host settings out.
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(directory, 'unused-system.json'), GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(directory, 'unused-defaults.json'),
      GEMINI_CLI_NO_RELAUNCH: '1', GEMINI_CLI_AUTH_OVERRIDE: launch.authMethod, NO_BROWSER: '1', ELECTRON_RUN_AS_NODE: '1',
    } }, close: () => closing ??= (async () => {
      try {
        if (launch.authMethod === 'oauth-personal') await persistCredentials(persistent, settingsHome, directory, originals);
      } finally { await rm(directory, { recursive: true, force: true }); }
    })() };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
