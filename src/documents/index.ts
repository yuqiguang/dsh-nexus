import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { ChannelError } from '../channels/types.js';
import { type Converter, type ConvertRequest, type Format, type Runner, convertWithCom, convertWithPandoc, convertWithSoffice, defaultRunner, detectConverters, formatOf, pdfText, routesFor } from './converters.js';
import { type DocxEdit, createDocx, editDocx, readDocx } from './docx.js';
import { parseMarkdown, plain } from './markdown.js';
import { PandocInstaller, type PandocInstallStatus } from './pandoc.js';
import { type PptxEdit, createPptx, editPptx, readPptx, type SlideInput } from './pptx.js';
import { type CellValue, type XlsxEdit, createXlsx, editXlsx, readXlsx } from './xlsx.js';
import { openZip, saveZip } from './xml.js';

/**
 * Office documents for the model: read into Markdown, create from Markdown or
 * rows, edit in place, convert between formats. Reading, creating and editing
 * docx/xlsx/pptx need nothing outside the package; PDF and format conversion
 * use whatever converter this machine has, and say so when it has none.
 */

export interface DocumentsView {
  platform: NodeJS.Platform;
  converters: Converter[];
  detectedAt?: number;
  pandoc?: PandocInstallStatus;
  capabilities: string[];
}

export interface DocumentServiceDeps {
  ctx: Context;
  workspace: string;
  /** Where a downloaded pandoc and LibreOffice's private profile live. */
  managedRoot: string;
  platform?: NodeJS.Platform;
  runner?: Runner;
  detect?: () => Promise<Converter[]>;
  installer?: PandocInstaller;
  now?: () => number;
  report?: (message: string) => void;
}

/**
 * How much text one `doc_read` hands the model. DSH 0.1.7's spill policy keeps
 * only the head and the tail of any tool result it prices over `maxInlineTokens`
 * (12500, see `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`) and files
 * the rest, pricing text at 4 characters per token — about 50,000 characters.
 * The old 60,000-character cap was past that: the model was shown the first and
 * last thirds of a long document with an omission notice it did not ask for,
 * and the middle only existed in a file it then had to read. Under the budget,
 * what this tool returns is what the model reads, and the notice it appends
 * says how to get the rest (xlsx has `sheet` and `max_rows`).
 */
const MAX_TEXT = 15_000;
const READABLE: Format[] = ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'txt', 'csv', 'html', 'doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf'];

export class DocumentService {
  private converters: Converter[] = [];
  private detectedAt?: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly runner: Runner;
  private readonly installer: PandocInstaller;
  private readonly now: () => number;
  private readonly report: (message: string) => void;
  private disposers: (() => void)[] = [];

  constructor(private readonly deps: DocumentServiceDeps) {
    this.runner = deps.runner ?? defaultRunner;
    this.installer = deps.installer ?? new PandocInstaller({ managedRoot: deps.managedRoot, ...(deps.platform ? { platform: deps.platform } : {}) });
    this.now = deps.now ?? Date.now;
    this.report = deps.report ?? (message => console.error(`[nexus-documents] ${message}`));
  }

  async start(): Promise<void> {
    await this.detect();
    this.registerTools();
    this.deps.ctx.effect(() => () => { for (const dispose of this.disposers.splice(0)) dispose(); });
  }

  async detect(): Promise<Converter[]> {
    try {
      this.converters = this.deps.detect ? await this.deps.detect() : await detectConverters({ managedRoot: this.deps.managedRoot, runner: this.runner, ...(this.deps.platform ? { platform: this.deps.platform } : {}) });
    } catch (error) { this.report(`converter detection failed: ${(error as Error)?.message ?? error}`); this.converters = []; }
    this.detectedAt = this.now();
    return this.converters;
  }

  private has(kind: Converter['kind']): boolean { return this.converters.some(item => item.kind === kind); }

