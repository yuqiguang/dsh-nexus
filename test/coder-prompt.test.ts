import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchPrompt } from '../src/coders/prompt.js';

test('dispatch guidance reflects platform and permission setting without imposing another mode', () => {
  const full = dispatchPrompt('Codex', 2, 'full', 'win32');
  assert.match(full, /当前为完全权限/);
  assert.doesNotMatch(full, /当前为严格模式|当前为标准模式/);
  assert.match(full, /当前 Windows/);
  const strict = dispatchPrompt('Claude Code', 1, 'strict', 'linux');
  assert.match(strict, /当前为严格模式/);
  assert.doesNotMatch(strict, /当前 Windows|当前为完全权限/);
  const standard = dispatchPrompt('Codex', 4, 'standard', 'win32');
  assert.match(standard, /当前为标准模式/);
  assert.match(standard, /最多同时执行 4 个任务/);
});
