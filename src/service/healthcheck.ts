/** Decision logic of `scripts/health.mjs`, kept pure so it can be tested without a service or systemd. */

export interface HealthState { failures: number; lastOkAt?: number; lastRestartAt?: number; lastError?: string }

export type Probe = { ok: true; snapshot: { channels?: { channel: string; phase: string; error?: string }[]; coders?: { active: string[] }; heldPushes?: number; uptimeMs?: number } }
  | { ok: false; error: string };

export interface HealthDecision {
  state: HealthState;
  /** Restart the unit with this reason; absent when nothing should be done. */
  restart?: string;
  /** One line for the journal. */
  line: string;
}

/** Consecutive failed probes before a restart; one probe a minute makes this a three-minute outage, longer than a 20-second event-loop stall. */
export const FAILURES_BEFORE_RESTART = 3;
/** Two restarts closer than this would mean restarting does not help; the check then only reports. */
export const RESTART_COOLDOWN_MS = 10 * 60_000;

export function decide(state: HealthState, probe: Probe, now: number, managed: boolean, updating = false): HealthDecision {
  if (probe.ok) {
    const { snapshot } = probe;
    const channels = (snapshot.channels ?? []).map(item => `${item.channel}=${item.phase}${item.error ? `(${item.error})` : ''}`).join(' ');
    const line = `nexus-health: ok up=${Math.round((snapshot.uptimeMs ?? 0) / 60_000)}m ${channels || 'channels=none'} coders=${snapshot.coders?.active.length ?? 0} held=${snapshot.heldPushes ?? 0}`;
    return { state: { ...state, failures: 0, lastOkAt: now, lastError: undefined }, line };
  }
  const failures = state.failures + 1;
  const next: HealthState = { ...state, failures, lastError: probe.error };
  if (failures < FAILURES_BEFORE_RESTART) return { state: next, line: `nexus-health: FAIL ${failures}/${FAILURES_BEFORE_RESTART} ${probe.error}` };
  if (!managed) return { state: next, line: `nexus-health: FAIL ${failures}/${FAILURES_BEFORE_RESTART} ${probe.error}; nexus.service is not managed by systemd, not restarting` };
  // The updater restarts the service itself and rolls back when the new build does not come up; a second restart here would only race it.
  if (updating) return { state: next, line: `nexus-health: FAIL ${failures}/${FAILURES_BEFORE_RESTART} ${probe.error}; an update is in progress, not restarting` };
  if (state.lastRestartAt !== undefined && now - state.lastRestartAt < RESTART_COOLDOWN_MS) {
    return { state: next, line: `nexus-health: FAIL ${failures}/${FAILURES_BEFORE_RESTART} ${probe.error}; restarted ${Math.round((now - state.lastRestartAt) / 60_000)}m ago, waiting` };
  }
  const reason = `连续 ${failures} 次健康检查失败（${probe.error}）`;
  return { state: { ...next, failures: 0, lastRestartAt: now }, restart: reason, line: `nexus-health: restarting nexus.service: ${reason}` };
}
