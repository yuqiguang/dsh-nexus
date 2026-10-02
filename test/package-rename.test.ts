import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const { renameProfilePatch, renameProfile } = await import(new URL('../../scripts/rename-profile.mjs', import.meta.url).href) as {
  renameProfilePatch(source: string): { changed: number; text: string };
  renameProfile(directory: string, apply?: boolean): Promise<{ changed: number; applied: boolean }>;
};

test('package rename preserves qualified configuration, enablement, comments and unrelated data', () => {
  const source = `# keep user comment
- id: nexus-channels
  name: nexus-next
  config:
    workspaceRoot: /project
    label: nexus-next
- id: nexus-memory
  name: nexus-next/memory
  disabled: false
- id: nexus-mail
  disabled: true
- id: other
  name: nexus-next/mail
- id: nexus-agenda
  name: other/agenda
`;
  const result = renameProfilePatch(source);
  assert.equal(result.changed, 2);
  assert.match(result.text, /# keep user comment/);
  const rows = parse(result.text);
  assert.deepEqual(rows[0], { id: 'nexus-channels', name: 'dsh-nexus', config: { workspaceRoot: '/project', label: 'nexus-next' } });
  assert.deepEqual(rows[1], { id: 'nexus-memory', name: 'dsh-nexus/memory', disabled: false });
  assert.deepEqual(rows.slice(2), parse(source).slice(2));
  assert.deepEqual(renameProfilePatch(result.text), { changed: 0, text: result.text });
});

test('package rename handles explicit insertions without rewriting nested configuration', () => {
  const source = JSON.stringify([{ insert: [
    { id: 'nexus-channels', name: 'nexus-next', config: { name: 'nexus-next', insert: [{ id: 'nexus-mail', name: 'nexus-next/mail' }] } },
    { id: 'nexus-mail', name: 'nexus-next/mail', disabled: false },
    { id: 'nexus-agenda', name: 'nexus-next/agenda', disabled: true },
    { id: 'nexus-documents', name: 'nexus-next/documents', disabled: true },
  ] }]);
  const result = renameProfilePatch(source);
  assert.equal(result.changed, 3);
  const rows = parse(result.text)[0].insert;
  assert.deepEqual(rows[0].config, parse(source)[0].insert[0].config);
  assert.equal(rows[1].disabled, false);
  assert.equal(rows[2].disabled, true);
  assert.equal(rows[3].name, 'nexus-next/documents');
});

test('unqualified native overrides and source profiles are byte-for-byte unchanged', () => {
  for (const source of ['[]\n', '- id: nexus-memory\n  disabled: false\n', '- insert:\n    - id: nexus-channels\n      name: file:///project/dist/src/plugin.js\n']) {
    assert.deepEqual(renameProfilePatch(source), { changed: 0, text: source });
  }
});

test('invalid patch shapes and duplicate keys cannot be silently migrated', () => {
  for (const source of ['{}', '- id: nexus-memory\n  name: nexus-next/memory\n  name: other', '[']) {
    assert.throws(() => renameProfilePatch(source), /invalid_profile_patch/);
  }
});

test('check does not write; apply backs up only the patch and preserves the remaining profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-rename-'));
  try {
    const source = '- id: nexus-memory\n  name: nexus-next/memory\n  disabled: false\n';
    await writeFile(join(directory, 'cordis.patch.yml'), source);
    await writeFile(join(directory, 'untouched.json'), '{"fixture":true}\n');
    assert.deepEqual(await renameProfile(directory), { changed: 1, applied: false });
    assert.equal((await readdir(directory)).length, 2);
    assert.equal(await readFile(join(directory, 'cordis.patch.yml'), 'utf8'), source);
    assert.deepEqual(await renameProfile(directory, true), { changed: 1, applied: true });
    const backup = (await readdir(directory)).find(name => name.includes('.before-dsh-nexus-'))!;
    assert.equal(await readFile(join(directory, backup), 'utf8'), source);
    assert.equal(await readFile(join(directory, 'untouched.json'), 'utf8'), '{"fixture":true}\n');
    assert.deepEqual(await renameProfile(directory, true), { changed: 0, applied: false });
    assert.equal((await readdir(directory)).length, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
