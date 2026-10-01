import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PatchRow } from '../scripts/setup.mjs';

// The setup script is plain JavaScript so `npm run setup` can run before the first build, and it is not
// mirrored into dist/. Load it by URL relative to this compiled file (dist/test/…) instead of by a specifier,
// which tsc would resolve against the source tree and Node against the build output.
const { backfillProfilePatch } = await import(new URL('../../scripts/setup.mjs', import.meta.url).href) as {
  backfillProfilePatch(patch: PatchRow[], coderRoots: string[]): PatchRow[];
};
const { splitWebUrl, saveWebUrl } = await import(new URL('../../scripts/weburl.mjs', import.meta.url).href) as {
  splitWebUrl(line: string): { shown: string; saved: string } | undefined;
  saveWebUrl(path: string, content: string): Promise<void>;
};

/** The JSON the profile's patch was first written as, before DSH rewrote it as YAML. */
const original = (): PatchRow[] => [{ insert: [
  { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
  { id: 'nexus-channels', name: 'file:///nexus/dist/src/plugin.js', config: { workspaceRoot: '/nexus/workspace' } },
] }];

/** What DSH's plugin manager writes after the first boot: YAML, with its own settings rows in it. */
const rewritten = (): PatchRow[] => [
  { insert: [
    { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
    { id: 'nexus-channels', name: 'file:///nexus/dist/src/plugin.js', config: { workspaceRoot: '/nexus/workspace' } },
  ] },
  { id: 'ui-theme', name: '@deepseek-ai/dsh-client-ui-theme', config: { preference: 'light' } },
];

test('back-filling adds coder roots and moves owned reminder rows to the official bundle', () => {
  const patch = backfillProfilePatch(original(), ['/nexus']);
  const inserted = patch[0]!.insert!;
  assert.deepEqual(inserted.map(row => row.id), ['nexus-channels', 'nexus-documents']);
  assert.deepEqual(inserted[0]!.config?.coderRoots, ['/nexus']);
  assert.deepEqual(inserted[0]!.config?.workspaceRoot, '/nexus/workspace', 'an existing workspace path is kept');
});

test('back-filling a patch DSH rewrote as YAML keeps DSH\'s own rows, and a second run changes nothing', () => {
  const patch = backfillProfilePatch(rewritten(), ['/nexus']);
  assert.deepEqual(patch.map(layer => layer.id ?? 'insert'), ['insert', 'ui-theme']);
  assert.deepEqual(patch[1]!.config, { preference: 'light' }, "DSH's settings rows survive untouched");
  const once = JSON.stringify(patch);
  assert.equal(JSON.stringify(backfillProfilePatch(patch, ['/nexus'])), once);
  assert.deepEqual(parse(once), patch, 'what setup writes reads back the same through YAML, as DSH reads it');
});

test('a patch without a nexus-channels row is left alone', () => {
  const patch = backfillProfilePatch([{ insert: [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule' }] }], ['/nexus']);
  assert.deepEqual(patch, [{ insert: [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule' }] }]);
});

test('document component is default-off and later native overrides survive setup', () => {
  const patch = backfillProfilePatch(original(), ['/nexus']);
  const documents = patch[0]!.insert!.find(row => row.id === 'nexus-documents');
  assert.deepEqual(documents, { id: 'nexus-documents', name: 'file:///nexus/dist/src/documents/plugin.js', disabled: true });
  patch.push({ id: 'nexus-documents', disabled: false });
  const before = JSON.stringify(patch);
  assert.equal(JSON.stringify(backfillProfilePatch(patch, ['/nexus'])), before);
});

test('the login address DSH prints is kept out of the service log and saved where only this user can read it', async () => {
  const token = 'fixture-login-token-0123456789';
  const split = splitWebUrl(`dsh web: http://127.0.0.1:3080/?token=${token} (LAN: http://192.168.1.5:3080/?token=${token})`);
  assert.deepEqual(split, { shown: 'dsh web: http://127.0.0.1:3080/（带登录令牌的地址在 .nexus/web-url，只有本机这个用户能读）',
    saved: `http://127.0.0.1:3080/?token=${token} (LAN: http://192.168.1.5:3080/?token=${token})\n` });
  assert.equal(split!.shown.includes(token), false);
  assert.deepEqual(splitWebUrl(`dsh web: http://127.0.0.1:3080/?lang=zh&token=${token}`)?.shown.includes(token), false, 'wherever the token sits in the query');
  // Every other line passes through as it is, including DSH's other "dsh web:" line.
  for (const line of ['dsh web: opening the default browser; pass --no-open to disable', '[nexus-mail] inbox check failed', 'dsh web: not a url ?token=x', ''])
    assert.equal(splitWebUrl(line), undefined, line);
  const dir = await mkdtemp(join(tmpdir(), 'nexus-weburl-'));
  await saveWebUrl(join(dir, 'web-url'), split!.saved);
  await saveWebUrl(join(dir, 'web-url'), split!.saved);
  assert.equal(await readFile(join(dir, 'web-url'), 'utf8'), split!.saved);
  assert.equal((await stat(join(dir, 'web-url'))).mode & 0o777, 0o600);
});


test('moving reminder services into the official bundle preserves their explicit configuration and later overrides', () => {
  const source: PatchRow[] = [{ insert: [
    { id: 'schedule', name: '@deepseek-ai/dsh-schedule', config: { deliveryHistoryDays: 7 } },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context', config: {} },
    { id: 'nexus-channels', name: 'file:///nexus/dist/src/plugin.js', config: {} },
  ] }, { id: 'schedule', config: { deliveryHistoryDays: 10 } }];
  const patch = backfillProfilePatch(source, ['/nexus']);
  assert.deepEqual(patch[0]!.insert!.map(row => row.id), ['nexus-channels', 'nexus-documents']);
  assert.deepEqual(patch.slice(1).map(row => [row.id, row.config]), [
    ['schedule', { deliveryHistoryDays: 7 }], ['time-context', {}], ['schedule', { deliveryHistoryDays: 10 }],
  ]);
  const once = JSON.stringify(patch);
  assert.equal(JSON.stringify(backfillProfilePatch(patch, ['/nexus'])), once);
});
