import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeLoginInstructions } from '../src/coders/login.js';

test('Bash login instructions preserve literal paths and deliver the dedicated home to the selected program', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-login-'));
  const home = join(root, "home ' $HOME `printf wrong` $(printf wrong)"), executable = join(root, "claude ' program");
  try {
    await writeFile(executable, '#!/bin/sh\nprintf "%s\\0" "$CLAUDE_CONFIG_DIR" "$@"\n', { mode: 0o700 });
    const login = claudeLoginInstructions('linux', home, executable);
    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', login.command], { encoding: 'utf8' });
    assert.deepEqual(output.split('\0'), [home, 'auth', 'login', '']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Windows login instructions use PowerShell literal strings and its call operator for executable paths', () => {
  const login = claudeLoginInstructions('win32', "C:\\Users\\O'Brien $user\\.dsh\\claude home", 'C:\\Program Files\\Claude\\claude.exe');
  assert.equal(login.shell, 'PowerShell');
  assert.equal(login.command, "$env:CLAUDE_CONFIG_DIR = 'C:\\Users\\O''Brien $user\\.dsh\\claude home'; & 'C:\\Program Files\\Claude\\claude.exe' auth login");
});
