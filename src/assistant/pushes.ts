import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';
import type { ChannelNotifier } from '../channels/notify.js';
import { identity } from '../channels/protocol.js';
import { inWindow, nextOccurrence } from './clock.js';
import type { AssistantSettingsRecord } from './settings.js';

/** One push the assistant chose not to send yet. */
export interface HeldPush { id: string; sessionId: string; text: string; at: number }

export const assistantDomain = defineDomain({
  name: 'nexus_assistant',
  version: 1,
  layout: 'per-record',
  tables: { held: domainTable<string, HeldPush>(z.object({ id: z.string(), sessionId: z.string(), text: z.string(), at: z.number() })) },
});

export type AssistantDomain = Domain<typeof assistantDomain>;
export interface AssistantDomainOpener { open(spec: typeof assistantDomain): Promise<AssistantDomain> }

const MAX_HELD_PER_SESSION = 50;
const MAX_HELD_BYTES = 256 * 1024;

/**
 * Quiet hours for proactive pushes. Held pushes live in native storage and go
 * out merged into one message when the window ends, when quiet hours are
 * turned off, or at startup outside the window. Replies to what the user just
 * typed never come through here.
 */
export class PushGate implements ChannelNotifier {
  private settings: AssistantSettingsRecord;
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private ticket?: object;

  constructor(private readonly domain: AssistantDomain, private readonly sink: ChannelNotifier, settings: AssistantSettingsRecord,
    private readonly now: () => number = Date.now, private readonly onError: (message: string) => void = () => {}) {
    this.settings = settings;
    this.arm();
  }

  static async open(opener: AssistantDomainOpener, sink: ChannelNotifier, settings: AssistantSettingsRecord, now?: () => number, onError?: (message: string) => void): Promise<PushGate> {
    return new PushGate(await opener.open(assistantDomain), sink, settings, now, onError);
  }

  private get held() { return this.domain.table('held'); }

  quiet(now = this.now()): boolean {
    const { quietStart, quietEnd, timeZone } = this.settings;
    return !!quietStart && !!quietEnd && inWindow(now, quietStart, quietEnd, timeZone);
  }

  /** New settings take effect at once: leaving quiet hours releases everything held. */
  update(settings: AssistantSettingsRecord): void {
    this.settings = settings;
    this.arm();
    if (!this.quiet()) void this.flush();
  }

  pending(sessionId?: string): HeldPush[] {
    return [...this.held.entries()].map(([, push]) => push).filter(push => !sessionId || push.sessionId === sessionId).sort((a, b) => a.at - b.at);
  }

  /** Hold or forward one push. Returns what the sink returns; a held push counts as accepted. */
  async notify(sessionId: string, text: string, deliveryId: string): Promise<boolean> {
    if (!this.quiet()) return this.sink.notify(sessionId, text, deliveryId);
    await this.hold(sessionId, text, deliveryId);
    return true;
  }

  async hold(sessionId: string, text: string, deliveryId: string): Promise<void> {
    const id = identity('held', deliveryId);
    if (this.held.get(id)) return;
    const mine = this.pending(sessionId);
    const bytes = mine.reduce((sum, push) => sum + Buffer.byteLength(push.text), 0);
    if (mine.length >= MAX_HELD_PER_SESSION || bytes + Buffer.byteLength(text) > MAX_HELD_BYTES) {
      // Too much for the morning digest: drop the oldest so the newest still arrives.
      const oldest = mine[0];
      if (oldest) await this.held.delete(oldest.id);
    }
    await this.held.put(id, { id, sessionId, text, at: this.now() });
  }

  /** Send every held push, merged per session; a push whose session no channel routes stays held. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    // The body yields once before doing anything, so `this.flushing` is assigned before it can settle and clear itself.
    const ticket = {};
    this.ticket = ticket;
    const run = (async () => {
      await Promise.resolve();
      try {
        const sessions = [...new Set(this.pending().map(push => push.sessionId))];
        for (const sessionId of sessions) {
          const pushes = this.pending(sessionId);
          if (!pushes.length) continue;
          const text = pushes.length === 1 ? pushes[0]!.text
            : [`安静时段里有 ${pushes.length} 条消息：`, ...pushes.map((push, index) => `${index + 1}. ${push.text}`)].join('\n\n');
          let routed = false;
          try { routed = await this.sink.notify(sessionId, text, identity('held-flush', ...pushes.map(push => push.id))); }
          catch (error) { this.onError(`held push failed for ${sessionId}: ${(error as Error)?.message ?? error}`); continue; }
          if (routed) for (const push of pushes) await this.held.delete(push.id);
        }
      } finally { if (this.ticket === ticket) { this.flushing = undefined; this.ticket = undefined; } }
    })();
    this.flushing = run;
    return run;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const { quietEnd, timeZone } = this.settings;
    if (!quietEnd) return;
    const delay = Math.min(nextOccurrence(this.now(), quietEnd, timeZone) - this.now() + 1000, 2 ** 31 - 1);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush().finally(() => this.arm()); }, delay);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
    await this.domain.close();
  }
}
