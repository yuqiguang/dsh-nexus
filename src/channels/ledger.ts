import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

/** The last turn of a session whose result the channel handled: sent, held for quiet hours, or judged silent. */
export interface DeliveryMark { sessionId: string; turn: number; at: number }

export const deliveryDomain = defineDomain({
  name: 'nexus_channels',
  version: 1,
  layout: 'per-record',
  tables: { delivered: domainTable<string, DeliveryMark>(z.object({ sessionId: z.string(), turn: z.number(), at: z.number() })) },
});

export type DeliveryDomain = Domain<typeof deliveryDomain>;
export interface DeliveryDomainOpener { open(spec: typeof deliveryDomain): Promise<DeliveryDomain> }

/**
 * Per-session delivery watermark in native storage. A bridge that mounts later
 * (after a restart, or after the connection was off) compares the session log
 * against it and delivers the completed turns nobody sent. A session seen for
 * the first time is marked at its current end, so upgrading never replays history.
 */
export class DeliveryLedger {
  private constructor(private readonly domain: DeliveryDomain) {}

  static async open(opener: DeliveryDomainOpener): Promise<DeliveryLedger> {
    return new DeliveryLedger(await opener.open(deliveryDomain));
  }

  get(sessionId: string): number | undefined { return this.domain.table('delivered').get(sessionId)?.turn; }

  async set(sessionId: string, turn: number, at = Date.now()): Promise<void> {
    const current = this.get(sessionId);
    if (current !== undefined && current >= turn) return;
    await this.domain.table('delivered').put(sessionId, { sessionId, turn, at });
  }

  close(): Promise<void> { return this.domain.close(); }
}

/** What a bridge needs from the ledger; tests fake it in memory. */
export type DeliveryMarks = Pick<DeliveryLedger, 'get' | 'set'>;
