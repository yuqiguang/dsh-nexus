import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MemoryPage, MemoryView } from '../memory/index.js';
import { MemoryTransfer } from './MemoryTransfer.js';
import { explain } from './ChannelSettings.js';

import { memoryApi, type MemoryApi } from './memory-api.js';
export { memoryApi, type MemoryApi } from './memory-api.js';

const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const REMEMBER_LABEL: Record<MemoryView['policy']['remember'], string> = { auto: '直接记住', ask: '先放待确认', off: '不记' };

function Pages({ label, info, disabled, select }: { label: string; info: MemoryPage; disabled: boolean; select(page: number): void }) {
  return <footer aria-label={`${label}分页`}>
    <span className="nexus-channel-hint">共 {info.total} 条，第 {info.page + 1}/{info.pages} 页，每页 {info.pageSize} 条</span>
    <button type="button" aria-label={`${label}上一页`} disabled={disabled || info.page === 0} onClick={() => select(info.page - 1)}>上一页</button>
    <button type="button" aria-label={`${label}下一页`} disabled={disabled || info.page + 1 >= info.pages} onClick={() => select(info.page + 1)}>下一页</button>
  </footer>;
}

export function MemorySettings({ api = memoryApi }: { api?: MemoryApi }) {
  const [view, setView] = useState<MemoryView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [editor, setEditor] = useState<{ kind: 'profile' | 'event' | 'proposal'; id: string; key?: string; text: string; original: string }>();
  const [selected, setSelected] = useState<Record<string, { kind: 'profile' | 'event' | 'proposal'; key?: string; id?: string; expectedText: string }>>({});
  const [batchConfirm, setBatchConfirm] = useState(false);
  const [policyTarget, setPolicyTarget] = useState<'default' | 'scope'>('scope');
  const [profileKey, setProfileKey] = useState('');
  const [profileValue, setProfileValue] = useState('');
  const [eventText, setEventText] = useState('');
  const [filter, setFilter] = useState('');
  const [listQuery, setListQuery] = useState<{ eventQuery?: string; eventPage?: number; injectionPage?: number }>({});
  const [reading, setReading] = useState(false);
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
        const next = await api('list', { ...listQuery, ...(scopeId ? { scopeId } : {}) }, controller.signal);
        if (!controller.signal.aborted && started === generation.current) { setView(next); setReadError(undefined); setReading(false); }
      } catch (failure) { if (!controller.signal.aborted && started === generation.current) { setReadError(explain((failure as Error).message)); setReading(false); } }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 10_000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, scopeId, listQuery]);
  const navigate = (query: typeof listQuery) => {
    generation.current++; setReading(true); setReadError(undefined);
    setListQuery({ ...listQuery, ...query });
  };
  const action = async (method: string, payload: unknown = {}): Promise<MemoryView | undefined> => {
    if (writing.current || reading) return undefined;
    writing.current = true; generation.current++;
    setBusy(true); setError(undefined);
    try { const next = await api(method, { ...listQuery, ...payload as object, ...(view?.scope ? { scopeId: view.scope.id } : {}) }); setView(next); setSelected({}); setBatchConfirm(false); return next; }
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
  const policy = policyTarget === 'default' ? view.defaultPolicy ?? view.policy : view.policy;
  const savePolicy = (change: object) => action('policy', { ...policy, ...change, ...(view.defaultPolicy ? { target: policyTarget } : {}) });
  const needle = filter.trim().toLowerCase();
  const legacy = view.scope?.kind === 'legacy';
  const copy = async (payload: object) => {
    setCopied(false);
    if (await action('legacy/copy', { ...payload, targetScopeId })) setCopied(true);
  };
  const select = (id: string, record: (typeof selected)[string], checked: boolean) => {
    setSelected(previous => { const next = { ...previous }; if (checked) next[id] = record; else delete next[id]; return next; }); setBatchConfirm(false);
  };
  const events = needle && !view.pagination ? view.events.filter(item => item.text.toLowerCase().includes(needle) || item.tags?.some(tag => tag.toLowerCase().includes(needle))) : view.events;
  return <section className="nexus-channel-settings" aria-label="记忆">
    <h2>记忆</h2>
    <p>新记忆按原生会话的工作目录和身份隔离；相同身份的全局个人偏好可以在项目间共享。模型只能写入当前项目。删除会停止后续检索与注入，已有会话上下文不会被撤回。</p>
    {view.scope && view.scopes && <div className="nexus-channel-card">
      <label htmlFor="memory-scope">查看与管理的范围</label>
      <select id="memory-scope" value={view.scope.id} disabled={busy} onChange={event => {
        generation.current++; setScopeId(event.target.value); setView(undefined); setFilter(''); setListQuery({}); setReading(true);
        setSelected({}); setBatchConfirm(false); setEditor(undefined); setProfileKey(''); setProfileValue(''); setEventText(''); setTargetScopeId(''); setCopied(false); setError(undefined);
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
    {view.moduleEnabled === false && <p role="status">长期记忆组件当前未运行，不使用模型记忆工具、自动注入或渠道摘要写入。仍可查看、导出、修改和删除数据。需要模型使用记忆时，请在 DSH 插件详情的组件列表中启用“长期记忆”，按宿主提示操作后刷新本页；旧版记忆开关不再生效。</p>}
    {view.moduleEnabled === true && <p role="status">长期记忆组件正在运行，模型读写与自动注入受下方策略和项目范围约束。组件开关在 DSH 插件详情中管理。</p>}
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    <div className="nexus-channel-card">
      <header><h3>写入策略</h3><span className="nexus-channel-state">画像 {view.counts.profile}/{view.limits.profileEntries}，事件 {view.counts.events}/{view.limits.events}</span></header>
      <p className="nexus-channel-hint">全局默认适用于未单独设置的范围；当前范围可覆盖默认。模型主动记忆与渠道换会话摘要可分别设置。旧版记录不参与自动读写。</p>
      {view.defaultPolicy && <>
        <label htmlFor="memory-policy-target">设置对象</label>
        <select id="memory-policy-target" value={policyTarget} disabled={busy || legacy} onChange={event => setPolicyTarget(event.target.value as 'default' | 'scope')}>
          <option value="scope">当前范围{view.policyOverride ? '（单独设置）' : '（继承默认）'}</option><option value="default">所有范围的默认策略</option>
        </select>
        {policyTarget === 'scope' && view.policyOverride && <button type="button" disabled={busy} onClick={() => void savePolicy({ inherit: true })}>恢复继承默认</button>}
      </>}
      <label htmlFor="memory-remember">模型调用 memory_remember 时</label>
      <select id="memory-remember" value={policy.remember} disabled={busy || legacy}
        onChange={event => { void savePolicy({ remember: event.target.value }); }}>
        {Object.entries(REMEMBER_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor="memory-inject"><input id="memory-inject" type="checkbox" checked={policy.inject} disabled={busy || legacy}
        onChange={event => { void savePolicy({ inject: event.target.checked }); }} style={{ width: 'auto', marginRight: 8 }} />
        每轮对话前注入画像和相关事件</label>
      {view.defaultPolicy && <>
        <label htmlFor="memory-summary">渠道换会话摘要</label>
        <select id="memory-summary" value={policy.summary ?? policy.remember} disabled={busy || legacy} onChange={event => void savePolicy({ summary: event.target.value })}>
          {Object.entries(REMEMBER_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </>}
    </div>
    {Object.keys(selected).length > 0 && <div className="nexus-channel-card">
      <p>已选择 {Object.keys(selected).length} 条记忆{batchConfirm ? '，确认删除？待确认条目会被丢弃。' : ''}</p>
      {batchConfirm ? <button disabled={busy} onClick={() => void action('records/delete', { records: Object.values(selected) })}>确认删除所选</button>
        : <button disabled={busy} onClick={() => setBatchConfirm(true)}>删除所选记忆</button>}
      <button disabled={busy} onClick={() => { setSelected({}); setBatchConfirm(false); }}>清空选择</button>
    </div>}
    {editor && <form className="nexus-channel-card" aria-label="编辑记忆" onSubmit={event => {
      event.preventDefault();
      const payload = editor.kind === 'profile' ? { key: editor.key, value: editor.text, expectedText: editor.original }
        : { id: editor.id, text: editor.text, expectedText: editor.original, ...(editor.kind === 'proposal' ? { key: editor.key, accept: true } : {}) };
      void action(editor.kind === 'profile' ? 'profile/set' : editor.kind === 'event' ? 'event/edit' : 'proposal/settle', payload).then(next => { if (next) setEditor(undefined); });
    }}>
      <p>{editor.kind === 'proposal' ? '编辑后采纳' : '编辑记忆'}{editor.key ? `：${editor.key}` : ''}</p>
      {editor.kind === 'proposal' && editor.key !== undefined && <>
        <label htmlFor="memory-edit-key">条目名</label>
        <input id="memory-edit-key" value={editor.key} maxLength={view.limits.profileKeyChars} onChange={event => setEditor({ ...editor, key: event.target.value })} />
      </>}
      <label htmlFor="memory-edit-text">记忆内容</label>
      <textarea id="memory-edit-text" value={editor.text} maxLength={editor.key !== undefined ? view.limits.profileValueChars : view.limits.eventChars} onChange={event => setEditor({ ...editor, text: event.target.value })} />
      <footer><button type="submit" disabled={busy || !editor.text.trim()}>{editor.kind === 'proposal' ? '保存并采纳' : '保存修改'}</button>
        <button type="button" disabled={busy} onClick={() => setEditor(undefined)}>取消编辑</button></footer>
    </form>}
    {view.proposals.length > 0 && <div className="nexus-channel-card">
      <header><h3>待确认</h3><span className="nexus-channel-state">{view.proposals.length} 条</span></header>
      <ul className="nexus-memory-list">
        {view.proposals.map(proposal => <li key={proposal.id}>
          <input type="checkbox" aria-label={`选择提案 ${proposal.id}`} checked={!!selected[proposal.id]} disabled={busy} style={{ width: 'auto' }}
            onChange={event => select(proposal.id, { kind: 'proposal', id: proposal.id, expectedText: proposal.text }, event.target.checked)} />
          <span>{proposal.kind === 'profile' ? `画像 ${proposal.key}：` : `事件 ${when(proposal.at)} `}{proposal.text}</span>
          <span className="nexus-memory-actions">
            {!legacy && <button type="button" disabled={busy} aria-label={`编辑提案 ${proposal.id}`} onClick={() => setEditor({ kind: 'proposal', id: proposal.id, key: proposal.key, text: proposal.text, original: proposal.text })}>编辑后采纳</button>}
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
          <input type="checkbox" aria-label={`选择画像 ${entry.key}`} checked={!!selected[`profile:${entry.key}`]} disabled={busy} style={{ width: 'auto' }}
            onChange={event => select(`profile:${entry.key}`, { kind: 'profile', key: entry.key, expectedText: entry.value }, event.target.checked)} />
          <span><strong>{entry.key}</strong>：{entry.value}<span className="nexus-channel-state"> {entry.source === 'user' ? '你写的' : '模型记的'} {when(entry.updatedAt)}</span></span>
          {!legacy && <button type="button" disabled={busy} aria-label={`编辑画像 ${entry.key}`} onClick={() => setEditor({ kind: 'profile', id: entry.key, key: entry.key, text: entry.value, original: entry.value })}>编辑</button>}
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
      <header><h3>事件</h3><span className="nexus-channel-state">已保存 {view.counts.events}/{view.limits.events} 条</span></header>
      <p className="nexus-channel-hint">按时间从新到旧浏览；搜索覆盖当前范围内的全部事件。普通事件满额后需先整理，系统不会自动删除；自动保存的对话摘要满额时只替换最旧摘要。</p>
      {view.counts.events >= view.limits.events * 0.9 && <p role="status">事件容量即将用满，可先导出，再删除过时记录。</p>}
      <label htmlFor="memory-filter">搜索事件</label>
      <input id="memory-filter" value={filter} maxLength={200} disabled={busy} onChange={event => {
        setFilter(event.target.value);
        if (view.pagination) navigate({ eventQuery: event.target.value, eventPage: 0 });
      }} placeholder="按内容或标签搜索当前范围" />
      {view.pagination?.eventQuery && <p className="nexus-channel-hint">当前结果：{view.pagination.eventQuery}</p>}
      {reading ? <p role="status">正在读取列表…</p> : events.length === 0 ? <p className="nexus-channel-hint">{needle ? '没有匹配的事件记忆。' : '没有事件记忆。'}</p> : <ul className="nexus-memory-list">
        {events.map(item => <li key={item.id}>
          <input type="checkbox" aria-label={`选择事件 ${item.id}`} checked={!!selected[item.id]} disabled={busy} style={{ width: 'auto' }}
            onChange={event => select(item.id, { kind: 'event', id: item.id, expectedText: item.text }, event.target.checked)} />
          <span><span className="nexus-channel-state">{when(item.at)}{item.source === 'summary' ? ' 对话摘要' : ''} </span>{item.text}{item.tags?.length ? <span className="nexus-channel-state"> #{item.tags.join(' #')}</span> : null}</span>
          {!legacy && <button type="button" disabled={busy} aria-label={`编辑事件 ${item.id}`} onClick={() => setEditor({ kind: 'event', id: item.id, text: item.text, original: item.text })}>编辑</button>}
          <button type="button" disabled={busy} aria-label={`删除事件 ${item.id}`} onClick={() => { void action('event/delete', { id: item.id }); }}>删除</button>
          {legacy && <button type="button" disabled={busy || !targetScopeId} onClick={() => void copy({ kind: 'event', id: item.id, expectedText: item.text })}>复制到所选范围</button>}
        </li>)}
      </ul>}
      {view.pagination && <Pages label="事件" info={view.pagination.events} disabled={busy || reading} select={eventPage => navigate({ eventPage })} />}
      {!legacy && <form onSubmit={event => { void addEvent(event); }}>
        <label htmlFor="memory-event-text">新增事件</label>
        <textarea id="memory-event-text" value={eventText} maxLength={view.limits.eventChars} onChange={event => setEventText(event.target.value)} placeholder="一句话，写清何时、什么、结论" />
        <footer><button type="submit" className="primary" disabled={busy || !eventText.trim()}>添加事件</button></footer>
      </form>}
    </div>
    <div className="nexus-channel-card">
      <header><h3>最近注入</h3></header>
      <p className="nexus-channel-hint">这是向模型提供记忆的使用记录，不是新增记忆。每个范围只保留最近 {view.limits.injections} 条，超过后自动清理最旧日志。新日志保存当时内容快照，之后修改或删除记忆不会改写这些历史记录。</p>
      {reading ? <p role="status">正在读取列表…</p> : view.injections.length === 0 ? <p className="nexus-channel-hint">还没有注入记录。</p> : <ul className="nexus-memory-list">
        {view.injections.map(record => <li key={record.id}>
          <span><span className="nexus-channel-state">{when(record.at)} </span>“{record.query}” → {record.profile ? '画像' : ''}{record.profile && record.eventIds.length ? '、' : ''}{record.eventIds.length ? `${record.eventIds.length} 条事件` : ''}</span>
          <details><summary>查看当时注入的内容</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{record.content ?? '旧日志未保存内容快照，无法准确还原当时的记忆。'}</pre></details>
        </li>)}
      </ul>}
      {view.pagination && <Pages label="注入记录" info={view.pagination.injections} disabled={busy || reading} select={injectionPage => navigate({ injectionPage })} />}
    </div>
    <MemoryTransfer key={view.scope?.id} view={view} busy={busy || reading} action={action} />
  </section>;
}
