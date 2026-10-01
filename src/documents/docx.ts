import JSZip from 'jszip';
import { type Inline, type MarkdownBlock, parseMarkdown, renderInlines, renderTable } from './markdown.js';
import { replaceInPart } from './ooxml-text.js';
import { attribute, children, cleanText, elementAt, elements, escapeXml, partText, relationshipsOfType, saveZip, unescapeXml } from './xml.js';

/** Word documents as text: read into Markdown, build from Markdown, and edit in place without touching what is not named. */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const MAIN_PART = 'word/document.xml';
export const MAX_BODY_BLOCKS = 5000;

// ---- reading ----

interface StyleInfo { headings: Map<string, number>; }

function styleInfo(styles: string | undefined): StyleInfo {
  const headings = new Map<string, number>();
  if (!styles) return { headings };
  for (const style of elements(styles, 'w:style')) {
    const id = attribute(style.xml, 'w:styleId');
    const nameTag = /<w:name\s[^>]*\/>/.exec(style.xml);
    const name = nameTag ? attribute(nameTag[0], 'w:val') ?? '' : '';
    const level = /^heading\s*(\d)$/i.exec(name)?.[1] ?? /^标题\s*(\d)$/.exec(name)?.[1] ?? /^Heading(\d)$/.exec(id ?? '')?.[1];
    if (id && level) headings.set(id, Number(level));
  }
  return { headings };
}

/** numId → ordered? from numbering.xml; bullets and unknown formats read as unordered. */
function numberingInfo(numbering: string | undefined): Map<string, boolean> {
  const ordered = new Map<string, boolean>();
  if (!numbering) return ordered;
  const abstracts = new Map<string, boolean>();
  for (const abstract of elements(numbering, 'w:abstractNum')) {
    const id = attribute(abstract.xml, 'w:abstractNumId');
    const first = elements(abstract.xml, 'w:lvl')[0];
    const fmt = first ? /<w:numFmt\s[^>]*\/>/.exec(first.xml) : null;
    if (id) abstracts.set(id, fmt ? attribute(fmt[0], 'w:val') !== 'bullet' : false);
  }
  for (const num of elements(numbering, 'w:num')) {
    const id = attribute(num.xml, 'w:numId');
    const ref = /<w:abstractNumId\s[^>]*\/>/.exec(num.xml);
    if (id && ref) ordered.set(id, abstracts.get(attribute(ref[0], 'w:val') ?? '') ?? false);
  }
  return ordered;
}

function runInlines(paragraph: string): Inline[] {
  const inlines: Inline[] = [];
  for (const run of elements(paragraph, 'w:r')) {
    const props = /<w:rPr>.*?<\/w:rPr>/s.exec(run.xml)?.[0] ?? '';
    const bold = /<w:b(\s[^>]*)?\/>/.test(props) && !/<w:b\s[^>]*w:val="(0|false)"/.test(props);
    const italic = /<w:i(\s[^>]*)?\/>/.test(props) && !/<w:i\s[^>]*w:val="(0|false)"/.test(props);
    let text = '';
    for (const piece of run.xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<w:drawing>|<w:pict>|<w:sym\s/g)) {
      if (piece[0].startsWith('<w:t')) text += unescapeXml(piece[1] ?? '');
      else if (piece[0] === '<w:tab/>') text += '\t';
      else if (piece[0] === '<w:br/>' || piece[0] === '<w:cr/>') text += '\n';
      else if (piece[0] === '<w:drawing>' || piece[0] === '<w:pict>') text += '[图片]';
    }
    if (!text) continue;
    const last = inlines[inlines.length - 1];
    if (last && !!last.bold === bold && !!last.italic === italic) last.text += text;
    else inlines.push({ text, ...(bold ? { bold } : {}), ...(italic ? { italic } : {}) });
  }
  return inlines;
}

