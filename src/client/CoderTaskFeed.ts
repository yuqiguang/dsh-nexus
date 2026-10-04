import { useSyncExternalStore } from 'react';
import type { TaskSummary } from '../coders/presentation.js';

export type TaskFeedApi = <T>(method: 'list' | 'notice', payload: Record<string, unknown>, signal: AbortSignal) => Promise<T>;
export const taskFeedApi: TaskFeedApi = async (method, payload, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-coder-tasks/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId || !message.result?.ok) throw new Error('connection_failed');
  return message.result.value;
};

interface Snapshot { tasks: readonly TaskSummary[]; notices: ReadonlyMap<number, TaskSummary | null>; problem?: string; revision: number }

/** One sequential, abortable feed shared by a session's dock and notification cards. */
export class TaskFeed {
  private snapshot: Snapshot = { tasks: [], notices: new Map(), revision: 0 };
  private listeners = new Set<() => void>();
  private requested = new Set<number>();
  private placed = new Set<string>();
  private dismissed = new Set<string>();
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(readonly owner: string, private api: TaskFeedApi, private release: () => void, private interval = 3000) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.controller) { this.controller = new AbortController(); void this.poll(this.controller.signal); }
    return () => {
      this.listeners.delete(listener);
      queueMicrotask(() => {
        if (this.listeners.size) return;
        this.controller?.abort(); this.controller = undefined; clearTimeout(this.timer); this.release();
      });
    };
  };
  private publish(next: Partial<Snapshot> = {}) {
    this.snapshot = { ...this.snapshot, ...next, revision: this.snapshot.revision + 1 };
    for (const listener of this.listeners) listener();
  }
  requestNotice(seq: number) { this.requested.add(seq); }
  placedNotice(id: string) { if (!this.placed.has(id)) { this.placed.add(id); this.publish(); } }
  dismiss(id: string) { this.dismissed.add(id); this.publish(); }
  inDock(task: TaskSummary) {
    // A persisted notice owns the result even while folded or outside the rendered history.
    // Keep only results still awaiting a notice in the dock; scrolling must not re-pin them.
    return task.active || (!task.completionNotice && !this.dismissed.has(task.id) && !this.placed.has(task.id));
  }
  private async poll(signal: AbortSignal) {
    try {
      // Background tabs do not need status polling. A visible dock will catch up on the next tick.
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        const tasks = await this.api<TaskSummary[]>('list', { ownerSession: this.owner }, signal);
        if (signal.aborted) return;
        const notices = new Map(this.snapshot.notices);
        for (const task of tasks) {
          if (task.ownerSession !== this.owner) continue;
          if (task.completionNotice) notices.set(task.completionNotice.seq, task);
        }
        for (const seq of this.requested) {
          if (notices.has(seq)) continue;
          const task = await this.api<TaskSummary | null>('notice', { ownerSession: this.owner, seq }, signal);
          if (signal.aborted) return;
          notices.set(seq, task?.ownerSession === this.owner && task.completionNotice?.seq === seq ? task : null);
        }
        // The server scopes the list to the chat's live work plus this conversation's own results, so the dock is rendered as
        // returned: a rotation must not empty the panel of work the user is still waiting on (ct-4c671559).
        this.publish({ tasks, notices, problem: undefined });
      }
    } catch { if (!signal.aborted) this.publish({ problem: '任务状态暂时无法更新，正在重试。' }); }
    if (!signal.aborted) this.timer = setTimeout(() => { void this.poll(signal); }, this.interval);
  }
}

export function taskFeeds(api: TaskFeedApi = taskFeedApi, interval = 3000) {
  const feeds = new Map<string, TaskFeed>();
  return (owner: string) => {
    let feed = feeds.get(owner);
    if (!feed) {
      feed = new TaskFeed(owner, api, () => { if (feeds.get(owner) === feed) feeds.delete(owner); }, interval);
      feeds.set(owner, feed);
    }
    return feed;
  };
}
export type TaskFeeds = ReturnType<typeof taskFeeds>;
export function useTaskFeed(feed: TaskFeed) { return useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot); }
