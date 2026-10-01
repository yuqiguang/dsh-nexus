import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MemoryView } from '../memory/index.js';
import { explain } from './ChannelSettings.js';

export type MemoryApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<MemoryView>;

export const memoryApi: MemoryApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-memory/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as MemoryView;
};

const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const REMEMBER_LABEL: Record<MemoryView['policy']['remember'], string> = { auto: '直接记住', ask: '先放待确认', off: '不记' };

export function MemorySettings({ api = memoryApi }: { api?: MemoryApi }) {
  const [view, setView] = useState<MemoryView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [exported, setExported] = useState<string>();
  const [profileKey, setProfileKey] = useState('');
  const [profileValue, setProfileValue] = useState('');
  const [eventText, setEventText] = useState('');
  const [filter, setFilter] = useState('');
  const [scopeId, setScopeId] = useState<string>();
  const [targetScopeId, setTargetScopeId] = useState('');
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const writing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || writing.current) return;
      pending = true;
      const started = generation.current;
      try {
        const next = await api('list', scopeId ? { scopeId } : {}, controller.signal);
        if (!controller.signal.aborted && started === generation.current) { setView(next); setReadError(undefined); }
      } catch (failure) { if (!controller.signal.aborted && started === generation.current) setReadError(explain((failure as Error).message)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, scopeId]);
  const action = async (method: string, payload: unknown = {}): Promise<MemoryView | undefined> => {
    if (writing.current) return undefined;
    writing.current = true; generation.current++;
    setBusy(true); setError(undefined);
    try { const next = await api(method, { ...payload as object, ...(view?.scope ? { scopeId: view.scope.id } : {}) }); setView(next); setExported(undefined); return next; }
    catch (failure) { setError(explain((failure as Error).message)); return undefined; }
    finally { writing.current = false; setBusy(false); }
  };
  if (!view) {
    return <section className="nexus-channel-settings" aria-label="记忆"><h2>记忆</h2>
      {readError ? <p role="alert" className="nexus-channel-error">{readError}</p> : <p role="status">正在读取记忆…</p>}</section>;
  }
  const addProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await action('profile/set', { key: profileKey, value: profileValue })) { setProfileKey(''); setProfileValue(''); }
  };
  const addEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await action('event/add', { text: eventText })) setEventText('');
  };
  const needle = filter.trim().toLowerCase();
  const legacy = view.scope?.kind === 'legacy';
  const copy = async (payload: object) => {
    setCopied(false);
    if (await action('legacy/copy', { ...payload, targetScopeId })) setCopied(true);
  };
  const events = needle ? view.events.filter(item => item.text.toLowerCase().includes(needle) || item.tags?.some(tag => tag.toLowerCase().includes(needle))) : view.events;
  return <section className="nexus-channel-settings" aria-label="记忆">
    <h2>记忆</h2>
    <p>新记忆按原生会话的工作目录和身份隔离；相同身份的全局个人偏好可以在项目间共享。模型只能写入当前项目。删除会停止后续检索与注入，已有会话上下文不会被撤回。</p>
    {view.scope && view.scopes && <div className="nexus-channel-card">
      <label htmlFor="memory-scope">查看与管理的范围</label>
      <select id="memory-scope" value={view.scope.id} disabled={busy} onChange={event => {
        generation.current++; setScopeId(event.target.value); setView(undefined); setExported(undefined); setFilter('');
        setProfileKey(''); setProfileValue(''); setEventText(''); setTargetScopeId(''); setCopied(false); setError(undefined);
      }}>{view.scopes.map(scope => <option key={scope.id} value={scope.id}>{scope.label}</option>)}</select>
      <p className="nexus-channel-hint">此选择只决定设置页管理哪组数据，不改变活动会话、项目或文件权限。新的本机项目可先在 DSH 中打开工作区；渠道范围在首次产生记忆后列出，各身份互不共享。</p>
      {view.scope.kind === 'global' && <p className="nexus-channel-hint">这里保存的内容会提供给同一身份的所有项目，请只放明确需要跨项目共享的个人偏好。</p>}
      {legacy && <>
        <p role="status">旧版记录没有可靠的项目归属，保持原数据，不自动注入。你可以导出、删除，或逐条复制到明确的范围。原记录会保留；复制不会覆盖目标中的同名画像。</p>
        <label htmlFor="memory-copy-target">旧记录复制到</label>
        <select id="memory-copy-target" value={targetScopeId} disabled={busy} onChange={event => { setTargetScopeId(event.target.value); setCopied(false); }}>
          <option value="">请选择目标范围…</option>
          {view.scopes.filter(scope => scope.kind !== 'legacy').map(scope => <option key={scope.id} value={scope.id}>{scope.label}</option>)}
        </select>
        {copied && <p role="status">已复制到所选范围，旧记录仍保留。</p>}
      </>}
    </div>}
    {view.moduleEnabled === false && <p role="status">记忆模块当前关闭，不运行模型记忆工具、自动注入或渠道摘要写入。仍可查看、导出、修改和删除；下方策略在“Nexus 扩展”重新启用并重启后才会用于模型。</p>}
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    <div className="nexus-channel-card">
      <header><h3>写入策略</h3><span className="nexus-channel-state">画像 {view.counts.profile}/{view.limits.profileEntries}，事件 {view.counts.events}/{view.limits.events}</span></header>
      <p className="nexus-channel-hint">此策略适用于所有新记忆范围。默认先待确认；渠道换会话时生成的摘要也遵守此策略。旧版记录不参与自动读写。</p>
      <label htmlFor="memory-remember">模型调用 memory_remember 时</label>
      <select id="memory-remember" value={view.policy.remember} disabled={busy || legacy}
        onChange={event => { void action('policy', { ...view.policy, remember: event.target.value }); }}>
        {Object.entries(REMEMBER_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor="memory-inject"><input id="memory-inject" type="checkbox" checked={view.policy.inject} disabled={busy || legacy}
        onChange={event => { void action('policy', { ...view.policy, inject: event.target.checked }); }} style={{ width: 'auto', marginRight: 8 }} />
        每轮对话前注入画像和相关事件</label>
      <footer>
        <button type="button" disabled={busy} onClick={() => { void action('export').then(next => setExported(next?.exportJson)); }}>导出 JSON</button>
      </footer>
      {exported !== undefined && <textarea aria-label="导出的记忆" readOnly value={exported} rows={8} />}
    </div>
    {view.proposals.length > 0 && <div className="nexus-channel-card">
      <header><h3>待确认</h3><span className="nexus-channel-state">{view.proposals.length} 条</span></header>
      <ul className="nexus-memory-list">
        {view.proposals.map(proposal => <li key={proposal.id}>
          <span>{proposal.kind === 'profile' ? `画像 ${proposal.key}：` : `事件 ${when(proposal.at)} `}{proposal.text}</span>
          <span className="nexus-memory-actions">
            {legacy ? <button type="button" disabled={busy || !targetScopeId} onClick={() => void copy({ kind: 'proposal', id: proposal.id, expectedText: proposal.text })}>复制并采纳到所选范围</button>
              : <button type="button" className="primary" disabled={busy} onClick={() => { void action('proposal/settle', { id: proposal.id, accept: true }); }}>采纳</button>}
            <button type="button" disabled={busy} onClick={() => { void action('proposal/settle', { id: proposal.id, accept: false }); }}>丢弃</button>
          </span>
        </li>)}
      </ul>
    </div>}
    <div className="nexus-channel-card">
      <header><h3>画像</h3></header>
      {view.profile.length === 0 ? <p className="nexus-channel-hint">还没有画像条目。</p> : <ul className="nexus-memory-list">
        {view.profile.map(entry => <li key={entry.key}>
          <span><strong>{entry.key}</strong>：{entry.value}<span className="nexus-channel-state"> {entry.source === 'user' ? '你写的' : '模型记的'} {when(entry.updatedAt)}</span></span>
          <button type="button" disabled={busy} aria-label={`删除画像 ${entry.key}`} onClick={() => { void action('profile/delete', { key: entry.key }); }}>删除</button>
          {legacy && <button type="button" disabled={busy || !targetScopeId} onClick={() => void copy({ kind: 'profile', key: entry.key, expectedText: entry.value })}>复制到所选范围</button>}
        </li>)}
      </ul>}
      {!legacy && <form onSubmit={event => { void addProfile(event); }}>
        <label htmlFor="memory-profile-key">条目名</label>
        <input id="memory-profile-key" value={profileKey} maxLength={view.limits.profileKeyChars} onChange={event => setProfileKey(event.target.value)} placeholder="如：称呼、饮食偏好" />
        <label htmlFor="memory-profile-value">内容</label>
        <input id="memory-profile-value" value={profileValue} maxLength={view.limits.profileValueChars} onChange={event => setProfileValue(event.target.value)} />
        <footer><button type="submit" className="primary" disabled={busy || !profileKey.trim() || !profileValue.trim()}>保存画像条目</button></footer>
      </form>}
    </div>
    <div className="nexus-channel-card">
      <header><h3>事件</h3><span className="nexus-channel-state">显示最近 {view.events.length} 条</span></header>
      <label htmlFor="memory-filter">筛选</label>
      <input id="memory-filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder="按内容或标签筛选" />
      {events.length === 0 ? <p className="nexus-channel-hint">没有事件记忆。</p> : <ul className="nexus-memory-list">
        {events.map(item => <li key={item.id}>
          <span><span className="nexus-channel-state">{when(item.at)}{item.source === 'summary' ? ' 对话摘要' : ''} </span>{item.text}{item.tags?.length ? <span className="nexus-channel-state"> #{item.tags.join(' #')}</span> : null}</span>
          <button type="button" disabled={busy} aria-label={`删除事件 ${item.id}`} onClick={() => { void action('event/delete', { id: item.id }); }}>删除</button>
          {legacy && <button type="button" disabled={busy || !targetScopeId} onClick={() => void copy({ kind: 'event', id: item.id, expectedText: item.text })}>复制到所选范围</button>}
        </li>)}
      </ul>}
      {!legacy && <form onSubmit={event => { void addEvent(event); }}>
        <label htmlFor="memory-event-text">新增事件</label>
        <textarea id="memory-event-text" value={eventText} maxLength={view.limits.eventChars} onChange={event => setEventText(event.target.value)} placeholder="一句话，写清何时、什么、结论" />
        <footer><button type="submit" className="primary" disabled={busy || !eventText.trim()}>添加事件</button></footer>
      </form>}
    </div>
    <div className="nexus-channel-card">
      <header><h3>最近注入</h3></header>
      {view.injections.length === 0 ? <p className="nexus-channel-hint">还没有注入记录。</p> : <ul className="nexus-memory-list">
        {view.injections.map(record => <li key={record.id}>
          <span><span className="nexus-channel-state">{when(record.at)} </span>“{record.query}” → {record.profile ? '画像' : ''}{record.profile && record.eventIds.length ? '、' : ''}{record.eventIds.length ? `${record.eventIds.length} 条事件` : ''}</span>
        </li>)}
      </ul>}
    </div>
  </section>;
}
