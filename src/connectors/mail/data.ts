import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { MailAccountSettings } from '../settings.js';
import type { MailWatch } from './render.js';

/** Where the inbox poller is: the mailbox generation and the last UID it has seen. Reset when UIDVALIDITY changes. */
export interface MailCursor { accountKey?: string; uidValidity: number; lastUid: number; checkedAt: number }

export const mailDomain = defineDomain({
  name: 'nexus_mail',
  version: 1,
  layout: 'per-record',
  // A cursor the schema no longer fits (an earlier build wrote NaN for a mailbox whose server omits UIDNEXT, which JSON keeps as null)
  // would otherwise fail `open` and take the whole boot down with it. Moving it aside and treating the mailbox as never polled is the
  // safe reading: nothing already there gets announced.
  invalidRecords: 'backup-and-skip',
  tables: {
    watches: domainTable<string, MailWatch>(z.object({ id: z.string(), description: z.string(), keywords: z.array(z.string()), createdAt: z.number() })),
    cursor: domainTable<string, MailCursor>(z.object({ accountKey: z.string().optional(), uidValidity: z.number(), lastUid: z.number(), checkedAt: z.number() })),
  },
});
export type MailDomain = Domain<typeof mailDomain>;
export interface MailDomainOpener { open(spec: typeof mailDomain): Promise<MailDomain> }

const MAX_WATCHES = 50;
const MAX_KEYWORDS = 10;

export function mailboxKey(settings: MailAccountSettings): string {
  return createHash('sha256').update(JSON.stringify([settings.imapHost, settings.imapPort, settings.user || settings.address])).digest('hex');
}

/** Persistent mailbox data stays open while the optional runtime is disabled. */
export class MailData {
  private constructor(private readonly domain: MailDomain, private readonly now: () => number) {}
  static async open(opener: MailDomainOpener, now = Date.now): Promise<MailData> {
    return new MailData(await opener.open(mailDomain), now);
  }
  private get watches() { return this.domain.table('watches'); }
  get cursor() { return this.domain.table('cursor'); }
  /** Attribute a pre-component cursor to the saved account before the owner can edit it. */
  async bindLegacyCursor(settings: MailAccountSettings): Promise<void> {
    const cursor = this.cursor.get('inbox');
    if (cursor && !cursor.accountKey && Number.isInteger(cursor.lastUid) && cursor.lastUid >= 0) {
      await this.cursor.put('inbox', { ...cursor, accountKey: mailboxKey(settings) });
    }
  }
  listWatches(): MailWatch[] { return [...this.watches.entries()].map(([, watch]) => watch).sort((a, b) => a.createdAt - b.createdAt); }
  async addWatch(description: string, keywords: string[]): Promise<MailWatch> {
    const cleanKeywords = [...new Set(keywords.map(item => item.replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, MAX_KEYWORDS);
    const cleanDescription = description.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!cleanKeywords.length || !cleanDescription) throw new Error('提醒需要说明和至少一个关键词。');
    if (this.watches.size >= MAX_WATCHES) throw new Error(`邮件提醒最多 ${MAX_WATCHES} 条，先删掉不用的。`);
    const existing = this.listWatches().find(watch => watch.keywords.join('\n') === cleanKeywords.join('\n'));
    if (existing) return existing;
    const watch: MailWatch = { id: `mw-${randomBytes(4).toString('hex')}`, description: cleanDescription, keywords: cleanKeywords, createdAt: this.now() };
    await this.watches.put(watch.id, watch);
    return watch;
  }

  removeWatch(id: string): Promise<boolean> { return this.watches.delete(id); }

  close(): Promise<void> { return this.domain.close(); }
}
