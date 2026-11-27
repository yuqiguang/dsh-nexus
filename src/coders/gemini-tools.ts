import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { canonical } from './permissions.js';
import { isInside, commandMentionsEnvironment } from './rules.js';
import { normalizeClaudeRequest, outputTail, redact } from './normalize.js';
import { createOutputDecoder } from './decode.js';
import { spawnTaskProcess, stopTaskProcess, taskProcessCleaned } from './process.js';
import { CoderQueue } from './queue.js';
import type { CoderDecision, CoderRequest, TaskRecord } from './types.js';
import type { ResearchBridge } from './research.js';
import type { CodexTurnResult } from './turn-result.js';

const MAX_FILE_BYTES = 1024 * 1024;
const pathSchema = z.string().min(1).max(4096);
const schemas = {
  read_file: z.object({ path: pathSchema }).strict(),
  write_file: z.object({ path: pathSchema, content: z.string().max(MAX_FILE_BYTES) }).strict(),
  replace_text: z.object({ path: pathSchema, old_text: z.string().min(1).max(MAX_FILE_BYTES), new_text: z.string().max(MAX_FILE_BYTES) }).strict(),
  command: z.object({ command: z.string().min(1).max(32_000), directory: pathSchema.optional() }).strict(),
  // ACP excludes the native ask_user name, including MCP aliases of that name.
  ask_question: z.object({ question: z.string().trim().min(1).max(12_000), options: z.array(z.object({ label: z.string().min(1).max(200), description: z.string().max(1000).optional() }).strict()).max(8).optional(), multi_select: z.boolean().optional() }).strict(),
  report_result: z.object({ status: z.enum(['completed', 'needs_input', 'blocked']), text: z.string().trim().min(1).max(24_000) }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  read_file: 'Read a UTF-8 project file (maximum 1 MiB) through Nexus access checks. Use command with rg for file discovery and searches.',
  write_file: 'Create or replace a UTF-8 project file through Nexus approval. Parent directories are created after authorization.',
  replace_text: 'Replace exactly one occurrence of old_text in a UTF-8 file. Fails if it is ambiguous or the file changes while approval is pending.',
  command: 'Run a foreground command in the task directory through Nexus command review. POSIX sh on Linux/macOS; PowerShell -NoProfile on Windows. Maximum 120 seconds; all child processes end with the command. No interactive stdin or persistent background services.',
  ask_question: 'Ask the task owner a blocking question using DSH native questions and the original channel. Wait for the answer instead of guessing or starting another task.',
  report_result: 'Report the structured result as the LAST tool call, then end the turn. completed means all requested coding work and self-checks finished; needs_input asks a blocking clarification; blocked explains why execution cannot proceed. This does not bypass independent DSH verification.',
};

export interface GeminiToolsDeps {
  env: NodeJS.ProcessEnv;
  decide(request: CoderRequest, signal: AbortSignal): Promise<CoderDecision>;
  onActivity?(text: string): void;
  onLog?(text: string): void;
  onSuccess?(): void;
  onFailure?(key: string): void;
  onResult?(result: CodexTurnResult | undefined): void;
}

/** Foreground commands have the same process ownership and secret filtering as the existing adapters. */
async function runCommand(command: string, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
  signal.throwIfAborted();
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|KEY|AUTH|PROXY|^DSH_|^GEMINI_|^GOOGLE_|^(?:BASH_ENV|ENV|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP)$/i.test(key)));
  const child = spawnTaskProcess(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh',
    process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command], cwd, cleanEnv);
  child.stdin.end();
  return new Promise(resolvePromise => {
    let output = '', settled = false, broken = false;
    const stdout = createOutputDecoder(), stderr = createOutputDecoder();
    const collect = (text: string) => { output = (output + text).slice(-24_000); };
    const stop = () => stopTaskProcess(child);
    const watchdog = setTimeout(() => { broken = true; collect('\n[command cleanup timed out]'); child.kill('SIGKILL'); settle(false); }, 126_000);
    watchdog.unref();
    const timeout = setTimeout(() => { broken = true; collect('\n[command timed out]'); stop(); }, 120_000);
    timeout.unref();
    let abortCleanup: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { stop(); abortCleanup ??= setTimeout(() => { broken = true; child.kill('SIGKILL'); settle(false); }, 6000); abortCleanup.unref(); };
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(watchdog); clearTimeout(abortCleanup);
      signal.removeEventListener('abort', abort); stop();
      collect(stdout.flush() + stderr.flush());
      resolvePromise({ ok: ok && !broken && !signal.aborted && taskProcessCleaned(child), output: redact(output) });
    };
    child.stdout.on('data', chunk => collect(stdout.push(chunk)));
    child.stderr.on('data', chunk => collect(stderr.push(chunk)));
    for (const stream of [child.stdout, child.stderr, child.stdin]) stream.on('error', () => { broken = true; abort(); });
    child.once('error', error => { collect(`\n[command start failed: ${error.message}]`); settle(false); });
    child.once('close', code => { if (code !== 0) collect(`\n[exit ${code ?? 'unknown'}]`); settle(code === 0); });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A private, per-run MCP bridge carries complete inputs; native ACP display titles are never treated as execution evidence. */
export async function createGeminiToolsBridge(task: TaskRecord, deps: GeminiToolsDeps, signal: AbortSignal): Promise<ResearchBridge> {
  const controller = new AbortController(), lifetime = AbortSignal.any([signal, controller.signal]);
  const token = randomBytes(32).toString('hex'), sessions = new Set<Server>(), running = new Set<Promise<unknown>>();
  const operations = new CoderQueue(1);
  let asking = 0, latestCall = 0;
  let origin = '';
  const authorized = async (name: string, input: Record<string, unknown>, active: AbortSignal) => {
    active.throwIfAborted();
    const decision = await deps.decide(normalizeClaudeRequest(name, input, {}, task.cwd), active);
    active.throwIfAborted();
    if (decision.behavior !== 'allow') throw new Error(decision.message || 'Nexus 未授权本次操作。');
    return decision;
  };
  const read = async (path: string, active: AbortSignal): Promise<string> => {
    const real = await canonical(resolve(task.cwd, path));
    await authorized('Read', { file_path: real }, active);
    if (await canonical(resolve(task.cwd, path)) !== real) throw new Error('文件路径在审核期间发生变化。');
    const file = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || task.permissions?.securityMode !== 'full' && stat.nlink !== 1) throw new Error('只能读取不超过 1 MiB 的普通文件；链接文件需要先核对。');
      const value = await file.readFile({ encoding: 'utf8', signal: active });
      if (Buffer.byteLength(value) > MAX_FILE_BYTES) throw new Error('文件超过读取上限。');
      deps.onActivity?.(`Gemini 读取：${relative(task.cwd, real) || basename(real)}`);
      deps.onSuccess?.();
      return value;
    } finally { await file.close(); }
  };
  const write = async (path: string, content: string, active: AbortSignal, expected?: string): Promise<void> => {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('文件超过写入上限。');
    const real = await canonical(resolve(task.cwd, path));
    await authorized('Write', { file_path: real, content }, active);
    if (await canonical(resolve(task.cwd, path)) !== real) throw new Error('文件路径在审核期间发生变化。');
    await mkdir(dirname(real), { recursive: true });
    active.throwIfAborted();
    if (await canonical(resolve(task.cwd, path)) !== real) throw new Error('文件路径在创建目录期间发生变化。');
    const file = await open(real, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o644);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || task.permissions?.securityMode !== 'full' && stat.nlink !== 1) throw new Error('不能写入链接文件。');
      if (expected !== undefined && (stat.size > MAX_FILE_BYTES || await file.readFile('utf8') !== expected)) throw new Error('文件在审核期间发生变化，请重新读取后修改。');
      active.throwIfAborted();
      await file.truncate(0);
      const bytes = Buffer.from(content);
      for (let offset = 0; offset < bytes.length;) {
        active.throwIfAborted();
        const result = await file.write(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesWritten) throw new Error('文件写入未完成。');
        offset += result.bytesWritten;
      }
      deps.onActivity?.(`Gemini 写入：${relative(task.cwd, real) || basename(real)}`);
      deps.onSuccess?.();
    } finally { await file.close(); }
  };
  const execute = async (name: keyof typeof schemas, input: Record<string, any>, active: AbortSignal, order: number): Promise<string> => {
    if (name === 'ask_question') {
      asking++;
      try {
        const decision = await authorized('AskUserQuestion', { questions: [{ question: input.question, options: input.options ?? [], multiSelect: input.multi_select ?? false }] }, active);
        const answer = (decision.updatedInput?.answers as Record<string, string> | undefined)?.[input.question];
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('提问没有得到用户回答，请等待或重新提问。');
        return answer;
      } finally { asking--; }
    }
    const release = await operations.acquire(active);
    try {
      if (name === 'report_result') {
        active.throwIfAborted();
        if (asking) throw new Error('仍在等待用户回答，不能确认任务结束。');
        if (order !== latestCall) throw new Error('结果报告必须是最后一个工具调用，请完成其他操作后重新报告。');
        deps.onResult?.({ status: input.status, text: input.text });
        return '任务结果已记录；请结束当前回合。';
      }
      if (name === 'read_file') return await read(input.path, active);
      if (name === 'write_file') { await write(input.path, input.content, active); return '文件已写入。'; }
      if (name === 'replace_text') {
        const original = await read(input.path, active);
        const start = original.indexOf(input.old_text);
        if (start < 0 || original.indexOf(input.old_text, start + 1) >= 0) throw new Error('old_text 必须在文件中恰好出现一次。');
        await write(input.path, original.slice(0, start) + input.new_text + original.slice(start + input.old_text.length), active, original);
        return '替换已完成。';
      }
      const directory = await canonical(resolve(task.cwd, input.directory ?? '.'));
      if (!isInside(task.cwd, directory)) throw new Error('命令目录必须在任务目录内。');
      await authorized('Bash', { command: input.command, cwd: directory }, active);
      if (await canonical(resolve(task.cwd, input.directory ?? '.')) !== directory) throw new Error('命令目录在审核期间发生变化。');
      deps.onActivity?.(`Gemini 命令：${redact(input.command).slice(0, 160)}`);
      const result = await runCommand(input.command, directory, deps.env, active);
      if (result.ok) deps.onSuccess?.(); else deps.onFailure?.(`command:${input.command}`);
      const output = commandMentionsEnvironment(input.command) ? '环境配置内容已隐藏。' : outputTail(result.output);
      deps.onLog?.(output);
      return `${result.ok ? '命令执行成功' : '命令执行失败'}\n${output}`;
    } finally { release(); }
  };
  const server = createServer(async (req, res) => {
    if (lifetime.aborted) { res.writeHead(503).end(); return; }
    if (req.headers.host !== origin || req.headers.origin || req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(405).end(); return; }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 2 * MAX_FILE_BYTES) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mcp = new Server({ name: 'nexus-coder', version: '1.0.0' }, { capabilities: { tools: {} } });
      sessions.add(mcp);
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (Object.keys(schemas) as (keyof typeof schemas)[]).map(name => ({
        name, description: descriptions[name], inputSchema: z.toJSONSchema(schemas[name]) as { type: 'object' },
      })) }));
      mcp.setRequestHandler(CallToolRequestSchema, (request, extra) => {
        const order = ++latestCall;
        deps.onResult?.(undefined);
        const call = (async () => {
          const name = request.params.name as keyof typeof schemas;
          const parsed = Object.hasOwn(schemas, name) ? schemas[name].safeParse(request.params.arguments ?? {}) : undefined;
          if (!parsed?.success) return { isError: true, content: [{ type: 'text' as const, text: '无效的 Gemini 工具参数。' }] };
          const active = AbortSignal.any([lifetime, extra.signal]);
          try { return { content: [{ type: 'text' as const, text: await execute(name, parsed.data, active, order) }] }; }
          catch (error) { return { isError: true, content: [{ type: 'text' as const, text: active.aborted ? '任务操作已取消。' : redact((error as Error).message).slice(0, 2000) }] }; }
        })();
        running.add(call); void call.finally(() => running.delete(call));
        return call;
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('close', () => { sessions.delete(mcp); void mcp.close().catch(() => {}); });
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 31 * 60_000; server.maxConnections = 16;
  await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('gemini_tools_bridge_unavailable');
  origin = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    controller.abort(); operations.close(); server.closeAllConnections();
    await Promise.allSettled([...running, ...[...sessions].map(session => session.close())]);
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    signal.removeEventListener('abort', abort);
  })();
  const abort = () => { void close(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { await close(); signal.throwIfAborted(); }
  return { url: `http://${origin}/mcp`, token, close };
}
