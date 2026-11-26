import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext, ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';

/** Execute one native tool through the single-call or batch API, preserving agent scope. */
export async function executeNativeTool(ctx: Context, name: string, args: Record<string, unknown>, exec: ToolRunContext, callId: ToolCallId): Promise<ToolExecutionResult> {
  const tools = ctx.tools as unknown as {
    setExecutor?: unknown;
    execute(input: unknown): Promise<ToolExecutionResult | { results: { callId: ToolCallId; result: ToolExecutionResult }[]; additionalContexts?: ToolExecutionResult['additionalContexts'] }>;
  };
  if (typeof tools.setExecutor !== 'function') {
    return await tools.execute({ name, arguments: args, agent: exec.agent, callId,
      rootCallId: exec.rootCallId, parent: exec.token, signal: exec.signal }) as ToolExecutionResult;
  }
  const batch = await tools.execute({ calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
    agent: exec.agent, signal: exec.signal, toolSet: (exec as unknown as { toolSet?: unknown }).toolSet });
  const outcome = 'results' in batch ? batch.results[0] : undefined;
  if (!('results' in batch) || batch.results.length !== 1 || !outcome || outcome.callId !== callId) throw new Error('native_tool_result_mismatch');
  return { ...outcome.result, additionalContexts: batch.additionalContexts ?? outcome.result.additionalContexts };
}
