import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import JSZip from 'jszip';
import { DataError, MANIFEST, PENDING_FILE, STAGING_DIR, allowedPath, applyPendingImport, exportData as exportSelectedData, previewData, boundedBuffer, importedReason, stageImport } from '../src/data/archive.js';
import { restartNotice } from '../src/service/lifecycle.js';

// Existing replacement fixtures inspect the decoded ZIP; the public exporter encrypts selected credentials.
const exportData: typeof exportSelectedData = async (dir, meta, options = { includeCredentials: true, includeSettings: true }) => {
  const { decryptArchive } = await import('../src/data/encryption.js');
  const result = await exportSelectedData(dir, meta, { ...options, password: 'fixture-password' });
  const { encrypted: _, ...summary } = result.summary;
  return { zip: await decryptArchive(result.zip, 'fixture-password'), summary };
};
const T0 = Date.parse('2026-09-27T10:00:00+08:00');
const CREDENTIALS = 'version: 1\nrecords:\n  nexus-channels/wechat:\n    kind: grant\n    payload:\n      secret: fixture-secret-token\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: fixture-browser\n';

/** A DSH home with data under every root, plus what must never travel: attachments, a projection cache, a rejected-record backup, a temporary file, a link out of the home. */
async function home(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-data-'));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  return dir;
}

async function tree(dir: string, under = dir): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let names: string[];
  try { names = await readdir(dir); } catch { return out; }
  for (const name of names.sort()) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) Object.assign(out, await tree(path, under));
    else out[relative(under, path)] = await readFile(path, 'utf8');
  }
  return out;
}

const DATA = {
  'sessions/--home-u-nexus-workspace--/nexus-wechat-aaaa/session.v4.jsonl.zstd': 'LOG-A',
  'sessions/--home-u-nexus-workspace--/nexus-wechat-aaaa-1/session.v4.jsonl.zstd': 'LOG-A1',
  'sessions/--home-u-project--/session-7/session.v3.jsonl.zstd': 'LOG-7',
  'storages/nexus_memory/profile/pf-1.json': '{"version":1,"record":{"text":"不吃香菜"}}',
  'storages/nexus_agenda/events/ev-1.json': '{"version":1,"record":{"title":"起床"}}',
  'storages/workspace.json': '{"workspaces":[]}',
  '.credentials.yaml': CREDENTIALS,
  'profiles/nexus/cordis.patch.yml': '- id: nexus-channels\n',
};
const NEVER = {
  'attachments/img-1.png': 'PNG',
  'storages/session_projcache/x.json': 'CACHE',
  'storages/nexus_mail/cursor/inbox.json.bak.1790000000': 'OLD',
  'storages/nexus_files/files/f-1.json.123.tmp': 'TMP',
  'service-run.json': '{}',
  'restart-reason.json': '{}',
  'profiles/nexus/package.json': '{}',
};

test('an export carries the sessions, native storage, credentials and DSH settings, and restores into an empty home as it was', async () => {
  const source = await home({ ...DATA, ...NEVER });
  await symlink('/etc', join(source, 'sessions', 'escape'));
  const { zip, summary } = await exportData(source, { now: T0, dshVersion: '0.1.7-rc.1', commit: 'abc1234' });
  const archive = await JSZip.loadAsync(zip);
  const names = Object.values(archive.files).filter(entry => !entry.dir).map(entry => entry.name).sort();
  assert.deepEqual(names, [...Object.keys(DATA), MANIFEST].sort(), 'nothing else, and no link is followed');
  const manifest = JSON.parse(await archive.file(MANIFEST)!.async('string'));
  assert.deepEqual([manifest.format, manifest.version, manifest.createdAt, manifest.dshVersion, manifest.commit], ['nexus-data', 2, T0, '0.1.7-rc.1', 'abc1234']);
  assert.match((await archive.file('.credentials.yaml')!.async('string')), /fixture-secret-token/, 'the secrets travel in plain text, as the user chose');
  assert.deepEqual(summary, { roots: ['sessions', 'storages', '.credentials.yaml', 'profiles/nexus/cordis.patch.yml'], createdAt: T0, dshVersion: '0.1.7-rc.1', commit: 'abc1234', sessions: 3, records: 3, credentials: 2,
    bytes: Object.values(DATA).reduce((sum, text) => sum + Buffer.byteLength(text), 0) });
  // Into a home that has nothing yet: staged beside it, then swapped in at the next start.
  const target = await home({});
  const pending = await stageImport(target, zip, T0 + 1000);
  assert.deepEqual(pending.summary, summary);
  assert.deepEqual(await tree(target, target), Object.fromEntries([...Object.entries(DATA).map(([path, text]) => [join(STAGING_DIR, path), text]), [PENDING_FILE, JSON.stringify(pending)]]),
    'staging touches nothing live');
  assert.deepEqual(await applyPendingImport(target), pending);
  assert.deepEqual(await tree(target), DATA);
  assert.equal((await stat(join(target, '.credentials.yaml'))).mode & 0o777, 0o600);
  assert.equal(await applyPendingImport(target), undefined, 'nothing pending any more');
});

