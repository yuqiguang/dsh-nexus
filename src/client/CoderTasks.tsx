import { useEffect, useState } from 'react';
import type { TaskDetailView } from '../coders/index.js';
import type { TranscriptEntry } from '../coders/transcript.js';

/** The right-sidebar resource a coding task opens as. */
export const TASK_RESOURCE = 'dsh-resource://nexus-coder-task/';
export const TASK_TAB_ID = 'nexus-next/coder-task';
export const TASK_TAB_KIND = 'nexus-coder-task';

export const taskAddress = (id: string) => `${TASK_RESOURCE}${id}`;
export const taskIdOf = (address: string) => address.startsWith(TASK_RESOURCE) ? address.slice(TASK_RESOURCE.length).split(/[/?#]/)[0] ?? '' : '';

export type TaskApi = (id: string, brief: boolean, signal?: AbortSignal) => Promise<TaskDetailView>;

export const taskApi: TaskApi = async (id, brief, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch('/api/nexus-coder-tasks/get', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'get', payload: { id, brief } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as TaskDetailView;
};

const failures: Record<string, string> = { task_not_found: '这个任务的记录已经不在了。', session_expired: '登录已过期，刷新页面后再看。' };
const explainFailure = (error: unknown) => failures[(error as Error)?.message] ?? '读取任务失败，稍后会重试。';

/** The task id `coder_task` printed in its result: "已派发编码任务 ct-xxxxxxxx，…". */
export function dispatchedTaskId(content: readonly unknown[]): string | undefined {
  const text = content.map(block => block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : '').join('\n');
  return /编码任务 (ct-[0-9a-f]{8})/.exec(text)?.[1];
}

/** Read one task, then again every `interval` while it is active and `live` holds; never two reads at once. */
function useTask(id: string | undefined, brief: boolean, interval: number, live: boolean, api: TaskApi, refresh = 0) {
  const [loaded, setLoaded] = useState<{ id: string; brief: boolean; value: TaskDetailView }>();
  const [failure, setFailure] = useState<{ id: string; brief: boolean; message: string }>();
  useEffect(() => {
    if (!id || !live) return;
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const next = await api(id, brief, controller.signal);
        if (controller.signal.aborted) return;
        setLoaded({ id, brief, value: next });
        setFailure(undefined);
        active = next.active;
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure({ id, brief, message: explainFailure(error) });
        if ((error as Error)?.message === 'task_not_found') { active = false; setLoaded(undefined); }
      }
      if (active) timer = setTimeout(() => { void load(); }, interval);
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, brief, interval, live, api, refresh]);
  return { view: loaded && loaded.id === id && loaded.brief === brief ? loaded.value : undefined,
    problem: failure && failure.id === id && failure.brief === brief ? failure.message : undefined };
}

const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });

interface RowProps {
  phase: 'preparing' | 'start' | 'result';
  block: { content?: readonly unknown[]; isError?: boolean };
}

/** The `coder_task` row in the chat: which task, how it stands, and the way into its panel. */
export function coderTaskRow(open: (address: string) => void, api: TaskApi = taskApi) {
  return function CoderTaskRow(props: RowProps) {
    const id = props.phase === 'result' && !props.block.isError ? dispatchedTaskId(props.block.content ?? []) : undefined;
    const { view, problem } = useTask(id, true, 3000, true, api);
    if (props.phase !== 'result') return <div className="nexus-coder-row" data-state="dispatching"><span className="nexus-coder-row-title">正在派发编码任务…</span></div>;
    if (!id) {
      const reason = (props.block.content ?? []).map(block => String((block as { text?: unknown } | null)?.text ?? '')).join(' ').trim();
      return <div className="nexus-coder-row" data-state="error"><span className="nexus-coder-row-title">编码任务没有派发</span>{reason && <span className="nexus-coder-row-detail">{reason}</span>}</div>;
    }
    return (
      <div className="nexus-coder-row" data-state={view?.status ?? 'loading'}>
        <span className="nexus-coder-row-title">{view ? `${view.coderName} 任务` : '编码任务'} {id}</span>
        <span className="nexus-coder-row-status">{view?.statusLabel ?? '正在读取状态'}</span>
        {problem && <span className="nexus-coder-row-detail">{problem}</span>}
        {view?.activity && <span className="nexus-coder-row-detail">当前：{view.activity}</span>}
        {view?.pending && <span className="nexus-coder-row-detail">等你回答：{view.pending.summary}</span>}
        <button type="button" className="nexus-coder-row-open" onClick={() => open(taskAddress(id))}>查看过程</button>
      </div>
    );
  };
}

