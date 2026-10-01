import assert from 'node:assert/strict';
import { test } from 'node:test';
import { windowsVerifyWords } from '../src/coders/verify.js';
import { windowsSandbox, windowsVerifyArgv } from '../src/coders/windows-sandbox.js';
import type { CodexProcess } from '../src/coders/codex.js';
import { firewallProfilesEnabled } from '../src/coders/windows-firewall.js';

test('Windows firewall enforcement requires all three profiles, with unknown values failing closed', () => {
  assert.equal(firewallProfilesEnabled([true, true, true]), true);
  for (const value of [[true, false, true], [1, 1, 1], [], true, null]) assert.equal(firewallProfilesEnabled(value), false);
});

test('Windows verifier preserves quoted paths, empty args and literal metacharacters without a shell', () => {
  assert.deepEqual(windowsVerifyWords('"C:\\Program Files\\nodejs\\node.exe" "test\\空 格 & %test%.cjs" ""'),
    ['C:\\Program Files\\nodejs\\node.exe', 'test\\空 格 & %test%.cjs', '']);
  assert.throws(() => windowsVerifyWords('npm test && whoami'), /shell/);
  assert.throws(() => windowsVerifyWords('node "incomplete'), /引号/);
  assert.throws(() => windowsVerifyWords('"" file'), /不能为空/);
});

test('Windows independent verifier binds explicit roots and network to an unpredictable profile', () => {
  const argv = windowsVerifyArgv('C:\\codex.exe', ['C:\\node.exe', 'test.cjs'], 'C:\\work space', 'C:\\work space\\child');
  assert.deepEqual(argv.slice(-3), ['--', 'C:\\node.exe', 'test.cjs']);
  assert.ok(argv.includes('windows.sandbox="elevated"'));
  assert.ok(argv.includes('--include-managed-config'));
  const profile = argv[argv.indexOf('-P') + 1];
  const policy = argv.find(arg => arg.startsWith(`permissions.${profile}=`))!;
  assert.match(policy, /network=\{enabled=false\}/);
  assert.ok(policy.includes('"C:\\\\work space"="write"'));
  const other = windowsVerifyArgv('codex', ['node'], 'C:\\work', 'C:\\work');
  assert.notEqual(other[other.indexOf('-P') + 1], profile);
  assert.match(windowsVerifyArgv('codex', ['node'], 'C:\\work', 'C:\\work', 'ask').join(' '), /enabled=true/);
  assert.throws(() => windowsVerifyArgv('codex', ['node'], 'C:\\work', 'C:\\work', 'loopback'), /不支持/);
});

function fakeSandbox(setupSucceeded: boolean) {
  const requests: string[] = [];
  let wake: ((value: IteratorResult<string>) => void) | undefined;
  const queue: string[] = [];
  let killed = false;
  let exit: (code: number) => void = () => {};
  const exited = new Promise<number>(resolve => { exit = resolve; });
  const push = (value: unknown) => { const line = JSON.stringify(value); if (wake) { const next = wake; wake = undefined; next({ done: false, value: line }); } else queue.push(line); };
  const child: CodexProcess = {
    exited,
    kill() { killed = true; wake?.({ done: true, value: undefined }); exit(0); },
    lines: { [Symbol.asyncIterator]() { return { next: () => queue.length ? Promise.resolve({ done: false as const, value: queue.shift()! }) : killed ? Promise.resolve({ done: true as const, value: undefined }) : new Promise<IteratorResult<string>>(resolve => { wake = resolve; }) }; } },
    write(line) {
      const request = JSON.parse(line); requests.push(request.method);
      if (request.method === 'initialize') push({ id: request.id, result: {} });
      if (request.method === 'windowsSandbox/readiness') push({ id: request.id, result: { status: 'ready' } });
      if (request.method === 'windowsSandbox/setupStart') {
        assert.equal(request.params.mode, 'elevated');
        push({ id: request.id, result: { started: true } });
        push({ method: 'windowsSandbox/setupCompleted', params: { success: setupSucceeded, mode: 'elevated' } });
      }
    },
  };
  return { child, requests, wasKilled: () => killed };
}

test('Windows sandbox readiness uses no model turn and always closes its process', async () => {
  const fake = fakeSandbox(true);
  assert.equal(await windowsSandbox({ command: 'codex', env: {} }, 'C:\\work', false, () => fake.child), 'ready');
  assert.deepEqual(fake.requests, ['initialize', 'initialized', 'windowsSandbox/readiness']);
  assert.equal(fake.wasKilled(), true);
});

test('Windows sandbox setup requires a success notification before accepting readiness', async () => {
  const failed = fakeSandbox(false);
  await assert.rejects(windowsSandbox({ command: 'codex', env: {} }, 'C:\\work', true, () => failed.child), /失败/);
  assert.equal(failed.requests.includes('windowsSandbox/readiness'), false);
  assert.equal(failed.wasKilled(), true);
  const success = fakeSandbox(true);
  assert.equal(await windowsSandbox({ command: 'codex', env: {} }, 'C:\\work', true, () => success.child), 'ready');
});