function paragraphMarkdown(paragraph: string, styles: StyleInfo, numbering: Map<string, boolean>, counters: Map<string, number>): string {
  const pPr = /<w:pPr>.*?<\/w:pPr>/s.exec(paragraph)?.[0] ?? '';
  const styleTag = /<w:pStyle\s[^>]*\/>/.exec(pPr);
  const style = styleTag ? attribute(styleTag[0], 'w:val') : undefined;
  const text = renderInlines(runInlines(paragraph)).replace(/\n/g, '  \n');
  const level = style ? styles.headings.get(style) : undefined;
  if (level) return `${'#'.repeat(Math.min(6, level))} ${text.trim()}`;
  const numId = /<w:numId\s[^>]*\/>/.exec(pPr);
  const ilvl = /<w:ilvl\s[^>]*\/>/.exec(pPr);
  if (numId) {
    const id = attribute(numId[0], 'w:val') ?? '';
    const depth = Number(ilvl ? attribute(ilvl[0], 'w:val') ?? '0' : '0');
    const indent = '  '.repeat(Math.min(depth, 4));
    if (numbering.get(id)) {
      const key = `${id}:${depth}`;
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return `${indent}${count}. ${text.trim()}`;
    }
    return `${indent}- ${text.trim()}`;
  }
  return text.trim();
}

function tableRows(table: string, cell: (paragraphs: string[]) => string): string[][] {
  const rows: string[][] = [];
  for (const row of children(table, ['w:tr'], 0, table.length)) {
    const cells: string[] = [];
    for (const tc of children(row.block.xml, ['w:tc'], 0, row.block.xml.length)) {
      cells.push(cell(children(tc.block.xml, ['w:p'], 0, tc.block.xml.length).map(item => item.block.xml)));
    }
    rows.push(cells);
  }
  return rows;
}

export interface DocxText { markdown: string; paragraphs: number; tables: number; }

/** The body as Markdown: headings by style, lists by numbering, tables as pipe tables, images as a marker. */
export async function readDocx(zip: JSZip): Promise<DocxText> {
  const document = await partText(zip, MAIN_PART);
  const styles = styleInfo(await zip.file('word/styles.xml')?.async('string'));
  const numbering = numberingInfo(await zip.file('word/numbering.xml')?.async('string'));
  const body = elementAt(document, document.indexOf('<w:body'), 'w:body');
  if (!body) throw new Error('文档没有正文。');
  const counters = new Map<string, number>();
  const lines: string[] = [];
  let paragraphs = 0;
  let tables = 0;
  let previousList: 'none' | 'bullet' | 'ordered' = 'none';
  for (const child of children(body.xml, ['w:p', 'w:tbl'], 0, body.xml.length)) {
    if (child.name === 'w:tbl') {
      tables++;
      // The header row reads as plain text: Markdown already sets it apart, and Word templates bold it anyway.
      const rows = tableRows(child.block.xml, items => items.map(item => renderInlines(runInlines(item)).trim()).filter(Boolean).join(' '));
      if (rows[0]) rows[0] = rows[0].map(cell => cell.replace(/^\*\*(.*)\*\*$/, '$1'));
      lines.push('', renderTable(rows), '');
      previousList = 'none';
      continue;
    }
    paragraphs++;
    const line = paragraphMarkdown(child.block.xml, styles, numbering, counters);
    const kind = /^\s*- /.test(line) ? 'bullet' : /^\s*\d+\. /.test(line) ? 'ordered' : 'none';
    if (!line) { if (lines[lines.length - 1] !== '') lines.push(''); previousList = 'none'; continue; }
    if (kind === 'none' || kind !== previousList) if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(line);
    previousList = kind;
  }
  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), paragraphs, tables };
}

