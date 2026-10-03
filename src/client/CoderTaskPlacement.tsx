import { useEffect, useState, type ComponentType } from 'react';
import type { TaskSummary } from '../coders/presentation.js';
import { taskAddress } from './CoderTasks.js';
import { taskFeeds, useTaskFeed, type TaskFeeds } from './CoderTaskFeed.js';

type OpenTask = (address: string) => void;
export function TaskCard({ task, open, dismiss }: { task: TaskSummary; open: OpenTask; dismiss?: () => void }) {
  return <article className="nexus-coder-row nexus-coder-card" data-task-id={task.id} data-state={task.status}>
    <span className="nexus-coder-row-title">{task.coderName} · {task.id}</span>
    <span className="nexus-coder-row-status">{task.statusLabel}</span>
    <button type="button" className="nexus-coder-row-open" onClick={() => open(taskAddress(task.id))}>查看过程</button>
    <span className="nexus-coder-row-detail nexus-coder-card-description" title={task.description}>{task.description}</span>
    {task.pending ? <span className="nexus-coder-card-pending">等你回答：{task.pending}</span>
      : task.active && task.activity ? <span className="nexus-coder-row-detail">{task.activity}</span> : null}
    {task.pending && task.pendingReason && <span className="nexus-coder-row-detail">需要你确认的原因：{task.pendingReason}</span>}
    {task.channelWarning && <span role="alert" className="nexus-coder-row-detail">{task.channelWarning}</span>}
    {dismiss && <button type="button" className="nexus-coder-card-dismiss" onClick={dismiss}>收起结果</button>}
  </article>;
}

export function coderTaskDock(open: OpenTask, feeds: TaskFeeds) {
  function Dock({ sessionId }: { sessionId: string }) {
    const feed = feeds(sessionId), snapshot = useTaskFeed(feed);
    const [expanded, setExpanded] = useState(false);
    const tasks = snapshot.tasks.filter(task => feed.inDock(task));
    // Waiting for an answer stays prominent; other active work precedes finished fallbacks.
    tasks.sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
    if (!tasks.length && !snapshot.problem) return null;
    const active = tasks.filter(task => task.active).length;
    return <section className="nexus-coder-dock" aria-label="编码任务">
      <div className="nexus-coder-dock-head"><strong>{active ? `${active} 个任务进行中` : '任务结果'}</strong>
        {tasks.length > 1 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起列表' : `查看全部 ${tasks.length} 个任务`}</button>}
      </div>
      {snapshot.problem && <p role="status" className="nexus-channel-hint">{snapshot.problem}</p>}
      <div className="nexus-coder-dock-list">{(expanded ? tasks : tasks.slice(0, 1)).map(task =>
        <TaskCard key={task.id} task={task} open={open} dismiss={task.active ? undefined : () => feed.dismiss(task.id)} />)}</div>
    </section>;
  }
  return function SessionDock(props: { sessionId: string }) { return <Dock key={props.sessionId} {...props} />; };
}

export interface TriggerProps {
  sessionId: string;
  node: { data: { seq: number; source?: { kind?: string; form?: string } } };
}
export function coderTaskTrigger(Native: ComponentType<TriggerProps>, open: OpenTask, feeds: TaskFeeds) {
  function Result({ sessionId, seq }: { sessionId: string; seq: number }) {
    const feed = feeds(sessionId);
    feed.requestNotice(seq);
    const task = useTaskFeed(feed).notices.get(seq);
    useEffect(() => { if (task && !task.active) feed.placedNotice(task.id); }, [feed, task]);
    return task && !task.active ? <TaskCard task={task} open={open} /> : null;
  }
  return function TaskTrigger(props: TriggerProps) {
    const data = props.node.data;
    return <>{data.source?.kind === 'tool-jobs' && data.source.form === 'notice'
      && <Result key={`${props.sessionId}:${data.seq}`} sessionId={props.sessionId} seq={data.seq} />}
      <Native {...props} /></>;
  };
}

/** Narrow public slot surface; avoids pulling the entire DSH client type graph into this plugin. */
export interface TaskSlots {
  inject(name: string, register: () => () => void): unknown;
  register(options: { name: string; key?: string; id?: string; order?: number; priority?: number; locale?: string }, component: unknown): () => void;
  entries(name: string): readonly NativeEntry[];
  subscribe(name: string, listener: () => void): () => void;
}
interface NativeEntry {
  component: unknown;
  options: { key?: string; priority?: number };
  locale?: string;
  inject?: unknown;
  children?: unknown;
  store?: unknown;
}

/** Decorate the native notification through public slot priority, retaining its component and all props. */
export function installTaskPlacement(slots: TaskSlots, open: OpenTask, feeds: TaskFeeds = taskFeeds()) {
  slots.inject('conversation.input.dock', () => slots.register({ name: 'conversation.input.dock', id: 'nexus-coder-tasks', order: 0 }, coderTaskDock(open, feeds)));
  slots.inject('conversation.chat.node', () => {
    const name = 'conversation.chat.node';
    let original: NativeEntry | undefined, remove: (() => void) | undefined;
    const sync = () => {
      const next = slots.entries(name).find(entry => entry.options.key === 'turn-trigger' && (entry.options.priority ?? 0) === 0);
      if (next === original) return;
      remove?.(); remove = undefined; original = next;
      // Fail open to the native renderer if a future DSH release changes its component contract.
      if (!next || next.inject || next.store || next.children) return;
      remove = slots.register({ name, key: 'turn-trigger', priority: -1, ...(next.locale ? { locale: next.locale } : {}) },
        coderTaskTrigger(next.component as ComponentType<TriggerProps>, open, feeds));
    };
    const unsubscribe = slots.subscribe(name, sync);
    sync();
    return () => { unsubscribe(); remove?.(); };
  });
}
