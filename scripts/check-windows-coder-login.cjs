/** Execute generated PowerShell instructions against a local stub, never a real login. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

async function main() {
  assert.equal(process.platform, 'win32');
  const { claudeLoginInstructions } = await import(pathToFileURL(path.resolve(process.argv[2], 'src/coders/login.js')).href);
  const root = await fs.mkdtemp(path.join(tmpdir(), 'nexus-login-check-'));
  try {
    const home = path.join(root, "home 用户 O'Brien $home $(whoami)"), executable = path.join(root, "claude ' fixture.ps1");
    await fs.writeFile(executable, "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()\n@{ home = $env:CLAUDE_CONFIG_DIR; arguments = @($args) } | ConvertTo-Json -Compress\n");
    const login = claudeLoginInstructions('win32', home, executable);
    const shell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', login.command], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, 'local PowerShell fixture must complete');
    assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()), { home, arguments: ['auth', 'login'] });
    console.log(JSON.stringify({ ok: true, checks: ['PowerShell login instructions preserve spaces, quotes, Unicode and literal variables'], realLoginAttempted: false }));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(() => { console.error('Windows login command fixture failed.'); process.exitCode = 1; });
