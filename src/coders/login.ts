export interface ClaudeLoginInstructions {
  shell: 'PowerShell' | 'Bash';
  command: string;
}

/** Display-only instructions; quote paths literally in the host's shell. */
export function claudeLoginInstructions(platform: NodeJS.Platform, home: string, executable: string): ClaudeLoginInstructions {
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return { shell: 'PowerShell', command: `$env:CLAUDE_CONFIG_DIR = ${quote(home)}; $env:DISABLE_AUTOUPDATER = '1'; & ${quote(executable)} auth login` };
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return { shell: 'Bash', command: `CLAUDE_CONFIG_DIR=${quote(home)} DISABLE_AUTOUPDATER=1 ${quote(executable)} auth login` };
}

/** Gemini uses its interactive account picker; credentials stay in Nexus's dedicated home. */
export function geminiLoginInstructions(platform: NodeJS.Platform, home: string, command: string, args: readonly string[] = []): ClaudeLoginInstructions {
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return { shell: 'PowerShell', command: `$env:GEMINI_CLI_HOME = ${quote(home)}; $env:ELECTRON_RUN_AS_NODE = '1'; & ${[command, ...args].map(quote).join(' ')}` };
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return { shell: 'Bash', command: `GEMINI_CLI_HOME=${quote(home)} ELECTRON_RUN_AS_NODE=1 ${[command, ...args].map(quote).join(' ')}` };
}
