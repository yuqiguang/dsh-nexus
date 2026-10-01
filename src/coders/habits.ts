import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { isInside } from './rules.js';
import type { CoderRequest, HabitKind, HabitRule } from './types.js';

const run = promisify(execFile);

export const HABIT_KINDS: readonly HabitKind[] = ['command', 'file-write', 'file-read', 'question', 'other'];

export const KIND_LABEL: Record<HabitKind, string> = {
  command: '命令', 'file-write': '写文件', 'file-read': '读文件', question: '提问', other: '工具',
};
export const DECISION_LABEL: Record<HabitRule['decision'], string> = { allow: '允许', deny: '拒绝', answer: '回答' };

/** Programs that cannot change anything by themselves: no rule is needed for them, unless the segment redirects their output into a file. */
const HARMLESS = new Set(['cd', 'pwd', 'true', 'false', ':', 'echo', 'printf', 'test', '[', '[[', 'read', 'exit', 'return', 'break', 'continue',
  'export', 'unset', 'set', 'shift', 'local', 'declare', 'readonly', 'sleep', 'wait']);
/** Shell keywords that precede a command inside a compound statement; they are not the program. */
const LEADING_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', '!', '{']);
/** Segments that are only control syntax and run nothing themselves: `fi`, `done`, `for f in *`, a closing brace or parenthesis. */
const SYNTAX_ONLY = /^(?:fi|done|esac|\}|\))(?:\s|$)|^for\s/;
/** Constructs whose effect is not visible from the leading tokens: allow rules do not apply to them, deny rules still do. */
const OPAQUE: readonly RegExp[] = [/\$\(/, /`/, /^(?:eval|exec|source|xargs|\.)(?:\s|$)/, /\b(?:ba|z|da)?sh\s+-[a-zA-Z]*c\b/, /\bsudo\b/,
  /^(?:case|select|function|trap)\s/, /^\w+\s*\(\s*\)/];
/** Output redirections (`>`, `>>`, `>|`, `2>`, `&>`); `2>&1` is not one because its target starts with `&`. */
const REDIRECT = /(?<![<>&|])(?:\d*>>?\|?|&>>?)\s*([^\s;&|<>]+)/g;
/** Shells: a heredoc fed to one is a script, not data. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

export type RuleDraft = Pick<HabitRule, 'kind' | 'pattern' | 'decision' | 'answer'>;

const BUILTIN: HabitRule = { id: 'builtin', source: 'project', kind: 'command', pattern: 'cd、pwd、echo、test', decision: 'allow',
  note: '内置：只切换目录、打印或判断，不改任何东西', createdAt: 0 };

export function describeDraft(draft: RuleDraft): string {
  return `${DECISION_LABEL[draft.decision]}${KIND_LABEL[draft.kind]}「${draft.pattern}」${draft.decision === 'answer' ? ` → ${draft.answer ?? ''}` : ''}`;
}

export function describeRule(rule: HabitRule): string {
  const origin = rule.source === 'project' ? rule.note ?? '项目约定' : rule.source === 'learned' ? '自动固化' : rule.note ? `用户：${rule.note}` : '用户设定';
  // Routine requests are allowed by default now; an allow rule left from before changes nothing.
  return `${rule.id} ${describeDraft(rule)}（${origin}）${rule.decision === 'allow' ? '——已无作用，可删除' : ''}`;
}

/** Strip the `bash -lc '<script>'` wrapper Codex puts around a command. One layer only; a nested one counts as opaque. */
export function unwrapShell(command: string): string {
  const match = /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-[a-zA-Z]*c\s+([\s\S]+)$/.exec(command);
  if (!match) return command.trim();
  const inner = match[1]!.trim();
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.length >= 2 && inner.endsWith(quote) ? inner.slice(1, -1) : inner;
}

interface HeredocOperator { delimiter: string; quoted: boolean; strip: boolean; end: number }

/** `<<`, `<<-`, optional blanks and a bare or quoted delimiter starting at `text[index]`; `<<<` is a here-string, not a heredoc. */
function heredocOperator(text: string, index: number): HeredocOperator | undefined {
  if (text[index] !== '<' || text[index + 1] !== '<' || text[index + 2] === '<' || text[index - 1] === '<') return undefined;
  let cursor = index + 2;
  const strip = text[cursor] === '-';
  if (strip) cursor++;
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor++;
  const quote = text[cursor];
  let delimiter = '';
  let quoted = false;
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, cursor + 1);
    if (close < 0) return undefined;
    delimiter = text.slice(cursor + 1, close);
    quoted = true;
    cursor = close + 1;
  } else {
    while (cursor < text.length && !/[\s;&|<>()]/.test(text[cursor]!)) {
      if (text[cursor] === '\\') { delimiter += text[cursor + 1] ?? ''; quoted = true; cursor += 2; } else delimiter += text[cursor++];
    }
  }
  return delimiter ? { delimiter, quoted, strip, end: cursor } : undefined;
}

/** The body lines from `from` up to the terminator line; `end` is the newline after the terminator, or the text's end. An unterminated body runs to the end. */
function heredocBody(text: string, from: number, delimiter: string, strip: boolean): { body: string; end: number } {
  let cursor = from;
  while (cursor <= text.length) {
    const lineEnd = text.indexOf('\n', cursor) < 0 ? text.length : text.indexOf('\n', cursor);
    const line = strip ? text.slice(cursor, lineEnd).replace(/^\t+/, '') : text.slice(cursor, lineEnd);
    if (line === delimiter) return { body: text.slice(from, cursor), end: lineEnd };
    if (lineEnd >= text.length) break;
    cursor = lineEnd + 1;
  }
  return { body: text.slice(from), end: text.length };
}

export interface Heredoc { delimiter: string; quoted: boolean; body: string }

/**
 * One segment with its heredocs taken out: the operator and delimiter, and the body up to the terminator line. The body is data the
 * program reads, like the content of a file write, so rules never see it; whether the delimiter was quoted says if the shell expands it.
 */
export function parseHeredocs(segment: string): { text: string; heredocs: Heredoc[] } {
  let text = '';
  const heredocs: Heredoc[] = [];
  const pending: HeredocOperator[] = [];
  let quote: string | undefined;
  for (let index = 0; index < segment.length; index++) {
    const char = segment[index]!;
    if (quote) {
      text += char;
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') text += segment[++index] ?? '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; text += char; continue; }
    if (char === '\\') { text += char + (segment[++index] ?? ''); continue; }
    const operator = heredocOperator(segment, index);
    if (operator) { pending.push(operator); text += ' '; index = operator.end - 1; continue; }
    if (char === '\n' && pending.length) {
      let cursor = index + 1;
      for (const item of pending.splice(0)) {
        const { body, end } = heredocBody(segment, cursor, item.delimiter, item.strip);
        heredocs.push({ delimiter: item.delimiter, quoted: item.quoted, body });
        cursor = end + 1;
      }
      text += ' ';
      index = cursor - 1;
      continue;
    }
    text += char;
  }
  return { text, heredocs };
}

/**
 * Split a script into simple commands on `&&`, `||`, `;`, `|`, `&` and newlines outside quotes; `2>&1` and `>|` stay intact. A
 * heredoc's body lines belong to the command that opened it, wherever on the line the operator was, so a script written with
 * `cat > file << 'EOF'` is one segment and its content never becomes commands.
 */
export function splitSegments(script: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | undefined;
  const pending: (HeredocOperator & { owner?: number })[] = [];
  const push = () => {
    for (const item of pending) item.owner ??= segments.length;
    segments.push(current);
    current = '';
  };
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!;
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') current += script[++index] ?? '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '\\') { current += char + (script[++index] ?? ''); continue; }
    const operator = heredocOperator(script, index);
    if (operator) { current += script.slice(index, operator.end); pending.push(operator); index = operator.end - 1; continue; }
    if (char === '\n' && pending.length) {
      let cursor = index + 1;
      for (const item of pending.splice(0)) {
        const { end } = heredocBody(script, cursor, item.delimiter, item.strip);
        const chunk = '\n' + script.slice(cursor, end);
        if (item.owner === undefined) current = current.trimEnd() + chunk; else segments[item.owner] = segments[item.owner]!.trimEnd() + chunk;
        cursor = end + 1;
      }
      push();
      index = cursor - 1;
      continue;
    }
    if (char === '&' && (script[index - 1] === '>' || script[index + 1] === '>')) { current += char; continue; }
    if (char === '|' && script[index - 1] === '>') { current += char; continue; }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      if ((char === '|' || char === '&') && script[index + 1] === char) index++;
      push();
      continue;
    }
    current += char;
  }
  push();
  return segments.map(segment => segment.trim()).filter(Boolean);
}

/**
 * Tokens of one simple command with quotes removed; leading `VAR=value` assignments, shell keywords (`if`, `then`, `do`, …) and
 * grouping parentheses are dropped, so `then cat -A x` and `(cd x` yield `cat` and `cd`. The program is reduced to its basename.
 * A segment that is only control syntax (`fi`, `done`, `for f in *`) has no tokens; heredocs are left out entirely.
 */
export function tokens(segment: string): string[] {
  let text = parseHeredocs(segment).text.trim();
  if (SYNTAX_ONLY.test(text)) return [];
  if (text.startsWith('(')) text = text.slice(1);
  if (text.endsWith(')') && !text.endsWith('\\)')) text = text.slice(0, -1);
  const out: string[] = [];
  let current = '';
  let quote: string | undefined;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\' && quote === '"') current += text[++index] ?? '';
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\\') { current += text[++index] ?? ''; started = true; continue; }
    if (/\s/.test(char)) { if (started) out.push(current); current = ''; started = false; continue; }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  while (out.length && (LEADING_KEYWORDS.has(out[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0]!))) out.shift();
  if (out[0]) out[0] = basename(out[0]);
  return out;
}

/** Files a segment redirects output into, sorted; `/dev/null` does not count, and a heredoc body is not scanned. */
export function redirectTargets(segment: string): string[] {
  const targets: string[] = [];
  for (const match of parseHeredocs(segment).text.matchAll(REDIRECT)) if (match[1] !== '/dev/null') targets.push(match[1]!);
  return targets.sort();
}

/** True when the segment writes a file through a redirection: even `echo` or `true` then creates a file. */
export function redirectsOutput(segment: string): boolean {
  return redirectTargets(segment).length > 0;
}

/** A segment no rule is needed for: pure control syntax, or a harmless program, in both cases without an output redirection. */
export function isHarmless(segment: string): boolean {
  const program = tokens(segment)[0];
  return (program === undefined || HARMLESS.has(program)) && !redirectsOutput(segment);
}

/** A rule's command pattern matches a segment when the pattern's tokens are the segment's leading tokens. Deny rules use this. */
export function commandMatches(pattern: string, segment: string): boolean {
  const want = tokens(pattern);
  const have = tokens(segment);
  return want.length > 0 && want.length <= have.length && want.every((token, index) => token === have[index]);
}

/**
 * An allow rule covers a segment when it matches and both write the same files: `cat` does not cover `cat a > b`, which needs a
 * rule such as `cat a > b` itself. Deny rules match by prefix alone, so `cat` still denies `cat a > b`.
 */
export function commandCovers(pattern: string, segment: string): boolean {
  return commandMatches(pattern, segment) && redirectTargets(pattern).join('\n') === redirectTargets(segment).join('\n');
}

export function isOpaque(segment: string): boolean {
  const { text, heredocs } = parseHeredocs(segment);
  if (OPAQUE.some(pattern => pattern.test(text.trim()))) return true;
  // A heredoc fed to a shell is a script; with an unquoted delimiter the shell runs `$(…)` in the body before the program sees it.
  if (heredocs.length && (SHELLS.has(tokens(segment)[0] ?? '') || heredocs.some(item => !item.quoted && /\$\(|`/.test(item.body)))) return true;
  return redirectTargets(segment).some(target => /^[/~$]/.test(target));
}

