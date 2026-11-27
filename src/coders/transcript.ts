import { readdir, readFile, stat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { geminiSessionWorkspace } from './gemini-config.js';
import { unwrapShell } from './habits.js';
import { redact } from './normalize.js';
import { isEnvironmentFile, commandMentionsEnvironment } from './rules.js';
import { CODER_NAMES, isActive, type CoderKind, type TaskRecord } from './types.js';

/**
 * One entry of a task's process as the coder itself logged it. Everything comes from the coder's own session file, read on
 * demand for the task panel: it is never stored on the task and never shown to the model.
 */
export interface TranscriptEntry {
  at: number;
  kind: 'user' | 'message' | 'reasoning' | 'command' | 'edit' | 'tool' | 'interrupted';
  /** One line: the command, the edited file, the tool. */
  title: string;
  /** The message, the command's output, the diff; secrets masked and clipped. */
  body?: string;
  exitCode?: number;
  durationMs?: number;
  error?: boolean;
}

export interface Transcript {
  entries: TranscriptEntry[];
  /** The session file read, for the panel to name. */
  source?: string;
  /** Why there is nothing to show, when there is nothing. */
  problem?: string;
  /** Entries dropped from the front to stay under {@link ENTRY_LIMIT}. */
  omitted?: number;
}

/** Where each coder keeps its sessions; the first directory that has the task's session wins. */
export interface CoderHomes { codex: string[]; claude: string[]; gemini?: string[] }

const ENTRY_LIMIT = 400;
const BODY_LIMIT = 20_000;
const REASONING_LIMIT = 4_000;
const ENVIRONMENT_HIDDEN = '环境配置内容已隐藏。';
/** Slack around the task's own time span: a session file is shared by every task that resumed it. */
const WINDOW_SLACK_MS = 2_000;

/** The session homes to search: the running coder's own first, then the user's default. */
export function coderHomes(env: { codex?: NodeJS.ProcessEnv; claude?: NodeJS.ProcessEnv; gemini?: NodeJS.ProcessEnv }): CoderHomes {
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))];
  return {
    codex: unique([env.codex?.CODEX_HOME, process.env.CODEX_HOME, join(homedir(), '.codex')]),
    claude: unique([env.claude?.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]),
    gemini: unique([env.gemini?.GEMINI_CLI_HOME ? join(env.gemini.GEMINI_CLI_HOME, '.gemini') : undefined,
      process.env.GEMINI_CLI_HOME ? join(process.env.GEMINI_CLI_HOME, '.gemini') : undefined, join(homedir(), '.gemini')]),
  };
}

