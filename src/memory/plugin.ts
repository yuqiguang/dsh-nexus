import type { Context } from '@deepseek-ai/cordis';
import type {} from '../dsh/nexus.js';
import { installMemory } from './index.js';

export const name = 'nexus-memory';
export const inject = ['nexusMemoryData', 'tools', 'systemPrompt'];

/** The core owns user data; this component owns only model access and automatic writes. */
export function apply(ctx: Context): void {
  const runtime = installMemory(ctx, ctx.nexusMemoryData, { closeService: false });
  ctx.provide('nexusMemoryRuntime', runtime);
}
