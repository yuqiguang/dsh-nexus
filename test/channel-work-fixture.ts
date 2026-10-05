import { ChannelWork, type ChannelWorkDomain, type ChannelWorkOrigin } from '../src/channels/work.js';
import type { SessionRosterView } from '../src/sessions/index.js';
export function channelWorkFixture(sessions?: Pick<SessionRosterView, 'activeFor'>) {
  const records = new Map<string, ChannelWorkOrigin>();
  const domain = { table: () => ({ get: (id: string) => records.get(id), async put(id: string, row: ChannelWorkOrigin) { records.set(id, structuredClone(row)); } }), async close() {} } as unknown as ChannelWorkDomain;
  return { work: new ChannelWork(domain, sessions), records, reopen: () => new ChannelWork(domain, sessions) };
}
