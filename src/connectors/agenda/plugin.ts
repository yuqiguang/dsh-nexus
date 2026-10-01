import type { Context } from '@deepseek-ai/cordis';
import type {} from '../../dsh/nexus.js';

export const name = 'nexus-agenda';
export const inject = ['nexusConnectors', 'tools', 'systemPrompt'];

/** Native lifetime owns tools and reminders; the core retains data and settings. */
export async function apply(ctx: Context): Promise<void> {
  await ctx.nexusConnectors.enableAgenda(ctx);
}