const KIND_LABEL: Record<TranscriptEntry['kind'], string> = { user: '输入', message: '说明', reasoning: '思考', command: '命令', edit: '改动', tool: '工具', interrupted: '打断' };

function Entry({ entry }: { entry: TranscriptEntry }) {
  const facts = [entry.exitCode !== undefined ? `退出码 ${entry.exitCode}` : '', entry.durationMs !== undefined ? `${(entry.durationMs / 1000).toFixed(1)} 秒` : '',
    entry.error ? '出错' : ''].filter(Boolean).join('，');
  // Messages are read in full; outputs, thinking and diffs stay folded until asked for.
  const folded = entry.kind === 'command' || entry.kind === 'reasoning' || entry.kind === 'edit' || entry.kind === 'tool';
  return (
    <li className="nexus-coder-entry" data-kind={entry.kind}>
      <div className="nexus-coder-entry-head">
        <time>{clock(entry.at)}</time><span className="nexus-coder-entry-kind">{KIND_LABEL[entry.kind]}</span>
        <span className="nexus-coder-entry-title">{entry.kind === 'message' || entry.kind === 'user' ? '' : entry.title}</span>
        {facts && <span className="nexus-coder-entry-facts">{facts}</span>}
      </div>
      {entry.body && (folded
        ? <details><summary>{entry.kind === 'command' ? '输出' : entry.kind === 'edit' ? '内容' : '展开'}</summary><pre>{entry.body}</pre></details>
        : <p className="nexus-coder-entry-body">{entry.body}</p>)}
    </li>
  );
}

interface PanelProps { useTabInfo: () => { tab: { contentId: string; visible: boolean } } }

