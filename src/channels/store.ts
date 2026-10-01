import { isAbsolute, resolve } from 'node:path';
import type { Records } from './records.js';
import { ChannelError, type ChannelId, type ConnectionRecord } from './types.js';

export type ConnectionInput = { accountId: string; ownerId: string; secret?: string };

function text(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.trim().length > max) throw new ChannelError('invalid_configuration');
  return value.trim();
}

/**
 * One channel's working directory: an absolute path, made canonical by `resolve`
 * (so `..` and a trailing slash cannot name a second directory). Empty means the
 * service's shared workspace. The directory itself is created when the channel
 * mounts, so the settings page never has to check that it exists.
 */
export function workspaceRoot(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > 1024) throw new ChannelError('invalid_workspace');
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) throw new ChannelError('invalid_workspace');
  return resolve(trimmed);
}

export function connectionInput(value: unknown): ConnectionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelError('invalid_configuration');
  const input = value as Record<string, unknown>;
  return { accountId: text(input.accountId), ownerId: text(input.ownerId),
    ...(input.secret === undefined ? {} : { secret: text(input.secret, 4096) }) };
}

export function wechatBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ChannelError('invalid_wechat_server'); }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.username || url.password ||
      url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new ChannelError('invalid_wechat_server');
  }
  return url.origin;
}

function decode(record: unknown): ConnectionRecord | undefined {
  if (record === undefined) return undefined;
  if (!record || typeof record !== 'object') throw new ChannelError('invalid_saved_connection');
  const value = record as ConnectionRecord;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.enabled !== 'boolean' || typeof value.accountId !== 'string' ||
      typeof value.ownerId !== 'string' || typeof value.secret !== 'string') throw new ChannelError('invalid_saved_connection');
  // A stored directory that is not an absolute path is a record this version cannot honour: refuse the
  // channel rather than quietly working somewhere the user did not name.
  const workspace = workspaceRoot(value.workspaceRoot);
  return workspace ? { ...value, workspaceRoot: workspace } : { ...value };
}

export function requireFeishuApplication(record: Pick<ConnectionRecord, 'accountId' | 'secret'>): void {
  if (!record.accountId || !record.secret) throw new ChannelError('missing_application_credentials');
  if (!/^cli_[a-f0-9]{16}$/i.test(record.accountId)) throw new ChannelError('invalid_feishu_app_id');
}

export function requireConnection(channel: ChannelId, record: ConnectionRecord): void {
  if (!record.accountId || !record.ownerId || !record.secret) throw new ChannelError('missing_credentials');
  if (channel === 'feishu' && !/^cli_[a-f0-9]{16}$/i.test(record.accountId)) throw new ChannelError('invalid_feishu_app_id');
  if (channel === 'wechat') wechatBaseUrl(record.baseUrl ?? '');
}

/** DSH owns durable credential writes; the record groups a grant and its connection preferences atomically. */
export class ConnectionStore {
  constructor(private readonly records: Records, private readonly legacyFeishu?: ConnectionRecord) {}

  async read(channel: ChannelId): Promise<ConnectionRecord | undefined> {
    return decode(await this.records.read(channel))
      ?? (channel === 'feishu' ? this.legacyFeishu : undefined);
  }

  async save(channel: ChannelId, expectedRevision: number, input: ConnectionInput, enabled: boolean): Promise<ConnectionRecord> {
    if (channel === 'wechat') throw new ChannelError('wechat_requires_qr');
    return this.modify(channel, expectedRevision, previous => ({
      ...previous, version: 1, revision: (previous?.revision ?? 0) + 1, enabled, invalidated: false,
      accountId: input.accountId, ownerId: input.ownerId,
      secret: input.secret || (channel !== 'feishu' || previous?.accountId === input.accountId ? previous?.secret : '') || '',
    }));
  }

  async setEnabled(channel: ChannelId, expectedRevision: number, enabled: boolean): Promise<ConnectionRecord> {
    return this.modify(channel, expectedRevision, previous => {
      if (!previous) throw new ChannelError('missing_credentials');
      return { ...previous, enabled, revision: previous.revision + 1 };
    }, enabled);
  }

  async saveWechat(expectedRevision: number, grant: { accountId: string; ownerId: string; secret: string; baseUrl: string }): Promise<ConnectionRecord> {
    const input = connectionInput(grant);
    return this.modify('wechat', expectedRevision, previous => ({
      version: 1, revision: (previous?.revision ?? 0) + 1, enabled: true,
      accountId: input.accountId, ownerId: input.ownerId, secret: input.secret ?? '', baseUrl: wechatBaseUrl(grant.baseUrl),
      // The scan grants a connection, not a working directory: a workspace the user chose survives it.
      ...(previous?.workspaceRoot ? { workspaceRoot: previous.workspaceRoot } : {}),
    }));
  }

  /**
   * Where this channel works. Unset returns it to the service's shared workspace.
   * The directory is used when the channel next mounts, so a session already open
   * finishes where it started and the generations after it use the new one.
   */
  async setWorkspace(channel: ChannelId, expectedRevision: number, root: string | undefined): Promise<ConnectionRecord> {
    return this.modify(channel, expectedRevision, previous => {
      if (!previous) throw new ChannelError('missing_credentials');
      const { workspaceRoot: _dropped, ...kept } = previous;
      return root ? { ...kept, revision: previous.revision + 1, workspaceRoot: root } : { ...kept, revision: previous.revision + 1 };
    });
  }

  /** A failed old connection cannot erase a newer grant or another owner's credentials. */
  async invalidate(channel: ChannelId, failed: ConnectionRecord): Promise<void> {
    await this.records.modify(channel, async current => {
      const previous = decode(current) ?? (channel === 'feishu' ? this.legacyFeishu : undefined);
      if (!previous || previous.accountId !== failed.accountId || previous.ownerId !== failed.ownerId || previous.secret !== failed.secret) return undefined;
      return { ...previous, secret: '', enabled: false, invalidated: true, revision: previous.revision + 1 };
    });
  }

  private async modify(channel: ChannelId, expectedRevision: number,
    update: (previous: ConnectionRecord | undefined) => ConnectionRecord, validate = true): Promise<ConnectionRecord> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ChannelError('invalid_revision');
    const result = await this.records.modify(channel, async current => {
      const previous = decode(current) ?? (channel === 'feishu' ? this.legacyFeishu : undefined);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new ChannelError('configuration_changed');
      const next = update(previous);
      if (validate) {
        if (channel === 'feishu' && !next.enabled && !next.ownerId) requireFeishuApplication(next);
        else requireConnection(channel, next);
      }
      return next;
    });
    return decode(result)!;
  }
}
