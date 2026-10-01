import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-tools';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { INBOX_DIR } from '../channels/inbox.js';

/**
 * Text the user did not write (mail, an inbound hook, a web page, a file sent into the chat)
 * is marked before the model sees it, and an obvious attempt to override the assistant is replaced.
 * The rest of the text stays, so the model can still tell the user what the message was about.
 * A paraphrase that does not use these words is not caught here; sending mail still asks the user.
 */

/** What replaces one override attempt. It must not itself match a pattern below. */
export const REDACTED_INSTRUCTION = '[已略去：这段文字在要求忽略既有指令]';

const RULES: readonly RegExp[] = [
  /忽略\s*(?:之前|以上|前面|先前|所有|全部)\s*的?\s*(?:指令|指示|命令|规则)/g,
  /ignore(?:\s+\w+){0,6}\s+(?:previous|prior|above|earlier)\s+(?:instructions|prompts|rules)/gi,
  /disregard(?:\s+\w+){0,6}\s+(?:previous|prior|above|earlier|all)\s+(?:instructions|prompts|rules)/gi,
  /(?:do not|don't)\s+follow(?:\s+\w+){0,4}\s+(?:previous|original)\s+(?:instructions|rules)/gi,
];

/** Replace each obvious override and leave the surrounding text. A second pass finds nothing new. */
export function redactInstructions(text: string): string {
  let out = text;
  for (const rule of RULES) {
    rule.lastIndex = 0;
    out = out.replace(rule, REDACTED_INSTRUCTION);
  }
  return out;
}

/** One line in front of a mail body or a file sent into the chat. The rule for it is in the assistant prompt. */
export function markUntrusted(source: string, text: string): string {
  return `[外部内容] 来源：${source}\n${redactInstructions(text)}`;
}

/** DSH's web tools already open every result with their own untrusted-data notice, so only the redaction is added. */
const WEB_TOOLS = new Set(['web_fetch', 'web_search']);
/** The file tools and the argument naming the file, for files the chat delivered into `inbox/`. */
const FILE_TOOLS: Readonly<Record<string, string>> = { read: 'file_path' };

/** Where a tool result came from when it is text someone else wrote, or undefined when it is not. */
export function untrustedSource(name: string, args: unknown, cwd: string | undefined): { kind: 'web' } | { kind: 'file'; path: string } | undefined {
  if (WEB_TOOLS.has(name)) return { kind: 'web' };
  const key = FILE_TOOLS[name];
  const path = key ? (args as Record<string, unknown> | undefined)?.[key] : undefined;
  if (typeof path !== 'string' || !cwd) return undefined;
  const inside = relative(resolve(cwd), resolve(cwd, path));
  return !isAbsolute(inside) && inside.startsWith(INBOX_DIR + sep) ? { kind: 'file', path: inside.split(sep).join('/') } : undefined;
}

/** The result as the model should see it: redacted, and a file from the chat marked the way a mail body is. */
export function markResult(source: NonNullable<ReturnType<typeof untrustedSource>>, content: readonly ContentBlock[]): ContentBlock[] {
  const redacted = content.map(block => block.type === 'text' ? { ...block, text: redactInstructions(block.text) } : block);
  return source.kind === 'file' ? [{ type: 'text', text: `[外部内容] 来源：聊天里发来的文件 ${source.path}` }, ...redacted] : redacted;
}

/**
 * Web results and files the chat delivered pass through here after the tool ran. DSH's spill policy
 * prepends itself to this waterfall, so it runs outside this one and trims a large result after it was marked.
 */
export function installUntrustedResults(ctx: Context): void {
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || decision.value !== undefined || result.isError) return decision;
    const source = untrustedSource(exec.name, exec.arguments, exec.agent?.session.header.cwd);
    if (!source) return decision;
    return { ...decision, content: markResult(source, decision.content ?? result.content) };
  });
}
