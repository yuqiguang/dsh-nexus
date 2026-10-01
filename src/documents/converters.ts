import { execFile as execFileCallback, type ExecFileOptions } from 'node:child_process';
import { access, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/**
 * The converters a machine may have. None ships with Nexus: LibreOffice and
 * Word/WPS (through PowerShell COM) are whatever the user installed; pandoc is
 * either on PATH or downloaded on request into the data directory. Detection
 * is cheap (a file exists, a registry key exists) and never launches Office.
 */

export type ConverterKind = 'soffice' | 'pandoc' | 'msoffice' | 'wps' | 'pdftotext' | 'ghostscript';

export interface Converter { kind: ConverterKind; path: string; version?: string }

export interface Runner {
  (file: string, args: string[], options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{ stdout: string; stderr: string }>;
}

export const defaultRunner: Runner = async (file, args, options) => {
  const execOptions: ExecFileOptions & { encoding: 'utf8' } = { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: options.env ?? process.env, windowsHide: true };
  try { return await execFile(file, args, execOptions); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; signal?: string };
    if (failure.killed || failure.signal === 'SIGTERM') throw new Error(`${basename(file)} 超过 ${Math.round(options.timeoutMs / 1000)} 秒没有完成，已中止。`);
    throw new Error((failure.stderr || failure.stdout || failure.message || String(error)).trim().split('\n').slice(-3).join(' '));
  }
};

export interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Where a downloaded pandoc lives. */
  managedRoot: string;
  runner?: Runner;
  exists?: (path: string) => Promise<boolean>;
}

const exists = async (path: string) => { try { await access(path); return true; } catch { return false; } };

async function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, has: (path: string) => Promise<boolean>): Promise<string | undefined> {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    for (const candidate of names) { const full = join(dir, candidate); if (await has(full)) return full; }
  }
  return undefined;
}

const SOFFICE_CANDIDATES: Record<string, string[]> = {
  linux: ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice', '/snap/bin/libreoffice', '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice'],
  darwin: ['/Applications/LibreOffice.app/Contents/MacOS/soffice'],
  win32: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'],
};

/** Everything found, in the order the converter picks them. */
export async function detectConverters(options: DetectOptions): Promise<Converter[]> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const has = options.exists ?? exists;
  const runner = options.runner ?? defaultRunner;
  const found: Converter[] = [];
  const soffice = await onPath('soffice', env, platform, has) ?? await onPath('libreoffice', env, platform, has);
  const sofficePath = soffice ?? (await Promise.all((SOFFICE_CANDIDATES[platform] ?? []).map(async path => (await has(path)) ? path : undefined))).find(Boolean);
  if (sofficePath) found.push({ kind: 'soffice', path: sofficePath });
  const managedPandoc = join(options.managedRoot, 'pandoc', 'bin', platform === 'win32' ? 'pandoc.exe' : 'pandoc');
  const pandoc = (await has(managedPandoc)) ? managedPandoc : await onPath('pandoc', env, platform, has);
  if (pandoc) found.push({ kind: 'pandoc', path: pandoc });
  if (platform === 'win32') {
    const powershell = await onPath('powershell', env, platform, has) ?? 'powershell.exe';
    const query = async (key: string) => { try { await runner('reg.exe', ['query', key, '/ve'], { timeoutMs: 5000, env }); return true; } catch { return false; } };
    if (await query('HKCR\\Word.Application')) found.push({ kind: 'msoffice', path: powershell });
    if (await query('HKCR\\KWPS.Application') || await query('HKCR\\WPS.Application')) found.push({ kind: 'wps', path: powershell });
  }
  const pdftotext = await onPath('pdftotext', env, platform, has);
  if (pdftotext) found.push({ kind: 'pdftotext', path: pdftotext });
  const gs = await onPath(platform === 'win32' ? 'gswin64c' : 'gs', env, platform, has) ?? (platform === 'win32' ? await onPath('gswin32c', env, platform, has) : undefined);
  if (gs) found.push({ kind: 'ghostscript', path: gs });
  return found;
}

export type Format = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html' | 'txt' | 'csv' | 'odt' | 'ods' | 'odp' | 'doc' | 'xls' | 'ppt' | 'rtf';

export const CONVERT_TIMEOUT_MS = 180_000;

