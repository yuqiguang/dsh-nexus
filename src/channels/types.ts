export const channelIds = ['wechat', 'feishu', 'wecom'] as const;
export type ChannelId = typeof channelIds[number];
export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export interface ConnectionState {
  phase: ConnectionPhase;
  error?: string;
  retryAfterMs?: number;
  pendingDeliveries?: number;
  deliveryError?: string;
}

/** One connection grant; only the host may read the secret. */
export interface ConnectionRecord {
  version: 1;
  revision: number;
  enabled: boolean;
  accountId: string;
  ownerId: string;
  secret: string;
  baseUrl?: string;
  /**
   * Absolute directory this channel's sessions work in. Unset means the service's
   * shared workspace (the profile's `workspaceRoot`), which is where every channel
   * worked before this existed — so an unset field is the old behaviour, not "nowhere".
   */
  workspaceRoot?: string;
  invalidated?: boolean;
}

export interface ConnectionView extends ConnectionState {
  channel: ChannelId;
  revision: number;
  enabled: boolean;
  accountId: string;
  ownerId: string;
  configured: boolean;
  secretConfigured: boolean;
  /** The directory in effect, not only what was saved: the shared workspace when the record sets none. */
  workspaceRoot?: string;
}

export interface QrView {
  phase: 'waiting' | 'scanned' | 'connected' | 'expired' | 'error';
  image?: string;
  error?: string;
}

export interface FeishuPairingView {
  id: string;
  revision: number;
  phase: 'connecting' | 'waiting' | 'confirm' | 'expired' | 'error';
  expiresAt: number;
  code?: string;
  candidateOpenId?: string;
  error?: string;
}

export interface ChannelsView { connections: ConnectionView[]; wechatQr?: QrView; feishuPairing?: FeishuPairingView }

export class ChannelError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function channelId(value: unknown): ChannelId {
  if (!channelIds.includes(value as ChannelId)) throw new ChannelError('invalid_channel');
  return value as ChannelId;
}
