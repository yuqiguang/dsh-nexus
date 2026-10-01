import JSZip from 'jszip';
import { execFile as execFileCallback } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dualStackFetch } from '../wechat/http.js';

const execFile = promisify(execFileCallback);

/**
 * pandoc downloaded on request, the way the coders' managed install works:
 * one pinned release, the asset for this platform, unpacked into the data
 * directory. Never part of the package.
 */
export const PANDOC_VERSION = '3.11';
const MAX_DOWNLOAD_BYTES = 120 * 1024 * 1024;

export function pandocAsset(platform: NodeJS.Platform, arch: string): { name: string; url: string; archive: 'tar.gz' | 'zip' } | undefined {
  const table: Record<string, string> = { 'linux-x64': 'linux-amd64.tar.gz', 'linux-arm64': 'linux-arm64.tar.gz', 'darwin-x64': 'x86_64-macOS.zip', 'darwin-arm64': 'arm64-macOS.zip', 'win32-x64': 'windows-x86_64.zip' };
  const suffix = table[`${platform}-${arch}`];
  if (!suffix) return undefined;
  const name = `pandoc-${PANDOC_VERSION}-${suffix}`;
  return { name, url: `https://github.com/jgm/pandoc/releases/download/${PANDOC_VERSION}/${name}`, archive: suffix.endsWith('.zip') ? 'zip' : 'tar.gz' };
}

export interface PandocInstallStatus { phase: 'installing' | 'installed' | 'failed'; startedAt: number; finishedAt?: number; error?: string; version?: string; bytes?: number }

export interface PandocInstallerDeps {
  managedRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Test seam: a different release host. */
  assetUrl?: (asset: { name: string }) => string;
}

/** Follow up to five redirects by hand: GitHub sends release assets through a second host. */
async function download(fetchImpl: typeof fetch, url: string, target: string, onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetchImpl(current, { redirect: 'manual', signal, headers: { 'user-agent': 'nexus-next' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`下载地址重定向但没有目标（HTTP ${response.status}）。`);
      await response.body?.cancel().catch(() => {});
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status !== 200 || !response.body) throw new Error(`下载失败：HTTP ${response.status}。`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_DOWNLOAD_BYTES) throw new Error('下载文件超过预期大小。');
    const file = createWriteStream(target);
    let total = 0;
    try {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) throw new Error('下载文件超过预期大小。');
        if (!file.write(chunk)) await new Promise<void>(resolve => file.once('drain', resolve));
        onBytes(total);
      }
    } finally { await new Promise<void>(resolve => file.end(resolve)); }
    return;
  }
  throw new Error('下载地址重定向次数过多。');
}

async function findBinary(root: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = await findBinary(path, name); if (found) return found; }
  }
  return undefined;
}

export class PandocInstaller {
  private current?: PandocInstallStatus;
  private running?: Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: PandocInstallerDeps) { this.now = deps.now ?? Date.now; }

  status(): PandocInstallStatus | undefined { return this.current ? { ...this.current } : undefined; }

  get binary(): string { return join(this.deps.managedRoot, 'pandoc', 'bin', (this.deps.platform ?? process.platform) === 'win32' ? 'pandoc.exe' : 'pandoc'); }

  /** Start an install; returns at once, the status tells the page how it went. */
  install(signal?: AbortSignal): Promise<void> {
    if (this.running) return this.running;
    this.current = { phase: 'installing', startedAt: this.now() };
    this.running = this.run(signal ?? new AbortController().signal)
      .then(() => { Object.assign(this.current!, { phase: 'installed', finishedAt: this.now(), version: PANDOC_VERSION }); })
      .catch(error => { Object.assign(this.current!, { phase: 'failed', finishedAt: this.now(), error: (error as Error)?.message ?? String(error) }); })
      .finally(() => { this.running = undefined; });
    return this.running;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const platform = this.deps.platform ?? process.platform;
    const asset = pandocAsset(platform, this.deps.arch ?? process.arch);
    if (!asset) throw new Error(`没有适用于 ${platform}/${this.deps.arch ?? process.arch} 的 pandoc 发行包。`);
    const work = await mkdtemp(join(tmpdir(), 'nexus-pandoc-'));
    try {
      const archive = join(work, asset.name);
      await download(this.deps.fetch ?? dualStackFetch, this.deps.assetUrl ? this.deps.assetUrl(asset) : asset.url, archive, bytes => { if (this.current) this.current.bytes = bytes; }, signal);
      const unpacked = join(work, 'unpacked');
      await mkdir(unpacked, { recursive: true });
      signal.throwIfAborted();
      if (asset.archive === 'tar.gz') await execFile('tar', ['-xzf', archive, '-C', unpacked], { timeout: 120_000, signal });
      else await unzip(archive, unpacked);
      const name = platform === 'win32' ? 'pandoc.exe' : 'pandoc';
      const binary = await findBinary(unpacked, name);
      if (!binary) throw new Error('发行包里没有 pandoc 可执行文件。');
      const dir = join(this.deps.managedRoot, 'pandoc', 'bin');
      await mkdir(dir, { recursive: true });
      signal.throwIfAborted();
      const target = join(dir, name);
      await rm(target, { force: true });
      try { await rename(binary, target); }
      catch { const { copyFile } = await import('node:fs/promises'); await copyFile(binary, target); }
      if (platform !== 'win32') await chmod(target, 0o755);
      await stat(target);
    } finally { await rm(work, { recursive: true, force: true }); }
  }
}

async function unzip(archive: string, into: string): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises');
  const zip = await JSZip.loadAsync(await readFile(archive));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || name.includes('..')) continue;
    const path = join(into, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, await entry.async('nodebuffer'));
  }
}
