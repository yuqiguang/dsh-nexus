import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

/** Loopback-only, unauthenticated liveness and state summary for the health check; nothing here is a secret. */
export const HEALTH_PATH = '/nexus-health';
/** Loopback-only: the updater tells the user through the running service when an update did not happen. */
export const NOTICE_PATH = '/nexus-health/notice';

export interface HealthChannel { channel: string; enabled: boolean; phase: string; error?: string; pendingDeliveries?: number }
export interface HealthSnapshot {
  ok: true;
  startedAt: number;
  now: number;
  uptimeMs: number;
  channels: HealthChannel[];
  coders: { active: string[] };
  heldPushes: number;
  /** Turns whose end has not been seen: the model is working or waiting on the user. */
  runningTurns: number;
  /** Time since the last session event (or the start), so the updater restarts only a quiet service. */
  idleMs: number;
  /** Git commit the running build was made from; absent for a build outside a checkout. */
  commit?: string;
}

export interface HealthSources {
  startedAt: number;
  channels(): Promise<HealthChannel[]>;
  coders(): string[];
  heldPushes(): number;
  runningTurns?(): number;
  lastActivityAt?(): number;
  commit?: string;
  /** Deliver a notice to every bound chat; `false` when none is bound. */
  notify?(text: string, id: string): Promise<boolean>;
  now?: () => number;
}

/** Read `dist/build-info.json`, written by `npm run build`; absent when the file is missing or unreadable. */
export function readBuildInfo(url: URL): { commit?: string; subject?: string; builtAt?: number; dirty?: boolean } | undefined {
  try {
    const info = JSON.parse(readFileSync(url, 'utf8')) as Record<string, unknown>;
    return { ...(typeof info.commit === 'string' ? { commit: info.commit } : {}), ...(typeof info.subject === 'string' ? { subject: info.subject } : {}),
      ...(typeof info.builtAt === 'number' ? { builtAt: info.builtAt } : {}), ...(typeof info.dirty === 'boolean' ? { dirty: info.dirty } : {}) };
  } catch { return undefined; }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

export async function healthSnapshot(sources: HealthSources): Promise<HealthSnapshot> {
  const now = (sources.now ?? Date.now)();
  return { ok: true, startedAt: sources.startedAt, now, uptimeMs: now - sources.startedAt, channels: await sources.channels(),
    coders: { active: sources.coders() }, heldPushes: sources.heldPushes(), runningTurns: sources.runningTurns?.() ?? 0,
    idleMs: Math.max(0, now - (sources.lastActivityAt?.() ?? sources.startedAt)), ...(sources.commit ? { commit: sources.commit } : {}) };
}

const MAX_NOTICE_BYTES = 8 * 1024;

function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('payload too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); } });
    request.on('error', reject);
  });
}

/** `POST /nexus-health/notice` with `{ text, id }` from this machine: the text goes to the bound chats through the usual push path. */
export async function handleNotice(sources: HealthSources, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(body));
  };
  if (!isLoopback(request.socket?.remoteAddress)) { reply(403, { error: 'loopback only' }); return; }
  if (request.method !== 'POST') { reply(405, { error: 'method not allowed' }); return; }
  if (!sources.notify) { reply(501, { error: 'no notifier' }); return; }
  let body: { text?: unknown; id?: unknown };
  try { body = await readJson(request, MAX_NOTICE_BYTES) as typeof body; } catch { reply(400, { error: 'invalid json' }); return; }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const id = typeof body?.id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(body.id) ? body.id : '';
  if (!text || !id) { reply(400, { error: 'text and id are required' }); return; }
  try { reply(200, { delivered: await sources.notify(text, id) }); }
  catch (error) { reply(500, { error: (error as Error)?.message ?? String(error) }); }
}

export async function handleHealth(sources: HealthSources, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const reply = (status: number, body: unknown) => {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(body));
  };
  if (!isLoopback(request.socket?.remoteAddress)) { reply(403, { error: 'loopback only' }); return; }
  if (request.method !== 'GET' && request.method !== 'HEAD') { reply(405, { error: 'method not allowed' }); return; }
  try { reply(200, await healthSnapshot(sources)); }
  catch (error) { reply(500, { ok: false, error: (error as Error)?.message ?? String(error) }); }
}

/** Register the health route where an HTTP listener exists; the desktop carrier has none. */
export function installHealth(ctx: Context, sources: HealthSources): void {
  ctx.inject(['webServer'], hostCtx => {
    hostCtx.effect(() => hostCtx.webServer.register({ kind: 'exact', path: HEALTH_PATH, handler: (request, response) => handleHealth(sources, request, response) }));
    hostCtx.effect(() => hostCtx.webServer.register({ kind: 'exact', path: NOTICE_PATH, handler: (request, response) => handleNotice(sources, request, response) }));
  });
}