  /** What this machine can do, in the words the model and the settings page both see. */
  capabilities(): string[] {
    const office = this.has('msoffice') ? 'Word/Excel/PowerPoint' : this.has('wps') ? 'WPS' : this.has('soffice') ? 'LibreOffice' : undefined;
    const lines = ['读取 docx、xlsx、pptx、md、txt、csv、html；生成 docx、xlsx、pptx、md、csv、html；修改 docx、xlsx、pptx（都不需要额外软件）'];
    lines.push(this.has('pdftotext') || this.has('ghostscript') ? `读取 PDF 文字（${this.has('pdftotext') ? 'pdftotext' : 'ghostscript'}）` : '不能读 PDF：本机没有 pdftotext 或 ghostscript');
    lines.push(office ? `转成 PDF、doc/xls/ppt 旧格式和 odt/ods/odp（${office}）` : '不能转 PDF 和旧格式：本机没有 Word、WPS 或 LibreOffice');
    lines.push(this.has('pandoc') ? 'Markdown、HTML、docx、odt、rtf 互转（pandoc）' : 'Markdown 与 docx 互转由内置实现完成；HTML、odt、rtf 与 Markdown 互转需要 pandoc（设置页可下载）');
    return lines;
  }

  view(): DocumentsView {
    const pandoc = this.installer.status();
    return { platform: this.deps.platform ?? process.platform, converters: this.converters.map(item => ({ ...item })), ...(this.detectedAt !== undefined ? { detectedAt: this.detectedAt } : {}),
      ...(pandoc ? { pandoc } : {}), capabilities: this.capabilities() };
  }

  async handle(method: string, _payload: unknown): Promise<DocumentsView> {
    if (method === 'list') return this.view();
    if (method === 'detect') { await this.detect(); return this.view(); }
    if (method === 'pandoc/install') {
      if (this.installer.status()?.phase === 'installing') throw new ChannelError('install_in_progress');
      void this.installer.install().then(() => this.detect());
      return this.view();
    }
    throw new ChannelError('unknown_action');
  }

  // ---- paths and permissions ----

  private cwdOf(exec: ToolRunContext): string {
    return exec.agent?.session.header.cwd ?? this.deps.workspace;
  }

  private resolveRead(exec: ToolRunContext, path: string): string {
    if (!path || typeof path !== 'string') throw new Error('要给文件路径。');
    return resolve(this.cwdOf(exec), path);
  }

