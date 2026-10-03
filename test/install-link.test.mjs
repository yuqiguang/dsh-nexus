import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { syncInstallLink } from '../scripts/install-link.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture({ previous, corrupt = false, failRename = false, badUpload = false } = {}) {
  const incoming = Buffer.from('new verified release');
  const sums = Buffer.from(`${corrupt ? '0'.repeat(64) : hash(incoming)}  dsh-nexus-0.2.38.tgz\n`);
  const source = { id: 1, tag_name: 'v0.2.38', draft: false, assets: [{ name: 'dsh-nexus-0.2.38.tgz', state: 'uploaded' }, { name: 'SHA256SUMS', state: 'uploaded' }] };
  let current = previous ? { id: 2, tag_name: 'install', body: `<!-- nexus-install-source: ${previous} -->` } : undefined;
  const assets = new Map();
  if (current) {
    assets.set(40, { id: 40, name: 'dsh-nexus.tgz', bytes: Buffer.from('old archive') });
    assets.set(41, { id: 41, name: 'SHA256SUMS', bytes: Buffer.from('old checksum') });
  }
  let next = 100, fault = failRename;
  const changes = [];
  const read = name => [...assets.values()].find(asset => asset.name === name)?.bytes;
  const client = {
    async release(tag) { return tag === 'install' ? current && { ...current, assets: [...assets.values()].map(asset => ({ ...asset })) } : source; },
    async commit() { return 'c'.repeat(40); },
    async download(tag, name) { return tag === 'install' ? read(name) : name === 'SHA256SUMS' ? sums : incoming; },
    async create(commit, body) { changes.push('create'); current = { id: 2, tag_name: 'install', body }; return { ...current, assets: [] }; },
    async upload(release, name, bytes) {
      assert.equal(release.id, 2);
      changes.push('upload'); const id = next++;
      const asset = { id, name, bytes, size: bytes.length, state: 'uploaded', digest: `sha256:${badUpload ? '0'.repeat(64) : hash(bytes)}` };
      assets.set(id, asset); return { ...asset };
    },
    async rename(id, name) {
      if (fault && id >= 100 && name === 'SHA256SUMS') { fault = false; throw new Error('rename failed'); }
      assert.ok(assets.has(id), 'only installation assets may change');
      assert.ok(![...assets.values()].some(asset => asset.id !== id && asset.name === name));
      changes.push('rename'); assets.get(id).name = name;
    },
    async remove(id) { assert.ok(assets.has(id)); changes.push('delete'); assets.delete(id); },
    async pointAlias() { changes.push('alias-ref'); },
    async publish(id, body) { assert.equal(id, 2); changes.push('publish'); current.body = body; },
  };
  return { client, source, incoming, changes, assets, read };
}

test('creates a fixed URL using the exact published bytes and a matching renamed checksum', async () => {
  const f = fixture(); const before = structuredClone(f.source);
  const result = await syncInstallLink(f.client, 'owner/nexus', 'v0.2.38');
  assert.equal(result.url, 'https://github.com/owner/nexus/releases/download/install/dsh-nexus.tgz');
  assert.deepEqual(f.read('dsh-nexus.tgz'), f.incoming);
  assert.equal(f.read('SHA256SUMS').toString(), `${hash(f.incoming)}  dsh-nexus.tgz\n`);
  assert.deepEqual(f.source, before);
});
test('a later release replaces the fixed files and retains the versioned source', async () => {
  const f = fixture({ previous: 'v0.2.37' }); const before = structuredClone(f.source);
  await syncInstallLink(f.client, 'owner/nexus', 'v0.2.38');
  assert.deepEqual(f.read('dsh-nexus.tgz'), f.incoming);
  assert.equal(f.assets.size, 2); assert.deepEqual(f.source, before);
});
test('a failed switch restores both previous public files', async () => {
  const f = fixture({ previous: 'v0.2.37', failRename: true });
  await assert.rejects(syncInstallLink(f.client, 'owner/nexus', 'v0.2.38'), /rename failed/);
  assert.equal(f.read('dsh-nexus.tgz').toString(), 'old archive');
  assert.equal(f.read('SHA256SUMS').toString(), 'old checksum');
  assert.ok(!f.changes.includes('delete')); assert.ok(!f.changes.includes('publish'));
});
test('a corrupted source refuses all publication changes', async () => {
  const f = fixture({ corrupt: true });
  await assert.rejects(syncInstallLink(f.client, 'owner/nexus', 'v0.2.38'), /source checksum mismatch/);
  assert.deepEqual(f.changes, []);
});
test('an incomplete release refuses all publication changes', async () => {
  const f = fixture(); f.source.assets.pop();
  await assert.rejects(syncInstallLink(f.client, 'owner/nexus', 'v0.2.38'), /incomplete/);
  assert.deepEqual(f.changes, []);
});
test('late publication of an older version never downgrades the fixed entry', async () => {
  const f = fixture({ previous: 'v0.2.39' });
  assert.equal((await syncInstallLink(f.client, 'owner/nexus', 'v0.2.38')).status, 'skipped-older-release');
  assert.deepEqual(f.changes, []);
});
test('an invalid staged upload leaves the previous public files intact', async () => {
  const f = fixture({ previous: 'v0.2.37', badUpload: true });
  await assert.rejects(syncInstallLink(f.client, 'owner/nexus', 'v0.2.38'), /uploaded asset checksum mismatch/);
  assert.equal(f.read('dsh-nexus.tgz').toString(), 'old archive');
  assert.equal(f.read('SHA256SUMS').toString(), 'old checksum');
  assert.deepEqual(f.changes, ['upload']);
});
test('repeating the same release verifies the entry without uploading or replacing it again', async () => {
  const f = fixture();
  await syncInstallLink(f.client, 'owner/nexus', 'v0.2.38');
  const before = [...f.changes];
  assert.equal((await syncInstallLink(f.client, 'owner/nexus', 'v0.2.38')).status, 'up-to-date');
  assert.deepEqual(f.changes, before);
});