test('an import replaces the data as a whole, keeps what it replaced, and survives a crash half way', async () => {
  const exported = (await exportData(await home(DATA), { now: T0 })).zip;
  const live = { ...DATA, 'sessions/--home-u-nexus-workspace--/nexus-wechat-aaaa-2/session.v4.jsonl.zstd': 'LATER',
    'storages/nexus_memory/events/me-9.json': '{"later":true}', '.credentials.yaml': CREDENTIALS.replace('fixture-secret-token', 'newer-token'),
    'profiles/nexus/cordis.patch.yml': '- id: newer\n', ...NEVER };
  const target = await home(live);
  const pending = await stageImport(target, exported, T0 + 5000);
  assert.match(pending.replacedDir, /^replaced-\d{8}-\d{6}-[0-9a-f]{6}$/);
  const applied = await applyPendingImport(target);
  assert.equal(applied?.replacedDir, pending.replacedDir);
  const after = await tree(target);
  for (const [path, text] of Object.entries(DATA)) assert.equal(after[path], text, path);
  assert.equal(after['sessions/--home-u-nexus-workspace--/nexus-wechat-aaaa-2/session.v4.jsonl.zstd'], undefined, 'what came after the export is gone from the live data');
  assert.equal(after['storages/nexus_memory/events/me-9.json'], undefined);
  assert.equal(after['storages/session_projcache/x.json'], undefined, 'the cache went aside with the rest of storage and is rebuilt');
  for (const path of ['attachments/img-1.png', 'service-run.json', 'restart-reason.json', 'profiles/nexus/package.json']) assert.equal(after[path], (NEVER as Record<string, string>)[path], `${path} is not part of the data`);
  const kept = await tree(join(target, pending.replacedDir));
  assert.equal(kept['sessions/--home-u-nexus-workspace--/nexus-wechat-aaaa-2/session.v4.jsonl.zstd'], 'LATER', 'the replaced data is kept whole');
  assert.match(kept['.credentials.yaml']!, /newer-token/);
  assert.equal(kept['profiles/nexus/cordis.patch.yml'], '- id: newer\n');
  assert.equal(kept['storages/session_projcache/x.json'], 'CACHE');

  // A crash between two roots: sessions already swapped, the rest still staged.
  const again = await home(live);
  const second = await stageImport(again, exported, T0 + 6000);
  await mkdir(join(again, second.replacedDir), { recursive: true });
  await rename(join(again, 'sessions'), join(again, second.replacedDir, 'sessions'));
  await rename(join(again, STAGING_DIR, 'sessions'), join(again, 'sessions'));
  await applyPendingImport(again);
  const recovered = await tree(again);
  for (const [path, text] of Object.entries(DATA)) assert.equal(recovered[path], text, path);
  assert.equal((await tree(join(again, second.replacedDir)))['sessions/--home-u-nexus-workspace--/nexus-wechat-aaaa-2/session.v4.jsonl.zstd'], 'LATER');
  assert.deepEqual(await readdir(again).then(names => names.filter(name => name === STAGING_DIR || name === PENDING_FILE)), []);
});

test('an archive without DSH settings leaves the profile alone, and one without sessions still clears them', async () => {
  const bare = await home({ '.credentials.yaml': CREDENTIALS });
  const exported = (await exportData(bare, { now: T0 })).zip;
  const target = await home(DATA);
  const pending = await stageImport(target, exported, T0);
  await applyPendingImport(target);
  const after = await tree(target);
  assert.equal(after['profiles/nexus/cordis.patch.yml'], DATA['profiles/nexus/cordis.patch.yml'], 'without its patch the profile would start without Nexus');
  assert.equal(Object.keys(after).some(path => path.startsWith('sessions/') || path.startsWith('storages/')), false);
  assert.equal((await tree(join(target, pending.replacedDir)))['storages/nexus_agenda/events/ev-1.json'], DATA['storages/nexus_agenda/events/ev-1.json']);
});

