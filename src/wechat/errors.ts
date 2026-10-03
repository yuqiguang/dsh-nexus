import { ChannelError, type WechatDiagnostic } from '../channels/types.js';

export function safeDiagnostic(value: unknown): WechatDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const d = value as WechatDiagnostic;
  if (!['send', 'poll', 'other'].includes(d.operation) || !Number.isInteger(d.httpStatus) || d.httpStatus < 100 || d.httpStatus > 599) return;
  return { operation: d.operation, httpStatus: d.httpStatus,
    ...(Number.isSafeInteger(d.ret) ? { ret: d.ret } : {}), ...(Number.isSafeInteger(d.errcode) ? { errcode: d.errcode } : {}) };
}

export class WechatRequestError extends ChannelError {
  readonly diagnostic?: WechatDiagnostic;
  constructor(code: string, diagnostic?: WechatDiagnostic) {
    super(code);
    this.diagnostic = safeDiagnostic(diagnostic);
  }
}
