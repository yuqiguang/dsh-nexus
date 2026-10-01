import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { MANAGED_PACKAGES, isManagedVersion, safeDownloadUrl } from './install-shared.js';

export interface DownloadProgress {
  package: string;
  state: 'connecting' | 'downloading' | 'cached' | 'retrying' | 'verified';
  bytes: number;
  total?: number;
  bytesPerSecond: number;
  attempt: number;
  source?: string;
}

interface Response {
  body: Readable;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export interface RegistryFetch {
  (url: string, options: Record<string, unknown>): Promise<Response>;
  pickRegistry(spec: string, options: Record<string, unknown>): string;
}

const require = createRequire(import.meta.url);

/** Use npm's public configuration package, including scoped auth, proxies and CA files. */
export async function npmDownloadOptions(npmPath: string, args: string[], cwd = process.cwd()): Promise<Record<string, unknown>> {
  const Config = require('@npmcli/config');
  const definitions = require('@npmcli/config/lib/definitions');
  const config = new Config({ ...definitions, npmPath, cwd, argv: [process.execPath, 'npm', ...args] });
  await config.load();
  return { ...config.flat, preferOffline: true, preferOnline: false };
}

/** Only prefetch exact managed package pins; npm continues to resolve other dependencies. */
export function downloadTargets(dependencies: Record<string, string>): { name: string; version: string }[] {
  const targets: { name: string; version: string }[] = [];
  for (const [name, spec] of Object.entries(dependencies)) {
    if (!Object.values(MANAGED_PACKAGES).some(pkg => name === pkg.name || name.startsWith(pkg.name + '-'))) continue;
    const alias = /^npm:(@[^/]+\/[^@]+)@(.+)$/.exec(spec);
    const source = alias?.[1] ?? name, version = alias?.[2] ?? spec;
    if (!/^@[a-z0-9._-]+\/[a-z0-9._-]+$/.test(source) || !isManagedVersion(version, 128)) continue;
    targets.push({ name: source, version });
  }
  return targets;
}

/** Stream verified tarballs into the normal npm cache, without unpacking or executing them. */
export async function downloadPackages(dependencies: Record<string, string>, options: Record<string, unknown>,
  report: (progress: DownloadProgress) => void,
  fetch: RegistryFetch = require('npm-registry-fetch'), now: () => number = Date.now, intervalMs = 1000): Promise<void> {
  for (const target of downloadTargets(dependencies)) {
    const label = `${target.name}@${target.version}`;
    let progress: DownloadProgress = { package: label, state: 'connecting', bytes: 0, bytesPerSecond: 0, attempt: 1 };
    report({ ...progress });
    const registry = fetch.pickRegistry(label, options);
    const metadataUrl = `${registry.replace(/\/$/, '')}/${target.name.replace('/', '%2f')}/${target.version}`;
    const metadata = await (await fetch(metadataUrl, { ...options, registry, timeout: 30_000 })).json() as
      { name?: string; version?: string; dist?: { tarball?: string; integrity?: string } };
    const dist = metadata.dist;
    if (metadata.name !== target.name || metadata.version !== target.version || !dist?.tarball
      || !/^https?:$/.test(new URL(dist.tarball).protocol) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(dist.integrity ?? '')) {
      throw new Error('download_manifest_invalid');
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      progress = { package: label, state: attempt === 1 ? 'connecting' : 'retrying', bytes: 0, bytesPerSecond: 0, attempt, source: safeDownloadUrl(dist.tarball) };
      report({ ...progress });
      let timer: NodeJS.Timeout | undefined;
      let fromCache = false;
      try {
        // npm-registry-fetch verifies integrity and commits a cache entry only on success.
        // Its body timeout must allow a large package on a slow but active connection.
        // Existing npm/pacote caches may have only a digest entry, without an HTTP
        // URL entry. Reuse those too, and let cacache verify the bytes on read.
        const cache = require('cacache');
        const hit = typeof options.cache === 'string' && await cache.get.hasContent(options.cache, dist.integrity);
        fromCache = !!hit;
        const response: Response = hit ? {
          body: cache.get.stream.byDigest(options.cache, dist.integrity), json: async () => undefined,
          headers: { get: name => name === 'content-length' ? String(hit.size) : name === 'x-local-cache-status' ? 'hit' : null },
        } : await fetch(dist.tarball, { ...options, registry, integrity: dist.integrity, timeout: 60 * 60_000,
          headers: { 'accept-encoding': 'identity' } });
        const length = Number(response.headers.get('content-length'));
        const cached = ['hit', 'stale', 'revalidated'].includes(response.headers.get('x-local-cache-status') ?? '');
        progress.state = cached ? 'cached' : 'downloading';
        if (Number.isSafeInteger(length) && length > 0) progress.total = length;
        let sampledAt = now(), sampledBytes = 0, lastDataAt = sampledAt;
        const sample = () => {
          const at = now(), duration = at - sampledAt;
          progress.bytesPerSecond = cached || duration <= 0 ? 0 : Math.round((progress.bytes - sampledBytes) * 1000 / duration);
          sampledAt = at; sampledBytes = progress.bytes;
          report({ ...progress });
          if (at - lastDataAt >= 90_000) response.body.destroy(new Error('download_stalled'));
        };
        report({ ...progress });
        timer = setInterval(sample, intervalMs);
        timer.unref();
        for await (const chunk of response.body) {
          progress.bytes += Buffer.byteLength(chunk);
          lastDataAt = now();
        }
        if (progress.total !== undefined && progress.bytes !== progress.total) throw new Error('download_incomplete');
        // The stream's completion includes the npm cache's integrity check and flush.
        report({ ...progress, state: 'verified', bytesPerSecond: 0 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
        if (fromCache && ['EINTEGRITY', 'ENOENT'].includes(code) && attempt < 3) {
          await require('cacache').rm.content(options.cache, dist.integrity);
          continue;
        }
        if (attempt === 3 || !['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ERR_STREAM_PREMATURE_CLOSE', 'download_stalled', 'download_incomplete'].includes(code)) throw error;
      } finally { if (timer) clearInterval(timer); }
    }
  }
}
