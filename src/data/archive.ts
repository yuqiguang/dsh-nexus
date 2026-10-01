import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import JSZip from 'jszip';
import { parse } from 'yaml';
import { formatLocal } from '../assistant/clock.js';
import { DEFAULT_TIME_ZONE } from '../assistant/settings.js';
import type { RestartReason } from '../service/lifecycle.js';

/**
 * The user's data as one zip: every session log, every native storage domain, the credentials document with
 * its secrets in plain text (the user chose a package that restores without reconnecting anything), and the
 * profile's DSH settings. Attachments and workspace files stay out. An import replaces all of it at once: it is
 * checked and unpacked beside the live data while the service runs, and swapped in by the next start, before
 * DSH opens any of it; what it replaced is kept whole in `replaced-<time>/`.
 */

export const DATA_FORMAT = 'nexus-data';
export const DATA_VERSION = 1;
export const MANIFEST = 'manifest.json';
export const STAGING_DIR = 'import-staging';
export const PENDING_FILE = 'import-pending.json';
/** Largest upload accepted, and the most an archive may unpack to; both far above a year of one person's use. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_DATA_BYTES = 512 * 1024 * 1024;

/** What an archive carries, relative to the DSH home: two directories and two files. */
const DIRECTORIES = ['sessions', 'storages'] as const;
const FILES = ['.credentials.yaml', 'profiles/nexus/cordis.patch.yml'] as const;
export const DATA_ROOTS = [...DIRECTORIES, ...FILES] as const;
/** The user's data proper, replaced as a whole on import even where the archive has none of it. The profile's settings are replaced only by an archive that carries them: without them DSH would start without Nexus. */
const WHOLE = new Set<string>(['sessions', 'storages', '.credentials.yaml']);
/** Derived or transient files that are never exported: a cache DSH rebuilds, backups of rejected records, temporaries, locks. */
const SKIP = [/^storages\/session_projcache(\/|$)/, /\.bak\.[^/]*$/, /\.tmp$/, /\.lock$/];

export interface ManifestFile { path: string; size: number; sha256: string }
export interface DataManifest {
  format: typeof DATA_FORMAT;
  version: typeof DATA_VERSION;
  createdAt: number;
  dshVersion?: string;
  commit?: string;
  files: ManifestFile[];
}
export interface DataSummary { createdAt: number; dshVersion?: string; commit?: string; sessions: number; records: number; credentials: number; bytes: number }
export interface PendingImport { stagedAt: number; replacedDir: string; summary: DataSummary }

export class DataError extends Error {
  constructor(readonly code: string) { super(code); }
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const posixPath = (path: string) => path.split(sep).join('/');

/** Whether an archive path is one this format may carry: under a data root, relative, with no `..` or empty segment. */
export function allowedPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const segments = path.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false;
  if (SKIP.some(pattern => pattern.test(path))) return false;
  return (FILES as readonly string[]).includes(path) || DIRECTORIES.some(root => path.startsWith(`${root}/`));
}

/** Every regular file under the data roots, as archive paths; links are not followed, so nothing outside the home is read. */
async function dataFiles(home: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (absolute: string): Promise<void> => {
    let info;
    try { info = await lstat(absolute); } catch { return; }
    const path = posixPath(relative(home, absolute));
    if (info.isDirectory()) {
      for (const name of (await readdir(absolute)).sort()) await walk(join(absolute, name));
    } else if (info.isFile() && allowedPath(path)) found.push(path);
  };
  for (const root of DATA_ROOTS) await walk(join(home, ...root.split('/')));
  return found;
}

