import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError, MAX_ARCHIVE_BYTES, PENDING_FILE, STAGING_DIR, exportData, previewData, stageImport, type DataSummary, type PendingImport } from './archive.js';
import { discardStagedImport, type DesktopRestore, type DesktopRestoreStatus } from './desktop.js';

export interface DataRoutesDeps {
  ctx: Context;
  /** The DSH home the data lives in. */
  home: string;
  now?: () => number;
  /** True only when a launcher applies staged imports before DSH opens its storage. */
  importEnabled?: boolean;
  desktopRestore?: DesktopRestore;
  isIdle?: () => boolean;
  dshVersion?: string;
  commit?: string;
  /** Restart the service so the next start swaps a staged import in; `false` where this process cannot restart itself. */
  restart(): boolean;
  report?: (message: string) => void;
}

export interface ImportResult { pending: PendingImport; restarting: boolean; desktop?: DesktopRestoreStatus }

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (code: string, status = 200) => json({ ok: false, error: { code } }, status);

/** The request's body, refused once it grows past `limit` bytes instead of being read to the end. */
async function readLimited(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new DataError('archive_too_large');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new DataError('archive_too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Read and drop the body of a streamed request that is refused before it is used: answering while the client is
 * still sending makes the carrier drop the connection, and the client sees a network error instead of the refusal.
 */
async function refuse(request: Request, response: Response): Promise<Response> {
  await readLimited(request, MAX_ARCHIVE_BYTES).catch(() => {});
  return response;
}

/**
 * `POST /api/nexus-data/export` answers the whole data archive as a download; `POST /api/nexus-data/import` takes
 * one, stages it and restarts the service so the next start swaps it in. Both sit on the shared `/api` carrier, so
 * they need the login; each insists on its own content type, which a page on another site cannot send without a
 * preflight the carrier does not grant.
 */
export function installDataRoutes(deps: DataRoutesDeps): void {
  const { ctx } = deps;
  const now = deps.now ?? Date.now;
  const report = deps.report ?? (() => {});
  let importing = false;
  ctx.connection.fetch.register({ path: '/api/nexus-data/capabilities', methods: ['GET'], requestBody: 'buffered',
    async fetch() { return json({ importEnabled: deps.importEnabled === true || !!deps.desktopRestore,
      ...(deps.desktopRestore ? { importMode: 'desktop' } : {}) }); } });
  ctx.connection.fetch.register({ path: '/api/nexus-data/restore-status', methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      try { return json({ ok: true, value: await deps.desktopRestore?.status() ?? null }); }
      catch { return failure('restore_state_invalid'); }
    } });
  ctx.connection.fetch.register({ path: '/api/nexus-data/restore-cancel', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/json') return new Response('unsupported content type', { status: 415 });
      try {
        const input = JSON.parse((await readLimited(request, 4096)).toString());
        if (!deps.desktopRestore || typeof input?.id !== 'string') throw new DataError('restore_not_waiting');
        await deps.desktopRestore.cancel(input.id);
        return json({ ok: true });
      } catch (error) { return failure(error instanceof DataError ? error.code : 'restore_not_waiting'); }
    } });
  ctx.connection.fetch.register({
    path: '/api/nexus-data/export', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('content type must be application/json', { status: 415 });
      if (importing) return failure('import_in_progress');
      importing = true;
      try {
        if (deps.isIdle?.() === false) throw new DataError('tasks_running');
        let options;
        try { options = JSON.parse((await readLimited(request, 4096)).toString() || '{}'); } catch { throw new DataError('invalid_options'); }
        if (!options || typeof options !== 'object' || Array.isArray(options)
          || (options.includeCredentials !== undefined && typeof options.includeCredentials !== 'boolean')
          || (options.includeSettings !== undefined && typeof options.includeSettings !== 'boolean')
          || (options.password !== undefined && (typeof options.password !== 'string' || options.password.length > 1024))) throw new DataError('invalid_options');
        if ((options.includeCredentials || options.password) && (!options.password || options.password.length < 10)) throw new DataError('archive_password_weak');
        // Every live session's buffered events reach its log before the logs are read.
        await ctx.sessionPersistence.flush();
        const at = now();
        const { zip, summary } = await exportData(deps.home, { now: at, ...(deps.dshVersion ? { dshVersion: deps.dshVersion } : {}), ...(deps.commit ? { commit: deps.commit } : {}) },
          { includeCredentials: options.includeCredentials === true, includeSettings: options.includeSettings === true, password: options.password });
        if (deps.isIdle?.() === false) throw new DataError('tasks_running');
        return new Response(new Uint8Array(zip), { headers: { 'Content-Type': 'application/zip', 'Content-Length': String(zip.length), 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="nexus-data-${new Date(at).toISOString().slice(0, 10)}.${options.password ? 'nxb' : 'zip'}"`, 'X-Nexus-Summary': encodeURIComponent(JSON.stringify(summary satisfies DataSummary)) } });
      } catch (error) {
        report(`data export failed: ${error instanceof DataError ? error.code : 'export_failed'}`);
        return failure(error instanceof DataError ? error.code : 'export_failed', 500);
      } finally { importing = false; }
    },
  });
  const password = (request: Request) => {
    try {
      const value = decodeURIComponent(request.headers.get('x-nexus-archive-password') ?? '');
      if (value.length > 1024) throw new Error();
      return value;
    } catch { throw new DataError('invalid_options'); }
  };
  ctx.connection.fetch.register({ path: '/api/nexus-data/preview', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/zip') return refuse(request, new Response('unsupported content type', { status: 415 }));
      if (importing) return refuse(request, failure('import_in_progress'));
      importing = true;
      try { return json({ ok: true, value: await previewData(await readLimited(request, MAX_ARCHIVE_BYTES), password(request)) }); }
      catch (error) { return failure(error instanceof DataError ? error.code : 'import_failed'); }
      finally { importing = false; }
    } });
  ctx.connection.fetch.register({
    path: '/api/nexus-data/import', methods: ['POST'], requestBody: 'streaming',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/zip') return refuse(request, new Response('content type must be application/zip', { status: 415 }));
      if (!deps.importEnabled && !deps.desktopRestore) return refuse(request, failure('import_unavailable', 409));
      if (importing) return refuse(request, failure('import_in_progress'));
      importing = true;
      try {
        // The updater swaps builds and restarts on its own schedule; an import must not race it.
        if (await access(join(deps.home, 'update.lock')).then(() => true, () => false)) return await refuse(request, failure('update_in_progress'));
        if (deps.isIdle?.() === false) return await refuse(request, failure('tasks_running'));
        const archive = await readLimited(request, MAX_ARCHIVE_BYTES), secret = password(request);
        const preview = await previewData(archive, secret);
        if (request.headers.get('x-nexus-preview') !== preview.digest) throw new DataError('preview_required');
        if (deps.desktopRestore) {
          if (preview.summary.dshVersion !== deps.dshVersion) throw new DataError('desktop_restore_version_mismatch');
          if (preview.summary.roots?.some(root => root.startsWith('profiles/'))) throw new DataError('desktop_restore_profile_mismatch');
          const previous = await deps.desktopRestore.status();
          if (previous && !['completed', 'cancelled', 'rolled-back'].includes(previous.phase)) throw new DataError('import_in_progress');
        }
        if (deps.isIdle?.() === false) throw new DataError('tasks_running');
        const pending = await stageImport(deps.home, archive, now(), secret);
        if (deps.isIdle?.() === false) {
          await rm(join(deps.home, PENDING_FILE), { force: true });
          await rm(join(deps.home, STAGING_DIR), { recursive: true, force: true });
          throw new DataError('tasks_running');
        }
        if (deps.desktopRestore) {
          try {
            const desktop = await deps.desktopRestore.prepare(pending);
            return json({ ok: true, value: { pending: { stagedAt: pending.stagedAt, replacedDir: pending.replacedDir, summary: pending.summary }, restarting: false, desktop } satisfies ImportResult });
          } catch (error) { await discardStagedImport(deps.home); throw error; }
        }
        const restarting = deps.restart();
        report(`data import staged: ${pending.summary.sessions} sessions, ${pending.summary.records} records, ${pending.summary.credentials} credentials${restarting ? '; restarting' : ''}`);
        return json({ ok: true, value: { pending, restarting } satisfies ImportResult });
      } catch (error) {
        if (!(error instanceof DataError)) report('data import failed');
        return failure(error instanceof DataError ? error.code : 'import_failed');
      } finally { importing = false; }
    },
  });
}
