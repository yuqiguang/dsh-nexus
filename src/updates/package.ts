import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ChannelError } from '../channels/types.js';

const REPOSITORY = 'yuqiguang/dsh-nexus';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const DOWNLOAD = `https://github.com/${REPOSITORY}/releases/download`;
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
export const UPDATE_IDLE_MS = 2 * 60 * 1000;
const MAX_PACKAGE = 32 * 1024 * 1024;
export const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function validVersion(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value); }
export function newerVersion(a: string, b: string): boolean {
  if (!validVersion(a) || !validVersion(b)) return false;
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! > right[i]!;
  return false;
}
export interface UpdatePackage { version: string; sha256: string; commit: string; dshVersion: string; path: string; releaseUrl: string; compatible: boolean }
interface PackageMetadata { version: string; commit: string; dshVersion: string; compatible: boolean }

/** Read only two bounded metadata files; pnpm owns installation and extraction. */
export function inspectPackage(archive: Buffer, expectedVersion: string, dshVersion: string): PackageMetadata {
  let tar: Buffer;
  try { tar = gunzipSync(archive, { maxOutputLength: 128 * 1024 * 1024 }); }
  catch { throw new ChannelError('update_package_invalid'); }
  const metadata = new Map<string, Buffer>(), names = new Set<string>();
  const field = (header: Buffer, from: number, length: number) => header.subarray(from, from + length).toString('utf8').split('\0')[0]!;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const rawSize = field(header, 124, 12).trim();
    const size = /^[0-7]+$/.test(rawSize) ? parseInt(rawSize, 8) : NaN;
    const prefix = field(header, 345, 155), name = `${prefix ? prefix + '/' : ''}${field(header, 0, 100)}`;
    const type = header[156];
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
    if (parseInt(field(header, 148, 8).trim(), 8) !== checksum || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length
      || !name.startsWith('package/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')
      || names.has(name) || ![0, 48, 53].includes(type!)) throw new ChannelError('update_package_invalid');
    names.add(name);
    if (name === 'package/package.json' || name === 'package/dist/build-info.json') {
      if (size > 128 * 1024 || type === 53) throw new ChannelError('update_package_invalid');
      metadata.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  try {
    const pkg = JSON.parse(metadata.get('package/package.json')!.toString('utf8'));
    const build = JSON.parse(metadata.get('package/dist/build-info.json')!.toString('utf8'));
    if (pkg.name !== 'dsh-nexus' || pkg.version !== expectedVersion || !validVersion(pkg.version)
      || pkg.exports?.['.'] !== './dist/src/plugin.js' || pkg.dsh?.bundle?.patch !== './cordis.patch.yml'
      || !names.has('package/dist/src/plugin.js') || !names.has('package/dist/client.js') || !names.has('package/cordis.patch.yml')
      || !/^[a-f0-9]{40}$/.test(build.commit) || build.dirty !== false
      || ['preinstall', 'install', 'postinstall', 'prepare'].some(key => pkg.scripts?.[key])) throw new Error();
    const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
    if (!peers.length || !peers.every(([, value]) => typeof value === 'string')) throw new Error();
    return { version: pkg.version, commit: build.commit, dshVersion: String(peers[0]![1]), compatible: peers.every(([, value]) => value === dshVersion) };
  } catch { throw new ChannelError('update_package_invalid'); }
}

export class ReleasePackages {
  constructor(private readonly home: string, private readonly dshVersion: string, private readonly transport: typeof fetch = fetch) {}
  private async read(url: string, limit: number, signal: AbortSignal): Promise<Buffer> {
    let response: Response;
    try { response = await this.transport(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { Accept: url.startsWith(API) ? 'application/vnd.github+json' : 'application/octet-stream' } }); }
    catch { throw new ChannelError(signal.aborted ? 'update_cancelled' : 'update_network'); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ChannelError(response.status === 403 || response.status === 429 ? 'update_rate_limited' : response.status === 404 ? 'update_release_missing' : 'update_network');
    }
    if (!response.body) throw new ChannelError('update_network');
    const reader = response.body.getReader(); let length = 0; const parts: Buffer[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        length += value.length;
        if (length > limit) throw new ChannelError('update_package_too_large');
        parts.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(parts);
  }
  async latest(signal: AbortSignal): Promise<string> {
    try {
      const release = JSON.parse((await this.read(`${API}/releases/tags/install`, 1024 * 1024, signal)).toString('utf8'));
      const version = /<!-- nexus-install-source: v([\d.]+) -->/.exec(release.body)?.[1];
      if (release.draft || release.tag_name !== 'install' || !validVersion(version)) throw new ChannelError('update_release_invalid');
      return version;
    } catch (error) { if (error instanceof ChannelError) throw error; throw new ChannelError('update_release_invalid'); }
  }
  async get(version: string, signal: AbortSignal): Promise<UpdatePackage> {
    if (!validVersion(version)) throw new ChannelError('update_release_invalid');
    const filename = `dsh-nexus-${version}.tgz`;
    const base = `${DOWNLOAD}/v${version}`;
    const sums = (await this.read(`${base}/SHA256SUMS`, 64 * 1024, signal)).toString('utf8').trim().split(/\r?\n/)
      .map(line => /^([a-f0-9]{64})[ \t]+\*?(.+)$/.exec(line)).filter(line => line?.[2] === filename);
    if (sums.length !== 1) throw new ChannelError('update_checksum_invalid');
    const hash = sums[0]![1]!;
    const directory = join(this.home, 'nexus-updates', 'packages'), path = join(directory, `${hash}.tgz`);
    let archive: Buffer | undefined = await readFile(path).catch(() => undefined);
    if (!archive || sha256(archive) !== hash) archive = await this.read(`${base}/${filename}`, MAX_PACKAGE, signal);
    if (sha256(archive) !== hash) throw new ChannelError('update_checksum_invalid');
    const meta = inspectPackage(archive, version, this.dshVersion);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path + '.tmp', archive, { mode: 0o600 }); await rename(path + '.tmp', path);
    return { ...meta, sha256: hash, path, releaseUrl: `https://github.com/${REPOSITORY}/releases/tag/v${version}` };
  }
  async verify(pkg: UpdatePackage): Promise<void> {
    const bytes = await readFile(pkg.path).catch(() => { throw new ChannelError('update_package_missing'); });
    if (sha256(bytes) !== pkg.sha256) throw new ChannelError('update_checksum_invalid');
    const meta = inspectPackage(bytes, pkg.version, this.dshVersion);
    if (!meta.compatible || meta.commit !== pkg.commit) throw new ChannelError('update_incompatible');
  }
}
