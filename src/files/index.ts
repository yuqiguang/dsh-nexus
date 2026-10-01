import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { randomBytes } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { formatLocal, localDate } from '../assistant/clock.js';
import { INBOX_DIR, formatBytes } from '../channels/inbox.js';
import { rank } from '../memory/search.js';

/**
 * One file that crossed the channel: sent in by the user (`inbound`, saved
 * under inbox/) or delivered to the user (`outbound`, presented from the
 * workspace). `request` is what the user asked in that turn and `note` the
 * assistant's reply, so a later "那个合同" or "上周做的预算表" can be found
 * by what it was about, not only by name.
 */
export interface FileRecord {
  id: string; kind: 'inbound' | 'outbound'; path: string; name: string; bytes: number; at: number;
  sessionId?: string; request?: string; note?: string;
}

const recordSchema = z.object({ id: z.string(), kind: z.enum(['inbound', 'outbound']), path: z.string(), name: z.string(), bytes: z.number(), at: z.number(),
  sessionId: z.string().optional(), request: z.string().optional(), note: z.string().optional() });

export const filesDomain = defineDomain({
  name: 'nexus_files',
  version: 1,
  layout: 'per-record',
  tables: { files: domainTable<string, FileRecord>(recordSchema) },
});

export type FilesDomain = Domain<typeof filesDomain>;
export interface FilesDomainOpener { open(spec: typeof filesDomain): Promise<FilesDomain> }

/** How much of the request and reply is kept per file; enough to recognise the task, not a transcript. */
export const LEDGER_LIMITS = { requestChars: 200, noteChars: 160, records: 5000 };
/** Directories `file_find` scans for names the ledger does not know (files the model wrote but never presented). */
export const SCANNED_DIRS = [INBOX_DIR, 'outputs'];

export interface FileLedgerEntry { kind: FileRecord['kind']; path: string; name: string; bytes: number; sessionId?: string; request?: string; note?: string }

const clip = (text: string | undefined, max: number) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export class FileLedger {
  private constructor(private readonly domain: FilesDomain, private readonly now: () => number, private readonly timeZone: () => string) {}

  static async open(opener: FilesDomainOpener, now: () => number = Date.now, timeZone: () => string = () => 'Asia/Shanghai'): Promise<FileLedger> {
    return new FileLedger(await opener.open(filesDomain), now, timeZone);
  }

  /** Records a file; the same path recorded again in the same turn (a redelivered message) updates the entry instead of duplicating it. */
  async record(entry: FileLedgerEntry): Promise<FileRecord> {
    const table = this.domain.table('files');
    const at = this.now();
    const existing = [...table.entries()].map(([, record]) => record)
      .find(record => record.kind === entry.kind && record.path === entry.path && record.sessionId === entry.sessionId && record.request === clip(entry.request, LEDGER_LIMITS.requestChars));
    const record: FileRecord = { id: existing?.id ?? `f-${randomBytes(4).toString('hex')}`, kind: entry.kind, path: entry.path, name: entry.name, bytes: entry.bytes, at: existing?.at ?? at,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(clip(entry.request, LEDGER_LIMITS.requestChars) ? { request: clip(entry.request, LEDGER_LIMITS.requestChars) } : {}),
      ...(clip(entry.note, LEDGER_LIMITS.noteChars) ? { note: clip(entry.note, LEDGER_LIMITS.noteChars) } : {}) };
    await table.put(record.id, record);
    await this.prune();
    return record;
  }

  private async prune(): Promise<void> {
    const table = this.domain.table('files');
    if (table.size <= LEDGER_LIMITS.records) return;
    const oldest = [...table.entries()].map(([, record]) => record).sort((a, b) => a.at - b.at).slice(0, table.size - LEDGER_LIMITS.records);
    for (const record of oldest) await table.delete(record.id);
  }

  list(): FileRecord[] { return [...this.domain.table('files').entries()].map(([, record]) => record).sort((a, b) => b.at - a.at); }

  /** Ledger records matching the words of `query`, newest first among equal scores; an empty query lists the newest. */
  find(query: string, limit: number, date?: string): FileRecord[] {
    const records = this.list().filter(record => !date || localDay(record.at, this.timeZone()).startsWith(date));
    if (!query.trim()) return records.slice(0, limit);
    const items = records.map(record => ({ id: record.id, text: [record.name, record.path, record.request, record.note].filter(Boolean).join(' '), at: record.at }));
    const byId = new Map(records.map(record => [record.id, record]));
    return rank(query, items, this.now()).slice(0, limit).map(({ item }) => byId.get(item.id)!);
  }

  close(): Promise<void> { return this.domain.close(); }
}

