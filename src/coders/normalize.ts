import { isAbsolute, resolve } from 'node:path';
import { unwrapShell } from './habits.js';
import type { CoderQuestion, CoderRequest, CoderRequestKind } from './types.js';

/** The subset of the Agent SDK's `canUseTool` options that helps describe a request. */
export interface ClaudePermissionContext {
  title?: string;
  toolUseID?: string;
  decisionReason?: string;
  blockedPath?: string;
  description?: string;
}

const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const FILE_READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function absolute(cwd: string, value: unknown): string[] {
  const path = text(value);
  if (!path) return [];
  return [isAbsolute(path) ? resolve(path) : resolve(cwd, path)];
}

function kindOf(toolName: string): CoderRequestKind {
  if (toolName === 'Bash') return 'command';
  if (FILE_WRITE_TOOLS.has(toolName)) return 'file-write';
  if (FILE_READ_TOOLS.has(toolName)) return 'file-read';
  if (NETWORK_TOOLS.has(toolName)) return 'network';
  if (toolName === 'AskUserQuestion') return 'question';
  return 'other';
}

function questionsOf(input: Record<string, unknown>): CoderQuestion[] {
  const items = Array.isArray(input.questions) ? input.questions : [];
  return items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const question = text(record.question);
    if (!question) return [];
    const options = Array.isArray(record.options) ? record.options.flatMap(option => {
      const label = option && typeof option === 'object' ? text((option as Record<string, unknown>).label) : '';
      if (!label) return [];
      const description = option && typeof option === 'object' ? text((option as Record<string, unknown>).description) : '';
      return [description ? { label, description } : { label }];
    }) : [];
    const header = text(record.header);
    return [{ question, ...(header ? { header } : {}), options, multiSelect: record.multiSelect === true }];
  });
}

/** Map one Agent SDK permission request onto the coder-agnostic request model. */
export function normalizeClaudeRequest(toolName: string, input: Record<string, unknown>,
  context: ClaudePermissionContext = {}, cwd: string): CoderRequest {
  if (toolName === 'mcp__nexus_web__search') toolName = 'WebSearch';
  if (toolName === 'mcp__nexus_web__fetch') toolName = 'WebFetch';
  const kind = kindOf(toolName);
  const base = { tool: toolName, raw: input };
  const blocked = absolute(cwd, context.blockedPath);
  switch (kind) {
    case 'command': {
      const command = text(input.command);
      return { ...base, kind, summary: context.title ?? `Bash: ${clip(command, 160)}`, detail: command, command, paths: blocked };
    }
    case 'file-write': {
      const paths = [...absolute(cwd, input.file_path), ...absolute(cwd, input.notebook_path), ...blocked];
      const detail = toolName === 'Write' ? clip(text(input.content), 1500)
        : toolName === 'Edit' ? `- ${clip(text(input.old_string), 700)}\n+ ${clip(text(input.new_string), 700)}`
          : clip(JSON.stringify(input), 1500);
      return { ...base, kind, summary: context.title ?? `${toolName}: ${paths[0] ?? ''}`, detail, paths };
    }
    case 'file-read': {
      const paths = [...absolute(cwd, input.file_path), ...absolute(cwd, input.path), ...blocked];
      const detail = text(input.pattern) || text(input.file_path) || text(input.path);
      return { ...base, kind, summary: context.title ?? `${toolName}: ${paths[0] ?? detail}`, detail, paths };
    }
    case 'network': {
      const detail = redact(text(input.url) || text(input.query));
      return { ...base, kind, summary: redact(context.title ?? `${toolName}: ${clip(detail, 160)}`), detail, paths: blocked };
    }
    case 'question': {
      const questions = questionsOf(input);
      const detail = questions.map(question => [question.header, question.question,
        ...question.options.map((option, index) => `${index + 1}. ${option.label}`)].filter(Boolean).join('\n')).join('\n\n');
      return { ...base, kind, summary: questions[0]?.question ?? 'Claude Code 提问', detail, paths: [], questions };
    }
    default:
      return { ...base, kind, summary: context.title ?? `${toolName}`, detail: clip(JSON.stringify(input), 1500), paths: blocked };
  }
}

function absoluteAll(cwd: string, values: readonly string[]): string[] {
  return values.flatMap(value => absolute(cwd, value));
}

/** `item/commandExecution/requestApproval` from `codex app-server`. */
export function codexCommandRequest(params: Record<string, unknown>, cwd: string): CoderRequest {
  const command = text(params.command);
  const reason = text(params.reason);
  const commandCwd = text(params.cwd) || cwd;
  const network = params.networkApprovalContext as { host?: unknown; protocol?: unknown } | undefined;
  const host = text(network?.host);
  return { kind: 'command', tool: 'codex.command', summary: command ? `命令：${clip(command, 160)}` : host ? `网络请求：${clip(host, 160)}` : '命令：（未提供）',
    detail: [command, host ? `联网目标：${host}` : '', reason ? `Codex 说明：${reason}` : '', commandCwd !== cwd ? `目录：${commandCwd}` : ''].filter(Boolean).join('\n'),
    command, paths: commandCwd !== cwd ? [commandCwd] : [], raw: params };
}

