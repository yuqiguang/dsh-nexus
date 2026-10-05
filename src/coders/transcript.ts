import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { unwrapShell } from './habits.js';
import { redact } from './normalize.js';
import { isEnvironmentFile, commandMentionsEnvironment } from './rules.js';
import { isActive, type CoderKind, type TaskRecord } from './types.js';

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
export interface CoderHomes { codex: string[]; claude: string[] }

const ENTRY_LIMIT = 400;
const BODY_LIMIT = 20_000;
const REASONING_LIMIT = 4_000;
const ENVIRONMENT_HIDDEN = '环境配置内容已隐藏。';
/** Slack around the task's own time span: a session file is shared by every task that resumed it. */
const WINDOW_SLACK_MS = 2_000;

/** The session homes to search: the running coder's own first, then the user's default. */
export function coderHomes(env: { codex?: NodeJS.ProcessEnv; claude?: NodeJS.ProcessEnv }): CoderHomes {
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => !!value))];
  return {
    codex: unique([env.codex?.CODEX_HOME, process.env.CODEX_HOME, join(homedir(), '.codex')]),
    claude: unique([env.claude?.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude')]),
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

/** The task's process from the coder's own session file, limited to the task's time span. */
export async function taskTranscript(task: TaskRecord, homes: CoderHomes, now = Date.now()): Promise<Transcript> {
  if (!task.coderSessionId) return { entries: [], problem: '编码工具还没有报告会话，过程记录要等它启动后才有。' };
  const coder: CoderKind = task.coder;
  const source = coder === 'codex' ? await findCodexRollout(homes.codex, task.coderSessionId, task.createdAt)
    : await findClaudeSession(homes.claude, task.coderSessionId);
  if (!source) return { entries: [], problem: `没有找到 ${coder === 'codex' ? 'Codex' : 'Claude Code'} 的会话记录（${task.coderSessionId}）。` };
  const file = await readFile(source, 'utf8').catch(() => undefined);
  if (file === undefined) return { entries: [], source, problem: '会话记录读不出来。' };
  const window = { from: task.createdAt - WINDOW_SLACK_MS, to: (isActive(task) ? now : task.updatedAt) + WINDOW_SLACK_MS };
  const all = coder === 'codex' ? parseCodexRollout(file, window) : parseClaudeSession(file, window);
  const omitted = Math.max(0, all.length - ENTRY_LIMIT);
  return { entries: all.slice(omitted), source, ...(omitted ? { omitted } : {}) };
}