/** Build the archive from the DSH home. The caller flushes live sessions first. */
export async function exportData(home: string, meta: { now: number; dshVersion?: string; commit?: string }): Promise<{ zip: Buffer; summary: DataSummary }> {
  const zip = new JSZip();
  const files: ManifestFile[] = [];
  let total = 0;
  for (const path of await dataFiles(home)) {
    const bytes = await readFile(join(home, ...path.split('/')));
    total += bytes.length;
    if (total > MAX_DATA_BYTES) throw new DataError('data_too_large');
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
    zip.file(path, bytes, { date: new Date(meta.now) });
  }
  if (!files.some(file => file.path === '.credentials.yaml')) throw new DataError('credentials_missing');
  const manifest: DataManifest = { format: DATA_FORMAT, version: DATA_VERSION, createdAt: meta.now,
    ...(meta.dshVersion ? { dshVersion: meta.dshVersion } : {}), ...(meta.commit ? { commit: meta.commit } : {}), files };
  zip.file(MANIFEST, JSON.stringify(manifest, null, 2), { date: new Date(meta.now) });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { zip: bytes, summary: summarize(manifest, await credentialCount(await readFile(join(home, '.credentials.yaml'), 'utf8'))) };
}

function summarize(manifest: DataManifest, credentials: number): DataSummary {
  const sessions = new Set(manifest.files.flatMap(file => /^sessions\/[^/]+\/[^/]+\//.test(file.path) ? [file.path.split('/').slice(0, 3).join('/')] : []));
  return { createdAt: manifest.createdAt, ...(manifest.dshVersion ? { dshVersion: manifest.dshVersion } : {}), ...(manifest.commit ? { commit: manifest.commit } : {}),
    sessions: sessions.size, records: manifest.files.filter(file => file.path.startsWith('storages/') && file.path.endsWith('.json')).length,
    credentials, bytes: manifest.files.reduce((sum, file) => sum + file.size, 0) };
}

/** How many records the credentials document holds; throws when it is not one. */
async function credentialCount(text: string): Promise<number> {
  let document: unknown;
  try { document = parse(text); } catch { throw new DataError('credentials_invalid'); }
  const records = (document as { version?: unknown; records?: unknown } | null)?.records;
  if ((document as { version?: unknown } | null)?.version !== 1 || !records || typeof records !== 'object' || Array.isArray(records)) throw new DataError('credentials_invalid');
  return Object.keys(records).length;
}

function parseManifest(text: string | undefined): DataManifest {
  let manifest: DataManifest;
  try { manifest = JSON.parse(text ?? '') as DataManifest; } catch { throw new DataError('manifest_invalid'); }
  if (manifest?.format !== DATA_FORMAT) throw new DataError('not_a_nexus_archive');
  if (manifest.version !== DATA_VERSION) throw new DataError('archive_version_unsupported');
  if (!Number.isSafeInteger(manifest.createdAt) || !Array.isArray(manifest.files)) throw new DataError('manifest_invalid');
  const seen = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (typeof file?.path !== 'string' || !allowedPath(file.path) || seen.has(file.path)) throw new DataError('archive_path_rejected');
    if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new DataError('manifest_invalid');
    seen.add(file.path);
    total += file.size;
  }
  if (total > MAX_DATA_BYTES) throw new DataError('data_too_large');
  if (!seen.has('.credentials.yaml')) throw new DataError('credentials_missing');
  return manifest;
}

/**
 * Check an uploaded archive and unpack it beside the live data, for the next start to swap in. Nothing live is
 * touched. Every entry must be listed in the manifest with its size and hash, and every listed file present;
 * the credentials document must be one. A second upload replaces an earlier staged one.
 */
export async function stageImport(home: string, archive: Buffer, now: number): Promise<PendingImport> {
  if (archive.length > MAX_ARCHIVE_BYTES) throw new DataError('archive_too_large');
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(archive, { checkCRC32: true }); } catch { throw new DataError('archive_unreadable'); }
  const manifest = parseManifest(await zip.file(MANIFEST)?.async('string'));
  const listed = new Map(manifest.files.map(file => [file.path, file]));
  const entries = Object.values(zip.files).filter(entry => !entry.dir && entry.name !== MANIFEST);
  for (const entry of entries) if (!listed.has(entry.name)) throw new DataError('archive_path_rejected');
  if (entries.length !== listed.size) throw new DataError('archive_incomplete');
  const staging = join(home, STAGING_DIR);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  let credentials = 0;
  try {
    for (const entry of entries) {
      const file = listed.get(entry.name)!;
      const bytes = await entry.async('nodebuffer');
      if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new DataError('archive_corrupt');
      if (file.path === '.credentials.yaml') credentials = await credentialCount(bytes.toString('utf8'));
      const target = join(staging, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600 });
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  const pending: PendingImport = { stagedAt: now, replacedDir: `replaced-${stamp(now)}-${randomBytes(3).toString('hex')}`, summary: summarize(manifest, credentials) };
  await writeFile(join(home, PENDING_FILE), JSON.stringify(pending), { mode: 0o600 });
  return pending;
}

/** `20260927-071530`, local to the machine, for the name of the directory the replaced data moves to. */
function stamp(at: number): string {
  const date = new Date(at);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/**
 * Swap a staged import in, before DSH starts. Each data root the archive carries is moved aside into
 * `replacedDir` and the staged one moved into its place. Sessions, storage and credentials the archive has none
 * of are moved aside too, because the import replaces the data as a whole; the profile's settings stay unless
 * the archive brings its own. Safe to run again after a crash part-way: a root already
 * swapped has nothing left in staging and is skipped, and the pending note is removed only at the end.
 * Returns what was imported, or `undefined` when nothing was pending.
 */
export async function applyPendingImport(home: string): Promise<PendingImport | undefined> {
  let pending: PendingImport;
  try { pending = JSON.parse(await readFile(join(home, PENDING_FILE), 'utf8')) as PendingImport; } catch { return undefined; }
  if (typeof pending?.replacedDir !== 'string' || !/^replaced-[0-9a-z-]+$/.test(pending.replacedDir)) {
    await rm(join(home, PENDING_FILE), { force: true });
    throw new DataError('pending_import_invalid');
  }
  const staging = join(home, STAGING_DIR);
  const replaced = join(home, pending.replacedDir);
  const exists = async (path: string) => { try { await lstat(path); return true; } catch { return false; } };
  if (!await exists(staging)) { await rm(join(home, PENDING_FILE), { force: true }); return undefined; }
  await mkdir(replaced, { recursive: true, mode: 0o700 });
  for (const root of DATA_ROOTS) {
    const parts = root.split('/');
    const live = join(home, ...parts);
    const staged = join(staging, ...parts);
    const kept = join(replaced, ...parts);
    const incoming = await exists(staged);
    // Already swapped on an earlier, interrupted run: the live copy is the imported one.
    if (!incoming && await exists(kept)) continue;
    if (!incoming && !WHOLE.has(root)) continue;
    if (await exists(live)) {
      await mkdir(dirname(kept), { recursive: true, mode: 0o700 });
      await rename(live, kept);
    }
    if (incoming) {
      await mkdir(dirname(live), { recursive: true, mode: 0o700 });
      await rename(staged, live);
    }
  }
  const credentials = join(home, '.credentials.yaml');
  if (await exists(credentials)) await chmod(credentials, 0o600);
  await rm(staging, { recursive: true, force: true });
  await rm(join(home, PENDING_FILE), { force: true });
  return pending;
}

/** What the start after an import tells the bound chats, through the same note the updater and the health check leave. */
export function importedReason(pending: PendingImport, now: number, timeZone = DEFAULT_TIME_ZONE): RestartReason {
  const { summary } = pending;
  return { at: now, kind: 'import', reason: `导入了 ${formatLocal(summary.createdAt, timeZone)} 导出的数据（${summary.sessions} 个会话、${summary.records} 条存储记录、${summary.credentials} 条凭据），原来的数据在 .nexus/${pending.replacedDir}` };
}
