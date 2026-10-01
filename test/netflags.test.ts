import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

// Plain JavaScript like the rest of scripts/, loaded by URL relative to this compiled file (dist/test/…) the
// same way the setup test does, so tsc does not try to resolve the script against the source tree.
const { networkFlags, networkNodeOptions } = await import(new URL('../../scripts/netflags.mjs', import.meta.url).href) as {
  networkFlags: string[];
  networkNodeOptions: (existing?: string) => string;
};

test('the network flags are ones this Node still accepts, and a child starts with all of them', () => {
  // A flag renamed or dropped in a Node upgrade would make every start fail, a far worse failure than the
  // dual-stack timeout it prevents, so each flag is proven against the interpreter that will run DSH.
  for (const flag of networkFlags) {
    assert.equal(execFileSync(process.execPath, [flag, '-e', ''], { stdio: 'pipe' }).toString(), '');
  }
  const options = networkNodeOptions();
  const seen = execFileSync(process.execPath, ['-e', 'process.stdout.write(process.env.NODE_OPTIONS ?? "")'],
    { env: { ...process.env, NODE_OPTIONS: options }, stdio: 'pipe' }).toString();
  assert.equal(seen, options);
});

test('the parent keeps its own options, and flags already present are not repeated', () => {
  assert.equal(networkNodeOptions('--max-old-space-size=384'),
    '--max-old-space-size=384 --no-network-family-autoselection --dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000');
  assert.equal(networkNodeOptions('--no-network-family-autoselection --trace-warnings'),
    '--trace-warnings --no-network-family-autoselection --dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=2000');
  assert.equal(networkNodeOptions(''), networkFlags.join(' '));
  assert.equal(networkNodeOptions('--network-family-autoselection-attempt-timeout=250'), networkFlags.join(' '));
});
