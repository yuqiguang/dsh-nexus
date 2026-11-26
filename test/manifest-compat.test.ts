import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import semver from 'semver';

/**
 * engines.dsh is DSH's authoritative activation requirement and accepts the
 * entire 0.2 line, including prereleases, using includePrerelease: true.
 * Peers use the same range, with explicit prerelease anchors for npm's default
 * prerelease handling so the pinned development toolchain remains installable.
 * A range permits activation; future host API changes still need regression checks.
 */
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string; engines: Record<string, string>; peerDependencies: Record<string, string>;
};
const dshPeers = Object.entries(manifest.peerDependencies)
  .filter(([name]) => /^@deepseek-ai\/dsh(?:-|$)/.test(name));
const hostRange = manifest.engines.dsh ?? '';

test('no DSH peer drifts: all of them declare the same host releases', () => {
  assert.ok(dshPeers.length > 0, 'no @deepseek-ai/dsh* peer is declared');
  const declared = new Set(dshPeers.map(([, range]) => range));
  assert.equal(declared.size, 1, `peers declare ${declared.size} different ranges: ${[...declared].join(' / ')}`);
});

test('every supported host release passes every DSH peer; 0.3.0 and older lines do not', () => {
  for (const version of ['0.2.0-alpha.0', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.2-rc.5', '0.2.2', '0.2.99-beta.1', '0.2.999']) {
    assert.equal(semver.satisfies(version, hostRange, { includePrerelease: true }), true, `engines.dsh excludes ${version}`);
    for (const [name, range] of dshPeers) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${name} excludes ${version}`);
    }
  }
  for (const version of ['0.3.0-0', '0.3.0-alpha.1', '0.3.0', '0.1.9', '1.0.0']) {
    assert.equal(semver.satisfies(version, hostRange, { includePrerelease: true }), false, `engines.dsh accepts ${version}`);
    for (const [name, range] of dshPeers) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), false, `${name} accepts ${version}`);
    }
  }
});

test('npm accepts the pinned development hosts and current desktop without prerelease options', () => {
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3', '0.2.2-rc.5', '0.2.2']) {
    for (const [name, range] of dshPeers) {
      assert.equal(semver.satisfies(version, range), true, `${name} excludes ${version} under npm defaults`);
    }
  }
});
