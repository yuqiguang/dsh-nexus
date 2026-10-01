import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';

/** The few XML helpers the Office Open XML handlers need; parts are handled as text, not as a DOM. */

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function unescapeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

/** One attribute of an element's opening tag. */
export function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`[\\s"']${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]!) : undefined;
}

export interface Block { start: number; end: number; xml: string }

/** The `<name …>…</name>` element starting at `start`, with nesting of the same name counted. */
export function elementAt(xml: string, start: number, name: string): Block | undefined {
  const token = new RegExp(`<(/?)${name}(?=[\\s>/])[^>]*?(/?)>`, 'g');
  token.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = token.exec(xml))) {
    if (match[1] === '/') { depth--; if (depth === 0) return { start, end: match.index + match[0].length, xml: xml.slice(start, match.index + match[0].length) }; }
    else if (match[2] !== '/') depth++;
    else if (depth === 0) return { start, end: match.index + match[0].length, xml: match[0] };
  }
  return undefined;
}

/** Every element of one name at any depth, in document order, without descending into a found element. */
export function elements(xml: string, name: string, from = 0, to = xml.length): Block[] {
  const found: Block[] = [];
  const open = new RegExp(`<${name}(?=[\\s>/])`, 'g');
  open.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) && match.index < to) {
    const block = elementAt(xml, match.index, name);
    if (!block) break;
    found.push(block);
    open.lastIndex = block.end;
  }
  return found;
}

/** The outermost elements of any of `names` between two offsets, in order: a body's paragraphs and tables, a cell's paragraphs. */
export function children(xml: string, names: string[], from: number, to: number): { name: string; block: Block }[] {
  const found: { name: string; block: Block }[] = [];
  const open = new RegExp(`<(${names.join('|')})(?=[\\s>/])`, 'g');
  open.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) && match.index < to) {
    const block = elementAt(xml, match.index, match[1]!);
    if (!block) break;
    found.push({ name: match[1]!, block });
    open.lastIndex = block.end;
  }
  return found;
}

/** The characters XML 1.0 cannot carry; Word refuses a file that contains them. */
export function cleanText(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '');
}

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export async function openZip(path: string): Promise<JSZip> {
  const bytes = await readFile(path);
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error(`文件超过 ${MAX_DOCUMENT_BYTES / 1024 / 1024} MiB，请在本机处理。`);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('这不是 Office Open XML 文件（docx、xlsx、pptx 都是 zip 包）；旧的 doc、xls、ppt 要先用 doc_convert 转成新格式。');
  return JSZip.loadAsync(bytes);
}

export async function partText(zip: JSZip, name: string): Promise<string> {
  const file = zip.file(name);
  if (!file) throw new Error(`文件里没有 ${name}，不是预期的格式。`);
  return file.async('string');
}

export function saveZip(zip: JSZip): Promise<Buffer> {
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** `Target` of the relationship with the given `Id`, resolved against the part's directory. */
export function relationshipTarget(rels: string, id: string, base: string): string | undefined {
  const match = new RegExp(`<Relationship\\s[^>]*Id="${id}"[^>]*>`).exec(rels);
  const target = match && attribute(match[0], 'Target');
  return target ? resolvePart(base, target) : undefined;
}

export function relationshipsOfType(rels: string, type: string, base: string): string[] {
  const found: string[] = [];
  for (const match of rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const attrType = attribute(match[0], 'Type');
    const target = attribute(match[0], 'Target');
    if (attrType && attrType.endsWith(type) && target) found.push(resolvePart(base, target));
  }
  return found;
}

export function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base ? base.split('/') : [];
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.join('/');
}

export function dirOf(part: string): string {
  const slash = part.lastIndexOf('/');
  return slash < 0 ? '' : part.slice(0, slash);
}
