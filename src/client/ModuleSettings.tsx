import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MODULE_KEYS, type ModuleFlags, type ModuleKey, type ModulesView } from '../modules/settings.js';
import { explain } from './ChannelSettings.js';

export type ModulesApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<ModulesView>;
export const modulesApi: ModulesApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-modules/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as ModulesView;
};

const labels: Record<ModuleKey, string> = { memory: '长期记忆', mail: '邮箱', agenda: '日历与待办', documents: '办公文档' };
const hints: Record<ModuleKey, string> = {
  memory: '关闭后停止模型记忆工具、自动注入和渠道摘要写入；设置页仍可管理数据。新记忆按会话项目和身份隔离，旧记忆需明确归类。',
  mail: '开启模块后，还需在邮箱与日程中配置并启用邮箱账号。关闭后停止邮件工具、轮询和连接测试，保留凭据与提醒规则。',
  agenda: '关闭后停止日历、待办工具和自动提醒，也不再加入每日简报；原有日程与待办保留。',
  documents: '关闭后不注册文档工具，也不探测本机转换软件；已有文件和已安装软件保留。',
};

export function ModuleSettings({ api = modulesApi }: { api?: ModulesApi }) {
  const [view, setView] = useState<ModulesView>();
  const [draft, setDraft] = useState<ModuleFlags>();
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const controller = useRef<AbortController>();
  const accept = (next: ModulesView) => { setView(next); setDraft({ ...next.saved }); setRevision(next.revision); };
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void api('list', {}, abort.signal).then(next => { if (!abort.signal.aborted) accept(next); })
      .catch(failure => { if (!abort.signal.aborted) setError(explain((failure as Error).message)); });
    return () => abort.abort();
  }, [api]);
  const action = async (method: 'list' | 'save') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(undefined);
    const signal = controller.current?.signal;
    try {
      const next = await api(method, method === 'save' ? { revision, enabled: draft } : {}, signal);
      if (!signal?.aborted) accept(next);
    } catch (failure) { if (!signal?.aborted) setError(explain((failure as Error).message)); }
    finally { pending.current = false; if (!signal?.aborted) setBusy(false); }
  };
  return <section className="nexus-channel-settings" aria-label="Nexus 扩展">
    <h2>Nexus 扩展</h2>
    <p>编码任务、验证、验收和数据管理始终保留。渠道在“渠道连接”中逐个绑定和启用。</p>
    <p>下方开关保存后，下次启动 DSH 时生效。请等任务结束后手动重启；保存不会自动重启或中断当前任务。</p>
    {error && <p role="alert" className="nexus-channel-error">{error}</p>}
    {!view || !draft ? <>{!error && <p role="status">正在读取扩展配置…</p>}<button disabled={busy} onClick={() => void action('list')}>重新载入</button></> : <>
      {view.revision === 0 && <p className="nexus-channel-hint">尚未保存模块配置，当前沿用旧版兼容默认值。仅做编码时，可用下方快捷配置关闭四项扩展；账号连接仍由各自设置决定。</p>}
      <p role="status">{view.pendingRestart ? '已保存的配置与当前运行状态不同，等待重启生效。' : '已保存的配置与当前运行状态一致。'}</p>
      <form onSubmit={event => { event.preventDefault(); void action('save'); }}>
        {MODULE_KEYS.map(key => <article className="nexus-channel-card" key={key}>
          <header><h3>{labels[key]}</h3><span>当前：{view.active[key] ? '开启' : '关闭'} · 已保存：{view.saved[key] ? '开启' : '关闭'}</span></header>
          <label htmlFor={`module-${key}`}><input id={`module-${key}`} type="checkbox" checked={draft[key]} disabled={busy}
            style={{ width: 'auto', marginRight: 8 }} onChange={event => setDraft({ ...draft, [key]: event.target.checked })} />下次启动启用{labels[key]}</label>
          <p className="nexus-channel-hint">{hints[key]}</p>
        </article>)}
        <div className="nexus-channel-actions">
          <button type="button" disabled={busy} onClick={() => setDraft({ memory: false, mail: false, agenda: false, documents: false })}>仅保留编码核心</button>
          <button type="submit" disabled={busy}>{busy ? '处理中…' : '保存扩展开关'}</button>
          <button type="button" disabled={busy} onClick={() => void action('list')}>重新载入</button>
        </div>
      </form>
      <p className="nexus-channel-hint">原生定时提醒：{view.nativeRemindersAvailable ? '宿主服务可用' : '当前宿主未提供服务'}。本页不会取消或接管已有原生提醒，请在 DSH 任务页管理。助理的静默时段、每日简报和语音设置仍在“助理”中管理。</p>
    </>}
  </section>;
}

/** Do not mount (and poll) a module's settings page when its runtime is absent. */
export function ModuleBoundary({ module, children, api = modulesApi }: { module: ModuleKey; children: ReactNode; api?: ModulesApi }) {
  const [view, setView] = useState<ModulesView>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api('list', {}, controller.signal).then(next => { if (!controller.signal.aborted) { setView(next); setError(undefined); } })
      .catch(failure => { if (!controller.signal.aborted) setError(explain((failure as Error).message)); });
    return () => controller.abort();
  }, [api, attempt]);
  if (view?.active[module]) return children;
  return <section className="nexus-channel-settings"><h2>{labels[module]}</h2>
    {error ? <><p role="alert">{error}</p><button onClick={() => setAttempt(attempt + 1)}>重试</button></> : !view ? <p role="status">正在读取扩展状态…</p> :
      <p role="status">此扩展当前关闭。{view.saved[module] ? '已保存开启配置，重启 DSH 后生效。' : '请在“Nexus 扩展”中启用并保存，重启 DSH 后使用。'}</p>}
  </section>;
}
