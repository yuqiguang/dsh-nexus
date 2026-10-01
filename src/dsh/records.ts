import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import type { Records } from '../channels/records.js';
import { ChannelError } from '../channels/types.js';

export type Credentials = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'> & Partial<Pick<CredentialProvider, 'listRecords'>>;

function payload(record: CredentialRecord | undefined): unknown {
  if (!record) return undefined;
  if (record.kind !== 'grant') throw new ChannelError('invalid_saved_record');
  return record.payload;
}

/** Only this adapter knows DSH's credential keys and grant envelope. */
export class DshRecords implements Records {
  constructor(private readonly credentials: Credentials, private readonly scope = 'nexus-channels') {}

  async read(key: string): Promise<unknown> {
    return payload(await this.credentials.readRecord(credentialKey(this.scope, key)));
  }

  async list(prefix: string): Promise<{ key: string; value: unknown }[]> {
    const scoped = `${this.scope}/${prefix}`;
    const entries = (await this.credentials.listRecords?.()) ?? [];
    const found: { key: string; value: unknown }[] = [];
    for (const entry of entries) {
      if (entry.kind !== 'grant' || !String(entry.key).startsWith(scoped)) continue;
      const key = String(entry.key).slice(this.scope.length + 1);
      found.push({ key, value: await this.read(key) });
    }
    return found;
  }

  async modify(key: string, update: (current: unknown) => Promise<unknown>): Promise<unknown> {
    return payload(await this.credentials.modifyRecord(credentialKey(this.scope, key), async current => {
      const next = await update(payload(current));
      return next === undefined ? undefined : { kind: 'grant', payload: next };
    }));
  }
}
