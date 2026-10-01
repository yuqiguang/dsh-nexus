export interface ClaudeLoginInstructions {
  shell: 'PowerShell' | 'Bash';
  command: string;
}

/** Display-only instructions; quote paths literally in the host's shell. */
export function claudeLoginInstructions(platform: NodeJS.Platform, home: string, executable: string): ClaudeLoginInstructions {
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return { shell: 'PowerShell', command: `$env:CLAUDE_CONFIG_DIR = ${quote(home)}; & ${quote(executable)} auth login` };
  }
  const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  return { shell: 'Bash', command: `CLAUDE_CONFIG_DIR=${quote(home)} ${quote(executable)} auth login` };
}