/** `*` within one path segment, `**` across segments, `?` one character; everything else literal. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Relative patterns are anchored at the task directory; a trailing `/` means everything below. */
export function pathMatches(pattern: string, path: string, cwd: string): boolean {
  const expanded = pattern.endsWith('/') ? `${pattern}**` : pattern;
  const anchored = isAbsolute(expanded) ? expanded : `${resolve(cwd)}/${expanded}`;
  return globToRegExp(anchored).test(resolve(path));
}

export interface HabitVerdict {
  decision: 'allow' | 'deny' | 'answer';
  rule: HabitRule;
  /** Question text to fixed answer, for `answer` verdicts. */
  answers?: Record<string, string>;
}

function commandOf(request: CoderRequest): string {
  return unwrapShell(request.command ?? request.detail);
}

/**
 * Second decision layer: deterministic habit rules. A deny rule from any
 * source wins; allowing needs every part of the request covered by an allow
 * rule. `undefined` means no rule applies, never "allow".
 */
export function habitRule(request: CoderRequest, rules: readonly HabitRule[], cwd: string): HabitVerdict | undefined {
  const applicable = rules.filter(rule => rule.kind === request.kind);
  if (request.kind === 'command') {
    const segments = splitSegments(commandOf(request));
    if (!segments.length) return undefined;
    for (const segment of segments) {
      const deny = applicable.find(rule => rule.decision === 'deny' && commandMatches(rule.pattern, segment));
      if (deny) return { decision: 'deny', rule: deny };
    }
    if (segments.some(isOpaque)) return undefined;
    let matched: HabitRule | undefined;
    for (const segment of segments) {
      if (isHarmless(segment)) continue;
      const allow = applicable.find(rule => rule.decision === 'allow' && commandCovers(rule.pattern, segment));
      if (!allow) return undefined;
      matched ??= allow;
    }
    return { decision: 'allow', rule: matched ?? BUILTIN };
  }
  if (request.kind === 'file-write' || request.kind === 'file-read') {
    if (!request.paths.length) return undefined;
    for (const path of request.paths) {
      const deny = applicable.find(rule => rule.decision === 'deny' && pathMatches(rule.pattern, path, cwd));
      if (deny) return { decision: 'deny', rule: deny };
    }
    let matched: HabitRule | undefined;
    for (const path of request.paths) {
      const allow = applicable.find(rule => rule.decision === 'allow' && pathMatches(rule.pattern, path, cwd));
      if (!allow) return undefined;
      matched ??= allow;
    }
    return matched ? { decision: 'allow', rule: matched } : undefined;
  }
  if (request.kind === 'question') {
    const questions = request.questions ?? [];
    if (!questions.length) return undefined;
    const answers: Record<string, string> = {};
    let matched: HabitRule | undefined;
    for (const question of questions) {
      const haystack = `${question.header ?? ''}\n${question.question}`.toLowerCase();
      const rule = applicable.find(rule => rule.decision === 'answer' && !!rule.answer && haystack.includes(rule.pattern.toLowerCase()));
      if (!rule) return undefined;
      answers[question.question] = rule.answer!;
      matched ??= rule;
    }
    return matched ? { decision: 'answer', rule: matched, answers } : undefined;
  }
  if (request.kind === 'other') {
    const deny = applicable.find(rule => rule.decision === 'deny' && globToRegExp(rule.pattern).test(request.tool));
    if (deny) return { decision: 'deny', rule: deny };
    const allow = applicable.find(rule => rule.decision === 'allow' && globToRegExp(rule.pattern).test(request.tool));
    return allow ? { decision: 'allow', rule: allow } : undefined;
  }
  return undefined;
}