// ---- writing ----

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/><w:sz w:val="24"/><w:szCs w:val="24"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${[1, 2, 3, 4, 5, 6].map(level => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:rFonts w:eastAsia="黑体"/><w:b/><w:bCs/><w:sz w:val="${[40, 32, 28, 26, 24, 24][level - 1]}"/><w:szCs w:val="${[40, 32, 28, 26, 24, 24][level - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="宋体" w:cs="Consolas"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const abstractNum = (id: number, ordered: boolean) => `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2].map(level =>
  `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? 'decimal' : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${level + 1}.` : '•'}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + level * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
const SECTION = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

/** The style ids a target document uses for the roles our Markdown needs. */
interface StyleMap { heading(level: number): string | undefined; list?: string; code?: string; table?: string }

function styleMap(styles: string | undefined): StyleMap {
  const byName = new Map<string, string>();
  if (styles) for (const style of elements(styles, 'w:style')) {
    const id = attribute(style.xml, 'w:styleId');
    const nameTag = /<w:name\s[^>]*\/>/.exec(style.xml);
    const name = nameTag ? (attribute(nameTag[0], 'w:val') ?? '').toLowerCase() : '';
    if (id && name) byName.set(name, id);
  }
  const info = styleInfo(styles);
  const headingIds = new Map<number, string>();
  for (const [id, level] of info.headings) if (!headingIds.has(level)) headingIds.set(level, id);
  return { heading: level => headingIds.get(level), list: byName.get('list paragraph'), code: byName.get('code') ?? byName.get('source code'), table: byName.get('table grid') };
}

function run(inline: Inline, extra = ''): string {
  const props = [inline.bold ? '<w:b/><w:bCs/>' : '', inline.italic ? '<w:i/><w:iCs/>' : '', inline.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '', extra].join('');
  const pieces = cleanText(inline.text).split('\n').map(piece => `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`).join('<w:br/>');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${pieces}</w:r>`;
}

function paragraph(inlines: Inline[], pPr = ''): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inlines.map(inline => run(inline)).join('')}</w:p>`;
}

interface Numbering { bullet: number; nextOrdered(): number; xml(): string }

/** Fresh numbering definitions appended to whatever the document already has; each ordered list restarts at 1. */
function numberingFor(existing: string | undefined): Numbering {
  const ids = [...(existing ?? '').matchAll(/w:abstractNumId="(\d+)"/g)].map(match => Number(match[1]));
  const numIds = [...(existing ?? '').matchAll(/<w:num\s[^>]*w:numId="(\d+)"/g)].map(match => Number(match[1]));
  const abstractBase = (ids.length ? Math.max(...ids) : -1) + 1;
  let nextNum = (numIds.length ? Math.max(...numIds) : 0) + 1;
  const bullet = nextNum++;
  const ordered: number[] = [];
  return {
    bullet,
    nextOrdered() { const id = nextNum++; ordered.push(id); return id; },
    xml() {
      const abstracts = abstractNum(abstractBase, false) + abstractNum(abstractBase + 1, true);
      const nums = [`<w:num w:numId="${bullet}"><w:abstractNumId w:val="${abstractBase}"/></w:num>`,
        ...ordered.map(id => `<w:num w:numId="${id}"><w:abstractNumId w:val="${abstractBase + 1}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`)].join('');
      if (!existing) return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W_NS}>${abstracts}${nums}</w:numbering>`;
      // abstractNum elements must precede num elements.
      const firstNum = existing.search(/<w:num\s/);
      const closing = existing.lastIndexOf('</w:numbering>');
      if (firstNum >= 0) return existing.slice(0, firstNum) + abstracts + existing.slice(firstNum, closing) + nums + existing.slice(closing);
      return existing.slice(0, closing) + abstracts + nums + existing.slice(closing);
    },
  };
}

export function blocksToXml(blocks: MarkdownBlock[], styles: StyleMap, numbering: Numbering): string {
  if (blocks.length > MAX_BODY_BLOCKS) throw new Error(`内容超过 ${MAX_BODY_BLOCKS} 个段落，请拆分。`);
  const out: string[] = [];
  for (const block of blocks) {
    if (block.type === 'heading') {
      const style = styles.heading(block.level);
      out.push(paragraph(style ? block.inlines : block.inlines.map(inline => ({ ...inline, bold: true })), style ? `<w:pStyle w:val="${style}"/>` : ''));
    } else if (block.type === 'paragraph') out.push(paragraph(block.inlines));
    else if (block.type === 'list') {
      const numId = block.ordered ? numbering.nextOrdered() : numbering.bullet;
      for (const item of block.items) out.push(paragraph(item, `${styles.list ? `<w:pStyle w:val="${styles.list}"/>` : ''}<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>`));
    } else if (block.type === 'code') {
      for (const line of block.text.split('\n')) out.push(paragraph([{ text: line || ' ', code: !styles.code }], styles.code ? `<w:pStyle w:val="${styles.code}"/>` : '<w:spacing w:after="0"/>'));
    } else if (block.type === 'table') {
      const width = Math.max(...block.rows.map(row => row.length));
      const rows = block.rows.map((row, r) => `<w:tr>${Array.from({ length: width }, (_item, c) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${paragraph((row[c] ?? []).map(inline => r === 0 ? { ...inline, bold: true } : inline), '<w:spacing w:after="0"/>')}</w:tc>`).join('')}</w:tr>`).join('');
      const borders = styles.table ? '' : '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders>';
      out.push(`<w:tbl><w:tblPr>${styles.table ? `<w:tblStyle w:val="${styles.table}"/>` : ''}<w:tblW w:w="0" w:type="auto"/>${borders}<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${Array.from({ length: width }, () => '<w:gridCol/>').join('')}</w:tblGrid>${rows}</w:tbl>`, paragraph([]));
    }
  }
  return out.join('');
}

/** A new document from Markdown; with a template, its styles, headers, footers and page setup are kept and only the body is replaced. */
export async function createDocx(markdown: string, template?: JSZip): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  if (!template) {
    const zip = new JSZip();
    const numbering = numberingFor(undefined);
    const builtin: StyleMap = { heading: level => `Heading${Math.min(6, level)}`, list: 'ListParagraph', code: 'Code', table: 'TableGrid' };
    const body = blocksToXml(blocks, builtin, numbering);
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS);
    zip.file('word/styles.xml', STYLES);
    zip.file('word/numbering.xml', numbering.xml());
    zip.file(MAIN_PART, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${body}${SECTION}</w:body></w:document>`);
    return saveZip(zip);
  }
  const document = await partText(template, MAIN_PART);
  const body = elementAt(document, document.indexOf('<w:body'), 'w:body');
  if (!body) throw new Error('模板没有正文。');
  const numbering = await ensureNumbering(template);
  const xml = blocksToXml(blocks, styleMap(await template.file('word/styles.xml')?.async('string')), numbering);
  const sectPr = /<w:sectPr(\s[^>]*)?>.*?<\/w:sectPr>|<w:sectPr(\s[^>]*)?\/>/s.exec(body.xml);
  const open = /<w:body[^>]*>/.exec(body.xml)![0];
  const rebuilt = `${open}${xml}${sectPr ? sectPr[0] : ''}</w:body>`;
  template.file(MAIN_PART, document.slice(0, body.start) + rebuilt + document.slice(body.end));
  template.file('word/numbering.xml', numbering.xml());
  return saveZip(template);
}

/** The document's numbering part with our definitions appended, creating the part, its relationship and content type when absent. */
async function ensureNumbering(zip: JSZip): Promise<Numbering> {
  const existing = await zip.file('word/numbering.xml')?.async('string');
  if (!existing) {
    const rels = await partText(zip, 'word/_rels/document.xml.rels');
    if (!relationshipsOfType(rels, '/numbering', 'word').length) {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map(match => Number(match[1]));
      const id = (ids.length ? Math.max(...ids) : 0) + 1;
      zip.file('word/_rels/document.xml.rels', rels.replace('</Relationships>', `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`));
    }
    const types = await partText(zip, '[Content_Types].xml');
    if (!types.includes('/word/numbering.xml')) zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>'));
  }
  return numberingFor(existing);
}

// ---- editing ----

export type DocxEdit =
  | { op: 'replace'; find: string; replace: string; all?: boolean }
  | { op: 'append'; markdown: string }
  | { op: 'set_cell'; table: number; row: number; col: number; text: string };

export interface EditReport { replaced: number; appended: number; cells: number }

/** Apply edits to the main part (and text replacements to headers and footers too); the caller writes the result to a new file. */
export async function editDocx(zip: JSZip, edits: DocxEdit[]): Promise<EditReport> {
  const report: EditReport = { replaced: 0, appended: 0, cells: 0 };
  let document = await partText(zip, MAIN_PART);
  const rels = await partText(zip, 'word/_rels/document.xml.rels');
  const extraParts = [...relationshipsOfType(rels, '/header', 'word'), ...relationshipsOfType(rels, '/footer', 'word')];
  let numbering: Numbering | undefined;
  for (const edit of edits) {
    if (edit.op === 'replace') {
      if (!edit.find) throw new Error('replace 的 find 不能为空。');
      const all = edit.all !== false;
      const result = replaceInPart(document, 'w:p', 'w:t', edit.find, cleanText(edit.replace), all);
      document = result.xml;
      let count = result.count;
      for (const part of extraParts) {
        if (count && !all) break;
        const file = zip.file(part);
        if (!file) continue;
        const partResult = replaceInPart(await file.async('string'), 'w:p', 'w:t', edit.find, cleanText(edit.replace), all);
        if (partResult.count) { zip.file(part, partResult.xml); count += partResult.count; }
      }
      if (!count) throw new Error(`文档里没有找到「${edit.find}」。注意要和文档里的文字完全一致；先用 doc_read 看原文。`);
      report.replaced += count;
    } else if (edit.op === 'append') {
      const body = elementAt(document, document.indexOf('<w:body'), 'w:body');
      if (!body) throw new Error('文档没有正文。');
      numbering ??= await ensureNumbering(zip);
      const blocks = parseMarkdown(edit.markdown);
      const xml = blocksToXml(blocks, styleMap(await zip.file('word/styles.xml')?.async('string')), numbering);
      const sectAt = body.xml.search(/<w:sectPr(\s|>|\/)/);
      const insertAt = body.start + (sectAt >= 0 ? sectAt : body.xml.lastIndexOf('</w:body>'));
      document = document.slice(0, insertAt) + xml + document.slice(insertAt);
      report.appended += blocks.length;
    } else if (edit.op === 'set_cell') {
      const body = elementAt(document, document.indexOf('<w:body'), 'w:body');
      if (!body) throw new Error('文档没有正文。');
      const tables = children(body.xml, ['w:tbl'], 0, body.xml.length);
      const table = tables[edit.table - 1];
      if (!table) throw new Error(`文档里只有 ${tables.length} 个表格，没有第 ${edit.table} 个。`);
      const rows = children(table.block.xml, ['w:tr'], 0, table.block.xml.length);
      const row = rows[edit.row - 1];
      if (!row) throw new Error(`第 ${edit.table} 个表格只有 ${rows.length} 行。`);
      const cells = children(row.block.xml, ['w:tc'], 0, row.block.xml.length);
      const cell = cells[edit.col - 1];
      if (!cell) throw new Error(`第 ${edit.table} 个表格第 ${edit.row} 行只有 ${cells.length} 列。`);
      const rewritten = setCellText(cell.block.xml, cleanText(edit.text));
      const absolute = body.start + table.block.start + row.block.start + cell.block.start;
      document = document.slice(0, absolute) + rewritten + document.slice(absolute + cell.block.xml.length);
      report.cells++;
    }
  }
  zip.file(MAIN_PART, document);
  if (numbering) zip.file('word/numbering.xml', numbering.xml());
  return report;
}

/** One paragraph with the cell's first paragraph and run properties, holding the new text. */
function setCellText(cell: string, text: string): string {
  const paragraphs = children(cell, ['w:p'], 0, cell.length);
  const first = paragraphs[0]?.block;
  const pPr = first ? /<w:pPr>.*?<\/w:pPr>/s.exec(first.xml)?.[0] ?? '' : '';
  const rPr = first ? /<w:r>(<w:rPr>.*?<\/w:rPr>)/s.exec(first.xml)?.[1] ?? '' : '';
  const pieces = text.split('\n').map(piece => `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>`).join('<w:br/>');
  const replacement = `<w:p>${pPr}<w:r>${rPr}${pieces}</w:r></w:p>`;
  if (!first) return cell.replace(/<\/w:tc>$/, `${replacement}</w:tc>`);
  const last = paragraphs[paragraphs.length - 1]!.block;
  return cell.slice(0, first.start) + replacement + cell.slice(last.end);
}