/** `item/fileChange/requestApproval`; paths and diff come from the matching `fileChange` item notification. */
export function codexFileChangeRequest(params: Record<string, unknown>, paths: readonly string[], diff: string, cwd: string,
  changes?: readonly { path: string; diff: string }[]): CoderRequest {
  const reason = text(params.reason);
  const grantRoot = text(params.grantRoot);
  const resolved = absoluteAll(cwd, paths);
  return { kind: 'file-write', tool: 'codex.fileChange', summary: `改动文件：${resolved.length ? resolved.map(path => clip(path, 80)).join('，') : '（未知路径）'}`,
    detail: [reason ? `Codex 说明：${reason}` : '', grantRoot ? `申请写入：${grantRoot}` : '', clip(diff, 1500)].filter(Boolean).join('\n'),
    paths: [...resolved, ...absolute(cwd, grantRoot)], ...(changes ? { fileChanges: changes.map(change => ({ path: resolve(cwd, change.path), diff: change.diff })) } : {}), raw: params };
}

/** `item/tool/requestUserInput`: structured questions, answered by question id. */
export function codexQuestionRequest(params: Record<string, unknown>): CoderRequest {
  const items = Array.isArray(params.questions) ? params.questions : [];
  const questionIds: string[] = [];
  const questions: CoderQuestion[] = items.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const question = text(record.question);
    if (!question) return [];
    questionIds.push(text(record.id) || String(questionIds.length));
    const options = Array.isArray(record.options) ? record.options.flatMap(option => {
      const label = option && typeof option === 'object' ? text((option as Record<string, unknown>).label) : '';
      const description = option && typeof option === 'object' ? text((option as Record<string, unknown>).description) : '';
      return label ? [description ? { label, description } : { label }] : [];
    }) : [];
    const header = text(record.header);
    return [{ question, ...(header ? { header } : {}), options, multiSelect: false }];
  });
  const detail = questions.map(question => [question.header, question.question,
    ...question.options.map((option, index) => `${index + 1}. ${option.label}`)].filter(Boolean).join('\n')).join('\n\n');
  return { kind: 'question', tool: 'codex.requestUserInput', summary: questions[0]?.question ?? 'Codex 提问', detail, paths: [], questions,
    raw: { ...params, questionIds } };
}

/** A turn that ended in a plain-text question: one free-text question whose text is the whole message. */
export function codexTextQuestion(message: string): CoderRequest {
  const question = message.trim();
  return { kind: 'question', tool: 'codex.message', summary: clip(question.split('\n').filter(Boolean).at(-1) ?? question, 160),
    detail: clip(question, 1500), paths: [], questions: [{ question, options: [], multiSelect: false }], raw: { text: question } };
}

/** `item/permissions/requestApproval`: extra sandbox permissions for the turn. */
export function codexPermissionRequest(params: Record<string, unknown>, cwd: string): CoderRequest {
  const permissions = (params.permissions ?? {}) as { fileSystem?: { entries?: { access?: string; path?: { path?: string; pattern?: string } }[]; read?: string[]; write?: string[] }; network?: { enabled?: boolean } };
  const paths = [...(permissions.fileSystem?.entries ?? []).flatMap(entry => entry.path?.path ? [entry.path.path] : []),
    ...(permissions.fileSystem?.read ?? []), ...(permissions.fileSystem?.write ?? [])];
  const network = permissions.network?.enabled === true;
  const reason = text(params.reason);
  return { kind: network && paths.length === 0 ? 'network' : 'other', tool: 'codex.permissions',
    summary: `申请额外权限：${[paths.length ? `文件 ${paths.map(path => clip(path, 60)).join('，')}` : '', network ? '网络' : ''].filter(Boolean).join('；') || '（未说明）'}`,
    detail: [reason ? `Codex 说明：${reason}` : '', clip(JSON.stringify(permissions), 1000)].filter(Boolean).join('\n'),
    paths: absoluteAll(cwd, paths), raw: params };
}

const STEP_LIMIT = 120;

/**
 * Secrets that tend to ride along in a command line or in the output it prints: `API_KEY=…`,
 * `Authorization: Bearer …`, `--token …`, `"apiKey": "…"`, and a bare credential carrying a
 * vendor prefix.
 *
 * The first four only recognise the shapes a *shell* produces. A command that dumps a JSON
 * configuration — `kubectl get -o json`, `docker inspect`, a settings file, an env dump — prints
 * `"apiKey": "sk-…"`, which is a colon and not an `=`, so every one of them walks past it and the
 * key reaches the activity log in full. The fifth rule is what covers that shape.
 *
 * Nothing here tries to detect high entropy: output is full of hashes, ids and checksums that
 * would be masked for no reason, and a rule that guesses would still miss a credential that
 * looks ordinary. Each pattern is a shape a secret is actually written in.
 */