/** The right-sidebar body for one coding task: its standing, then its process as the coder logged it. */
export function coderTaskPanel(api: TaskApi = taskApi, openSession?: (id: string) => void, openTask?: (id: string) => void) {
  return function CoderTaskPanel({ useTabInfo }: PanelProps) {
    const { tab } = useTabInfo();
    const id = taskIdOf(tab.contentId);
    const [refresh, setRefresh] = useState(0);
    const { view, problem } = useTask(id, false, 2000, tab.visible, api, refresh);
    if (!view) return <div className="nexus-coder-panel"><p className="nexus-channel-hint">{problem ?? '正在读取任务…'}</p>
      {problem && <button type="button" onClick={() => setRefresh(value => value + 1)}>重新读取</button>}</div>;
    const entries = view.transcript.entries;
    return (
      <div className="nexus-coder-panel">
        <header>
          <h3>{view.coderName} 任务 {view.id}</h3>
          <span className="nexus-coder-row-status" data-state={view.status}>{view.statusLabel}</span>
        </header>
        <p className="nexus-coder-panel-task">{view.description}</p>
        <p><button type="button" className="nexus-coder-row-open" onClick={() => setRefresh(value => value + 1)}>刷新结果</button></p>
        {view.ownerSession && openSession && <p><button type="button" className="nexus-coder-row-open" onClick={() => openSession(view.ownerSession!)}>回到所属会话</button></p>}
        <p className="nexus-channel-hint">继续修改、取消任务或回答审批，请在任务所属会话中操作。最后更新：{new Date(view.updatedAt).toLocaleString('zh-CN', { hour12: false })}。</p>
        {view.planStep && <p className="nexus-channel-hint">计划步骤：{view.planStep}</p>}
        <p className="nexus-channel-hint">{view.cwd}{view.resumedFrom ? `，续接 ${view.resumedFrom}` : ''}{view.runningFor ? `。${view.runningFor}` : ''}</p>
        {view.brief && <div className="nexus-channel-hint"><p>总体目标：{view.brief.objective}（{view.brief.id} v{view.brief.revision}）</p><p>共同约束：{view.brief.constraints || "无补充"}</p><p>本任务验收项：{view.brief.acceptance.map(item => `${item.id} ${item.text}`).join("；")}</p></div>}
        {!!view.dependsOn?.length && <p className="nexus-channel-hint">前置任务（均需独立验证通过）：{view.dependsOn.join("、")}</p>}
        {view.permissionDescription && <p className="nexus-channel-hint">{view.permissionDescription}</p>}
        {view.stopReason && <p className="nexus-coder-panel-pending">{view.stopReason}</p>}
        {view.pending && <p className="nexus-coder-panel-pending">等你回答：{view.pending.summary}（{clock(view.pending.at)} 提出，在聊天里回复）</p>}
        {view.recovery && <section className="nexus-coder-panel-result" aria-label="恢复建议">
          <strong>{view.recovery.title}</strong>
          <p>{view.recovery.nextStep}</p>
          {view.recovery.context && <p>{view.recovery.context}</p>}
          {view.recovery.blockers.length > 0 && <ul>{view.recovery.blockers.map((line, index) => <li key={index}>{line}</li>)}</ul>}
          {view.recovery.followingTasks.map(task => <p key={task}>{openTask
            ? <button type="button" className="nexus-coder-row-open" onClick={() => openTask(task)}>查看后续任务 {task}</button>
            : `后续任务：${task}`}</p>)}
          <p className="nexus-channel-hint">此处仅展示记录，不启动任务。恢复时仍需检查当前工作区、依赖与审批；一次性授权不会沿用。</p>
        </section>}
        <p className="nexus-channel-hint">升级给你 {view.escalations} 次，常规操作自动放行 {view.autoAllowed} 次{view.decisions.length ? `，决定 ${view.decisions.length} 条` : ''}。</p>
        {view.result && <div className="nexus-coder-panel-result">
          <strong>编码工具报告</strong>
          <p>{view.result.summary || view.result.detail || '（没有文本结果）'}</p>
          {view.result.summary && view.result.detail && <p>执行说明：{view.result.detail}</p>}
          <p className="nexus-channel-hint">改动文件 {view.result.changedFiles.length} 个{view.result.verification === 'passed' && view.result.verifyOk === true ? '，验证通过' : view.result.verification === 'failed' ? '，验证失败' : '，尚未独立验证'}</p>
          {view.result.changedFiles.length > 0 && <ul>{view.result.changedFiles.slice(0, 40).map(file => <li key={file}>{file}</li>)}</ul>}
          {!!view.result.outsideRoots.length && <p role="alert">发现 {view.result.outsideRoots.length} 项工作区外改动，请先检查改动范围。</p>}
          <h4>独立验证</h4>
          <p className="nexus-channel-hint">仅表示以下检查的结果，业务验收见“目标与验收”。没有记录的检查不能视为通过。</p>
          {view.result.verifyChecks?.length ? <ol>{view.result.verifyChecks.map((check, index) => <li key={index}>
            <details><summary>{check.executed ? check.ok ? '通过' : '失败' : '未执行'}：{check.command}</summary><pre>{check.output || '（无输出）'}</pre></details>
          </li>)}</ol> : <p>没有逐条检查记录。</p>}
          {view.result.verifyOutput && <details><summary>验证汇总与原因</summary><pre>{view.result.verifyOutput}</pre></details>}
        </div>}
        {view.goal && <div className="nexus-coder-panel-result">
          <strong>目标与验收</strong>
          {view.brief && view.brief.revision !== view.goal.revision && <p>此任务属于旧目标版本 v{view.brief.revision}；以下显示当前版本 v{view.goal.revision} 的验收进度。</p>}
          <p>{view.goal.report}</p>
          {view.goal.recovery && <details><summary>按当前目标查看恢复清单</summary><pre>{view.goal.recovery}</pre></details>}
        </div>}
        {view.decisions.length > 0 && <details className="nexus-coder-panel-decisions"><summary>监工的决定</summary><ul>{view.decisions.map((line, index) => <li key={index}>{line}</li>)}</ul></details>}
        <h4>过程</h4>
        {problem && <p className="nexus-channel-hint">{problem}</p>}
        {view.transcript.omitted ? <p className="nexus-channel-hint">更早的 {view.transcript.omitted} 条没有显示。</p> : null}
        {entries.length > 0
          ? <ol className="nexus-coder-entries">{entries.map((entry, index) => <Entry key={`${entry.at}-${index}`} entry={entry} />)}</ol>
          : <>
            {view.transcript.problem && <p className="nexus-channel-hint">{view.transcript.problem}下面是监工记下的步骤。</p>}
            {view.trace.length > 0
              ? <ol className="nexus-coder-entries">{view.trace.map((step, index) => <li key={index} className="nexus-coder-entry"><div className="nexus-coder-entry-head"><time>{clock(step.at)}</time><span className="nexus-coder-entry-title">{step.text}</span></div></li>)}</ol>
              : <p className="nexus-channel-hint">还没有记录到任何动作。</p>}
          </>}
      </div>
    );
  };
}