function clipBody(value: string, limit = BODY_LIMIT): string {
  const text = redact(value.replace(/\s+$/, ''));
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，共 ${text.length} 字）` : text;
}

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const texts = (value: unknown): string => Array.isArray(value)
  ? value.map(item => typeof item === 'string' ? item : text((item as { text?: unknown } | null)?.text)).filter(Boolean).join('\n') : text(value);

/** Codex keeps a thread in `<home>/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`; the day it started is tried first. */
export async function findCodexRollout(homes: readonly string[], threadId: string, startedAt: number): Promise<string | undefined> {
  const day = new Date(startedAt);
  const dated = [String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')];
  const suffix = `-${threadId}.jsonl`;
  for (const home of homes) {
    const root = join(home, 'sessions');
    const direct = join(root, ...dated);
    const hit = (await readdir(direct).catch(() => [] as string[])).find(name => name.endsWith(suffix));
    if (hit) return join(direct, hit);
    for (const year of (await readdir(root).catch(() => [] as string[])).sort().reverse()) {
      for (const month of (await readdir(join(root, year)).catch(() => [] as string[])).sort().reverse()) {
        for (const date of (await readdir(join(root, year, month)).catch(() => [] as string[])).sort().reverse()) {
          const found = (await readdir(join(root, year, month, date)).catch(() => [] as string[])).find(name => name.endsWith(suffix));
          if (found) return join(root, year, month, date, found);
        }
      }
    }
  }
  return undefined;
}

/** Claude Code keeps a session in `<config dir>/projects/<encoded cwd>/<session id>.jsonl`. */
export async function findClaudeSession(homes: readonly string[], sessionId: string): Promise<string | undefined> {
  for (const home of homes) {
    const root = join(home, 'projects');
    for (const project of await readdir(root).catch(() => [] as string[])) {
      const path = join(root, project, `${sessionId}.jsonl`);
      if (await stat(path).then(item => item.isFile(), () => false)) return path;
    }
  }
  return undefined;
}

function records(file: string): Record<string, unknown>[] {
  return file.split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line) as Record<string, unknown>] : []; } catch { return []; } });
}

type Window = { from: number; to: number };
const within = (at: number, window: Window) => Number.isFinite(at) && at >= window.from && at <= window.to;

/** A Codex rollout's completed items and aborted turns, in order. */
export function parseCodexRollout(file: string, window: Window): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const record of records(file)) {
    const at = Date.parse(text(record.timestamp));
    if (!within(at, window) || record.type !== 'event_msg') continue;
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    if (payload.type === 'turn_aborted') { entries.push({ at, kind: 'interrupted', title: '这一回合被打断' }); continue; }
    if (payload.type !== 'item_completed') continue;
    const item = (payload.item ?? {}) as Record<string, unknown>;
    const type = text(item.type);
    if (type === 'UserMessage') entries.push({ at, kind: 'user', title: '发给 Codex', body: clipBody(texts(item.content)) });
    else if (type === 'AgentMessage') entries.push({ at, kind: 'message', title: 'Codex 说', body: clipBody(texts(item.content)) });
    else if (type === 'Reasoning') {
      const thought = texts(item.summary_text) || texts(item.raw_content);
      if (thought.trim()) entries.push({ at, kind: 'reasoning', title: 'Codex 思考', body: clipBody(thought, REASONING_LIMIT) });
    } else if (type === 'CommandExecution') {
      const parsed = Array.isArray(item.parsed_cmd) ? text((item.parsed_cmd[0] as { cmd?: unknown } | undefined)?.cmd) : '';
      const command = parsed || unwrapShell(Array.isArray(item.command) ? item.command.map(text).join(' ') : text(item.command));
      const duration = item.duration as { secs?: unknown; nanos?: unknown } | undefined;
      const environment = commandMentionsEnvironment(command);
      entries.push({ at, kind: 'command', title: environment ? '环境配置命令（内容已隐藏）' : redact(command), body: environment ? ENVIRONMENT_HIDDEN : clipBody(text(item.aggregated_output) || text(item.formatted_output)),
        ...(typeof item.exit_code === 'number' ? { exitCode: item.exit_code } : {}),
        ...(typeof duration?.secs === 'number' ? { durationMs: duration.secs * 1000 + Math.round(Number(duration.nanos ?? 0) / 1e6) } : {}) });
    } else if (type === 'FileChange' || type === 'PatchApply') {
      // The change set is keyed by path or listed, depending on the Codex version; either way each entry carries its diff.
      const changes = item.changes;
      const list: Record<string, unknown>[] = Array.isArray(changes) ? changes as Record<string, unknown>[]
        : changes && typeof changes === 'object' ? Object.entries(changes).map(([path, change]) => ({ path, ...(change as Record<string, unknown>) })) : [];
      const paths = list.map(change => text(change.path)).filter(Boolean);
      const diff = list.map(change => `--- ${text(change.path)}\n${isEnvironmentFile(text(change.path)) ? ENVIRONMENT_HIDDEN : text(change.unified_diff) || text(change.diff) || text(change.content)}`).join('\n');
      entries.push({ at, kind: 'edit', title: `改文件：${paths.join('，') || '（未知路径）'}`, body: clipBody(diff) });
    } else if (type && !['ContextCompaction', 'Plan', 'HookPrompt'].includes(type)) {
      entries.push({ at, kind: 'tool', title: type, body: clipBody(JSON.stringify(item, null, 2), 2_000) });
    }
  }
  return entries;
}

/** A Claude Code session's messages, thinking, and tool calls with their results, in order. */
export function parseClaudeSession(file: string, window: Window): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const calls = new Map<string, TranscriptEntry>();
  const privateCalls = new Set<string>();
  for (const record of records(file)) {
    const at = Date.parse(text(record.timestamp));
    if (!within(at, window) || record.isSidechain === true) continue;
    const content = (record.message as { content?: unknown } | undefined)?.content;
    if (record.type === 'user') {
      if (typeof content === 'string') { if (content.trim()) entries.push({ at, kind: 'user', title: '发给 Claude Code', body: clipBody(content) }); continue; }
      for (const block of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
        if (block.type === 'text' && text(block.text).trim()) entries.push({ at, kind: 'user', title: '发给 Claude Code', body: clipBody(text(block.text)) });
        if (block.type === 'tool_result') {
          const call = calls.get(text(block.tool_use_id));
          if (!call) continue;
          const output = texts(block.content);
          if (output.trim() && !privateCalls.has(text(block.tool_use_id))) call.body = call.body ? `${call.body}\n\n${clipBody(output)}` : clipBody(output);
          if (block.is_error === true) call.error = true;
          call.durationMs = at - call.at;
        }
      }
    } else if (record.type === 'assistant') {
      for (const block of Array.isArray(content) ? content as Record<string, unknown>[] : []) {
        if (block.type === 'text' && text(block.text).trim()) entries.push({ at, kind: 'message', title: 'Claude Code 说', body: clipBody(text(block.text)) });
        else if (block.type === 'thinking' && text(block.thinking).trim()) entries.push({ at, kind: 'reasoning', title: 'Claude Code 思考', body: clipBody(text(block.thinking), REASONING_LIMIT) });
        else if (block.type === 'tool_use') {
          const name = text(block.name);
          const input = (block.input ?? {}) as Record<string, unknown>;
          const environment = isEnvironmentFile(text(input.file_path)) || isEnvironmentFile(text(input.path)) || name === 'Bash' && commandMentionsEnvironment(text(input.command));
          const entry: TranscriptEntry = environment ? { at, kind: name === 'Bash' ? 'command' : ['Write', 'Edit'].includes(name) ? 'edit' : 'tool', title: `${name}：环境配置（内容已隐藏）`, body: ENVIRONMENT_HIDDEN }
            : name === 'Bash' ? { at, kind: 'command', title: redact(text(input.command)) }
            : name === 'Edit' ? { at, kind: 'edit', title: `改文件：${text(input.file_path)}`, body: clipBody(`- ${text(input.old_string)}\n+ ${text(input.new_string)}`) }
              : name === 'Write' ? { at, kind: 'edit', title: `写文件：${text(input.file_path)}`, body: clipBody(text(input.content)) }
                : { at, kind: 'tool', title: name, body: clipBody(JSON.stringify(input, null, 2), 2_000) };
          entries.push(entry);
          if (text(block.id)) calls.set(text(block.id), entry);
          if (environment) privateCalls.add(text(block.id));
        }
      }
    }
  }
  return entries;
}

/** Gemini 0.71 uses project registry identifiers and JSONL; match both the complete session ID and the recorded workspace hash. */
export async function findGeminiSession(homes: readonly string[], sessionId: string, cwd: string): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(sessionId)) return undefined;
  const hash = createHash('sha256').update(cwd).digest('hex');
  for (const home of homes) {
    const nativeHash = createHash('sha256').update(geminiSessionWorkspace(dirname(home), cwd)).digest('hex');
    const root = join(home, 'tmp');
    const directories = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const directory of directories.filter(entry => entry.isDirectory()).slice(0, 512)) {
      const chats = join(root, directory.name, 'chats');
      const files = await readdir(chats).catch(() => []);
      for (const name of files.filter(name => name.endsWith(`-${sessionId.slice(0, 8)}.jsonl`) || name.endsWith(`-${sessionId.slice(0, 8)}.json`)).sort().reverse()) {
        const path = join(chats, name);
        try {
          const file = await open(path, 'r');
          let metadata: any;
          try {
            if ((await file.stat()).size > 32 * 1024 * 1024) continue;
            if (name.endsWith('.json')) metadata = JSON.parse(await file.readFile('utf8'));
            else { const buffer = Buffer.alloc(16_384); const { bytesRead } = await file.read(buffer, 0, buffer.length, 0); metadata = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0]!); }
          } finally { await file.close(); }
          if (metadata.sessionId === sessionId && [hash, nativeHash].includes(metadata.projectHash)) return path;
        } catch { /* Partial records or a different workspace cannot supply this task's transcript. */ }
      }
    }
  }
  return undefined;
}

/** JSONL patches update messages/tool results; rewinds remove abandoned work instead of replaying it. */
export function parseGeminiSession(file: string, window: Window): TranscriptEntry[] {
  const messages = new Map<string, any>();
  try { const legacy = JSON.parse(file); if (Array.isArray(legacy.messages)) for (const message of legacy.messages) if (typeof message?.id === 'string') messages.set(message.id, message); } catch { /* JSONL */ }
  const patch = (value: any) => {
    const previous = messages.get(value?.id);
    if (!previous) return;
    if (value.content !== undefined) previous.content = value.content;
    if (Array.isArray(value.toolCalls)) for (const update of value.toolCalls) {
      const call = previous.toolCalls?.find((call: any) => call.id === update.id);
      if (call && update.result !== undefined) call.result = update.result;
    }
  };
  if (!messages.size) for (const record of records(file)) {
    if (typeof record.$rewindTo === 'string') {
      const ids = [...messages.keys()], index = ids.indexOf(record.$rewindTo);
      for (const id of index < 0 ? ids : ids.slice(index)) messages.delete(id);
    } else if (record.$patch) {
      const value = record.$patch as any;
      patch(value); if (Array.isArray(value.updates)) value.updates.forEach(patch);
      if (Array.isArray(value.removeIds)) for (const id of value.removeIds) messages.delete(id);
      if (Array.isArray(value.orderIds)) for (const id of value.orderIds) { const message = messages.get(id); if (message) { messages.delete(id); messages.set(id, message); } }
    } else if (typeof record.id === 'string' && ['user', 'gemini'].includes(text(record.type))) messages.set(record.id, record);
  }
  const entries: TranscriptEntry[] = [];
  for (const message of messages.values()) {
    const at = Date.parse(text(message.timestamp));
    if (!within(at, window)) continue;
    const body = texts(message.content);
    if (body.trim()) entries.push({ at, kind: message.type === 'user' ? 'user' : 'message', title: message.type === 'user' ? '发给 Gemini CLI' : 'Gemini CLI 说', body: clipBody(body) });
    for (const thought of Array.isArray(message.thoughts) ? message.thoughts : []) {
      const body = [text(thought.subject), text(thought.description)].filter(Boolean).join('\n');
      if (body) entries.push({ at, kind: 'reasoning', title: 'Gemini CLI 思考', body: clipBody(body, REASONING_LIMIT) });
    }
    for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const input = call.args ?? {}, name = text(call.name);
      const command = name === 'run_shell_command' || name.endsWith('_command');
      const edit = name === 'write_file' || name === 'replace' || name.endsWith('_write_file') || name.endsWith('_replace_text');
      const environment = isEnvironmentFile(text(input.path)) || isEnvironmentFile(text(input.file_path)) || command && commandMentionsEnvironment(text(input.command));
      const details = edit ? input.content ?? `- ${text(input.old_text)}\n+ ${text(input.new_text)}` : command ? text(input.command) : JSON.stringify(input, null, 2);
      const output = call.resultDisplay ?? call.result;
      entries.push({ at, kind: command ? 'command' : edit ? 'edit' : 'tool',
        title: environment ? `${name}：环境配置（内容已隐藏）` : command ? redact(text(input.command)) : edit ? `改文件：${text(input.path ?? input.file_path)}` : name,
        body: environment ? ENVIRONMENT_HIDDEN : clipBody([typeof details === 'string' ? details : '', typeof output === 'string' ? output : output ? JSON.stringify(output) : ''].filter(Boolean).join('\n\n')),
        ...(['failed', 'error', 'cancelled'].includes(text(call.status)) ? { error: true } : {}),
      });
    }
  }
  return entries;
}

/** The task's process from the coder's own session file, limited to the task's time span. */
export async function taskTranscript(task: TaskRecord, homes: CoderHomes, now = Date.now()): Promise<Transcript> {
  if (!task.coderSessionId) return { entries: [], problem: '编码工具还没有报告会话，过程记录要等它启动后才有。' };
  const coder: CoderKind = task.coder;
  const source = coder === 'codex' ? await findCodexRollout(homes.codex, task.coderSessionId, task.createdAt)
    : coder === 'gemini' ? await findGeminiSession(homes.gemini ?? [], task.coderSessionId, task.cwd) : await findClaudeSession(homes.claude, task.coderSessionId);
  if (!source) return { entries: [], problem: `没有找到 ${CODER_NAMES[coder]} 的会话记录（${task.coderSessionId}）。` };
  const file = await readFile(source, 'utf8').catch(() => undefined);
  if (file === undefined) return { entries: [], source, problem: '会话记录读不出来。' };
  const window = { from: task.createdAt - WINDOW_SLACK_MS, to: (isActive(task) ? now : task.updatedAt) + WINDOW_SLACK_MS };
  const all = coder === 'codex' ? parseCodexRollout(file, window) : coder === 'gemini' ? parseGeminiSession(file, window) : parseClaudeSession(file, window);
  const omitted = Math.max(0, all.length - ENTRY_LIMIT);
  return { entries: all.slice(omitted), source, ...(omitted ? { omitted } : {}) };
}
