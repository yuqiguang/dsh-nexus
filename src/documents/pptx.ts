import JSZip from 'jszip';
import { replaceInPart } from './ooxml-text.js';
import { attribute, cleanText, elements, partText, relationshipTarget, relationshipsOfType, unescapeXml } from './xml.js';

type PptxGenJSInstance = InstanceType<typeof import('pptxgenjs').default>;

/** Presentations as text: slide titles, body text and notes read out; new decks built with pptxgenjs; text replaced in place. */

interface SlidePart { index: number; part: string }

export async function listSlides(zip: JSZip): Promise<SlidePart[]> {
  const presentation = await partText(zip, 'ppt/presentation.xml');
  const rels = await partText(zip, 'ppt/_rels/presentation.xml.rels');
  const slides: SlidePart[] = [];
  for (const [i, id] of [...presentation.matchAll(/<p:sldId\s[^>]*\/>/g)].entries()) {
    const rid = attribute(id[0], 'r:id') ?? attribute(id[0], 'id') ?? '';
    const part = relationshipTarget(rels, rid, 'ppt');
    if (part) slides.push({ index: i + 1, part });
  }
  return slides;
}

function shapeText(shape: string): string {
  return elements(shape, 'a:p').map(paragraph => {
    const level = Number(attribute(/<a:pPr\s[^>]*>|<a:pPr\s[^>]*\/>/.exec(paragraph.xml)?.[0] ?? '', 'lvl') ?? '0');
    const text = [...paragraph.xml.matchAll(/<a:t(?:\s[^>]*)?>(.*?)<\/a:t>|<a:br\/>/gs)].map(match => match[0] === '<a:br/>' ? '\n' : unescapeXml(match[1] ?? '')).join('');
    return text.trim() ? `${'  '.repeat(Math.min(level, 4))}${text.trim()}` : '';
  }).filter(Boolean).join('\n');
}

export interface PptxText { markdown: string; slides: number }

export async function readPptx(zip: JSZip): Promise<PptxText> {
  const slides = await listSlides(zip);
  const out: string[] = [];
  for (const slide of slides) {
    const xml = await partText(zip, slide.part);
    const lines: string[] = [];
    let title: string | undefined;
    for (const shape of elements(xml, 'p:sp')) {
      const kind = attribute(/<p:ph\s[^>]*\/>|<p:ph\s[^>]*>/.exec(shape.xml)?.[0] ?? '', 'type');
      const text = shapeText(shape.xml);
      if (!text) continue;
      if ((kind === 'title' || kind === 'ctrTitle') && title === undefined) title = text.replace(/\n/g, ' ');
      else lines.push(text.split('\n').map(line => `- ${line}`).join('\n'));
    }
    for (const frame of elements(xml, 'p:graphicFrame')) {
      const rows = elements(frame.xml, 'a:tr').map(row => elements(row.xml, 'a:tc').map(cell => shapeText(cell.xml).replace(/\n/g, ' ')));
      if (rows.length) lines.push(rows.map(row => `| ${row.join(' | ')} |`).join('\n'));
    }
    if (/<p:pic>/.test(xml)) lines.push('- [图片]');
    const relsPart = `${slide.part.replace(/([^/]+)$/, '_rels/$1')}.rels`;
    const rels = await zip.file(relsPart)?.async('string');
    const notesPart = rels ? relationshipsOfType(rels, '/notesSlide', 'ppt/slides')[0] : undefined;
    const notes = notesPart ? await zip.file(notesPart)?.async('string') : undefined;
    const noteText = notes ? elements(notes, 'p:sp').filter(shape => attribute(/<p:ph\s[^>]*\/?>/.exec(shape.xml)?.[0] ?? '', 'type') === 'body').map(shape => shapeText(shape.xml)).join('\n').trim() : '';
    out.push([`## 第 ${slide.index} 页${title ? `：${title}` : ''}`, ...lines, ...(noteText ? [`备注：${noteText}`] : [])].join('\n'));
  }
  return { markdown: out.join('\n\n') || '（没有幻灯片）', slides: slides.length };
}

