import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import semver from 'semver';

/**
 * The published manifest is what a DSH host and the plugin market read before
 * loading Nexus: the host's boot gate skips a plugin whose dsh peer range
 * excludes the running runtime, and the market reports the same verdict.
 *
 * The peers must therefore name every host release we support. They are an
 * explicit "||" list and not a `>=x <y` range on purpose: npm resolves a peer
 * range to its LOWEST satisfying version, so `>=0.2.0-rc.2 <0.3.0` makes
 * `npm ci` install 0.2.0-rc.2 next to this repo's 0.2.1-rc.2 dev toolchain and
 * fail with ERESOLVE. Keep the list; add the next release when the host ships it.
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
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.2', '0.2.1-rc.3']) {
    assert.equal(semver.satisfies(version, hostRange, { includePrerelease: true }), true, `engines.dsh excludes ${version}`);
    for (const [name, range] of dshPeers) {
      assert.equal(semver.satisfies(version, range, { includePrerelease: true }), true, `${name} excludes ${version}`);
    }
  }
  for (const version of ['0.3.0', '0.1.9', '1.0.0']) {
    assert.equal(semver.satisfies(version, hostRange, { includePrerelease: true }), false, `engines.dsh accepts ${version}`);
  }
});