  /** Where a tool may write: nowhere in read-only mode, under the workspace root in workspace-write, anywhere with full access. */
  private resolveWrite(exec: ToolRunContext, path: string): string {
    const target = this.resolveRead(exec, path);
    const policy = this.deps.ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {});
    if (policy.mode === 'read-only') throw new Error('当前会话是只读模式，不能写文件。请用户在本机把会话切到“工作区写入”模式后再试。');
    if (policy.mode === 'workspace-write') {
      const inside = relative(resolve(policy.workspaceRoot), target);
      if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`工作区写入模式只能写到 ${policy.workspaceRoot} 之内，请把输出放在 outputs/ 目录。`);
    }
    return target;
  }

  private display(exec: ToolRunContext, path: string): string {
    const rel = relative(this.cwdOf(exec), path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
  }

  /** Files the assistant produced itself live under outputs/; only those may be rewritten in place. */
  ownOutput(exec: ToolRunContext, path: string): boolean {
    const rel = relative(join(this.cwdOf(exec), 'outputs'), resolve(path));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  }

  /** Write beside the target and rename, so an in-place edit never leaves a half-written document. */
  async writeAtomically(target: string, bytes: Buffer): Promise<void> {
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, bytes);
    await rename(temp, target);
  }

  private async assertNotExists(path: string, overwrite: boolean): Promise<void> {
    if (overwrite) return;
    try { await stat(path); } catch { return; }
    throw new Error(`${path} 已存在；换个文件名，或带 overwrite: true。`);
  }

  // ---- reading ----

  async readText(exec: ToolRunContext, path: string, options: { sheet?: string; formulas?: boolean; maxRows?: number } = {}): Promise<string> {
    const full = this.resolveRead(exec, path);
    const format = formatOf(full);
    if (!format || !READABLE.includes(format)) throw new Error(`不认识的文件类型：${extname(full) || '（无扩展名）'}。能读的有 ${READABLE.join('、')}。`);
    if (['md', 'txt', 'csv', 'html'].includes(format)) return clip(await readFile(full, 'utf8'));
    if (['doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf'].includes(format)) {
      const to: Format = ['xls', 'ods'].includes(format) ? 'xlsx' : ['ppt', 'odp'].includes(format) ? 'pptx' : 'docx';
      const temp = await mkdtemp(join(tmpdir(), 'nexus-read-'));
      try {
        const converted = join(temp, `${basename(full, extname(full))}.${to}`);
        await this.convertFile({ source: full, target: converted, from: format, to });
        return this.readOoxml(converted, to, options);
      } finally { await rm(temp, { recursive: true, force: true }); }
    }
    if (format === 'pdf') {
      const text = await this.serial(() => pdfText(this.converters, full, this.runner));
      if (text === undefined) throw new Error('本机没有 pdftotext 或 ghostscript，读不了 PDF 的文字。告诉用户在本机装 poppler-utils 或 ghostscript，或让用户换发 docx。');
      const trimmed = text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return clip(trimmed || '（这个 PDF 没有可提取的文字，可能是扫描件；需要 OCR 才能读。）');
    }
    return this.readOoxml(full, format as 'docx' | 'xlsx' | 'pptx', options);
  }

  private async readOoxml(path: string, format: 'docx' | 'xlsx' | 'pptx', options: { sheet?: string; formulas?: boolean; maxRows?: number }): Promise<string> {
    const zip = await openZip(path);
    if (format === 'docx') { const text = await readDocx(zip); return clip(text.markdown || '（空文档）'); }
    if (format === 'xlsx') return clip((await readXlsx(zip, options)).markdown);
    return clip((await readPptx(zip)).markdown);
  }

  // ---- converting ----

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(task);
    this.queue = next;
    return next;
  }

  /** One conversion: the package's own code where it can, else the first converter that has the route, one external process at a time. */
  async convertFile(request: ConvertRequest, options: { template?: string } = {}): Promise<{ via: string }> {
    const { from, to } = request;
    if (from === to) throw new Error('源文件已经是这个格式。');
    const native = await this.convertNatively(request, options);
    if (native) return { via: '内置' };
    const routes = routesFor(from, to, this.converters);
    if (!routes.length) throw new Error(this.missingRouteText(from, to));
    let lastError: Error | undefined;
    for (const converter of routes) {
      try {
        await this.serial(async () => {
          if (converter.kind === 'soffice') await convertWithSoffice(converter, request, this.runner, this.deps.managedRoot);
          else if (converter.kind === 'pandoc') await convertWithPandoc(converter, request, this.runner, options.template);
          else if (converter.kind === 'msoffice' || converter.kind === 'wps') await convertWithCom(converter, converter.kind, request, this.runner);
          else throw new Error(`${converter.kind} 不做格式转换。`);
        });
        return { via: converter.kind };
      } catch (error) { lastError = error as Error; this.report(`${converter.kind} failed ${from}->${to}: ${lastError.message}`); }
    }
    throw new Error(`转换失败：${lastError?.message ?? '未知错误'}`);
  }

  private missingRouteText(from: Format, to: Format): string {
    if (to === 'pdf') return '本机没有 Word、WPS 或 LibreOffice，转不了 PDF。可以先把 docx 发给用户，或请用户在本机装 LibreOffice（Linux：sudo apt install libreoffice-writer-nogui）。';
    if (from === 'md' || to === 'md') return `${from} 与 ${to} 互转需要 pandoc；请用户在设置页“文档工具”里点“下载 pandoc”。`;
    return `${from} 转 ${to} 需要 Word、WPS 或 LibreOffice，本机都没有。`;
  }

  private async convertNatively(request: ConvertRequest, options: { template?: string }): Promise<boolean> {
    const { from, to, source, target } = request;
    await mkdir(dirname(target), { recursive: true });
    if (from === 'md' && to === 'docx' && !(this.has('pandoc') && options.template && /\.docx$/i.test(options.template) === false)) {
      const template = options.template ? await openZip(options.template) : undefined;
      await writeFile(target, await createDocx(await readFile(source, 'utf8'), template));
      return true;
    }
    if (from === 'docx' && to === 'md' && !this.has('pandoc')) { await writeFile(target, (await readDocx(await openZip(source))).markdown + '\n'); return true; }
    if (from === 'docx' && to === 'txt') { await writeFile(target, plainText((await readDocx(await openZip(source))).markdown) + '\n'); return true; }
    if (from === 'pptx' && (to === 'md' || to === 'txt')) { await writeFile(target, (await readPptx(await openZip(source))).markdown + '\n'); return true; }
    if (from === 'xlsx' && to === 'md') { await writeFile(target, (await readXlsx(await openZip(source))).markdown + '\n'); return true; }
    if (from === 'xlsx' && to === 'csv') {
      const text = await readXlsx(await openZip(source));
      const firstSheet = text.markdown.split('\n\n').find(part => part.startsWith('| '));
      await writeFile(target, tableToCsv(firstSheet ?? ''));
      return true;
    }
    if (from === 'csv' && to === 'xlsx') { await writeFile(target, await createXlsx([{ name: basename(source, extname(source)), rows: parseCsv(await readFile(source, 'utf8')) }])); return true; }
    if (from === 'md' && to === 'html') { await writeFile(target, markdownToHtml(await readFile(source, 'utf8'))); return true; }
    if (from === 'md' && to === 'txt') { await writeFile(target, plainText(await readFile(source, 'utf8')) + '\n'); return true; }
    return false;
  }

  // ---- tools ----

  private registerTools(): void {
    const { ctx } = this.deps;
    const service = this;
    const text = { schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const } } },
      render: (_args: unknown, value: { text: string }) => [{ type: 'text' as const, text: value.text }] };
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'doc_read',
      description: '读 Office 文档的内容：docx、xlsx、pptx、pdf、doc/xls/ppt、odt/ods/odp、rtf、md、txt、csv、html。返回 Markdown：Word 的标题、列表、表格保留；Excel 每张工作表一节，第一列是行号、表头是列名，formulas: true 时显示公式而不是值；PPT 每页一节含备注。用户发来的文件在 inbox/ 目录，路径见消息里的“[附件] … 已保存到”。',
      parameters: {
        path: { type: 'string', required: true, description: '文件路径，相对工作区或绝对路径。' },
        sheet: { type: 'string', description: 'xlsx：只读这张工作表。' },
        formulas: { type: 'boolean', description: 'xlsx：显示公式（=SUM(...)）而不是计算结果。' },
        max_rows: { type: 'number', description: 'xlsx：每张表最多显示多少行，默认全部（总共最多 2 万个单元格）。' },
      },
      output: text,
      async execute(args, exec) {
        return { text: await service.readText(exec, args.path, { ...(args.sheet ? { sheet: args.sheet } : {}), ...(args.formulas === true ? { formulas: true } : {}), ...(typeof args.max_rows === 'number' ? { maxRows: args.max_rows } : {}) }) };
      },
    })));
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'doc_create',
      description: '生成一个新文档，写到 outputs/ 下再用 present 交付给用户。format=docx：content 写 Markdown（# 标题、- 列表、1. 编号、| 表格 |、**粗体**），可选 template 指定一个 docx 作为样式模板（沿用它的字体、页眉页脚，正文替换成新内容）；xlsx：sheets 给每张表的名字和 rows（二维数组，字符串、数字、布尔；以 = 开头的字符串是公式，如 "=SUM(B2:B9)"）；pptx：title/subtitle 是封面，slides 每页 title、bullets、可选 table 和 notes；md/txt/csv/html：content 原样写入。要 PDF 时先生成 docx 再 doc_convert。',
      parameters: {
        path: { type: 'string', required: true, description: '输出路径，例如 outputs/报告.docx；扩展名要和 format 一致。' },
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'md', 'txt', 'csv', 'html'], required: true },
        content: { type: 'string', description: 'docx：Markdown 正文；md/txt/csv/html：文件内容。' },
        template: { type: 'string', description: 'docx：作为样式模板的 docx 路径。' },
        sheets: { type: 'array', description: 'xlsx：工作表。', items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', required: true }, rows: { type: 'array', required: true, items: { type: 'array', items: { type: 'json' } } } } } },
        title: { type: 'string', description: 'pptx：封面标题。' },
        subtitle: { type: 'string', description: 'pptx：封面副标题。' },
        slides: { type: 'array', description: 'pptx：内容页。', items: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }, table: { type: 'array', items: { type: 'array', items: { type: 'string' } } }, notes: { type: 'string' } } } },
        overwrite: { type: 'boolean', description: '目标已存在时覆盖。' },
      },
      output: text,
      async execute(args, exec) {
        const target = service.resolveWrite(exec, args.path);
        if (formatOf(target) !== args.format) throw new Error(`文件扩展名要是 .${args.format}。`);
        await service.assertNotExists(target, args.overwrite === true);
        await mkdir(dirname(target), { recursive: true });
        let bytes: Buffer;
        if (args.format === 'docx') {
          if (!args.content?.trim()) throw new Error('docx 需要 content（Markdown）。');
          bytes = await createDocx(args.content, args.template ? await openZip(service.resolveRead(exec, args.template)) : undefined);
        } else if (args.format === 'xlsx') {
          if (!args.sheets?.length) throw new Error('xlsx 需要 sheets。');
          bytes = await createXlsx(args.sheets.map(sheet => ({ name: sheet.name, rows: (sheet.rows as unknown[][]).map(row => row.map(cellValue)) })));
        } else if (args.format === 'pptx') {
          bytes = await createPptx({ ...(args.title ? { title: args.title } : {}), ...(args.subtitle ? { subtitle: args.subtitle } : {}), slides: (args.slides ?? []) as SlideInput[] });
        } else {
          if (typeof args.content !== 'string') throw new Error(`${args.format} 需要 content。`);
          bytes = Buffer.from(args.content, 'utf8');
        }
        await writeFile(target, bytes);
        return { text: `已生成 ${service.display(exec, target)}（${formatBytes(bytes.length)}）。要发给用户就用 present 交付这个路径。` };
      },
    })));
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'doc_edit',
      description: '修改已有的 docx、xlsx 或 pptx，结果写到新文件（默认 outputs/原名-edited.扩展名）；你自己在 outputs/ 里生成的文件可以 output 写同一路径并带 overwrite: true 原地改，用户发来的原件（inbox/）不能覆盖。先 doc_read 看清原文再改。docx 的 edits：{op:"replace", find, replace, all?} 替换文字（保留格式，find 要和原文完全一致；all 默认 true）；{op:"append", markdown} 在末尾追加内容；{op:"set_cell", table, row, col, text} 改第 table 个表格第 row 行第 col 列（都从 1 数）。xlsx：{op:"set", sheet?, cell:"B3", value} 改单元格（value 可以是文字、数字、布尔或 "=公式"）；{op:"append", sheet?, rows} 在末尾追加行。pptx：{op:"replace", find, replace, slide?} 替换文字。',
      parameters: {
        path: { type: 'string', required: true, description: '要改的文件。' },
        output: { type: 'string', description: '结果写到哪里，默认 outputs/原名-edited.扩展名。' },
        edits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          op: { type: 'string', enum: ['replace', 'append', 'set_cell', 'set'], required: true },
          find: { type: 'string' }, replace: { type: 'string' }, all: { type: 'boolean' }, slide: { type: 'number' },
          markdown: { type: 'string' }, table: { type: 'number' }, row: { type: 'number' }, col: { type: 'number' }, text: { type: 'string' },
          sheet: { type: 'string' }, cell: { type: 'string' }, value: { type: 'json' }, rows: { type: 'array', items: { type: 'array', items: { type: 'json' } } },
        } } },
        overwrite: { type: 'boolean', description: '输出已存在时覆盖。' },
      },
      output: text,
      async execute(args, exec) {
        const source = service.resolveRead(exec, args.path);
        const format = formatOf(source);
        if (format !== 'docx' && format !== 'xlsx' && format !== 'pptx') throw new Error('只能修改 docx、xlsx、pptx；其他格式先用 doc_convert 转过来。');
        const target = service.resolveWrite(exec, args.output ?? join('outputs', `${basename(source, extname(source))}-edited${extname(source)}`));
        const inPlace = resolve(target) === resolve(source);
        if (inPlace && !service.ownOutput(exec, source)) throw new Error('用户发来的原件不能覆盖，换个 output（放在 outputs/ 下）。');
        if (inPlace && args.overwrite !== true) throw new Error('要原地修改就带 overwrite: true，否则换个 output。');
        if (!inPlace) await service.assertNotExists(target, args.overwrite === true);
        if (!args.edits.length) throw new Error('edits 不能为空。');
        const zip = await openZip(source);
        let summary: string;
        if (format === 'docx') {
          const report = await editDocx(zip, args.edits.map(edit => docxEdit(edit as Record<string, unknown>)));
          summary = [report.replaced ? `替换 ${report.replaced} 处` : '', report.appended ? `追加 ${report.appended} 段` : '', report.cells ? `改了 ${report.cells} 个单元格` : ''].filter(Boolean).join('，');
        } else if (format === 'xlsx') {
          const report = await editXlsx(zip, args.edits.map(edit => xlsxEdit(edit as Record<string, unknown>)));
          summary = [report.set ? `改了 ${report.set} 个单元格` : '', report.appended ? `追加 ${report.appended} 行` : ''].filter(Boolean).join('，');
        } else {
          const report = await editPptx(zip, args.edits.map(edit => pptxEdit(edit as Record<string, unknown>)));
          summary = `替换 ${report.replaced} 处`;
        }
        await mkdir(dirname(target), { recursive: true });
        await service.writeAtomically(target, await saveZip(zip));
        return { text: `已${summary || '处理'}，结果在 ${service.display(exec, target)}${inPlace ? '（原地修改）' : '；原文件未动'}。要发给用户就 present 这个路径。` };
      },
    })));
    this.disposers.push(ctx.tools.register(defineTool({
      name: 'doc_convert',
      description: `把文档转成另一种格式，结果写到新文件（默认 outputs/原名.新扩展名）。能转什么取决于本机装了什么：${this.capabilities().join('；')}。转不了时会说明原因，照实告诉用户，不要反复尝试。`,
      parameters: {
        path: { type: 'string', required: true, description: '源文件。' },
        to: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'pptx', 'md', 'html', 'txt', 'csv', 'odt', 'ods', 'odp', 'doc', 'xls', 'ppt', 'rtf'], required: true },
        output: { type: 'string', description: '输出路径，默认 outputs/原名.新扩展名。' },
        template: { type: 'string', description: 'md 转 docx 时的样式模板 docx。' },
        overwrite: { type: 'boolean', description: '输出已存在时覆盖。' },
      },
      output: text,
      async execute(args, exec) {
        const source = service.resolveRead(exec, args.path);
        const from = formatOf(source);
        if (!from) throw new Error(`不认识的源文件类型：${extname(source) || '（无扩展名）'}`);
        await stat(source).catch(() => { throw new Error(`没有这个文件：${service.display(exec, source)}`); });
        const target = service.resolveWrite(exec, args.output ?? join('outputs', `${basename(source, extname(source))}.${args.to}`));
        if (formatOf(target) !== args.to) throw new Error(`输出文件扩展名要是 .${args.to}。`);
        await service.assertNotExists(target, args.overwrite === true);
        const { via } = await service.convertFile({ source, target, from, to: args.to as Format }, args.template ? { template: service.resolveRead(exec, args.template) } : {});
        const size = (await stat(target)).size;
        return { text: `已转成 ${service.display(exec, target)}（${formatBytes(size)}，经 ${via}）。要发给用户就 present 这个路径。` };
      },
    })));
    this.disposers.push(ctx.systemPrompt.section({
      name: 'nexus:documents',
      order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS') + 6,
      text: () => `办公文档：用户发来的 docx、xlsx、pptx、pdf 用 doc_read 读（不要用 read，它只会看到乱码）；要生成报告、表格、演示文稿用 doc_create 写到 outputs/ 再 present；要改用户发来的文件用 doc_edit，结果是新文件，原件不动；换格式用 doc_convert。本机当前能力：${this.capabilities().join('；')}。做不到的事直接告诉用户原因，不要说“稍后再试”。`,
    }));
  }
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n\n（内容超过 ${MAX_TEXT} 字，后面的已省略；xlsx 可用 sheet 或 max_rows 参数分段读）` : text;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;
}

export function cellValue(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  return String(value);
}

function docxEdit(edit: Record<string, unknown>): DocxEdit {
  const op = edit.op;
  if (op === 'replace') return { op, find: String(edit.find ?? ''), replace: String(edit.replace ?? ''), ...(edit.all === false ? { all: false } : {}) };
  if (op === 'append') { if (typeof edit.markdown !== 'string') throw new Error('append 需要 markdown。'); return { op, markdown: edit.markdown }; }
  if (op === 'set_cell') {
    for (const key of ['table', 'row', 'col']) if (!Number.isInteger(edit[key]) || (edit[key] as number) < 1) throw new Error(`set_cell 的 ${key} 要是从 1 起的整数。`);
    return { op, table: edit.table as number, row: edit.row as number, col: edit.col as number, text: String(edit.text ?? '') };
  }
  throw new Error(`docx 不支持 op=${String(op)}；可用 replace、append、set_cell。`);
}

function xlsxEdit(edit: Record<string, unknown>): XlsxEdit {
  const sheet = typeof edit.sheet === 'string' && edit.sheet ? { sheet: edit.sheet } : {};
  if (edit.op === 'set') { if (typeof edit.cell !== 'string') throw new Error('set 需要 cell（如 B3）。'); return { op: 'set', ...sheet, cell: edit.cell, value: cellValue(edit.value) }; }
  if (edit.op === 'append') {
    if (!Array.isArray(edit.rows)) throw new Error('append 需要 rows（二维数组）。');
    return { op: 'append', ...sheet, rows: (edit.rows as unknown[]).map(row => (Array.isArray(row) ? row : [row]).map(cellValue)) };
  }
  throw new Error(`xlsx 不支持 op=${String(edit.op)}；可用 set、append。`);
}

function pptxEdit(edit: Record<string, unknown>): PptxEdit {
  if (edit.op !== 'replace') throw new Error(`pptx 只支持 op=replace。`);
  return { op: 'replace', find: String(edit.find ?? ''), replace: String(edit.replace ?? ''), ...(edit.all === false ? { all: false } : {}), ...(typeof edit.slide === 'number' ? { slide: Math.floor(edit.slide) } : {}) };
}

/** Markdown with its marks removed, for txt output. */
export function plainText(markdown: string): string {
  return parseMarkdown(markdown).map(block => {
    if (block.type === 'code') return block.text;
    if (block.type === 'list') return block.items.map((item, i) => `${block.ordered ? `${i + 1}.` : '-'} ${plain(item)}`).join('\n');
    if (block.type === 'table') return block.rows.map(row => row.map(plain).join('\t')).join('\n');
    return plain(block.inlines);
  }).join('\n\n');
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') { if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && source[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.map(cells => cells.map(cell => (/^-?\d+(\.\d+)?$/.test(cell) && cell.length < 16 ? String(Number(cell)) : cell)));
}

/** The first sheet's pipe table (as readXlsx renders it) back to CSV, without the row-number column. */
function tableToCsv(table: string): string {
  const lines = table.split('\n').filter(line => line.startsWith('|'));
  const cells = (line: string) => line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
  const quote = (cell: string) => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  return lines.filter((_line, i) => i !== 0 && i !== 1).map(line => cells(line).slice(1).map(quote).join(',')).join('\n') + '\n';
}

export function markdownToHtml(markdown: string): string {
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (items: { text: string; bold?: boolean; italic?: boolean; code?: boolean }[]) => items.map(item => {
    const text = esc(item.text).replace(/\n/g, '<br>');
    return item.code ? `<code>${text}</code>` : item.bold && item.italic ? `<strong><em>${text}</em></strong>` : item.bold ? `<strong>${text}</strong>` : item.italic ? `<em>${text}</em>` : text;
  }).join('');
  const body = parseMarkdown(markdown).map(block => {
    if (block.type === 'heading') return `<h${block.level}>${inline(block.inlines)}</h${block.level}>`;
    if (block.type === 'paragraph') return `<p>${inline(block.inlines)}</p>`;
    if (block.type === 'code') return `<pre><code>${esc(block.text)}</code></pre>`;
    if (block.type === 'list') return `<${block.ordered ? 'ol' : 'ul'}>${block.items.map(item => `<li>${inline(item)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
    const [head, ...rest] = block.rows;
    return `<table><thead><tr>${(head ?? []).map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${rest.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }).join('\n');
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(basename(markdown.split('\n')[0] ?? '').replace(/^#+\s*/, '').slice(0, 80) || '文档')}</title><style>body{font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;max-width:48em;margin:2em auto;padding:0 1em;line-height:1.6}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}pre{background:#f4f4f4;padding:.8em;overflow:auto}</style></head><body>\n${body}\n</body></html>\n`;
}