/** Which converter can take a source format to a target, in preference order. */
export function routesFor(from: Format, to: Format, available: Converter[]): Converter[] {
  const kinds = new Set(available.map(item => item.kind));
  const order: ConverterKind[] = [];
  const wordFamily = ['docx', 'doc', 'odt', 'rtf', 'html', 'txt', 'md'];
  const sheetFamily = ['xlsx', 'xls', 'ods', 'csv'];
  const deckFamily = ['pptx', 'ppt', 'odp'];
  if (to === 'pdf') {
    if (wordFamily.includes(from) && from !== 'md') order.push('msoffice', 'wps', 'soffice');
    else if (sheetFamily.includes(from) || deckFamily.includes(from)) order.push('msoffice', 'wps', 'soffice');
    else if (from === 'md') order.push('soffice');
  } else if (from === 'md' || to === 'md') {
    if ((from === 'md' && ['docx', 'html', 'odt', 'rtf', 'pptx'].includes(to)) || (to === 'md' && ['docx', 'html', 'odt', 'rtf'].includes(from))) order.push('pandoc');
  } else if (wordFamily.includes(from) && wordFamily.includes(to)) order.push('msoffice', 'wps', 'soffice', 'pandoc');
  else if (sheetFamily.includes(from) && sheetFamily.includes(to)) order.push('msoffice', 'wps', 'soffice');
  else if (deckFamily.includes(from) && deckFamily.includes(to)) order.push('msoffice', 'wps', 'soffice');
  return order.filter(kind => kinds.has(kind)).map(kind => available.find(item => item.kind === kind)!);
}

export interface ConvertRequest { source: string; target: string; from: Format; to: Format }

const FILTERS: Partial<Record<Format, string>> = { pdf: 'pdf', docx: 'docx:"MS Word 2007 XML"', xlsx: 'xlsx:"Calc MS Excel 2007 XML"', pptx: 'pptx:"Impress MS PowerPoint 2007 XML"',
  odt: 'odt', ods: 'ods', odp: 'odp', html: 'html', txt: 'txt:Text', csv: 'csv', doc: 'doc:"MS Word 97"', xls: 'xls:"MS Excel 97"', ppt: 'ppt:"MS PowerPoint 97"', rtf: 'rtf' };

/** LibreOffice headless with its own profile directory, so a LibreOffice the user has open does not swallow the request; one at a time. */
export async function convertWithSoffice(converter: Converter, request: ConvertRequest, runner: Runner, profileRoot: string): Promise<void> {
  const filter = FILTERS[request.to];
  if (!filter) throw new Error(`LibreOffice 不能转成 ${request.to}。`);
  const outDir = await mkdtemp('nexus-convert-');
  try {
    const profile = join(profileRoot, 'soffice-profile');
    await mkdir(profile, { recursive: true });
    const profileUrl = `file://${profile.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`;
    const env = { ...process.env, HOME: process.env.HOME ?? profileRoot };
    await runner(converter.path, [`-env:UserInstallation=${profileUrl}`, '--headless', '--norestore', '--nologo', '--convert-to', filter, '--outdir', outDir, request.source], { timeoutMs: CONVERT_TIMEOUT_MS, env });
    const produced = (await readdir(outDir)).find(name => name.toLowerCase().endsWith(`.${request.to}`));
    if (!produced) throw new Error('LibreOffice 没有产生输出文件，源文件可能损坏或格式不受支持。');
    await mkdir(dirname(request.target), { recursive: true });
    await moveFile(join(outDir, produced), request.target);
  } finally { await rm(outDir, { recursive: true, force: true }); }
}

export async function convertWithPandoc(converter: Converter, request: ConvertRequest, runner: Runner, referenceDoc?: string): Promise<void> {
  const formats: Partial<Record<Format, string>> = { md: 'gfm', docx: 'docx', html: 'html', odt: 'odt', rtf: 'rtf', pptx: 'pptx', txt: 'plain' };
  const from = formats[request.from];
  const to = formats[request.to];
  if (!from || !to) throw new Error(`pandoc 不能把 ${request.from} 转成 ${request.to}。`);
  await mkdir(dirname(request.target), { recursive: true });
  const args = ['-f', from, '-t', to, '--standalone', '-o', request.target, request.source];
  if (referenceDoc && (request.to === 'docx' || request.to === 'pptx')) args.push('--reference-doc', referenceDoc);
  if (request.from === 'docx' && request.to === 'md') args.push('--wrap=none', '--extract-media', join(dirname(request.target), `${basename(request.target, extname(request.target))}-media`));
  await runner(converter.path, args, { timeoutMs: CONVERT_TIMEOUT_MS });
}

