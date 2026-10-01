import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Session } from '@deepseek-ai/dsh-session';
import { restoreSystemPermission } from '../src/dsh/policy.js';

const CHANNEL = 'nexus-wechat-f24adb6e4efc50cfcd3832b0f0000478-4';

/** A session log holding only permission events, in the order given; appends land at its end. */
function sessionWith(id: string, knobs: [type: string, value: string][]) {
  const events = knobs.map(([type, value], seq) => ({ type, seq, data: type === 'permission/preset' ? { preset: value } : type === 'sandbox/mode' ? { mode: value } : { policy: value } }));
  const session = { id, snapshotEvents: () => events, append(type: string, data: unknown) { events.push({ type, seq: events.length, data } as never); } } as unknown as Session;
  return { session, events };
}

/** What the bridge wrote until 2026-09-24: full access pinned by the preset, then the sandbox lowered before a message. */
const LOWERED: [string, string][] = [['permission/preset', 'danger-full-access'], ['sandbox/mode', 'danger-full-access'], ['approval/policy', 'never'], ['sandbox/mode', 'read-only']];

test('a channel session the bridge once lowered to read-only gets its full access back, once', () => {
  const { session, events } = sessionWith(CHANNEL, LOWERED);
  restoreSystemPermission(session);
  assert.deepEqual(events.at(-1), { type: 'sandbox/mode', seq: 4, data: { mode: 'danger-full-access' } });
  restoreSystemPermission(session);
  assert.equal(events.length, 5, 'a session that has its preset back is left alone');
});

test('any permission the user chose is kept, and so is a session that is not a channel\'s', () => {
  const chosen: [string, string][][] = [
    // Switched to 仅可查看 after full access: the preset was recorded with it.
    [...LOWERED, ['permission/preset', 'read-only'], ['approval/policy', 'ask']],
    [['permission/preset', 'read-only'], ['sandbox/mode', 'read-only'], ['approval/policy', 'ask']],
    [['permission/preset', 'workspace-write'], ['sandbox/mode', 'workspace-write'], ['approval/policy', 'ask']],
    [['permission/preset', 'danger-full-access'], ['sandbox/mode', 'danger-full-access'], ['approval/policy', 'never']],
    // Read-only with approvals still asked is not what the old bridge left behind.
    [['permission/preset', 'danger-full-access'], ['sandbox/mode', 'danger-full-access'], ['approval/policy', 'ask'], ['sandbox/mode', 'read-only']],
    [],
  ];
  for (const knobs of chosen) {
    const { session, events } = sessionWith(CHANNEL, knobs);
    restoreSystemPermission(session);
    assert.equal(events.length, knobs.length, JSON.stringify(knobs));
  }
  const { session, events } = sessionWith('session-95fef5d0-b6f7-4283-a177-2b3f634490b1', LOWERED);
  restoreSystemPermission(session);
  assert.equal(events.length, LOWERED.length, 'only the bridge\'s own sessions carry its old downgrade');
});
