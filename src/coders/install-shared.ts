import type { CoderKind } from './types.js';

// Shared with the standalone download worker: no DSH runtime dependencies.
/** Versions Nexus installs for itself; bump deliberately and rerun the adapter tests. */
export const MANAGED_PACKAGES: Record<CoderKind, { name: string; version: string }> = {
  // 0.155.0-alpha and 0.155.0 fail to build the bubblewrap sandbox when Docker leaves `net:[…]` nsfs mounts in mountinfo (WSL, 2026-09-20); 0.155.1 handles them.
  codex: { name: '@openai/codex', version: '0.155.1' },
  claude: { name: '@anthropic-ai/claude-agent-sdk', version: '0.3.273' },
};

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

