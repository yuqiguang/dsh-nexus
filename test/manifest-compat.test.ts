import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import semver from 'semver';

/**
 * The published manifest is the only thing a DSH host and the plugin market read
 * before loading Nexus. A peer range that enumerates individual releases silently
 * goes stale the day the host publishes a new rc, and the host's boot gate then
 * skips the plugin entirely, so pin the declared coverage instead of the string.
 */
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string; engines: Record<string, string>; peerDependencies: Record<string, string>;
};
const dshPeers = Object.entries(manifest.peerDependencies)
  .filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/.test(name));
const hostRange = manifest.engines.dsh ?? '';

test('every DSH peer declares the same host line as engines.dsh instead of enumerating releases', () => {
  assert.ok(dshPeers.length > 0, 'no @deepseek-ai/dsh* peer is declared');
  assert.equal(hostRange, '>=0.2.0-rc.2 <0.3.0');
  for (const [name, range] of dshPeers) assert.equal(range, hostRange, `${name} drifts from engines.dsh`);
});

test('the declared host line covers every published 0.2.x release and still refuses 0.3.0', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.2']) {
    assert.equal(semver.satisfies(version, hostRange, { includePrerelease: true }), true, `${version} is excluded`);
    for (const [name, range] of dshPeers) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${name} excludes ${version}`);
    }
  }
  for (const version of ['0.3.0', '0.1.9', '1.0.0']) {
    assert.equal(semver.satisfies(version, hostRange, { includePrerelease: true }), false, `${version} is accepted`);
  }
});
