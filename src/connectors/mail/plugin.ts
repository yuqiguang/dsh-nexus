import type { Context } from '@deepseek-ai/cordis';
import type {} from '../../dsh/nexus.js';

export const name = 'nexus-mail';
export const inject = ['nexusConnectors', 'tools', 'systemPrompt', 'userQuestions'];

/** Native component lifetime owns mail tools, approval hooks and connections. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.nexusConnectors.enableMail(ctx);
}
