import { type Block, children, elementAt, elements, escapeXml, unescapeXml } from './xml.js';

/**
 * Text replacement inside one WordprocessingML or DrawingML paragraph. Word
 * splits a sentence into runs at every formatting or spell-check boundary, so
 * a phrase is matched on the paragraph's joined text and written back into
 * the run where it starts; the runs it spilled into lose those characters and
 * keep their formatting.
 */

interface Segment { start: number; end: number; open: string; text: string }

/** The `<t>` segments of a paragraph in order, skipping deleted text of tracked changes. */
export function textSegments(paragraph: string, tTag: string): Segment[] {
  const segments: Segment[] = [];
  const open = new RegExp(`<${tTag}(\\s[^>]*)?>`, 'g');
  let match: RegExpExecArray | null;
  while ((match = open.exec(paragraph))) {
    if (match[0].endsWith('/>')) { segments.push({ start: match.index, end: match.index + match[0].length, open: match[0], text: '' }); continue; }
    const close = paragraph.indexOf(`</${tTag}>`, match.index);
    if (close < 0) break;
    const raw = paragraph.slice(match.index + match[0].length, close);
    segments.push({ start: match.index, end: close + tTag.length + 3, open: match[0], text: unescapeXml(raw) });
    open.lastIndex = close;
  }
  return segments;
}

export function paragraphText(paragraph: string, tTag: string): string {
  return textSegments(paragraph, tTag).map(segment => segment.text).join('');
}

function segmentXml(segment: Segment, tTag: string, text: string): string {
  let open = segment.open.replace(/\/>$/, '>');
  if (/\s/.test(text) && !/xml:space="preserve"/.test(open)) open = open.replace(/>$/, ' xml:space="preserve">');
  return `${open}${escapeXml(text)}</${tTag}>`;
}

/** Replace every (or the first) occurrence in one paragraph; returns the new XML and how many were replaced. */
export function replaceInParagraph(paragraph: string, tTag: string, find: string, replacement: string, all: boolean): { xml: string; count: number } {
  const segments = textSegments(paragraph, tTag);
  const text = segments.map(segment => segment.text).join('');
  if (!find || !text.includes(find)) return { xml: paragraph, count: 0 };
  const matches: [number, number][] = [];
  for (let from = 0; ;) {
    const at = text.indexOf(find, from);
    if (at < 0) break;
    matches.push([at, at + find.length]);
    from = at + find.length;
    if (!all) break;
  }
  // Walk the joined text once: characters inside a match are dropped, the replacement goes where the match starts.
  let xml = paragraph;
  let offset = 0;
  let next = 0;
  const edits: { index: number; text: string }[] = [];
  for (const [index, segment] of segments.entries()) {
    let out = '';
    let changed = false;
    for (let pos = offset; pos < offset + segment.text.length; pos++) {
      while (next < matches.length && matches[next]![1] <= pos) next++;
      const match = matches[next];
      if (match && pos >= match[0]) { changed = true; if (pos === match[0]) out += replacement; continue; }
      out += text[pos];
    }
    offset += segment.text.length;
    if (changed) edits.push({ index, text: out });
  }
  for (const edit of edits.reverse()) {
    const segment = segments[edit.index]!;
    xml = xml.slice(0, segment.start) + segmentXml(segment, tTag, edit.text) + xml.slice(segment.end);
  }
  return { xml, count: matches.length };
}

/** Replace across every paragraph of a part; paragraphs are `<pTag>` elements, text lives in `<tTag>`. */
export function replaceInPart(part: string, pTag: string, tTag: string, find: string, replacement: string, all: boolean): { xml: string; count: number } {
  let count = 0;
  let xml = part;
  const paragraphs = elements(xml, pTag);
  for (const paragraph of paragraphs.reverse()) {
    const result = replaceInParagraph(paragraph.xml, tTag, find, replacement, all);
    if (!result.count) continue;
    count += result.count;
    xml = xml.slice(0, paragraph.start) + result.xml + xml.slice(paragraph.end);
    if (!all) break;
  }
  return { xml, count };
}

export { children, elementAt, type Block };