/** Word, Excel or PowerPoint (or WPS's equivalents) driven through COM from PowerShell; only on Windows, and only tested through its generated script here. */
export function comScript(app: 'msoffice' | 'wps', request: ConvertRequest): string {
  const family = ['docx', 'doc', 'odt', 'rtf', 'html', 'txt'].includes(request.from) ? 'word' : ['xlsx', 'xls', 'ods', 'csv'].includes(request.from) ? 'excel' : 'powerpoint';
  const progId = app === 'msoffice' ? { word: 'Word.Application', excel: 'Excel.Application', powerpoint: 'PowerPoint.Application' }[family]
    : { word: 'KWPS.Application', excel: 'KET.Application', powerpoint: 'KWPP.Application' }[family];
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const wordFormats: Record<string, number> = { pdf: 17, docx: 16, doc: 0, rtf: 6, txt: 2, html: 8, odt: 23 };
  const excelFormats: Record<string, number> = { xlsx: 51, xls: 56, csv: 6, ods: 60 };
  const pptFormats: Record<string, number> = { pptx: 24, ppt: 1, pdf: 32, odp: 35 };
  const lines = [`$ErrorActionPreference = 'Stop'`, `$app = New-Object -ComObject ${progId}`, `try {`];
  if (family === 'word') {
    lines.push(`  $app.Visible = $false`, `  $doc = $app.Documents.Open(${quote(request.source)}, $false, $true)`,
      request.to === 'pdf' ? `  $doc.ExportAsFixedFormat(${quote(request.target)}, 17)` : `  $doc.SaveAs2(${quote(request.target)}, ${wordFormats[request.to] ?? 16})`,
      `  $doc.Close($false)`);
  } else if (family === 'excel') {
    lines.push(`  $app.Visible = $false`, `  $app.DisplayAlerts = $false`, `  $book = $app.Workbooks.Open(${quote(request.source)}, 0, $true)`,
      request.to === 'pdf' ? `  $book.ExportAsFixedFormat(0, ${quote(request.target)})` : `  $book.SaveAs(${quote(request.target)}, ${excelFormats[request.to] ?? 51})`,
      `  $book.Close($false)`);
  } else {
    lines.push(`  $deck = $app.Presentations.Open(${quote(request.source)}, $true, $false, $false)`,
      `  $deck.SaveAs(${quote(request.target)}, ${pptFormats[request.to] ?? 24})`, `  $deck.Close()`);
  }
  lines.push(`} finally {`, `  $app.Quit()`, `  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)`, `}`);
  return lines.join('\n');
}

export async function convertWithCom(converter: Converter, app: 'msoffice' | 'wps', request: ConvertRequest, runner: Runner): Promise<void> {
  await mkdir(dirname(request.target), { recursive: true });
  const script = comScript(app, request);
  await runner(converter.path, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeoutMs: CONVERT_TIMEOUT_MS });
  try { await stat(request.target); } catch { throw new Error('Office 没有产生输出文件。'); }
}

/** Plain text from a PDF: pdftotext keeps layout best, ghostscript's txtwrite is the fallback most machines have. */
export async function pdfText(available: Converter[], path: string, runner: Runner): Promise<string | undefined> {
  const pdftotext = available.find(item => item.kind === 'pdftotext');
  if (pdftotext) return (await runner(pdftotext.path, ['-layout', '-enc', 'UTF-8', path, '-'], { timeoutMs: 60_000 })).stdout;
  const gs = available.find(item => item.kind === 'ghostscript');
  if (gs) return (await runner(gs.path, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=txtwrite', '-sOutputFile=-', path], { timeoutMs: 120_000 })).stdout;
  return undefined;
}

async function mkdtemp(prefix: string): Promise<string> {
  const { mkdtemp: make } = await import('node:fs/promises');
  return make(join(tmpdir(), prefix));
}

async function moveFile(from: string, to: string): Promise<void> {
  try { await rename(from, to); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const { copyFile } = await import('node:fs/promises');
    await copyFile(from, to);
  }
}

export function formatOf(path: string): Format | undefined {
  const ext = extname(path).slice(1).toLowerCase();
  const known: Format[] = ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html', 'txt', 'csv', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt', 'rtf'];
  if (ext === 'markdown') return 'md';
  if (ext === 'htm') return 'html';
  return known.includes(ext as Format) ? ext as Format : undefined;
}

export { resolve };
