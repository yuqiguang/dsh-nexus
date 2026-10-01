import JSZip from 'jszip';
import { renderTable } from './markdown.js';
import { attribute, cleanText, elementAt, elements, escapeXml, partText, relationshipTarget, saveZip, unescapeXml } from './xml.js';

/** Workbooks as text: sheets read into tables, new workbooks from rows, cells set in place with styles kept. */

const MAX_CELLS_READ = 20_000;
const MAX_ROWS_WRITE = 50_000;
const MAX_COLS = 16_384;

export interface Sheet { name: string; part: string; rid: string }

export async function listSheets(zip: JSZip): Promise<Sheet[]> {
  const workbook = await partText(zip, 'xl/workbook.xml');
  const rels = await partText(zip, 'xl/_rels/workbook.xml.rels');
  const sheets: Sheet[] = [];
  for (const sheet of workbook.matchAll(/<sheet\s[^>]*\/>/g)) {
    const name = attribute(sheet[0], 'name') ?? '';
    const rid = attribute(sheet[0], 'r:id') ?? attribute(sheet[0], 'id') ?? '';
    const part = relationshipTarget(rels, rid, 'xl');
    if (part) sheets.push({ name, part, rid });
  }
  if (!sheets.length) throw new Error('工作簿里没有工作表。');
  return sheets;
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (!xml) return [];
  return elements(xml, 'si').map(si => [...si.xml.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map(match => unescapeXml(match[1] ?? '')).join(''));
}

export function columnIndex(letters: string): number {
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index;
}

export function columnName(index: number): string {
  let name = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function parseRef(ref: string): { col: number; row: number } {
  const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref.trim());
  if (!match) throw new Error(`单元格地址要写成 B3 这样：${ref}`);
  const col = columnIndex(match[1]!);
  const row = Number(match[2]);
  if (col < 1 || col > MAX_COLS || row < 1 || row > 1_048_576) throw new Error(`单元格地址超出范围：${ref}`);
  return { col, row };
}

/** A cell as text the way a person reads it: shared and inline strings, numbers, booleans, errors, formulas shown as `=…`. */
function cellText(cell: string, strings: string[], showFormulas: boolean): string {
  const open = /<c\s[^>]*>|<c\/>/.exec(cell)![0];
  const type = attribute(open, 't');
  const formula = showFormulas ? /<f(?:\s[^>]*)?>(.*?)<\/f>/s.exec(cell)?.[1] : undefined;
  if (formula !== undefined) return `=${unescapeXml(formula)}`;
  const value = /<v(?:\s[^>]*)?>(.*?)<\/v>/s.exec(cell)?.[1];
  if (type === 's') return strings[Number(value)] ?? '';
  if (type === 'inlineStr') return [...cell.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map(match => unescapeXml(match[1] ?? '')).join('');
  if (value === undefined) return '';
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'e') return unescapeXml(value);
  const number = Number(value);
  return Number.isFinite(number) ? String(number) : unescapeXml(value);
}

export interface SheetText { name: string; rows: string[][]; cells: number; truncated: boolean }

export async function readSheet(zip: JSZip, sheet: Sheet, strings: string[], showFormulas: boolean, budget: { cells: number }): Promise<SheetText> {
  const xml = await partText(zip, sheet.part);
  const rows: string[][] = [];
  let cells = 0;
  let truncated = false;
  let maxCol = 0;
  for (const row of elements(xml, 'row')) {
    const rowNumber = Number(attribute(row.xml, 'r') ?? rows.length + 1);
    const values: string[] = [];
    for (const cell of elements(row.xml, 'c')) {
      const ref = attribute(cell.xml, 'r') ?? '';
      const col = /^[A-Za-z]+/.exec(ref) ? columnIndex(/^[A-Za-z]+/.exec(ref)![0]) : values.length + 1;
      const text = cellText(cell.xml, strings, showFormulas);
      if (!text) continue;
      values[col - 1] = text;
      maxCol = Math.max(maxCol, col);
      cells++;
      if (++budget.cells >= MAX_CELLS_READ) { truncated = true; break; }
    }
    while (rows.length < rowNumber - 1) rows.push([]);
    rows.push(values);
    if (truncated) break;
  }
  for (const row of rows) for (let i = 0; i < row.length; i++) row[i] ??= '';
  return { name: sheet.name, rows: rows.map(row => [...row, ...Array.from({ length: Math.max(0, maxCol - row.length) }, () => '')]), cells, truncated };
}

export interface XlsxText { markdown: string; sheets: { name: string; rows: number; cells: number }[]; truncated: boolean }

/** The whole workbook as Markdown: one section per sheet, rows as a table with the row number in the first column. */
export async function readXlsx(zip: JSZip, options: { sheet?: string; formulas?: boolean; maxRows?: number } = {}): Promise<XlsxText> {
  const sheets = await listSheets(zip);
  const wanted = options.sheet ? sheets.filter(item => item.name === options.sheet) : sheets;
  if (!wanted.length) throw new Error(`没有名为「${options.sheet}」的工作表，有：${sheets.map(item => item.name).join('、')}`);
  const strings = await sharedStrings(zip);
  const budget = { cells: 0 };
  const out: string[] = [];
  const summary: XlsxText['sheets'] = [];
  let truncated = false;
  for (const sheet of wanted) {
    const text = await readSheet(zip, sheet, strings, options.formulas === true, budget);
    truncated ||= text.truncated;
    // Trailing empty rows carry nothing; leading ones keep their numbers so B3 still means B3.
    let last = text.rows.length;
    while (last > 0 && text.rows[last - 1]!.every(cell => !cell)) last--;
    const rows = text.rows.slice(0, last);
    const limit = options.maxRows && options.maxRows > 0 ? options.maxRows : rows.length;
    const shown = rows.slice(0, limit);
    summary.push({ name: sheet.name, rows: last, cells: text.cells });
    out.push(`## 工作表「${sheet.name}」（${last} 行，${text.cells} 个非空单元格）`);
    if (!shown.length) { out.push('（空）'); continue; }
    const width = Math.max(...shown.map(row => row.length));
    const header = ['', ...Array.from({ length: width }, (_item, i) => columnName(i + 1))];
    out.push(renderTable([header, ...shown.map((row, i) => [String(i + 1), ...Array.from({ length: width }, (_item, c) => row[c] ?? '')])]));
    if (shown.length < rows.length) out.push(`（只显示前 ${shown.length} 行，共 ${last} 行；要看后面的行用 max_rows 或 sheet 参数）`);
    if (text.truncated) out.push(`（单元格超过 ${MAX_CELLS_READ} 个，后面的没有读取）`);
  }
  return { markdown: out.join('\n\n'), sheets: summary, truncated };
}

// ---- writing ----

export type CellValue = string | number | boolean | null;

function cellXml(ref: string, value: CellValue, style?: string): string {
  const s = style ? ` s="${style}"` : '';
  if (value === null || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"${s}><v>${value}</v></c>` : '';
  if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  const text = cleanText(value);
  if (text.startsWith('=') && text.length > 1) return `<c r="${ref}"${s}><f>${escapeXml(text.slice(1))}</f></c>`;
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

function sheetXml(rows: CellValue[][]): string {
  if (rows.length > MAX_ROWS_WRITE) throw new Error(`一张表最多写 ${MAX_ROWS_WRITE} 行。`);
  const lines: string[] = [];
  let maxCol = 1;
  for (const [r, row] of rows.entries()) {
    if (row.length > MAX_COLS) throw new Error('列数超过 Excel 上限。');
    maxCol = Math.max(maxCol, row.length);
    const cells = row.map((value, c) => cellXml(`${columnName(c + 1)}${r + 1}`, value)).join('');
    lines.push(`<row r="${r + 1}">${cells}</row>`);
  }
  const dimension = `A1:${columnName(maxCol)}${Math.max(1, rows.length)}`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="${dimension}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${lines.join('')}</sheetData></worksheet>`;
}

export interface SheetInput { name: string; rows: CellValue[][] }

export function sheetName(name: string, index: number): string {
  const clean = cleanText(name).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31);
  return clean || `Sheet${index + 1}`;
}

/** A new workbook: strings inline, numbers as numbers, `=SUM(B2:B9)` as a formula Excel computes when it opens the file. */
export async function createXlsx(sheets: SheetInput[]): Promise<Buffer> {
  if (!sheets.length) throw new Error('至少要有一张工作表。');
  const zip = new JSZip();
  const names = new Set<string>();
  const entries = sheets.map((sheet, i) => {
    let name = sheetName(sheet.name, i);
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${name.slice(0, 28)} ${n}`;
    names.add(name.toLowerCase());
    return { name, part: `xl/worksheets/sheet${i + 1}.xml`, rid: `rId${i + 1}`, rows: sheet.rows };
  });
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${entries.map(entry => `<Override PartName="/${entry.part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${entries.map((entry, i) => `<sheet name="${escapeXml(entry.name)}" sheetId="${i + 1}" r:id="${entry.rid}"/>`).join('')}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries.map(entry => `<Relationship Id="${entry.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${entry.part.slice(3)}"/>`).join('')}<Relationship Id="rId${entries.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  for (const entry of entries) zip.file(entry.part, sheetXml(entry.rows));
  return saveZip(zip);
}

// ---- editing ----

export type XlsxEdit =
  | { op: 'set'; sheet?: string; cell: string; value: CellValue }
  | { op: 'append'; sheet?: string; rows: CellValue[][] };

export interface XlsxEditReport { set: number; appended: number }

/** Set cells and append rows in an existing sheet; styles on a set cell stay, and the workbook recalculates when opened. */
export async function editXlsx(zip: JSZip, edits: XlsxEdit[]): Promise<XlsxEditReport> {
  const sheets = await listSheets(zip);
  const report: XlsxEditReport = { set: 0, appended: 0 };
  const parts = new Map<string, string>();
  const partOf = async (name: string | undefined) => {
    const sheet = name ? sheets.find(item => item.name === name) : sheets[0]!;
    if (!sheet) throw new Error(`没有名为「${name}」的工作表，有：${sheets.map(item => item.name).join('、')}`);
    if (!parts.has(sheet.part)) parts.set(sheet.part, await partText(zip, sheet.part));
    return sheet.part;
  };
  for (const edit of edits) {
    const part = await partOf(edit.sheet);
    let xml = parts.get(part)!;
    if (edit.op === 'set') {
      const { col, row } = parseRef(edit.cell);
      xml = setCell(xml, col, row, edit.value);
      report.set++;
    } else {
      if (edit.rows.length > MAX_ROWS_WRITE) throw new Error(`一次最多追加 ${MAX_ROWS_WRITE} 行。`);
      let last = 0;
      for (const row of elements(xml, 'row')) last = Math.max(last, Number(attribute(row.xml, 'r') ?? 0));
      for (const values of edit.rows) {
        last++;
        const cells = values.map((value, c) => cellXml(`${columnName(c + 1)}${last}`, value)).join('');
        xml = xml.replace('</sheetData>', `<row r="${last}">${cells}</row></sheetData>`);
        if (!xml.includes('</sheetData>')) xml = xml.replace('<sheetData/>', `<sheetData><row r="${last}">${cells}</row></sheetData>`);
      }
      report.appended += edit.rows.length;
    }
    parts.set(part, xml);
  }
  for (const [part, xml] of parts) zip.file(part, refreshDimension(xml));
  const workbook = await partText(zip, 'xl/workbook.xml');
  if (!/<calcPr\s[^>]*fullCalcOnLoad="1"/.test(workbook)) {
    zip.file('xl/workbook.xml', /<calcPr\s[^>]*\/>/.test(workbook) ? workbook.replace(/<calcPr\s[^>]*\/>/, match => match.replace(/\/>$/, ' fullCalcOnLoad="1"/>').replace(/fullCalcOnLoad="[^"]*"\s+fullCalcOnLoad/, 'fullCalcOnLoad'))
      : workbook.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>'));
  }
  return report;
}

function setCell(xml: string, col: number, row: number, value: CellValue): string {
  const ref = `${columnName(col)}${row}`;
  const rows = elements(xml, 'row');
  const existing = rows.find(item => Number(attribute(item.xml, 'r')) === row);
  if (!existing) {
    const after = rows.filter(item => Number(attribute(item.xml, 'r')) < row).pop();
    const insertAt = after ? after.end : xml.indexOf('<sheetData') + (/<sheetData[^>]*>/.exec(xml)?.[0].length ?? 0);
    if (xml.includes('<sheetData/>')) return xml.replace('<sheetData/>', `<sheetData><row r="${row}">${cellXml(ref, value)}</row></sheetData>`);
    return xml.slice(0, insertAt) + `<row r="${row}">${cellXml(ref, value)}</row>` + xml.slice(insertAt);
  }
  const cells = elements(existing.xml, 'c');
  const target = cells.find(item => attribute(item.xml, 'r') === ref);
  const style = target ? attribute(/<c\s[^>]*>|<c\/>/.exec(target.xml)![0], 's') : undefined;
  const fresh = cellXml(ref, value, style) || (style ? `<c r="${ref}" s="${style}"/>` : '');
  let rowXml: string;
  if (target) rowXml = existing.xml.slice(0, target.start) + fresh + existing.xml.slice(target.end);
  else {
    const before = cells.filter(item => columnIndex(/^[A-Za-z]+/.exec(attribute(item.xml, 'r') ?? 'A')![0]) < col).pop();
    const at = before ? before.end : (/<row\s[^>]*>/.exec(existing.xml)?.[0].length ?? 0);
    rowXml = existing.xml.slice(0, at) + fresh + existing.xml.slice(at);
  }
  // A row that declared how many columns it spans must not claim less than it now holds.
  rowXml = rowXml.replace(/^<row\s[^>]*spans="[^"]*"/, match => match.replace(/\sspans="[^"]*"/, ''));
  return xml.slice(0, existing.start) + rowXml + xml.slice(existing.end);
}

function refreshDimension(xml: string): string {
  let maxRow = 0;
  let maxCol = 0;
  for (const row of elements(xml, 'row')) {
    maxRow = Math.max(maxRow, Number(attribute(row.xml, 'r') ?? 0));
    for (const cell of elements(row.xml, 'c')) {
      const letters = /^[A-Za-z]+/.exec(attribute(cell.xml, 'r') ?? '')?.[0];
      if (letters) maxCol = Math.max(maxCol, columnIndex(letters));
    }
  }
  if (!maxRow || !maxCol) return xml;
  const dimension = `<dimension ref="A1:${columnName(maxCol)}${maxRow}"/>`;
  return /<dimension\s[^>]*\/>/.test(xml) ? xml.replace(/<dimension\s[^>]*\/>/, dimension) : xml;
}

export { elementAt };