const FENCE = /^```(?:nexus-)?coder-rules\s*$/;

/**
 * One line of a `coder-rules` block: `deny <kind>: <pattern>` or `answer question: <keyword> = <answer>`. `allow` lines are
 * skipped: routine requests are allowed by default, and what the hard rules escalate no rule may allow.
 */
export function parseRuleLine(line: string): RuleDraft | undefined {
  const match = /^(deny|answer)\s+(command|file-write|file-read|question|other)\s*[:：]\s*(.+)$/.exec(line.trim());
  if (!match) return undefined;
  const decision = match[1] as HabitRule['decision'];
  const kind = match[2] as HabitKind;
  const rest = match[3]!.trim();
  if (decision === 'answer') {
    if (kind !== 'question') return undefined;
    const pair = /^(.+?)\s*=\s*(.+)$/.exec(rest);
    return pair ? { kind, decision, pattern: pair[1]!.trim(), answer: pair[2]!.trim() } : undefined;
  }
  return kind === 'question' ? undefined : { kind, decision, pattern: rest };
}

/** Rules declared in fenced ```coder-rules blocks of a project file. Unparseable lines are skipped. */
export function parseRuleBlocks(text: string, file: string): HabitRule[] {
  const rules: HabitRule[] = [];
  let inside = false;
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!inside) { if (FENCE.test(line)) inside = true; return; }
    if (line.startsWith('```')) { inside = false; return; }
    if (!line || line.startsWith('#')) return;
    const draft = parseRuleLine(line);
    if (draft) rules.push({ ...draft, id: `${file}:${index + 1}`, source: 'project', note: `${file} 第 ${index + 1} 行`, createdAt: 0 });
  });
  return rules;
}

/**
 * Project conventions: `coder-rules` blocks in AGENTS.md and CLAUDE.md of the
 * task directory and of its repository root when that root lies inside a coder
 * root. Read once when a task starts, so a coder cannot grant itself rules mid-task.
 */
export async function projectRules(cwd: string, roots: readonly string[]): Promise<HabitRule[]> {
  const directories = [resolve(cwd)];
  try {
    const top = resolve((await run('git', ['rev-parse', '--show-toplevel'], { cwd })).stdout.trim());
    if (top && top !== directories[0] && roots.some(root => isInside(root, top))) directories.push(top);
  } catch { /* not a repository */ }
  const rules: HabitRule[] = [];
  for (const directory of directories) {
    for (const name of ['AGENTS.md', 'CLAUDE.md']) {
      const file = resolve(directory, name);
      const text = await readFile(file, 'utf8').catch(() => undefined);
      if (text) rules.push(...parseRuleBlocks(text, relative(resolve(cwd), file) || name));
    }
  }
  return rules;
}
