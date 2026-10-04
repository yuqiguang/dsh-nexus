/** Native app-server final-output contract; prose never controls task state. */
export const CODEX_RESULT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'text'],
  properties: {
    status: { type: 'string', enum: ['completed', 'needs_input', 'blocked'], description: 'completed: assigned work finished; needs_input: a user answer is required to continue the assigned work; blocked: cannot continue. Optional suggestions and quoted questions are not needs_input.' },
    text: { type: 'string', description: 'Human-readable result, blocking question, or blocker. Do not claim host verification has already run.' },
  },
} as const;
export interface CodexTurnResult { status: 'completed' | 'needs_input' | 'blocked'; text: string }
export function parseTurnResult(text: string): CodexTurnResult | undefined {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !['completed', 'needs_input', 'blocked'].includes(value.status) || typeof value.text !== 'string' || !value.text.trim()) return undefined;
    return { status: value.status, text: value.text };
  } catch { return undefined; }
}
