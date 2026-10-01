/** Read-only upgrade preflight using DSH's public persistence API. No agents, transports or credentials are opened. */
import { Context } from '@deepseek-ai/cordis';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { foldScheduleEvents } from '@deepseek-ai/dsh-schedule';
import { resolve, join } from 'node:path';
import { access } from 'node:fs/promises';

const home = process.argv[2];
if (!home) throw new Error('Usage: node --max-old-space-size=384 scripts/upgrade-check.mjs <DSH_HOME>');
const root = join(resolve(home), 'sessions');
await access(root);
const ctx = new Context();
const persistence = new JsonlSessionPersistence(ctx, { root });
let sessions = 0;
let activeLegacyReminders = 0;
const failures = [];
const legacySessions = [];
try {
  for (const snapshot of await persistence.list()) {
    const id = snapshot.header.id;
    let handle;
    try {
      handle = await persistence.open(id, 'read');
      const { events } = await handle.read(0);
      const count = foldScheduleEvents(events).active.length;
      sessions++;
      activeLegacyReminders += count;
      if (count) legacySessions.push({ sessionId: id, count });
    } catch (error) {
      // Never print a failed event, user message or authenticated URL from a decoder diagnostic.
      failures.push({ sessionId: id, error: error?.name ?? 'read_failed' });
    } finally { await handle?.close(); }
  }
  console.log(JSON.stringify({ sessions, activeLegacyReminders, legacySessions, failures,
    readyForMigrationReview: failures.length === 0 && activeLegacyReminders === 0 }, null, 2));
  if (failures.length || activeLegacyReminders) process.exitCode = 1;
} finally { await ctx.fiber.dispose(); }
