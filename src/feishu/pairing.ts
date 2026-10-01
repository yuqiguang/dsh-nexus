import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ChannelError, type ConnectionRecord, type ConnectionState, type FeishuPairingView } from '../channels/types.js';
import type { ChannelTransport, InboundMessage } from '../channels/protocol.js';

export const FEISHU_PAIRING_MS = 10 * 60_000;
/** Reserved pairing control message; a redelivery must never become a model task. */
export function isFeishuPairingCode(text: string): boolean { return /^DSH-[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/.test(text.trim()); }

/** A temporary authenticated listener, never a DSH session or a task/approval receiver. */
export class FeishuPairing {
  readonly id = randomBytes(16).toString('hex');
  readonly expiresAt: number;
  readonly controller = new AbortController();
  private readonly code = `DSH-${randomBytes(10).toString('hex').toUpperCase().match(/.{4}/g)!.join('-')}`;
  private phase: FeishuPairingView['phase'] = 'connecting';
  private candidate?: string;
  private error?: string;
  private transport?: ChannelTransport;
  private closing?: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(readonly record: ConnectionRecord, private readonly now = Date.now, ttl = FEISHU_PAIRING_MS) {
    this.expiresAt = now() + ttl;
    this.timer = setTimeout(() => this.expire(), ttl);
    this.timer.unref?.();
  }

  start(transport: ChannelTransport): void {
    this.transport = transport;
    if (this.controller.signal.aborted) { void this.stopTransport(); return; }
    void transport.start(async message => this.receive(message)).catch(error => this.state({ phase: 'error',
      error: error instanceof ChannelError ? error.code : 'connection_failed' }));
  }

  state(state: ConnectionState): void {
    if (!this.live()) return;
    if (state.phase === 'error') {
      this.error = state.error ?? 'connection_failed'; this.phase = 'error'; this.controller.abort(); clearTimeout(this.timer);
      void this.stopTransport();
    } else if (state.phase === 'connected') this.phase = this.candidate ? 'confirm' : 'waiting';
    else if (state.phase === 'connecting' || state.phase === 'reconnecting') this.phase = 'connecting';
  }

  private receive(message: InboundMessage): void {
    if (!this.live() || this.phase !== 'waiting' || this.candidate || message.chatType !== 'p2p'
      || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(message.senderId) || message.attachments?.length || message.transcribed) return;
    const code = Buffer.from(message.text.trim());
    const expected = Buffer.from(this.code);
    if (code.length !== expected.length || !timingSafeEqual(code, expected)) return;
    this.candidate = message.senderId;
    this.phase = 'confirm';
  }

  view(): FeishuPairingView {
    this.live();
    return { id: this.id, revision: this.record.revision, phase: this.phase, expiresAt: this.expiresAt,
      ...(this.phase === 'waiting' ? { code: this.code } : {}),
      ...(this.phase === 'confirm' ? { candidateOpenId: this.candidate } : {}), ...(this.error ? { error: this.error } : {}) };
  }

  owner(id: unknown, revision: unknown): string {
    if (id !== this.id || revision !== this.record.revision) throw new ChannelError('configuration_changed');
    if (!this.live() || this.phase !== 'confirm' || !this.candidate) throw new ChannelError('feishu_pairing_not_ready');
    return this.candidate;
  }

  private live(): boolean {
    if (!this.controller.signal.aborted && this.now() >= this.expiresAt) this.expire();
    return !this.controller.signal.aborted;
  }

  private expire(): void {
    if (this.controller.signal.aborted) return;
    this.phase = 'expired'; this.candidate = undefined; this.controller.abort(); clearTimeout(this.timer);
    void this.stopTransport();
  }

  /** Closing the temporary transport does not itself authorize the captured sender. */
  stopTransport(): Promise<void> {
    if (!this.transport) return Promise.resolve();
    return this.closing ??= Promise.resolve().then(() => this.transport?.stop()).then(() => {}, () => {});
  }

  cancel(): void {
    this.controller.abort(); clearTimeout(this.timer); this.candidate = undefined;
    void this.stopTransport();
  }
}
