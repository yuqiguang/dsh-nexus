import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export function firewallProfilesEnabled(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every(enabled => enabled === true);
}

/** Codex's offline identity depends on the Windows Firewall profiles being enabled.
 * A setup marker alone is not evidence that outbound rules are being enforced.
 */
export async function windowsFirewallEnabled(): Promise<boolean> {
  const result = await run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', '@(Get-NetFirewallProfile -PolicyStore ActiveStore -ErrorAction Stop | ForEach-Object { [int]$_.Enabled -eq 1 }) | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15_000, maxBuffer: 4096 });
  return firewallProfilesEnabled(JSON.parse(result.stdout.trim()));
}

export async function requireWindowsFirewall(): Promise<void> {
  if (!await windowsFirewallEnabled()) throw new Error('Windows 防火墙未全部启用，Codex 离线沙箱的网络限制无法保证。请先在 Windows 安全中心启用防火墙，再派发任务。');
}
