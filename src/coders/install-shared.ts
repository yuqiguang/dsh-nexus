import type { CoderKind } from './types.js';

// Shared with the standalone download worker: no DSH runtime dependencies.
/** Recommended versions verified with the adapters; users may pin another exact release. */
export const MANAGED_PACKAGES: Record<CoderKind, { name: string; version: string }> = {
  // 0.155.0-alpha and 0.155.0 fail to build the bubblewrap sandbox when Docker leaves `net:[…]` nsfs mounts in mountinfo (WSL, 2026-09-20); 0.155.1 handles them.
  codex: { name: '@openai/codex', version: '0.155.1' },
  claude: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.273' },
};

/** Exact releases only: no tags, ranges, URLs, or build metadata (Codex adds a platform suffix). */
export function isManagedVersion(value: unknown, maxLength = 96): value is string {
  if (typeof value !== 'string' || value.length > maxLength) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return !!match && match[0] === value && match.slice(1, 4).every(part => Number.isSafeInteger(Number(part)))
    && (!match[4] || match[4].split('.').every(part => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0')));
}

const PUBLIC_NPM_REGISTRIES = new Set(['registry.npmjs.org', 'registry.npmmirror.com', 'registry.yarnpkg.com']);

export function safeDownloadUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const path = decodeURIComponent(url.pathname);
    // Only retain standard public registry package paths. Custom mirrors/CDNs may
    // put signatures in the path itself, so their origin is the useful safe part.
    const publicPath = PUBLIC_NPM_REGISTRIES.has(url.hostname) && !url.port
      && /^\/(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/-\/[a-z0-9][a-z0-9._-]*\.tgz)?\/?$/.test(path);
    return url.origin + (publicPath ? path : path === '/' ? '/' : '/[路径已隐藏]')
      + (url.search || url.hash ? ' [参数已隐藏]' : '')
      + (url.username || url.password ? ' [认证信息已隐藏]' : '');
  } catch { return '[下载地址已隐藏]'; }
}

