import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import JSZip from 'jszip';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comScript, detectConverters, routesFor, type Converter } from '../src/documents/converters.js';
import { createDocx, editDocx, readDocx } from '../src/documents/docx.js';
import { DocumentService, markdownToHtml, parseCsv, plainText } from '../src/documents/index.js';
import { parseInlines, parseMarkdown, renderInlines, renderTable } from '../src/documents/markdown.js';
import { replaceInParagraph } from '../src/documents/ooxml-text.js';
import { pandocAsset } from '../src/documents/pandoc.js';
import { createPptx, editPptx, readPptx } from '../src/documents/pptx.js';
import { columnName, createXlsx, editXlsx, parseRef, readXlsx } from '../src/documents/xlsx.js';
import { elementAt, elements } from '../src/documents/xml.js';

const MARKDOWN = `# 季度报告

这是**重点**内容，还有*强调*和\`代码\`。

## 进展

- 第一项
- 第二项 **加粗**

1. 甲
2. 乙

| 项目 | 金额 |
| --- | --- |
| 房租 | 3000 |
| 水电 | 200 |

\`\`\`
raw code
\`\`\`
`;

test('markdown parses the office subset and renders back', () => {
  const blocks = parseMarkdown(MARKDOWN);
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'heading', 'list', 'list', 'table', 'code']);
  assert.deepEqual(parseInlines('这是**重点**内容，还有*强调*和`代码`。'), [{ text: '这是' }, { text: '重点', bold: true }, { text: '内容，还有' }, { text: '强调', italic: true }, { text: '和' }, { text: '代码', code: true }, { text: '。' }]);
  assert.equal(renderInlines([{ text: ' 粗 ', bold: true }, { text: 'x' }]), ' **粗** x');
  const table = blocks[5] as { rows: { text: string }[][][] };
  assert.deepEqual(table.rows.map(row => row.map(cell => cell.map(item => item.text).join(''))), [['项目', '金额'], ['房租', '3000'], ['水电', '200']]);
  assert.equal(renderTable([['a|b', 'c'], ['1']]), '| a\\|b | c |\n| --- | --- |\n| 1 |  |');
  assert.equal((blocks[3] as { ordered: boolean }).ordered, false);
  assert.equal((blocks[4] as { ordered: boolean }).ordered, true);
});

test('xml helpers find nested elements and text replacement spans runs while keeping formatting', () => {
  const xml = '<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc>inner</w:tc></w:tr></w:tbl></w:tc><w:tc>b</w:tc></w:tr></w:tbl>';
  const outer = elementAt(xml, 0, 'w:tbl')!;
  assert.equal(outer.end, xml.length, 'nested tables of the same name are counted');
  assert.equal(elements(xml, 'w:tbl').length, 1, 'found elements are not descended into');
  const paragraph = '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>张三</w:t></w:r><w:r><w:t xml:space="preserve"> 先生你好</w:t></w:r><w:r><w:t>，张三</w:t></w:r></w:p>';
  const result = replaceInParagraph(paragraph, 'w:t', '张三 先生', '李四 女士', true);
  assert.equal(result.count, 1);
  assert.equal(result.xml, '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">李四 女士</w:t></w:r><w:r><w:t xml:space="preserve">你好</w:t></w:r><w:r><w:t>，张三</w:t></w:r></w:p>');
  const all = replaceInParagraph(paragraph, 'w:t', '张三', '王五', true);
  assert.equal(all.count, 2);
  assert.equal(all.xml, '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>王五</w:t></w:r><w:r><w:t xml:space="preserve"> 先生你好</w:t></w:r><w:r><w:t>，王五</w:t></w:r></w:p>');
  assert.equal(replaceInParagraph(paragraph, 'w:t', '张三', '王五', false).count, 1);
  assert.equal(replaceInParagraph(paragraph, 'w:t', '<b>', '&', true).count, 0);
  const special = replaceInParagraph('<w:p><w:r><w:t>a &amp; b</w:t></w:r></w:p>', 'w:t', 'a & b', 'x < y', true);
  assert.equal(special.xml, '<w:p><w:r><w:t xml:space="preserve">x &lt; y</w:t></w:r></w:p>', 'entities decode for matching and encode on write');
});