// ---- writing ----

export interface SlideInput { title?: string; bullets?: string[]; notes?: string; table?: string[][] }

/** A plain deck: a title slide when `title` is given, then one slide per entry with a heading and bullets. */
export async function createPptx(deck: { title?: string; subtitle?: string; slides: SlideInput[] }): Promise<Buffer> {
  if (!deck.slides.length && !deck.title) throw new Error('至少要有一页。');
  if (deck.slides.length > 200) throw new Error('一次最多生成 200 页。');
  const module = await import('pptxgenjs') as unknown as { default: new () => PptxGenJSInstance };
  const pres = new module.default();
  pres.layout = 'LAYOUT_16x9';
  const font = 'Microsoft YaHei';
  if (deck.title) {
    const slide = pres.addSlide();
    slide.addText(cleanText(deck.title), { x: 0.5, y: 1.6, w: 9, h: 1.2, fontSize: 36, bold: true, fontFace: font, align: 'center' });
    if (deck.subtitle) slide.addText(cleanText(deck.subtitle), { x: 0.5, y: 2.9, w: 9, h: 0.8, fontSize: 20, fontFace: font, align: 'center', color: '666666' });
  }
  for (const input of deck.slides) {
    const slide = pres.addSlide();
    let y = 0.4;
    if (input.title) { slide.addText(cleanText(input.title), { x: 0.5, y, w: 9, h: 0.9, fontSize: 28, bold: true, fontFace: font }); y += 1.0; }
    const bullets = (input.bullets ?? []).map(item => cleanText(item)).filter(Boolean);
    if (bullets.length) {
      slide.addText(bullets.map((text, i) => ({ text, options: { bullet: true, breakLine: i < bullets.length - 1 } })),
        { x: 0.5, y, w: 9, h: Math.min(4.6, 0.45 * bullets.length + 0.2), fontSize: bullets.length > 8 ? 14 : 18, fontFace: font, valign: 'top' });
      y += Math.min(4.6, 0.45 * bullets.length + 0.3);
    }
    if (input.table?.length) {
      const rows = input.table.map((row, r) => row.map(cell => ({ text: cleanText(String(cell)), options: { bold: r === 0, fontSize: 12, fontFace: font } })));
      slide.addTable(rows, { x: 0.5, y, w: 9, border: { type: 'solid', pt: 0.5, color: '999999' } });
    }
    if (input.notes) slide.addNotes(cleanText(input.notes));
  }
  return pres.write({ outputType: 'nodebuffer' }) as Promise<Buffer>;
}

// ---- editing ----

export type PptxEdit = { op: 'replace'; find: string; replace: string; all?: boolean; slide?: number };

export async function editPptx(zip: JSZip, edits: PptxEdit[]): Promise<{ replaced: number }> {
  const slides = await listSlides(zip);
  let replaced = 0;
  for (const edit of edits) {
    if (!edit.find) throw new Error('replace 的 find 不能为空。');
    const targets = edit.slide ? slides.filter(slide => slide.index === edit.slide) : slides;
    if (!targets.length) throw new Error(`没有第 ${edit.slide} 页，共 ${slides.length} 页。`);
    let count = 0;
    for (const slide of targets) {
      if (count && edit.all === false) break;
      const xml = await partText(zip, slide.part);
      const result = replaceInPart(xml, 'a:p', 'a:t', edit.find, cleanText(edit.replace), edit.all !== false);
      if (result.count) { zip.file(slide.part, result.xml); count += result.count; }
    }
    if (!count) throw new Error(`幻灯片里没有找到「${edit.find}」；先用 doc_read 看原文，要和原文完全一致。`);
    replaced += count;
  }
  return { replaced };
}