test('anything but an intact archive of this format is refused before a byte is staged', async () => {
  const good = (await exportData(await home(DATA), { now: T0 })).zip;
  const target = await home(DATA);
  const refused = async (archive: Buffer, code: string) => {
    await assert.rejects(stageImport(target, archive, T0), (error: unknown) => error instanceof DataError && error.code === code, code);
    assert.deepEqual((await readdir(target)).filter(name => name === STAGING_DIR || name === PENDING_FILE), [], `${code}: nothing staged`);
  };
  const edit = async (change: (zip: JSZip, manifest: { files: { path: string; size: number; sha256: string }[]; format?: string; version?: number }) => void | Promise<void>) => {
    const zip = await JSZip.loadAsync(good);
    const manifest = JSON.parse(await zip.file(MANIFEST)!.async('string'));
    await change(zip, manifest);
    zip.file(MANIFEST, JSON.stringify(manifest));
    return zip.generateAsync({ type: 'nodebuffer' });
  };
  await refused(Buffer.from('not a zip'), 'archive_unreadable');
  const unlisted = await JSZip.loadAsync(good);
  unlisted.remove(MANIFEST);
  await refused(await unlisted.generateAsync({ type: 'nodebuffer' }), 'manifest_invalid');
  await refused(await edit((_zip, manifest) => { manifest.format = 'something-else'; }), 'not_a_nexus_archive');
  await refused(await edit((_zip, manifest) => { manifest.version = 99; }), 'archive_version_unsupported');
  // A path out of the home, or anywhere but the data roots, whether listed or merely present.
  for (const path of ['../evil', 'sessions/../../evil', '/etc/passwd', 'attachments/x', 'profiles/nexus/package.json', 'sessions', 'storages/session_projcache/x.json']) {
    await refused(await edit((zip, manifest) => { zip.file(path, 'x'); manifest.files.push({ path, size: 1, sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881' }); }), 'archive_path_rejected');
  }
  await refused(await edit(zip => { zip.file('storages/unlisted.json', '{}'); }), 'archive_path_rejected');
  await refused(await edit(zip => { zip.remove('storages/workspace.json'); }), 'archive_incomplete');
  await refused(await edit(zip => { zip.file('storages/workspace.json', '{"tampered":true}'); }), 'archive_corrupt');
  await refused(await edit(async (zip, manifest) => {
    const text = 'not: [valid';
    const { createHash } = await import('node:crypto');
    zip.file('.credentials.yaml', text);
    manifest.files = manifest.files.map(file => file.path === '.credentials.yaml' ? { ...file, size: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') } : file);
  }), 'credentials_invalid');
  await refused(await edit((zip, manifest) => { zip.remove('.credentials.yaml'); manifest.files = manifest.files.filter(file => file.path !== '.credentials.yaml'); }), 'credentials_missing');
  assert.equal(allowedPath('sessions/a/b'), true);
  assert.equal(allowedPath('sessions//b'), false);
  // JSZip normalises `..` in the names it writes, so the check on the listed path is what stops a crafted manifest.
  for (const path of ['sessions/../../evil', 'sessions/a/../../../x', 'storages/./x', 'sessions/..']) assert.equal(allowedPath(path), false, path);
  assert.equal(allowedPath('storages/nexus_mail/cursor/inbox.json.bak.1'), false);
  // A pending import remains intact until applied.
  const first = await stageImport(target, good, T0);
  await assert.rejects(stageImport(target, good, T0 + 1), /import_in_progress/);
  assert.equal(JSON.parse(await readFile(join(target, PENDING_FILE), 'utf8')).replacedDir, first.replacedDir);
});

test('the routes insist on their content types, cap a streamed upload, wait for a running update, and restart only after staging', async () => {
  const { installDataRoutes } = await import('../src/data/index.js');
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  let flushed = 0;
  const ctx = { connection: { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) { routes.set(route.path, route.fetch); return async () => {}; } } },
    sessionPersistence: { async flush() { flushed++; } } } as never;
  const target = await home(DATA);
  let restarts = 0;
  installDataRoutes({ ctx, importEnabled: true, home: target, now: () => T0, dshVersion: '0.1.7-rc.1', commit: 'abc1234', restart: () => { restarts++; return true; } });
  const exportRoute = routes.get('/api/nexus-data/export')!;
  const importRoute = routes.get('/api/nexus-data/import')!;
  assert.equal((await exportRoute(new Request('http://x/api/nexus-data/export', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }))).status, 415);
  const exported = await exportRoute(new Request('http://x/api/nexus-data/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(flushed, 1, 'live sessions are flushed before their logs are read');
  assert.deepEqual([exported.status, exported.headers.get('content-type'), exported.headers.get('content-disposition'), exported.headers.get('cache-control')],
    [200, 'application/zip', 'attachment; filename="nexus-data-2026-09-27.zip"', 'no-store']);
  assert.equal(JSON.parse(decodeURIComponent(exported.headers.get('x-nexus-summary')!)).sessions, 3);
  const zip = Buffer.from(await exported.arrayBuffer());
  const post = (body: BodyInit, type = 'application/zip', headers: Record<string, string> = {}) =>
    importRoute(new Request('http://x/api/nexus-data/import', { method: 'POST', headers: { 'content-type': type, ...headers }, body, duplex: 'half' } as RequestInit));
  assert.equal((await post(zip, 'application/octet-stream')).status, 415, 'a form on another site cannot send this type without a preflight');
  // A running update holds the lock: nothing is staged and nothing restarts.
  await writeFile(join(target, 'update.lock'), '1');
  assert.deepEqual(await (await post(zip)).json(), { ok: false, error: { code: 'update_in_progress' } });
  const { rm } = await import('node:fs/promises');
  await rm(join(target, 'update.lock'));
  // A declared or streamed body past the cap is cut off.
  assert.deepEqual(await (await post(zip, 'application/zip', { 'content-length': String(300 * 1024 * 1024) })).json(), { ok: false, error: { code: 'archive_too_large' } });
  let sent = 0;
  const endless = new ReadableStream({ pull(controller) { sent += 1024 * 1024; controller.enqueue(new Uint8Array(1024 * 1024)); } });
  assert.deepEqual(await (await post(endless)).json(), { ok: false, error: { code: 'archive_too_large' } });
  assert.ok(sent <= 258 * 1024 * 1024, 'reading stops at the cap');
  assert.deepEqual(await (await post(Buffer.from('nope'))).json(), { ok: false, error: { code: 'archive_unreadable' } });
  assert.equal(restarts, 0);
  const staged = await (await post(zip, 'application/zip', { 'x-nexus-preview': (await previewData(zip)).digest })).json() as { ok: boolean; value: { restarting: boolean; pending: { summary: { sessions: number } } } };
  assert.deepEqual([staged.ok, staged.value.restarting, staged.value.pending.summary.sessions], [true, true, 3]);
  assert.equal(restarts, 1);
  assert.ok((await readdir(target)).includes(PENDING_FILE));
});

test('the start after an import tells the chat what came in and where the old data went', () => {
  const reason = importedReason({ stagedAt: T0, replacedDir: 'replaced-20260927-101500-abcdef', summary: { createdAt: T0 - 86_400_000, sessions: 14, records: 81, credentials: 9, bytes: 1 } }, T0 + 60_000);
  assert.deepEqual([reason.kind, reason.at], ['import', T0 + 60_000]);
  assert.equal(restartNotice(T0 + 90_000, { startedAt: T0 - 1000, pid: 1, clean: true, stoppedAt: T0 }, reason, 'Asia/Shanghai'),
    'Nexus 已在 9/27 10:01 导入了 9/26 10:00 导出的数据（14 个会话、81 条存储记录、9 条凭据），原来的数据在 .nexus/replaced-20260927-101500-abcdef，并重新启动。导入前进行中的任务和等待中的审批不会继续。');
});


test('a host without the startup importer rejects uploads before staging or restarting', async () => {
  const { installDataRoutes } = await import('../src/data/index.js');
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const ctx = { connection: { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) { routes.set(route.path, route.fetch); } } } } as never;
  const target = await home(DATA);
  installDataRoutes({ ctx, home: target, restart() { throw new Error('must not restart'); } });
  assert.deepEqual(await (await routes.get('/api/nexus-data/capabilities')!(new Request('http://x'))).json(), { importEnabled: false });
  const response = await routes.get('/api/nexus-data/import')!(new Request('http://x', {
    method: 'POST', headers: { 'content-type': 'application/zip' }, body: 'fixture' }));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'import_unavailable' } });
  assert.equal((await readdir(target)).includes(PENDING_FILE), false);
});

test('v2 defaults omit credentials/settings and restore leaves those roots untouched; v1 archives remain readable', async () => {
  const source = await home(DATA), target = await home(DATA);
  const exported = await exportSelectedData(source, { now: T0 });
  const checked = await previewData(exported.zip);
  assert.equal(checked.summary.credentials, 0);
  assert.deepEqual(checked.summary.roots, ['sessions', 'storages']);
  assert.equal((await readdir(target)).includes(PENDING_FILE), false);
  await stageImport(target, exported.zip, T0);
  await applyPendingImport(target);
  assert.equal(await readFile(join(target, '.credentials.yaml'), 'utf8'), CREDENTIALS);
  assert.equal(await readFile(join(target, 'profiles/nexus/cordis.patch.yml'), 'utf8'), DATA['profiles/nexus/cordis.patch.yml']);
  const zip = await JSZip.loadAsync((await exportData(source, { now: T0 })).zip);
  const manifest = JSON.parse(await zip.file(MANIFEST)!.async('string'));
  manifest.version = 1; delete manifest.roots;
  zip.file(MANIFEST, JSON.stringify(manifest));
  assert.equal((await previewData(await zip.generateAsync({ type: 'nodebuffer' }))).summary.credentials, 2);
});

test('credential exports require encryption; wrong passwords/tampering leave no staging and the exact encrypted archive restores', async () => {
  const source = await home(DATA), target = await home({});
  await assert.rejects(exportSelectedData(source, { now: T0 }, { includeCredentials: true, includeSettings: true }), /archive_password_weak/);
  const encrypted = await exportSelectedData(source, { now: T0 }, { includeCredentials: true, includeSettings: true, password: 'fixture-long-password' });
  assert.equal(encrypted.zip.includes(Buffer.from('fixture-secret-token')), false);
  await assert.rejects(stageImport(target, encrypted.zip, T0), /archive_password_required/);
  await assert.rejects(stageImport(target, encrypted.zip, T0, 'wrong-password'), /archive_decrypt_failed/);
  const changed = Buffer.from(encrypted.zip); changed[changed.length - 1]! ^= 1;
  await assert.rejects(stageImport(target, changed, T0, 'fixture-long-password'), /archive_decrypt_failed/);
  assert.deepEqual(await readdir(target), []);
  const preview = await previewData(encrypted.zip, 'fixture-long-password');
  assert.equal(preview.summary.encrypted, true);
  await stageImport(target, encrypted.zip, T0, 'fixture-long-password');
  await applyPendingImport(target);
  assert.deepEqual(await tree(target), DATA);
});

test('the generated-archive collector refuses oversized output at the same byte boundary used for uploads', async () => {
  const { Readable } = await import('node:stream');
  assert.equal((await boundedBuffer(Readable.from([Buffer.alloc(6), Buffer.alloc(4)]), 10)).length, 10);
  await assert.rejects(boundedBuffer(Readable.from([Buffer.alloc(6), Buffer.alloc(5)]), 10), /archive_too_large/);
});

test('restore requires a matching preview and an idle host, including tasks started during staging', async () => {
  const { installDataRoutes } = await import('../src/data/index.js');
  const routes = new Map<string, (request: Request) => Promise<Response>>();
  const ctx = { connection: { fetch: { register(route: { path: string; fetch(request: Request): Promise<Response> }) { routes.set(route.path, route.fetch); } } }, sessionPersistence: { async flush() {} } } as never;
  const target = await home(DATA), zip = (await exportSelectedData(target, { now: T0 })).zip;
  let checks = 0, busyAfter = Infinity, restarts = 0;
  installDataRoutes({ ctx, home: target, importEnabled: true, isIdle: () => ++checks < busyAfter, restart: () => { restarts++; return true; } });
  const post = (digest = '') => routes.get('/api/nexus-data/import')!(new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Nexus-Preview': digest }, body: new Uint8Array(zip) }));
  assert.equal((await (await post()).json() as any).error.code, 'preview_required');
  const previewResponse = await routes.get('/api/nexus-data/preview')!(new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: new Uint8Array(zip) }));
  const preview = (await previewResponse.json() as any).value;
  assert.equal((await readdir(target)).includes(STAGING_DIR), false);
  checks = 0; busyAfter = 1;
  assert.equal((await (await post(preview.digest)).json() as any).error.code, 'tasks_running');
  checks = 0; busyAfter = 3;
  assert.equal((await (await post(preview.digest)).json() as any).error.code, 'tasks_running');
  assert.equal((await readdir(target)).includes(PENDING_FILE), false);
  assert.equal((await readdir(target)).includes(STAGING_DIR), false);
  assert.equal(restarts, 0);
});