test('docx: create from markdown, read back, edit with formatting kept, and build on a template', async () => {
  const bytes = await createDocx(MARKDOWN);
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(zip.file('word/document.xml') && zip.file('word/styles.xml') && zip.file('word/numbering.xml') && zip.file('[Content_Types].xml'));
  const text = await readDocx(zip);
  assert.equal(text.tables, 1);
  assert.equal(text.markdown, ['# 季度报告', '', '这是**重点**内容，还有`代码`。'.replace('`代码`', '代码').replace('还有', '还有*强调*和'), '', '## 进展', '', '- 第一项', '- 第二项 **加粗**', '', '1. 甲', '2. 乙', '',
    '| 项目 | 金额 |', '| --- | --- |', '| 房租 | 3000 |', '| 水电 | 200 |', '', 'raw code'].join('\n'));
  const report = await editDocx(zip, [{ op: 'replace', find: '房租', replace: '房屋租金' }, { op: 'set_cell', table: 1, row: 2, col: 2, text: '3500' }, { op: 'append', markdown: '## 结论\n\n1. 完成' }]);
  assert.deepEqual(report, { replaced: 1, appended: 2, cells: 1 });
  const edited = await readDocx(await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' })));
  assert.match(edited.markdown, /\| 房屋租金 \| 3500 \|/);
  assert.match(edited.markdown, /## 结论\n\n1\. 完成$/);
  const document = await zip.file('word/document.xml')!.async('string');
  assert.match(document, /<w:pStyle w:val="Heading1"\/>/);
  const numIds = [...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map(match => match[1]);
  assert.equal(new Set(numIds).size, 3, 'bullets, the first ordered list and the appended one each have their own numbering instance');
  assert.match(await zip.file('word/numbering.xml')!.async('string'), new RegExp(`<w:num w:numId="${numIds[numIds.length - 1]}"><w:abstractNumId w:val="\\d+"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>`), 'the appended list restarts at 1');
  await assert.rejects(editDocx(zip, [{ op: 'replace', find: '不存在的文字', replace: 'x' }]), /没有找到/);
  await assert.rejects(editDocx(zip, [{ op: 'set_cell', table: 2, row: 1, col: 1, text: 'x' }]), /只有 1 个表格/);
  // A template: its section (page size) and heading style ids survive, its body is replaced.
  const template = new JSZip();
  template.file('[Content_Types].xml', '<Types><Override PartName="/word/document.xml" ContentType="x"/></Types>');
  template.file('word/_rels/document.xml.rels', '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
  template.file('word/styles.xml', '<w:styles><w:style w:type="paragraph" w:styleId="Titre1"><w:name w:val="heading 1"/></w:style><w:style w:type="table" w:styleId="Grille"><w:name w:val="Table Grid"/></w:style></w:styles>');
  template.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>旧内容</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>');
  const fromTemplate = await JSZip.loadAsync(await createDocx('# 新标题\n\n正文\n\n- 项\n\n| a |\n| --- |\n| 1 |', template));
  const body = await fromTemplate.file('word/document.xml')!.async('string');
  assert.doesNotMatch(body, /旧内容/);
  assert.match(body, /<w:pStyle w:val="Titre1"\/>/);
  assert.match(body, /<w:tblStyle w:val="Grille"\/>/);
  assert.match(body, /<w:pgSz w:w="12240"/);
  assert.ok(fromTemplate.file('word/numbering.xml'), 'a numbering part is added for the list');
  assert.match(await fromTemplate.file('word/_rels/document.xml.rels')!.async('string'), /numbering\.xml/);
  assert.match(await fromTemplate.file('[Content_Types].xml')!.async('string'), /numbering\+xml/);
});

test('xlsx: create with formulas, read as tables, edit cells and rows keeping styles', async () => {
  const bytes = await createXlsx([{ name: '预算', rows: [['项目', '金额'], ['房租', 3000], ['水电', 200.5], ['合计', '=SUM(B2:B3)'], ['付清', true]] }, { name: 'a/b?', rows: [] }]);
  const zip = await JSZip.loadAsync(bytes);
  const text = await readXlsx(zip, { formulas: true });
  assert.deepEqual(text.sheets, [{ name: '预算', rows: 5, cells: 10 }, { name: 'a b', rows: 0, cells: 0 }]);
  assert.equal(text.markdown.split('\n\n')[1], ['|  | A | B |', '| --- | --- | --- |', '| 1 | 项目 | 金额 |', '| 2 | 房租 | 3000 |', '| 3 | 水电 | 200.5 |', '| 4 | 合计 | =SUM(B2:B3) |', '| 5 | 付清 | TRUE |'].join('\n'));
  assert.match((await readXlsx(zip, { sheet: '预算', maxRows: 2 })).markdown, /只显示前 2 行，共 5 行/);
  await assert.rejects(readXlsx(zip, { sheet: '没有' }), /没有名为/);
  // A sheet the way Excel writes it: shared strings, styles, spans and a dimension.
  const excel = new JSZip();
  excel.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>');
  excel.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  excel.file('xl/sharedStrings.xml', '<sst><si><t>名字</t></si><si><r><t>富</t></r><r><t>文本</t></r></si></sst>');
  excel.file('xl/worksheets/sheet1.xml', '<worksheet><dimension ref="A1:B2"/><sheetData><row r="1" spans="1:2"><c r="A1" t="s" s="3"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="5"><v>1.5</v></c><c r="B2"><f>A2*2</f><v>3</v></c></row></sheetData></worksheet>');
  const before = await readXlsx(excel);
  assert.match(before.markdown, /\| 1 \| 名字 \| 富文本 \|\n\| 2 \| 1.5 \| 3 \|/);
  const report = await editXlsx(excel, [{ op: 'set', cell: 'A2', value: '改' }, { op: 'set', cell: 'C1', value: 7 }, { op: 'set', cell: 'B4', value: '=A2' }, { op: 'append', rows: [['x', 1], ['y', '=B5*2']] }]);
  assert.deepEqual(report, { set: 3, appended: 2 });
  const sheet = await excel.file('xl/worksheets/sheet1.xml')!.async('string');
  assert.match(sheet, /<c r="A2" s="5" t="inlineStr"><is><t xml:space="preserve">改<\/t><\/is><\/c>/, 'the style index of a replaced cell survives');
  assert.match(sheet, /<c r="B1" t="s"><v>1<\/v><\/c><c r="C1"><v>7<\/v><\/c><\/row>/, 'a new cell lands after its neighbours');
  assert.match(sheet, /<row r="4"><c r="B4"><f>A2<\/f><\/c><\/row><row r="5">/, 'a row that did not exist is inserted in order');
  assert.match(sheet, /<dimension ref="A1:C6"\/>/);
  assert.doesNotMatch(sheet, /spans=/);
  assert.match(await excel.file('xl/workbook.xml')!.async('string'), /fullCalcOnLoad="1"/);
  assert.match((await readXlsx(excel, { formulas: true })).markdown, /\| 6 \| y \| =B5\*2 \|/);
  assert.equal(columnName(28), 'AB');
  assert.deepEqual(parseRef('ab12'), { col: 28, row: 12 });
  assert.throws(() => parseRef('12'), /单元格地址/);
});

test('pptx: build a deck, read titles, bullets, tables and notes, replace text', async () => {
  const bytes = await createPptx({ title: '封面', subtitle: '副标题', slides: [{ title: '第一页', bullets: ['要点一', '要点二'], notes: '讲稿' }, { title: '表', table: [['a', 'b'], ['1', '2']] }] });
  const zip = await JSZip.loadAsync(bytes);
  const text = await readPptx(zip);
  assert.equal(text.slides, 3);
  assert.match(text.markdown, /## 第 1 页\n- 封面\n- 副标题/);
  assert.match(text.markdown, /## 第 2 页\n- 第一页\n- 要点一\n- 要点二\n备注：讲稿/);
  assert.match(text.markdown, /## 第 3 页\n- 表\n\| a \| b \|\n\| 1 \| 2 \|/);
  const report = await editPptx(zip, [{ op: 'replace', find: '要点一', replace: '第一要点' }, { op: 'replace', find: '表', replace: '数据表', slide: 3, all: false }]);
  assert.deepEqual(report, { replaced: 2 });
  assert.match((await readPptx(zip)).markdown, /第一要点/);
  await assert.rejects(editPptx(zip, [{ op: 'replace', find: '没有', replace: 'x' }]), /没有找到/);
  await assert.rejects(editPptx(zip, [{ op: 'replace', find: 'x', replace: 'y', slide: 9 }]), /没有第 9 页/);
});

test('converters: detection is by files and registry keys, routes prefer Office then LibreOffice, and the COM script is well formed', async () => {
  const files = new Set(['/usr/bin/pandoc', '/usr/lib/libreoffice/program/soffice', '/usr/bin/gs']);
  const found = await detectConverters({ platform: 'linux', env: { PATH: '/usr/bin' }, managedRoot: '/data', exists: async path => files.has(path) });
  assert.deepEqual(found.map(item => [item.kind, item.path]), [['soffice', '/usr/lib/libreoffice/program/soffice'], ['pandoc', '/usr/bin/pandoc'], ['ghostscript', '/usr/bin/gs']]);
  const managed = await detectConverters({ platform: 'linux', env: { PATH: '' }, managedRoot: '/data', exists: async path => path === '/data/pandoc/bin/pandoc' });
  assert.deepEqual(managed.map(item => item.path), ['/data/pandoc/bin/pandoc'], 'a downloaded pandoc counts without PATH');
  const queried: string[] = [];
  const windows = await detectConverters({ platform: 'win32', env: { PATH: 'C:\\ps' }, managedRoot: 'D:\\data', exists: async path => path === 'C:\\ps\\powershell.exe',
    runner: async (_file, args) => { queried.push(args[1]!); if (args[1] === 'HKCR\\Word.Application') return { stdout: '', stderr: '' }; throw new Error('not found'); } });
  assert.deepEqual(windows.map(item => item.kind), ['msoffice']);
  assert.ok(queried.includes('HKCR\\KWPS.Application'));
  const all: Converter[] = [{ kind: 'soffice', path: 's' }, { kind: 'pandoc', path: 'p' }, { kind: 'msoffice', path: 'ps' }];
  assert.deepEqual(routesFor('docx', 'pdf', all).map(item => item.kind), ['msoffice', 'soffice']);
  assert.deepEqual(routesFor('md', 'html', all).map(item => item.kind), ['pandoc']);
  assert.deepEqual(routesFor('docx', 'odt', all).map(item => item.kind), ['msoffice', 'soffice', 'pandoc']);
  assert.deepEqual(routesFor('xlsx', 'docx', all), []);
  assert.deepEqual(routesFor('docx', 'pdf', [{ kind: 'pandoc', path: 'p' }]), []);
  const script = comScript('msoffice', { source: "C:\\in\\it's.docx", target: 'C:\\out\\x.pdf', from: 'docx', to: 'pdf' });
  assert.match(script, /New-Object -ComObject Word\.Application/);
  assert.match(script, /Documents\.Open\('C:\\in\\it''s\.docx', \$false, \$true\)/);
  assert.match(script, /ExportAsFixedFormat\('C:\\out\\x\.pdf', 17\)/);
  assert.match(script, /finally \{\n  \$app\.Quit\(\)/);
  assert.match(comScript('wps', { source: 'a.xlsx', target: 'a.pdf', from: 'xlsx', to: 'pdf' }), /KET\.Application[\s\S]*ExportAsFixedFormat\(0, 'a\.pdf'\)/);
  assert.match(comScript('msoffice', { source: 'a.pptx', target: 'a.pdf', from: 'pptx', to: 'pdf' }), /PowerPoint\.Application[\s\S]*SaveAs\('a\.pdf', 32\)/);
  assert.deepEqual(pandocAsset('linux', 'x64'), { name: 'pandoc-3.11-linux-amd64.tar.gz', url: 'https://github.com/jgm/pandoc/releases/download/3.11/pandoc-3.11-linux-amd64.tar.gz', archive: 'tar.gz' });
  assert.equal(pandocAsset('win32', 'x64')?.archive, 'zip');
  assert.equal(pandocAsset('linux', 'ia32'), undefined);
});

test('text helpers: csv parsing, plain text, and html', () => {
  assert.deepEqual(parseCsv('a,"b,c",3\r\n"say ""hi""",,\n'), [['a', 'b,c', '3'], ['say "hi"', '', '']]);
  assert.equal(plainText('# T\n\n**b** and *i*\n\n- x\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'), 'T\n\nb and i\n\n- x\n\na\tb\n1\t2');
  const html = markdownToHtml('# 标题\n\n段落 <b>\n\n| a |\n| --- |\n| 1 |');
  assert.match(html, /<h1>标题<\/h1>\n<p>段落 &lt;b&gt;<\/p>\n<table><thead><tr><th>a<\/th><\/tr><\/thead><tbody><tr><td>1<\/td><\/tr><\/tbody><\/table>/);
});

function fakeContext(mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspace: string) {
  const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<{ text: string }> }>();
  const sections: { name: string; text: () => string }[] = [];
  const ctx = {
    tools: { register(tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<{ text: string }> }) { tools.set(tool.name, tool); return () => { tools.delete(tool.name); }; } },
    systemPrompt: { section(section: { name: string; text: () => string }) { sections.push(section); return () => { sections.splice(sections.indexOf(section), 1); }; }, getSectionOrder() { return 10; } },
    sandboxPolicy: { resolve() { return { mode, workspaceRoot: workspace }; } },
    effect(fn: () => () => void) { fn(); },
  } as unknown as Context;
  // The third argument names the session's working directory, which is what a channel's session has.
  const run = (name: string, args: unknown, cwd = workspace) => { const tool = tools.get(name); if (!tool) throw new Error(`tool ${name} is not registered`); return tool.execute(args, { agent: { session: { id: 's1', header: { cwd } } } }); };
  return { ctx, tools, sections, run };
}

test('a long document is cut to what DSH still shows the model whole, with a note saying how to get the rest', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-docs-clip-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, 'inbox'), { recursive: true });
  const own = fakeContext('workspace-write', workspace);
  const svc = new DocumentService({ ctx: own.ctx, workspace, managedRoot: join(workspace, 'managed'), platform: 'linux', report: () => {}, detect: async () => [] });
  await svc.start();
  const line = '一'.repeat(100);
  await writeFile(join(workspace, 'inbox', '长.txt'), Array.from({ length: 400 }, () => line).join('\n'));
  const read = await own.run('doc_read', { path: 'inbox/长.txt' });
  const [body, ...rest] = read.text.split('\n\n（内容超过');
  assert.equal(body!.length, 15_000, 'the head is kept to the cap');
  assert.equal(body!.split('\n').at(-1)!.length < line.length, true, 'cut inside a line, never past the cap');
  assert.equal(rest.join('\n\n（内容超过').split('字，')[0]!.trim(), '15000');
  assert.match(read.text, /后面的已省略/);
  // Everything the model is shown must stay inside DSH's inline budget: the spill policy (maxInlineTokens 12500, priced at
  // 4 characters per token) would otherwise keep only the head and the tail of this result and file the middle.
  assert.ok(read.text.length <= 50_000, `a spilled result no longer reaches the model: ${read.text.length}`);
});

test('the document tools read, create, edit and convert inside the workspace, and report what the machine cannot do', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-docs-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const calls: string[][] = [];
  const runner = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file === '/fake/gs') return { stdout: 'PDF 正文\n\n\n第二段  \n', stderr: '' };
    const outDir = args[args.indexOf('--outdir') + 1]!;
    const source = args[args.length - 1]!;
    await writeFile(join(outDir, `${source.split('/').pop()!.replace(/\.[^.]+$/, '')}.${args[args.indexOf('--convert-to') + 1]!.split(':')[0]}`), 'fake pdf');
    return { stdout: '', stderr: '' };
  };
  await mkdir(join(workspace, 'inbox'), { recursive: true });
  const own = fakeContext('workspace-write', workspace);
  const svc = new DocumentService({ ctx: own.ctx, workspace, managedRoot: join(workspace, 'managed'), platform: 'linux', runner, report: () => {},
    detect: async () => [{ kind: 'soffice', path: '/fake/soffice' }, { kind: 'ghostscript', path: '/fake/gs' }] });
  await svc.start();
  assert.ok(['doc_read', 'doc_create', 'doc_edit', 'doc_convert'].every(name => own.tools.has(name)));
  assert.match(own.sections[0]!.text(), /LibreOffice/);
  assert.match(own.sections[0]!.text(), /ghostscript/);
  const created = await own.run('doc_create', { path: 'outputs/报告.docx', format: 'docx', content: MARKDOWN });
  assert.match(created.text, /已生成 outputs\/报告\.docx/);
  assert.match((await own.run('doc_read', { path: 'outputs/报告.docx' })).text, /^# 季度报告/);
  await assert.rejects(own.run('doc_create', { path: 'outputs/报告.docx', format: 'docx', content: 'x' }), /已存在/);
  await assert.rejects(own.run('doc_create', { path: '../outside.docx', format: 'docx', content: 'x' }), /只能写到/);
  await assert.rejects(own.run('doc_create', { path: 'outputs/x.txt', format: 'docx', content: 'x' }), /扩展名/);
  const edited = await own.run('doc_edit', { path: 'outputs/报告.docx', edits: [{ op: 'replace', find: '房租', replace: '租金' }] });
  assert.match(edited.text, /替换 1 处，结果在 outputs\/报告-edited\.docx/);
  assert.match((await own.run('doc_read', { path: 'outputs/报告-edited.docx' })).text, /租金/);
  assert.match((await own.run('doc_read', { path: 'outputs/报告.docx' })).text, /房租/, 'the original is untouched');
  // In place: only the assistant's own outputs/ files, and only with overwrite; a user's original never.
  await assert.rejects(own.run('doc_edit', { path: 'outputs/报告.docx', output: 'outputs/报告.docx', edits: [{ op: 'replace', find: '房租', replace: '租金' }] }), /带 overwrite: true/);
  const inPlace = await own.run('doc_edit', { path: 'outputs/报告.docx', output: 'outputs/报告.docx', overwrite: true, edits: [{ op: 'replace', find: '房租', replace: '租金' }] });
  assert.match(inPlace.text, /替换 1 处，结果在 outputs\/报告\.docx（原地修改）/);
  assert.match((await own.run('doc_read', { path: 'outputs/报告.docx' })).text, /租金/);
  await writeFile(join(workspace, 'inbox', '原件.docx'), await readFile(join(workspace, 'outputs', '报告.docx')));
  await assert.rejects(own.run('doc_edit', { path: 'inbox/原件.docx', output: 'inbox/原件.docx', overwrite: true, edits: [{ op: 'replace', find: 'a', replace: 'b' }] }), /原件不能覆盖/);
  const sheet = await own.run('doc_create', { path: 'outputs/预算.xlsx', format: 'xlsx', sheets: [{ name: '表', rows: [['a', 1], ['b', '=A1']] }] });
  assert.match(sheet.text, /已生成/);
  assert.match((await own.run('doc_read', { path: 'outputs/预算.xlsx', formulas: true })).text, /=A1/);
  const deck = await own.run('doc_create', { path: 'outputs/演示.pptx', format: 'pptx', title: '题', slides: [{ title: 'p', bullets: ['x'] }] });
  assert.match(deck.text, /已生成/);
  assert.match((await own.run('doc_read', { path: 'outputs/演示.pptx' })).text, /## 第 2 页\n- p\n- x/);
  // Conversions: md→docx is native, docx→pdf goes through the (fake) soffice one at a time, docx→md is native without pandoc.
  await writeFile(join(workspace, 'a.md'), '# 标题\n\n正文');
  const md2docx = await own.run('doc_convert', { path: 'a.md', to: 'docx' });
  assert.match(md2docx.text, /经 内置/);
  const pdf = await own.run('doc_convert', { path: 'outputs/报告.docx', to: 'pdf' });
  assert.match(pdf.text, /outputs\/报告\.pdf.*经 soffice/);
  assert.equal(await readFile(join(workspace, 'outputs', '报告.pdf'), 'utf8'), 'fake pdf');
  const sofficeCall = calls.find(call => call[0] === '/fake/soffice')!;
  assert.match(sofficeCall[1]!, /^-env:UserInstallation=file:\/\//);
  assert.ok(sofficeCall.includes('--headless') && sofficeCall.includes('pdf'));
  assert.match((await own.run('doc_read', { path: 'outputs/报告.pdf' })).text, /^PDF 正文\n\n第二段$/);
  assert.match((await own.run('doc_convert', { path: 'outputs/报告.docx', to: 'md' })).text, /经 内置/);
  await assert.rejects(own.run('doc_convert', { path: 'outputs/预算.xlsx', to: 'docx' }), /需要 Word、WPS 或 LibreOffice|转换失败/);
  await assert.rejects(own.run('doc_convert', { path: 'a.md', to: 'html', output: 'outputs/a.md' }), /扩展名/);
  // Without any converter the model is told plainly.
  const bare = fakeContext('read-only', workspace);
  const none = new DocumentService({ ctx: bare.ctx, workspace, managedRoot: join(workspace, 'managed'), platform: 'linux', detect: async () => [], report: () => {} });
  await none.start();
  assert.match(bare.sections[0]!.text(), /不能读 PDF/);
  assert.match(bare.sections[0]!.text(), /不能转 PDF/);
  await assert.rejects(bare.run('doc_read', { path: 'outputs/报告.pdf' }), /没有 pdftotext 或 ghostscript/);
  await assert.rejects(bare.run('doc_create', { path: 'outputs/x.md', format: 'md', content: 'x' }), /只读模式/);
  await assert.rejects(bare.run('doc_convert', { path: 'outputs/报告.docx', to: 'pdf' }), /只读模式/);
  assert.equal(none.view().capabilities.length, 4);
});

test('the document tools work in the session directory, so a channel edits its own outputs in place', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-docs-boot-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // A channel session works in its own directory, and the sandbox fences that directory;
  // the service itself was installed for the service's shared workspace.
  const channel = await mkdtemp(join(tmpdir(), 'nexus-docs-channel-'));
  t.after(() => rm(channel, { recursive: true, force: true }));
  const own = fakeContext('workspace-write', channel);
  const svc = new DocumentService({ ctx: own.ctx, workspace, managedRoot: join(workspace, 'managed'), platform: 'linux', report: () => {}, detect: async () => [] });
  await svc.start();
  const created = await own.run('doc_create', { path: 'outputs/报告.docx', format: 'docx', content: MARKDOWN }, channel);
  assert.match(created.text, /已生成 outputs\/报告\.docx/, 'the model is told the path it can resolve');
  assert.equal(existsSync(join(channel, 'outputs', '报告.docx')), true);
  assert.equal(existsSync(join(workspace, 'outputs', '报告.docx')), false, 'not in the workspace the service was installed with');
  await assert.rejects(own.run('doc_create', { path: '../outside.docx', format: 'docx', content: 'x' }, channel), /只能写到/);
  const inPlace = await own.run('doc_edit', { path: 'outputs/报告.docx', output: 'outputs/报告.docx', overwrite: true, edits: [{ op: 'replace', find: '房租', replace: '房屋租金' }] }, channel);
  assert.match(inPlace.text, /替换 1 处，结果在 outputs\/报告\.docx（原地修改）/, 'its own output may be rewritten where the session works');
  assert.match((await own.run('doc_read', { path: 'outputs/报告.docx' }, channel)).text, /房屋租金/);
  await mkdir(join(channel, 'inbox'), { recursive: true });
  await writeFile(join(channel, 'inbox', '原件.docx'), await readFile(join(channel, 'outputs', '报告.docx')));
  await assert.rejects(own.run('doc_edit', { path: 'inbox/原件.docx', output: 'inbox/原件.docx', overwrite: true, edits: [{ op: 'replace', find: '房屋租金', replace: 'x' }] }, channel), /原件不能覆盖/);
});
