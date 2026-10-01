/** A small Markdown reader for what office documents carry: headings, paragraphs, lists, tables, code, bold and italic. */

export interface Inline { text: string; bold?: boolean; italic?: boolean; code?: boolean }

export type MarkdownBlock =
  | { type: 'heading'; level: number; inlines: Inline[] }
  | { type: 'paragraph'; inlines: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'table'; rows: Inline[][][] }
  | { type: 'code'; text: string };

/** `**bold**`, `*italic*`, `` `code` ``; anything else is plain text. */
export function parseInlines(text: string): Inline[] {
  const inlines: Inline[] = [];
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)(?<!\s)\3|`([^`]+)`/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) inlines.push({ text: text.slice(last, match.index) });
    if (match[2] !== undefined) inlines.push({ text: match[2], bold: true });
    else if (match[4] !== undefined) inlines.push({ text: match[4], italic: true });
    else inlines.push({ text: match[5]!, code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) inlines.push({ text: text.slice(last) });
  return inlines;
}

export function plain(inlines: Inline[]): string { return inlines.map(item => item.text).join(''); }

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim());
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', inlines: parseInlines(paragraph.join('\n')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1]!.length, inlines: parseInlines(heading[2]!) }); continue; }
    if (line.includes('|') && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]!)) {
      flush();
      const rows: Inline[][][] = [tableCells(line).map(parseInlines)];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(tableCells(lines[i]!).map(parseInlines));
      i--;
      blocks.push({ type: 'table', rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const items: Inline[][] = [parseInlines(item[3]!)];
      for (i++; i < lines.length; i++) {
        const next = ITEM.exec(lines[i]!);
        if (!next || (next[2] !== undefined) !== ordered) break;
        items.push(parseInlines(next[3]!));
      }
      i--;
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    paragraph.push(line.replace(/^\s*>\s?/, '').trim());
  }
  flush();
  return blocks;
}

/** The inverse, for what the readers produce: marks hug the text so the result parses back. */
export function renderInlines(inlines: Inline[]): string {
  return inlines.map(item => {
    if (!item.text) return '';
    if (item.code) return `\`${item.text}\``;
    if (!item.text.trim() || (!item.bold && !item.italic)) return item.text;
    const lead = /^\s*/.exec(item.text)![0];
    const trail = /\s*$/.exec(item.text)![0];
    const core = item.text.slice(lead.length, item.text.length - trail.length);
    return lead + (item.bold && item.italic ? `***${core}***` : item.bold ? `**${core}**` : `*${core}*`) + trail;
  }).join('');
}

export function renderTable(rows: string[][]): string {
  if (!rows.length) return '';
  const width = Math.max(...rows.map(row => row.length));
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_item, i) => cell(row[i] ?? '')).join(' | ')} |`;
  return [line(rows[0]!), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}