/** What the bridge needs; tests fake it in memory. */
export type FileLedgerWriter = Pick<FileLedger, 'record'>;

function localDay(at: number, timeZone: string): string { return localDate(at, timeZone); }

export interface ScannedFile { path: string; name: string; bytes: number; at: number }

/** Files under inbox/ and outputs/ whose name contains every ASCII word of the query (case-insensitive) or any Chinese run of it. */
export async function scanWorkspace(workspace: string, query: string, limit: number): Promise<ScannedFile[]> {
  const needles = query.toLowerCase().split(/[\s,，。、；;]+/).filter(Boolean);
  const found: ScannedFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const name of names) {
      const full = join(dir, name);
      let info; try { info = await stat(full); } catch { continue; }
      if (info.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!info.isFile()) continue;
      const lower = name.toLowerCase();
      if (needles.length && !needles.some(needle => lower.includes(needle))) continue;
      found.push({ path: relative(workspace, full).split(sep).join('/'), name, bytes: info.size, at: info.mtimeMs });
    }
  };
  for (const dir of SCANNED_DIRS) await walk(join(workspace, dir), 0);
  return found.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface FileFindDeps { ctx: Context; workspace: string; ledger: FileLedger; timeZone?: () => string }

/** The directory the calling session works in, so files are listed from where the model reads them. */
function cwdOf(exec: ToolRunContext, deps: FileFindDeps): string {
  return exec.agent?.session.header.cwd ?? deps.workspace;
}

/** Renders one list for the model: ledger hits first, then files on disk the ledger does not mention. */
export async function findFiles(deps: FileFindDeps, query: string, limit = 10, date?: string): Promise<string> {
  const zone = deps.timeZone ?? (() => 'Asia/Shanghai');
  const hits = deps.ledger.find(query, limit, date);
  const known = new Set(hits.map(hit => hit.path));
  const scanned = (await scanWorkspace(deps.workspace, query, limit)).filter(file => !known.has(file.path))
    .filter(file => !date || localDay(file.at, zone()).startsWith(date));
  const lines = hits.map(hit => `${formatLocal(hit.at, zone())} ${hit.kind === 'inbound' ? '收到' : '发出'} ${hit.path}（${formatBytes(hit.bytes)}）${hit.request ? `，当时的事：${hit.request}` : ''}${hit.note ? `，回复：${hit.note}` : ''}`);
  const extra = scanned.slice(0, Math.max(limit - lines.length, 0)).map(file => `${formatLocal(file.at, zone())} 工作区 ${file.path}（${formatBytes(file.bytes)}），没有收发记录`);
  if (lines.length === 0 && extra.length === 0) return `没有找到和“${query}”相关的文件${date ? `（${date}）` : ''}。可以换个关键词、给个日期，或问用户是哪一个。`;
  return [...lines, ...extra].join('\n');
}

export function installFileFind(deps: FileFindDeps): void {
  const { ctx } = deps;
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'file_find',
    description: '查用户之前发来的文件和你发给用户的文件。按文件名、当时的事（用户当时的要求）、日期查，返回路径和当时的记录，新的在前。用户说“上次那个合同”“上周做的预算表”“把之前的报告再发我”这类话，且当前对话最近没有提到具体文件时先调用它；找到多个候选就列给用户问是哪一个，不要猜。也会列出工作区里名字匹配但没有收发记录的文件。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词：文件名的一部分、当时的事、类型（如“合同”“预算 xlsx”）。留空则列最近的。' },
      date: { type: 'string', description: '限定日期，YYYY-MM-DD，或 YYYY-MM 限定整月。' },
      limit: { type: 'number', description: '最多返回几条，默认 10，最多 30。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      // A channel works in its own directory, so the scan follows the session rather than the boot-time one.
      return { text: await findFiles({ ...deps, workspace: cwdOf(exec, deps) }, args.query, Math.min(Math.max(args.limit ?? 10, 1), 30), args.date?.trim() || undefined) };
    },
  })));
}
