import { ChannelError } from '../channels/types.js';
import type { CoderRequest } from './types.js';

/** Owner settings only. Snapshotted at admission; never populated from task arguments. */
export interface CoderReviewPolicy {
  commands: 'auto' | 'ask';
  files: 'auto' | 'ask';
  network: 'auto' | 'ask';
  instructions: string;
}
export const DEFAULT_REVIEW_POLICY: Readonly<CoderReviewPolicy> = Object.freeze({ commands: 'auto', files: 'auto', network: 'auto', instructions: '' });

export function reviewPolicy(value: unknown): CoderReviewPolicy {
  if (value === undefined) return { ...DEFAULT_REVIEW_POLICY };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError('invalid_configuration');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_REVIEW_POLICY, key))) throw new ChannelError('invalid_configuration');
  const result = { ...DEFAULT_REVIEW_POLICY };
  for (const key of ['commands', 'files', 'network'] as const) {
    if (input[key] === undefined) continue;
    if (input[key] !== 'auto' && input[key] !== 'ask') throw new ChannelError('invalid_configuration');
    result[key] = input[key];
  }
  if (input.instructions !== undefined) {
    if (typeof input.instructions !== 'string' || input.instructions.length > 4000) throw new ChannelError('invalid_configuration');
    result.instructions = input.instructions.trim();
  }
  return result;
}

/** Applies only after hard/habit rules, to requests which already require approval. */
export function reviewRequiresOwner(policy: CoderReviewPolicy | undefined, request: CoderRequest): boolean {
  if (!policy) return false;
  if (request.kind === 'network' || request.raw.networkApprovalContext && !request.command) return policy.network === 'ask';
  if (request.kind === 'command') return policy.commands === 'ask';
  if (request.kind === 'file-read' || request.kind === 'file-write') return policy.files === 'ask';
  return false;
}
