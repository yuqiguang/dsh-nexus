import { parse } from 'acorn';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-sandbox-policy';
import { defineTool } from '@deepseek-ai/dsh-tools';
import JSZip from 'jszip';
import { randomBytes } from 'node:crypto';
import type { Session } from '@deepseek-ai/dsh-session';
import { lstat, mkdir, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { readDelivery, MAX_DELIVERY_BYTES } from '../channels/files.js';
import { canonical } from './permissions.js';
import { isInside, isProtectedPath, isEnvironmentTemplate, isProjectEnvironment } from './rules.js';
import { safeEnvironmentTemplate } from './environment-files.js';
import { isActive, type TaskRecord } from './types.js';

/** Static resource references only. No fetching, executing JS, or interpreting instructions in a file. */
export function resourceReferences(path: string, text: string): string[] {
  const refs: string[] = [];
  if (/\.html?$/i.test(path)) {
    for (const tag of text.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(script|link|img|source|video|audio|iframe)\b[^>]*>/gi)) {
      const match = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(tag[0]);
      if (match) refs.push(match[1] ?? match[2] ?? match[3]!);
    }
    for (const block of text.matchAll(/<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
      const script = block[1]!.toLowerCase() === 'script';
      const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(block[2]!)?.[1]?.toLowerCase();
      if (script && type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
      refs.push(...resourceReferences(script ? 'inline.js' : 'inline.css', block[3]!));
    }
  } else if (/\.css$/i.test(path)) {
    for (const match of text.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) refs.push(match[1] ?? match[2]!);
  } else if (/\.[cm]?js$/i.test(path)) {
    // Parse syntax rather than matching import-like words inside comments, regexes or strings.
    let tree: unknown;
    try { tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true }); }
    catch { throw new Error(`无法解析 JavaScript 资源依赖：${path}；请检查语法或使用编译后的文件。`); }
    const literal = (node: any): string | undefined => typeof node?.value === 'string' ? node.value
      : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0]?.value.cooked : undefined;
    const visit = (node: any): void => {
      if (!node || typeof node !== 'object') return;
      const source = ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type) ? node.source
        : node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require' ? node.arguments[0] : undefined;
      const value = literal(source);
      if (value?.startsWith('.')) refs.push(value);
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === 'object') visit(child);
      }
    };
    visit(tree);
  }
  return [...new Set(refs.map(value => value.replace(/&amp;/g, '&')).filter(value => value && !/^(?:https?:|data:|blob:|\/\/|#)/i.test(value))
    .map(value => decodeURIComponent(value.split(/[?#]/)[0]!)).filter(Boolean))];
}

async function source(root: string, path: string): Promise<{ path: string; bytes: Buffer }> {
  const absolute = resolve(root, path), real = await canonical(absolute);
  const template = isEnvironmentTemplate(real) && isProjectEnvironment(real, root, true);
  if (absolute !== real || !isInside(root, absolute) || !isInside(root, real) || (!template && (isProtectedPath(absolute, [root], true) || isProtectedPath(real, [root], true)))
    || relative(root, real).split(/[\\/]/).some(part => ['.git', '.deliverables'].includes(part))) throw new Error('打包文件超出任务范围或属于受保护文件。');
  if ((await lstat(real)).nlink !== 1) throw new Error('交付源文件不能是硬链接。');
  const bytes = (await readDelivery(root, absolute)).bytes;
  if (template && !safeEnvironmentTemplate(bytes.toString('utf8'))) throw new Error('环境配置模板包含非占位内容，不能作为普通交付文件。');
  return { path: real, bytes };
}

/** Preserve relative paths and require explicit selection of every static dependency. */
export async function packageFiles(cwd: string, names: readonly string[], signal?: AbortSignal): Promise<{ path: string; files: string[] }> {
  if (!names.length || names.length > 100) throw new Error('请明确选择 1 到 100 个交付文件。');
  const root = await canonical(cwd);
  if (root !== resolve(cwd)) throw new Error('任务目录不能通过链接重定向。');
  const entries = new Map<string, Buffer>();
  let size = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const file = await source(root, name);
    if (entries.has(file.path)) continue;
    size += file.bytes.length;
    if (size > 8 * 1024 * 1024) throw new Error('交付源文件合计超过 8 MiB，请拆分交付。');
    entries.set(file.path, file.bytes);
  }
  const missing = new Set<string>();
  for (const [path, bytes] of entries) for (const reference of resourceReferences(path, bytes.toString('utf8'))) {
    if (isAbsolute(reference) || /^(?:file:|[a-z]:)/i.test(reference)) throw new Error('交付文件含机器绝对路径，请先改为项目内相对资源路径。');
    const lexical = resolve(dirname(path), reference), target = await canonical(lexical);
    if (target !== lexical) throw new Error('交付资源引用不能通过链接重定向，请改为实际相对文件路径。');
    if (!isInside(root, target) || isProtectedPath(target, [root], true)) throw new Error('交付资源引用越出任务目录或指向受保护文件。');
    if (!entries.has(target)) missing.add(relative(root, target));
  }
  if (missing.size) throw new Error(`缺少关联资源，请补入 files 后重新打包：${[...missing].slice(0, 30).join('、')}`);
  const zip = new JSZip();
  const files = [...entries.keys()].map(path => relative(root, path).replaceAll('\\', '/'));
  for (const [path, bytes] of entries) zip.file(`${basename(root)}/${relative(root, path).replaceAll('\\', '/')}`, bytes);
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  if (bytes.length > MAX_DELIVERY_BYTES) throw new Error('压缩包超过渠道文件大小限制。');
  const dir = join(root, '.deliverables');
  await mkdir(dir, { recursive: true });
  if (await canonical(dir) !== dir) throw new Error('交付输出目录不能通过链接重定向。');
  signal?.throwIfAborted();
  const output = join(dir, `${basename(root)}-${randomBytes(4).toString('hex')}.zip`);
  const file = await open(output, 'wx');
  try { await file.writeFile(bytes); } finally { await file.close(); }
  return { path: output, files };
}

/** Use public native policy hooks; only explicit present calls authorize channel delivery. */
export function installCoderPackaging(ctx: Context, tasks: () => TaskRecord[], roots: (session: Session) => readonly string[] | Promise<readonly string[]>): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_package', description: '将本会话已结束编码任务的明确文件列表打包，保留目录结构并核对静态资源引用。缺少依赖时返回要补入的文件；不自动发送，成功后对返回的 zip 调用 present。',
    parameters: { task_id: { type: 'string', required: true }, files: { type: 'array', items: { type: 'string' }, required: true } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', required: true }, files: { type: 'array', items: { type: 'string' }, required: true } } },
      render: (_args, value) => [{ type: 'text', text: `已生成完整文件归档：${value.path}\n包含：${value.files.join('、')}\n尚未发送；请 present 此 zip，并告知用户解压后打开入口。静态资源已核对，动态加载和外部资源仍需运行验证。` }] },
    async execute(args, exec) {
      const task = tasks().find(task => task.id === args.task_id && task.ownerSession === exec.agent?.id);
      if (!task || isActive(task)) throw new Error('只能打包本会话已结束的编码任务。');
      if (!exec.agent) throw new Error('打包需要所属会话。');
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
      if (policy.mode === 'read-only') throw new Error('只读会话不能生成归档。');
      const root = await canonical(task.cwd);
      const allowed = await Promise.all((await roots(exec.agent.session)).map(canonical));
      if (root !== resolve(task.cwd) || !task.permissions?.writableRoots.includes(root) || !allowed.some(path => isInside(path, root))
        || (policy.mode === 'workspace-write' && !isInside(await canonical(policy.workspaceRoot), root))) throw new Error('任务目录不在当前允许的工作区内。');
      return packageFiles(task.cwd, args.files, exec.signal);
    },
  })));
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow' || exec.name !== 'present' || !exec.agent) return decision;
    const files = (exec.arguments as { files?: { path?: string }[] }).files;
    for (const item of files ?? []) {
      if (typeof item.path !== 'string' || !/\.html?$/i.test(item.path)) continue;
      const path = resolve(exec.agent.session.header.cwd ?? ctx.sandboxPolicy.resolve({ session: exec.agent.session }).workspaceRoot, item.path);
      const task = tasks().find(task => task.ownerSession === exec.agent!.id && isInside(task.cwd, path));
      if (!task) continue;
      try {
        if (await canonical(task.cwd) !== resolve(task.cwd)) throw new Error('任务目录已改变。');
        const file = await source(task.cwd, path);
        if (resourceReferences(path, file.bytes.toString('utf8')).length) return { kind: 'deny', reason: `该网页依赖其他文件，不能单独交付为可运行入口。请用 coder_package 打包任务 ${task.id} 的完整资源，再 present 返回的 zip；或生成经过验证的自包含页面。` };
      } catch { return { kind: 'deny', reason: '无法核对网页交付资源，请检查任务范围和文件。' }; }
    }
    return decision;
  });
}
