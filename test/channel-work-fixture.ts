import { ChannelWork, type ChannelWorkDomain, type ChannelWorkOrigin, type ChannelJobNotice } from '../src/channels/work.js';
import type { SessionRosterView } from '../src/sessions/index.js';
export function channelWorkFixture(sessions?: Pick<SessionRosterView, 'activeFor'>) {
  const records = new Map<string, ChannelWorkOrigin>();
  const notices = new Map<string, ChannelJobNotice>();
  const table = (rows: Map<string, unknown>) => ({ get: (id: string) => rows.get(id), async put(id: string, row: unknown) { rows.set(id, structuredClone(row)); } });
  const domain = { table: (name: string) => table(name === 'notices' ? notices : records), async close() {} } as unknown as ChannelWorkDomain;
  return { work: new ChannelWork(domain, sessions), records, reopen: () => new ChannelWork(domain, sessions) };
}