const SECRETS: readonly [RegExp, string][] = [
  [/(https?:\/\/)[^\s/]+@/gi, '$1***@'],
  [/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*=)(?:'[^']*'|"[^"]*"|\S+)/gi, '$1***'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 ***'],
  [/(--?(?:token|password|passwd|api-key|secret)(?:=|\s+))(?:'[^']*'|"[^"]*"|\S+)/gi, '$1***'],
  // JSON and object literals. The keyword ends the key and the value is quoted, which is how a
  // credential is written and how a *setting* is not: `"apiKeyConfigured": true`, `token: none`
  // and prose keep reading normally. A key that merely contains the keyword (`tokenType`,
  // `secretName`) is left alone; one that ends with it (`monkey`, `hockey`) is masked, which is
  // the direction to be wrong in.
  [/(["']?[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)["']?\s*:\s*)("[^"\n]*"|'[^'\n]*')/gi, '$1***'],
  // A credential passed with no label at all. Only prefixes that belong to one vendor, so an
  // ordinary token-shaped string is not swallowed with it.
  [/\bsk-(?:ant|proj)-[A-Za-z0-9_-]{10,}/g, '***'],
  [/\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bxox[bpas]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
];

/** Mask secrets that tend to ride along in commands and their output. */
export function redact(value: string): string {
  return SECRETS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

/** A path inside the task directory, relative to it; any other path as given. */
function shortPath(path: string, cwd: string): string {
  const base = `${resolve(cwd)}/`;
  return isAbsolute(path) && resolve(path).startsWith(base) ? resolve(path).slice(base.length) : path;
}

function step(label: string, value: string): string {
  return `${label}：${clip(redact(value.replace(/\s+/g, ' ').trim()), STEP_LIMIT)}`;
}

/** The step a `tool_use` block from Claude Code's assistant message stands for; the tool's result is never read. */
export function claudeStep(block: unknown, cwd: string): string | undefined {
  if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') return undefined;
  const name = text((block as { name?: unknown }).name);
  const input = ((block as { input?: unknown }).input ?? {}) as Record<string, unknown>;
  if (!name) return undefined;
  if (name === 'Bash') return step('执行', text(input.command));
  if (FILE_WRITE_TOOLS.has(name)) return step('改文件', shortPath(text(input.file_path) || text(input.notebook_path), cwd));
  if (name === 'Read') return step('读文件', shortPath(text(input.file_path), cwd));
  if (name === 'Glob' || name === 'Grep') return step('搜索', text(input.pattern));
  if (name === 'WebFetch') return step('访问', text(input.url));
  if (name === 'WebSearch') return step('搜索网页', text(input.query));
  if (name === 'Task' || name === 'Agent') return step('子任务', text(input.description));
  return `调用 ${name}`;
}

/** The step an `item/started` item from `codex app-server` stands for; messages and reasoning are not steps. */
export function codexStep(item: unknown, cwd: string): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const record = item as { type?: unknown; command?: unknown; changes?: { path?: unknown }[]; tool?: unknown; server?: unknown; query?: unknown };
  if (record.type === 'commandExecution') return step('执行', unwrapShell(text(record.command)));
  if (record.type === 'fileChange') return step('改文件', (record.changes ?? []).map(change => shortPath(text(change.path), cwd)).filter(Boolean).join('，'));
  if (record.type === 'mcpToolCall') return `调用 ${[text(record.server), text(record.tool)].filter(Boolean).join('.') || '工具'}`;
  if (record.type === 'webSearch') return step('搜索网页', text(record.query));
  return undefined;
}

/** What the coder says about its own work ("先跑测试，再改 login.ts"), as one step. */
export function narration(message: string): string | undefined {
  return message.trim() ? step('说明', message) : undefined;
}

const OUTPUT_LINES = 15;
const OUTPUT_CHARS = 1500;

/** The end of a tool's output, secrets masked, for the job's own panel only: it never reaches the model or the task record. */
export function outputTail(output: string): string {
  const lines = redact(output).replace(/\s+$/, '').split('\n');
  const tail = lines.slice(-OUTPUT_LINES).join('\n');
  const cut = lines.length > OUTPUT_LINES || tail.length > OUTPUT_CHARS;
  return `${cut ? '…\n' : ''}${tail.length > OUTPUT_CHARS ? tail.slice(-OUTPUT_CHARS) : tail}`;
}

/** The text of a `tool_result` block in Claude Code's stream; its content is a string or text blocks. */
export function claudeToolOutput(block: unknown): string | undefined {
  if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_result') return undefined;
  const content = (block as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.flatMap(item => item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? [(item as { text: string }).text] : []).join('\n');
}
