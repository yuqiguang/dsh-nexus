import { FeishuPairing, isFeishuPairingCode } from '../feishu/pairing.js';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import type { ChannelIdentity, ChannelTransport, InboundMessage } from './protocol.js';
import { ConnectionStore, connectionInput, requireConnection, workspaceRoot } from './store.js';
import { ChannelError, channelId, channelIds, type ChannelId, type ChannelsView, type ConnectionRecord, type ConnectionState, type QrView } from './types.js';
import { WechatClient } from '../wechat/client.js';

export interface MountedChannel { receive(message: InboundMessage): Promise<void>; close(): Promise<void>; retryPending?(): Promise<void> }
export interface ChannelDependencies {
  transport(channel: ChannelId, record: ConnectionRecord, state: (state: ConnectionState) => void): ChannelTransport;
  /** Mounts a channel in `record.workspaceRoot` (or the shared workspace when it sets none). */
  mount(transport: ChannelTransport, identity: ChannelIdentity, record: ConnectionRecord): Promise<MountedChannel>;
  wechatClient(): WechatClient;
  /** The shared workspace a channel without its own directory works in; the settings page shows it as the current value. */
  defaultWorkspace?: string;
}

/** Connection lifecycle only. Agent execution and durable task state remain in DSH. */
export class ChannelManager {
  private readonly running = new Map<ChannelId, MountedChannel>();
  private readonly generations = new Map<ChannelId, number>();
  private readonly states = new Map<ChannelId, ConnectionState>();
  private qr?: QrView;
  private qrController?: AbortController;
  private readonly qrTasks = new Set<Promise<void>>();
  private readonly stateChanges = new Set<Promise<void>>();
  private qrOperations: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private feishuPairing?: FeishuPairing;
  private feishuOperations: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: ConnectionStore, private readonly dependencies: ChannelDependencies) {}

  async restore(): Promise<void> {
    for (const channel of channelIds) {
      const record = await this.store.read(channel);
      if (record?.enabled) await this.apply(channel, record);
    }
  }

  async view(): Promise<ChannelsView> {
    const connections = [];
    for (const channel of channelIds) {
      const record = await this.store.read(channel);
      connections.push({ channel, revision: record?.revision ?? 0, enabled: record?.enabled ?? false,
        accountId: record?.accountId ?? '', ownerId: record?.ownerId ?? '',
        configured: !!(record?.accountId && record.ownerId && record.secret), secretConfigured: !!record?.secret,
        ...(record?.workspaceRoot ?? this.dependencies.defaultWorkspace ? { workspaceRoot: record?.workspaceRoot ?? this.dependencies.defaultWorkspace } : {}),
        ...(this.states.get(channel) ?? (record?.invalidated
          ? { phase: 'error' as const, error: 'authentication_failed' } : { phase: 'disconnected' as const })) });
    }
    return { connections, ...(this.qr ? { wechatQr: { ...this.qr } } : {}), ...(this.feishuPairing ? { feishuPairing: this.feishuPairing.view() } : {}) };
  }

  /** Where every channel works: its own directory, else the shared one. */
  async workspaces(): Promise<string[]> {
    const roots = new Set<string>();
    for (const channel of channelIds) {
      const record = await this.store.read(channel);
      const root = record?.workspaceRoot ?? this.dependencies.defaultWorkspace;
      if (root) roots.add(root);
    }
    return [...roots];
  }

  async handle(method: string, payload: unknown): Promise<ChannelsView> {
    if (this.stopped) throw new ChannelError('connection_cancelled');
    if (method === 'list') return this.view();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ChannelError('invalid_configuration');
    const input = payload as Record<string, unknown>;
    if (method.startsWith('feishu/pair/')) {
      const pairing = this.feishuPairing;
      if (method === 'feishu/pair/cancel' && pairing && input.id === pairing.id && input.revision === pairing.record.revision) pairing.cancel();
      await this.queueFeishu(async () => {
        if (method === 'feishu/pair/start') await this.startFeishuPairing(input.revision as number, input.config);
        else if (method === 'feishu/pair/cancel') {
          if (!this.feishuPairing || input.id !== this.feishuPairing.id || input.revision !== this.feishuPairing.record.revision) throw new ChannelError('configuration_changed');
          await this.cancelFeishuPairing();
        } else if (method === 'feishu/pair/confirm') await this.confirmFeishuPairing(input.id, input.revision);
        else throw new ChannelError('unknown_action');
      });
    } else if (method === 'qr/start') {
      this.qrController?.abort();
      await this.queueQr(() => this.startQr(input.revision as number));
    } else if (method === 'qr/cancel') {
      this.qrController?.abort();
      await this.queueQr(async () => this.cancelQr());
    } else {
      const channel = channelId(input.channel);
      const revision = input.revision as number;
      const change = async () => {
        if (method === 'retry-delivery') {
          const record = await this.store.read(channel);
          if (record?.revision !== revision) throw new ChannelError('configuration_changed');
          const connection = this.running.get(channel);
          if (!record.enabled || !connection?.retryPending) throw new ChannelError('not_connected');
          await connection.retryPending();
          return;
        }
        let record: ConnectionRecord;
        if (method === 'save') {
          if (typeof input.connect !== 'boolean') throw new ChannelError('invalid_configuration');
          record = await this.store.save(channel, revision, connectionInput(input.config), input.connect);
        } else if (method === 'connect' || method === 'disconnect') {
          record = await this.store.setEnabled(channel, revision, method === 'connect');
        } else if (method === 'save-workspace') {
          record = await this.store.setWorkspace(channel, revision, workspaceRoot(input.workspaceRoot));
        } else throw new ChannelError('unknown_action');
        if (channel === 'feishu') await this.cancelFeishuPairing();
        await this.apply(channel, record);
      };
      if (channel === 'wechat' && method !== 'retry-delivery') {
        this.qrController?.abort();
        await this.queueQr(async () => { this.cancelQr(); await change(); });
      } else if (channel === 'feishu') await this.queueFeishu(change);
      else await change();
    }
    return this.view();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.feishuPairing?.cancel();
    await this.feishuOperations.catch(() => {});
    await this.cancelFeishuPairing();
    this.qrController?.abort();
    await this.queueQr(async () => this.cancelQr());
    await Promise.allSettled(this.qrTasks);
    for (const channel of channelIds) await this.stop(channel);
    await Promise.allSettled(this.stateChanges);
  }

  private queueFeishu(operation: () => Promise<void>): Promise<void> {
    const next = this.feishuOperations.catch(() => {}).then(() => {
      if (this.stopped) throw new ChannelError('connection_cancelled');
      return operation();
    });
    this.feishuOperations = next;
    return next;
  }

  private async cancelFeishuPairing(): Promise<void> {
    const pairing = this.feishuPairing;
    this.feishuPairing = undefined;
    pairing?.cancel();
    await pairing?.stopTransport();
  }

  private async startFeishuPairing(revision: number, config: unknown): Promise<void> {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new ChannelError('invalid_configuration');
    const input = connectionInput({ ...config, ownerId: '' });
    const previous = await this.store.read('feishu');
    // Keep the old owner for a same-application re-pair, but pause its task receiver.
    input.ownerId = previous?.accountId === input.accountId ? previous.ownerId : '';
    const record = await this.store.save('feishu', revision, input, false);
    await this.cancelFeishuPairing();
    await this.apply('feishu', record);
    if (this.stopped) return;
    const pairing = this.feishuPairing = new FeishuPairing(record);
    try { pairing.start(this.dependencies.transport('feishu', record, state => pairing.state(state))); }
    catch { pairing.state({ phase: 'error', error: 'connection_failed' }); }
  }

  private async confirmFeishuPairing(id: unknown, revision: unknown): Promise<void> {
    const pairing = this.feishuPairing;
    if (!pairing) throw new ChannelError('feishu_pairing_not_ready');
    const ownerId = pairing.owner(id, revision);
    await pairing.stopTransport();
    pairing.owner(id, revision); // Expiry/cancellation during close must not commit a grant.
    const record = await this.store.save('feishu', pairing.record.revision,
      { accountId: pairing.record.accountId, secret: pairing.record.secret, ownerId }, true);
    if (pairing.controller.signal.aborted || this.stopped || Date.now() >= pairing.expiresAt) {
      // A cancel or shutdown can arrive while native credentials commit. Restore the paused binding.
      await this.store.save('feishu', record.revision, pairing.record, false);
      return;
    }
    pairing.cancel(); this.feishuPairing = undefined;
    await this.apply('feishu', record);
  }

  private async stop(channel: ChannelId): Promise<number> {
    const generation = (this.generations.get(channel) ?? 0) + 1;
    this.generations.set(channel, generation);
    const previous = this.running.get(channel);
    this.running.delete(channel);
    await previous?.close();
    return generation;
  }

  private async apply(channel: ChannelId, record: ConnectionRecord): Promise<void> {
    const generation = await this.stop(channel);
    const current = () => !this.stopped && this.generations.get(channel) === generation;
    if (!current()) return;
    if (!record.enabled) { this.states.set(channel, { phase: 'disconnected' }); return; }
    requireConnection(channel, record);
    this.states.set(channel, { phase: 'connecting' });
    const updateState = (state: ConnectionState) => {
      if (!current()) return;
      this.states.set(channel, state);
      if (state.error === 'authentication_failed') {
        const change = this.invalidate(channel, record);
        this.stateChanges.add(change);
        void change.finally(() => this.stateChanges.delete(change));
      }
    };
    const transport = this.dependencies.transport(channel, record, updateState);
    const mounted = await this.dependencies.mount(transport, { channel, accountId: record.accountId, ownerId: record.ownerId }, record);
    if (!current()) { await mounted.close(); return; }
    this.running.set(channel, mounted);
    void transport.start(message => channel === 'feishu' && isFeishuPairingCode(message.text) ? Promise.resolve() : mounted.receive(message)).catch(async error => {
      if (!current()) return;
      if (error instanceof ChannelError && error.code === 'authentication_failed') {
        updateState({ phase: 'error', error: 'authentication_failed' });
        return;
      }
      this.running.delete(channel);
      await mounted.close().catch(() => {});
      if (current()) this.states.set(channel, { phase: 'error',
        error: error instanceof ChannelError ? error.code : 'connection_failed' });
    });
  }

  private async invalidate(channel: ChannelId, failed: ConnectionRecord): Promise<void> {
    const state = this.states.get(channel);
    let generation = this.generations.get(channel);
    try {
      generation = await this.stop(channel);
      await this.store.invalidate(channel, failed);
      if (this.generations.get(channel) === generation) this.states.set(channel, { ...state, phase: 'error', error: 'authentication_failed' });
    } catch {
      if (this.generations.get(channel) === generation) this.states.set(channel, { ...state, phase: 'error', error: 'configuration_failed' });
    }
  }

  private cancelQr(): void {
    this.qrController?.abort();
    this.qrController = undefined;
    this.qr = undefined;
  }

  private queueQr(operation: () => Promise<void>): Promise<void> {
    const next = this.qrOperations.catch(() => {}).then(operation);
    this.qrOperations = next;
    return next;
  }

  private async startQr(revision: number): Promise<void> {
    if (this.stopped) throw new ChannelError('connection_cancelled');
    if (!Number.isSafeInteger(revision) || revision < 0) throw new ChannelError('invalid_revision');
    const previous = await this.store.read('wechat');
    if ((previous?.revision ?? 0) !== revision) throw new ChannelError('configuration_changed');
    this.cancelQr();
    if (previous?.enabled) {
      const paused = await this.store.setEnabled('wechat', revision, false);
      revision = paused.revision;
      await this.apply('wechat', paused);
    }
    const controller = this.qrController = new AbortController();
    const client = this.dependencies.wechatClient();
    this.qr = { phase: 'waiting' };
    const task = (async () => {
      try {
        const result = await client.qr(controller.signal);
        if (controller.signal.aborted) return;
        const content = result.qrcode_img_content || result.qrcode;
        if (typeof content !== 'string' || content.length > 8192) throw new ChannelError('invalid_qr_response');
        const image = await QRCode.toDataURL(content, { width: 240, margin: 2 });
        if (controller.signal.aborted) return;
        this.qr = { phase: 'waiting', image };
        const deadline = Date.now() + 5 * 60_000;
        while (!controller.signal.aborted && Date.now() < deadline) {
          const status = await client.qrStatus(result.qrcode, controller.signal);
          if (controller.signal.aborted) return;
          if (status.status === 'confirmed') {
            if (!status.bot_token || !status.baseurl || !status.ilink_user_id || !status.ilink_bot_id) throw new ChannelError('invalid_qr_response');
            const grant = { accountId: status.ilink_bot_id, ownerId: status.ilink_user_id, secret: status.bot_token, baseUrl: status.baseurl };
            await this.queueQr(async () => {
              if (controller.signal.aborted || this.stopped) return;
              const record = await this.store.saveWechat(revision, grant);
              if (controller.signal.aborted || this.stopped) {
                await this.apply('wechat', await this.store.setEnabled('wechat', record.revision, false));
                return;
              }
              this.qr = { phase: 'connected' };
              await this.apply('wechat', record);
            });
            return;
          }
          if (status.status === 'expired') { this.qr = { phase: 'expired' }; return; }
          if (status.status === 'need_verifycode' || status.status === 'verify_code_blocked') throw new ChannelError('wechat_verification_required');
          if (status.status === 'scaned_but_redirect' && status.redirect_host) client.redirect(status.redirect_host);
          this.qr = { phase: status.status === 'scaned' ? 'scanned' : 'waiting', image };
          await delay(1500, undefined, { signal: controller.signal });
        }
        if (!controller.signal.aborted) this.qr = { phase: 'expired' };
      } catch (error) {
        if (!controller.signal.aborted) this.qr = { phase: 'error', error: error instanceof ChannelError ? error.code : 'connection_failed' };
      }
    })();
    this.qrTasks.add(task);
    void task.finally(() => this.qrTasks.delete(task));
  }
}
