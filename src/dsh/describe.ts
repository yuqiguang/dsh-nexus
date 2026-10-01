/** One line about the tool the model is running; the description field when a tool has one, else its name. */
export function describeToolCall(call: { name: string; arguments: string }): string {
  let text = call.name;
  try {
    const args = JSON.parse(call.arguments) as Record<string, unknown>;
    const detail = [args.description, args.summary, args.task, args.command, args.query].find(value => typeof value === 'string' && value.trim());
    if (typeof detail === 'string') text = `${call.name}：${detail.trim().replace(/\s+/g, ' ')}`;
  } catch { /* arguments still streaming or not JSON */ }
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** The heartbeat text: how long the turn has run and what the model touched last. */
export function heartbeatText(elapsedMs: number, lastCall?: string): string {
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  return [`还在处理，已用 ${minutes} 分钟。`, lastCall ? `最近一步：${lastCall}。` : '', '回复“状态”查看，/cancel 停止。'].filter(Boolean).join('');
}
