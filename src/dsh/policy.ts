import type { Session } from '@deepseek-ai/dsh-session';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
// Declare the `permission/preset` and `approval/policy` events the repair below reads.
import type {} from '@deepseek-ai/dsh-permission-presets';
import type {} from '@deepseek-ai/dsh-user-approval';

// A channel session runs with the permission DSH gives every session: the default preset it is created
// with, or whatever the user switches it to in the Web UI. Nothing here narrows it, so the permission the
// UI shows is the one a message from the phone runs with.

function remoteSession(id: string): boolean {
  return /^nexus-(wechat|feishu|wecom)-[a-f0-9]{32}(-\d+)?$/.test(id);
}

/**
 * Give back the full access an earlier version of this bridge took from a channel session. Its trace is
 * exact: the last preset the session recorded is full access and the sandbox was set to read-only after
 * it, while the approval policy stayed `never` — a pair no preset writes, which the Web UI shows as
 * "Custom", and in which the session could neither write nor ask. Any other state is the user's choice
 * and is kept.
 */
export function restoreSystemPermission(session: Session): void {
  if (!remoteSession(session.id)) return;
  let preset: { name: string; seq: number } | undefined;
  let sandbox: { mode: string; seq: number } | undefined;
  let approval: string | undefined;
  for (const event of session.snapshotEvents()) {
    if (event.type === 'permission/preset') preset = { name: event.data.preset, seq: event.seq };
    else if (event.type === 'sandbox/mode') sandbox = { mode: event.data.mode, seq: event.seq };
    else if (event.type === 'approval/policy') approval = event.data.policy;
  }
  if (preset?.name === 'danger-full-access' && sandbox?.mode === 'read-only' && sandbox.seq > preset.seq && approval === 'never') {
    setSandboxMode(session, 'danger-full-access');
  }
}
