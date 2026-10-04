import { isActive, type PendingEscalation, type TaskRecord } from './types.js';

/** Presentation state for overlapping native requests; native questions still own answers. */
export class UserWaits {
  private tasks = new Map<string, { resume: TaskRecord['status']; requests: Map<symbol, PendingEscalation> }>();
  add(task: TaskRecord, id: symbol, pending: PendingEscalation): Partial<TaskRecord> {
    if (!isActive(task)) return {};
    const state = this.tasks.get(task.id) ?? { resume: task.status === 'verifying' ? 'verifying' : 'running', requests: new Map<symbol, PendingEscalation>() };
    state.requests.set(id, pending);
    this.tasks.set(task.id, state);
    return { status: 'waiting-user', pending: state.requests.values().next().value };
  }
  remove(task: TaskRecord, id: symbol): Partial<TaskRecord> {
    const state = this.tasks.get(task.id);
    if (!state) return {};
    state.requests.delete(id);
    if (!state.requests.size) this.tasks.delete(task.id);
    if (!isActive(task)) return {};
    return state.requests.size ? { status: 'waiting-user', pending: state.requests.values().next().value }
      : { status: task.status === 'waiting-user' ? state.resume : task.status, pending: undefined };
  }
}
