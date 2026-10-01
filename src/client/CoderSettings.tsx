import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CodersView, CoderStatusView } from '../coders/manager.js';
import type { InstallProgress, InstallStatus } from '../coders/install.js';
import { explain } from './ChannelSettings.js';
import { CodingStart, type CodingNavigation } from './CodingStart.js';

export type CoderApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<CodersView>;

export const coderApi: CoderApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-coders/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as CodersView;
};

type Action = (method: string, payload?: unknown) => Promise<boolean>;
const names = { codex: 'Codex', claude: 'Claude Code' };
const sources = { managed: 'Nexus 托管', system: '系统安装', none: '未安装' };
const taskStatus: Record<string, string> = { queued: '排队中', running: '运行中', 'waiting-user': '等待回答', verifying: '验证中',
  completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' };
const problems: Record<string, string> = { binary_missing: '缺少可执行文件', platform_package_missing: '缺少匹配本机的平台包', version_check_failed: '无法读取版本',
  install_incomplete: '安装未完成', claude_cli_missing: '缺少 claude 命令和匹配本机的内置二进制',
  windows_launcher_unsupported: '检测到命令包装脚本，但无法定位 Windows 原生程序；请使用托管安装' };

interface Draft {
  revision: number; defaultCoder: 'codex' | 'claude'; roots: string; maxTaskMinutes: number; maxConcurrent: number; autoApproveSafe: boolean; securityMode: 'standard' | 'strict'; allowedNetworkDomains: string;
  codex: { source: 'managed' | 'system'; model: string; baseUrl: string; wireApi: 'responses' | 'chat'; apiKey: string };
  claude: { source: 'managed' | 'system'; model: string; baseUrl: string; authHeader: 'auth-token' | 'api-key'; token: string };
}

function fromView(view: CodersView): Draft {
  const { settings } = view;
  return { securityMode: settings.securityMode ?? 'standard', revision: settings.revision, defaultCoder: settings.defaultCoder, roots: (settings.roots ?? []).join('\n'), maxTaskMinutes: settings.maxTaskMinutes ?? 60, maxConcurrent: settings.maxConcurrent ?? 2, autoApproveSafe: settings.autoApproveSafe ?? true, allowedNetworkDomains: (settings.allowedNetworkDomains ?? ['registry.npmjs.org']).join('\n'),
    codex: { source: settings.codex.source, model: settings.codex.model ?? '', baseUrl: settings.codex.baseUrl ?? '', wireApi: settings.codex.wireApi ?? 'responses', apiKey: '' },
    claude: { source: settings.claude.source, model: settings.claude.model ?? '', baseUrl: settings.claude.baseUrl ?? '', authHeader: settings.claude.authHeader, token: '' } };
}

function Install({ label, status }: { label: string; status: InstallStatus }) {
  return <span>{label}：{status.installed ? `${status.version ?? '已安装'}` : status.problem ? `${status.version ?? ''} ${problems[status.problem] ?? status.problem}`.trim() : '未安装'}</span>;
}

function Status({ status }: { status: CoderStatusView }) {
  return <span className={`nexus-channel-state ${status.ready ? 'connected' : status.active === 'none' ? '' : 'error'}`}>
    {status.ready ? `可用（${sources[status.active]}${status.fallback ? `，首选的${sources[status.active === 'managed' ? 'system' : 'managed']}不可用` : ''}）` : status.active === 'none' ? '未安装' : '未就绪'}</span>;
}

function when(at: number) { return new Date(at).toLocaleString('zh-CN', { hour12: false }); }

const installStages = { preparing: '准备安装', downloading: '下载程序包', packages: '安装依赖', verifying: '检查程序文件', configuring: '写入配置' };
const installFailures: Record<string, string> = {
  install_timeout: '下载或安装超时，请检查网络或代理后重试。', ECONNRESET: '下载连接被重置，请检查网络或代理后重试。',
  ETIMEDOUT: '连接下载源超时，请检查网络或代理。', ENOTFOUND: '无法解析下载源的域名。',
  EAI_AGAIN: '暂时无法解析下载源的域名。', ECONNREFUSED: '下载源或代理拒绝连接。',
  EINTEGRITY: '程序包校验失败，请重新下载。', download_incomplete: '下载不完整，请重试。',
  download_stalled: '长时间未收到下载数据，请检查网络或代理后重试。',
  download_manifest_invalid: '下载源没有返回匹配版本的程序包信息或校验值。', download_failed: '程序包下载失败，请检查下载源、网络或代理。',
};
function downloadBytes(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}
function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function InstallActivity({ progress, readError }: { progress: InstallProgress; readError?: string }) {
  const [now, setNow] = useState(Date.now);
  const active = progress.phase === 'installing';
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, progress.startedAt]);
  const quietFor = now - (progress.lastOutputAt ?? progress.startedAt);
  const failure = progress.error && (installFailures[progress.error] ?? progress.error);
  const download = active && progress.stage === 'downloading' ? progress.download : undefined;
  const network = download?.state === 'downloading';
  return <div className="nexus-install-activity" aria-label={`${names[progress.coder]} 托管安装状态`}>
    <p role={progress.phase === 'failed' ? 'alert' : 'status'}>
      {names[progress.coder]} 托管安装：{active ? `进行中 · ${installStages[progress.stage ?? 'packages']}` : progress.phase === 'installed' ? '已完成' : `失败：${failure ?? '请查看安装日志'}`}
    </p>
    {active && <progress aria-label={`${names[progress.coder]} 托管安装进度`}
      {...(network && download.total ? { value: download.bytes, max: download.total } : {})} />}
    {download && <div className="nexus-download-progress">
      <p><code>{download.package}</code></p>
      <p>{download.state === 'cached' ? '读取本地缓存' : download.state === 'verified' ? '程序包校验完成'
        : download.state === 'retrying' ? `连接中断，正在第 ${download.attempt} 次尝试（重新下载此包）`
        : download.state === 'connecting' ? '正在连接下载源…' : `下载速度：${downloadBytes(download.bytesPerSecond)}/s${download.bytesPerSecond === 0 ? '（等待数据）' : ''}`}</p>
      <p>已{download.state === 'cached' ? '读取' : '下载'} {downloadBytes(download.bytes)}{download.total ? ` / ${downloadBytes(download.total)}` : '（总大小暂未知）'}
        {network && download.total ? ` · ${Math.min(100, Math.floor(download.bytes / download.total * 100))}%` : ''}</p>
      {download.source && <p className="nexus-channel-hint">下载来源：<code>{download.source}</code></p>}
    </div>}
    <p className="nexus-channel-hint">{active ? '已用时' : '总用时'} {elapsed((progress.finishedAt ?? now) - progress.startedAt)}
      {active && progress.lastOutputAt !== undefined && ` · 最近输出在 ${elapsed(quietFor)}前`}</p>
    {active && (readError ? <p role="alert">安装状态暂时无法刷新：{readError}。连接恢复后会自动更新。</p>
      : <p className="nexus-channel-hint">{!download && quietFor >= 30 ? `暂时没有新日志，可能正在等待网络响应或解压文件；本次安装最多等待 ${Math.round((progress.timeoutMs ?? 15 * 60_000) / 60_000)} 分钟。` : '状态会自动更新；关闭设置页面后安装仍会继续，请保持 DSH 运行。'}</p>)}
    {progress.log && <>
      <p className="nexus-channel-hint">最近日志：<code>{progress.log.trim().split('\n').filter(Boolean).at(-1)}</code></p>
      <details><summary>查看安装日志（最近部分，已脱敏）</summary><pre><code>{progress.log}</code></pre></details>
    </>}
  </div>;
}

export function CoderSettings({ api = coderApi, navigation, close }: { api?: CoderApi; navigation?: () => CodingNavigation | undefined; close?: () => void }) {
  const [view, setView] = useState<CodersView>();
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [startingInstall, setStartingInstall] = useState<'codex' | 'claude'>();
  const [installRequestFailed, setInstallRequestFailed] = useState<{ coder: 'codex' | 'claude'; previousStart?: number }>();
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
        const next = await api('list', {}, controller.signal);
        if (!controller.signal.aborted && started === generation.current) {
          setView(next); setReadError(undefined);
          setInstallRequestFailed(previous => previous && next.install?.coder === previous.coder && next.install.startedAt !== previous.previousStart ? undefined : previous);
        }
      } catch (failure) { if (!controller.signal.aborted && started === generation.current) setReadError(explain((failure as Error).message)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);
  useEffect(() => { if (view && !dirty) setDraft(fromView(view)); }, [view, dirty]);
  const action: Action = async (method, payload = {}) => {
    writing.current = true; generation.current++;
    setBusy(true); setError(undefined);
    try { setView(await api(method, payload)); setReadError(undefined); return true; }
    catch (failure) { setError(explain((failure as Error).message)); return false; }
    finally { writing.current = false; setBusy(false); }
  };
  if (!view || !draft) {
    return <section className="nexus-channel-settings" aria-label="编码工具"><h2>编码工具</h2>
      {readError ? <p role="alert" className="nexus-channel-error">{readError}</p> : <p role="status">正在读取编码工具设置…</p>}</section>;
  }
  const stale = dirty && draft.revision !== view.settings.revision;
  const edit = (change: (draft: Draft) => Draft) => { setDirty(true); setDraft(previous => previous && change(previous)); };
  const reload = () => { setDraft(fromView(view)); setDirty(false); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { codex, claude } = draft;
    if (await action('save', { revision: draft.revision, config: { defaultCoder: draft.defaultCoder, securityMode: draft.securityMode, roots: draft.roots, maxTaskMinutes: draft.maxTaskMinutes, maxConcurrent: draft.maxConcurrent, autoApproveSafe: draft.autoApproveSafe, allowedNetworkDomains: draft.allowedNetworkDomains,
      codex: { source: codex.source, model: codex.model, baseUrl: codex.baseUrl, wireApi: codex.wireApi, ...(codex.apiKey ? { apiKey: codex.apiKey } : {}) },
      claude: { source: claude.source, model: claude.model, baseUrl: claude.baseUrl, authHeader: claude.authHeader, ...(claude.token ? { token: claude.token } : {}) } } })) setDirty(false);
  };
  const installing = view.install?.phase === 'installing';
  const activeInstall = startingInstall ?? (installing ? view.install?.coder : undefined);
  const startInstall = async (coder: 'codex' | 'claude') => {
    setStartingInstall(coder); setInstallRequestFailed(undefined);
    const confirmed = await action('install', { coder });
    setStartingInstall(undefined);
    if (!confirmed) setInstallRequestFailed({ coder, previousStart: view.install?.startedAt });
  };
  const installButton = (coder: 'codex' | 'claude', status: CoderStatusView) =>
    <button type="button" disabled={busy || installing} onClick={() => void startInstall(coder)}>
      {startingInstall === coder ? '正在启动安装…' : installing && view.install?.coder === coder ? '正在安装…' : activeInstall ? `请先等待 ${names[activeInstall]} 安装结束` : status.managed.installed ? '重新安装托管版本' : '安装托管版本'}</button>;
  const installActivity = (coder: 'codex' | 'claude') => startingInstall === coder ? <p role="status">正在启动 {names[coder]} 托管安装…</p>
    : <>
      {activeInstall && activeInstall !== coder && <p className="nexus-channel-hint" role="status">正在安装 {names[activeInstall]}，一次只能安装一个工具。结束后请再点击安装 {names[coder]}，不会自动排队。</p>}
      {installRequestFailed?.coder === coder && error && <p role="alert">安装请求未能确认：{error}。请等待状态刷新后再决定是否重试。</p>}
      {view.install?.coder === coder && <InstallActivity progress={view.install} readError={readError} />}
    </>;
  return <section className="nexus-channel-settings" aria-label="编码工具">
    <h2>编码工具</h2>
    <CodingStart view={view} disabled={busy || dirty} action={action} navigation={navigation} close={close} />
    {dirty && <p className="nexus-channel-hint">请先保存或放弃下方工具设置的修改，再切换项目。</p>}
    <p>把编码任务派给本机的 Codex 或 Claude Code。Nexus 可以自己安装一份（托管）并用这里的端点和密钥运行，也可以使用系统里已有的安装。密钥保存在本机，不会回填到页面。</p>
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    <form onSubmit={event => { void submit(event); }}>
      <article className="nexus-channel-card">
        <header><h3>通用</h3></header>
        <label htmlFor="coders-default">默认工具</label>
        <select id="coders-default" value={draft.defaultCoder} disabled={busy} onChange={event => edit(d => ({ ...d, defaultCoder: event.target.value as Draft['defaultCoder'] }))}>
          <option value="codex">Codex</option><option value="claude">Claude Code</option></select>
        <label htmlFor="coders-concurrency">同时执行任务数</label>
        <select id="coders-concurrency" value={draft.maxConcurrent} disabled={busy} onChange={event => edit(d => ({ ...d, maxConcurrent: Number(event.target.value) }))}>
          {[1, 2, 3, 4].map(limit => <option key={limit} value={limit}>{limit}{limit === 2 ? '（推荐）' : ''}</option>)}</select>
        <p className="nexus-channel-hint">Codex 和 Claude Code 共用此上限。独立工作区可并行，同一目录或同一 Git 工作树仍排队；有依赖的任务等待前置验证。保存后立即生效，调低上限不终止正在执行的任务。</p>
        <label htmlFor="coders-security">派发模式（新任务生效）</label>
        <select id="coders-security" value={draft.securityMode} disabled={busy} onChange={event => edit(d => ({ ...d, securityMode: event.target.value as Draft['securityMode'] }))}>
          <option value="standard">标准：由 DSH 审核命令和额外权限</option><option value="strict">严格：要求原生沙箱隔离</option></select>
        <p className="nexus-channel-hint">标准模式允许联网，由 DSH 判断具体操作是否安全；Claude 命令没有操作系统文件隔离。严格模式要求沙箱可用，Claude 在原生 Windows 下不可用。已有任务续接保持原模式。</p>
        <label htmlFor="coders-roots">允许的工作目录（每行一个绝对路径，留空使用 profile 里的配置）</label>
        <textarea id="coders-roots" rows={3} value={draft.roots} disabled={busy} placeholder={view.profileRoots.join('\n')}
          onChange={event => edit(d => ({ ...d, roots: event.target.value }))} />
        <p className="nexus-channel-hint">当前生效：{view.effectiveRoots.join('、')}。任务目录必须位于这些根目录内；每个任务默认只写自己的目录；目录外文件操作单独审核；自动审核范围限于已配置的工作目录。</p>
        <label htmlFor="coders-network">命令联网允许域名（每行一个，不含协议或通配符）</label>
        <textarea id="coders-network" rows={2} value={draft.allowedNetworkDomains} disabled={busy} onChange={event => edit(d => ({ ...d, allowedNetworkDomains: event.target.value }))} />
        <p className="nexus-channel-hint">网页搜索和读取优先通过 DSH 只读服务，不受命令域名名单限制；访问私网、携带网页认证等仍会被安全读取器拒绝。标准模式的命令允许联网，由 DSH 审核用途和影响，域名名单不构成网络隔离。严格模式下，Claude 命令仅能访问名单内域名，Codex 的具体域名请求可匹配名单；修改后新建任务生效，续接不会扩大权限。</p>
        <label><input type="checkbox" checked={draft.autoApproveSafe} disabled={busy} onChange={event => edit(d => ({ ...d, autoApproveSafe: event.target.checked }))} /> 安全操作由 DSH 自动审核</label>
        <p className="nexus-channel-hint">标准模式下，DSH 审核具体命令、项目依赖安装和额外文件操作，安全且与任务有关时自动批准并记录理由；不确定或审核失败时询问你。关闭后命令和额外权限交给你确认。凭据和明确的破坏性操作仍受限制。</p>
        <label htmlFor="coders-budget">每次运行时限（分钟，1–240；到期暂停，可续接）</label>
        <input id="coders-budget" type="number" min={1} max={240} value={draft.maxTaskMinutes} disabled={busy} onChange={event => edit(d => ({ ...d, maxTaskMinutes: Number(event.target.value) }))} />
        <p className="nexus-channel-hint">无人值守开发：任务目录内写入，额外权限由监工逐次判断，范围不明时询问；同一拒绝累计三次或同一操作连续失败三次暂停；成功操作清零失败计数。Codex 保留工作目录写入沙箱；标准模式的 Claude 使用工具审批。审批不能约束任意脚本内部的全部行为，不等同于系统沙箱。续接沿用原任务权限。</p>
      </article>
      <article className="nexus-channel-card">
        <header><h3>Codex</h3><Status status={view.codex} /></header>
        <p><Install label="托管安装" status={view.codex.managed} />；<Install label="系统安装" status={view.codex.system} />{view.codex.system.path ? `（${view.codex.system.path}）` : ''}</p>
        {view.codex.login && <p className="nexus-channel-account">登录：{view.codex.login}</p>}
        {view.codex.problem && <p role="alert">{view.codex.problem}</p>}
        {view.codex.platformProblem && view.codex.platformProblem !== view.codex.problem && <p className="nexus-channel-hint">{view.codex.platformProblem}</p>}
        {view.codex.windowsSandbox && <p className="nexus-channel-hint">Windows 增强沙箱：{view.codex.windowsSandbox === 'ready' ? '已就绪' : view.codex.windowsSandbox === 'checking' ? '配置中…' : '未就绪'}。
          {view.codex.windowsSandbox !== 'ready' && view.codex.windowsSandbox !== 'firewallDisabled' && <button type="button" disabled={busy || view.codex.windowsSandbox === 'checking'} onClick={() => void action('windows-sandbox/setup')}>
            配置 Windows 沙箱</button>} 首次配置可能需要 Windows 管理员确认。</p>}
        <label htmlFor="codex-source">来源</label>
        <select id="codex-source" value={draft.codex.source} disabled={busy} onChange={event => edit(d => ({ ...d, codex: { ...d.codex, source: event.target.value as 'managed' | 'system' } }))}>
          <option value="managed">Nexus 托管（使用下方的端点和 API key）</option><option value="system">系统安装（沿用本机 Codex 的登录和配置）</option></select>
        <p className="nexus-channel-hint">系统安装使用 DSH 所在电脑当前用户的 Codex 配置，默认目录为 <code>{view.platform === 'win32' ? '%USERPROFILE%\\.codex' : '~/.codex'}</code>；若 DSH 启动环境设置了 CODEX_HOME，则使用指定目录。托管安装使用 Nexus 独立配置目录。Windows 与 WSL 的配置分别保存。</p>

        <label htmlFor="codex-model">模型（可选）</label>
        <input id="codex-model" maxLength={128} value={draft.codex.model} disabled={busy} autoComplete="off" placeholder="留空用 Codex 默认"
          onChange={event => edit(d => ({ ...d, codex: { ...d.codex, model: event.target.value } }))} />
        <label htmlFor="codex-endpoint">兼容端点（可选，托管安装使用）</label>
        <input id="codex-endpoint" maxLength={512} value={draft.codex.baseUrl} disabled={busy} autoComplete="off" placeholder="https://api.openai.com/v1"
          onChange={event => edit(d => ({ ...d, codex: { ...d.codex, baseUrl: event.target.value } }))} />
        <label htmlFor="codex-wire">端点协议</label>
        <select id="codex-wire" value={draft.codex.wireApi} disabled={busy} onChange={event => edit(d => ({ ...d, codex: { ...d.codex, wireApi: event.target.value as 'responses' | 'chat' } }))}>
          <option value="responses">responses</option><option value="chat">chat</option></select>
        <label htmlFor="codex-key">API key（托管安装使用）</label>
        <input id="codex-key" type="password" maxLength={4096} value={draft.codex.apiKey} disabled={busy} autoComplete="new-password"
          placeholder={view.settings.codex.apiKeyConfigured ? '已保存，留空保留当前密钥' : '输入 API key'}
          onChange={event => edit(d => ({ ...d, codex: { ...d.codex, apiKey: event.target.value } }))} />
        {view.codex.lastTask && <p className="nexus-channel-hint">最近任务 {view.codex.lastTask.id}：{view.codex.lastTask.statusLabel ?? taskStatus[view.codex.lastTask.status] ?? view.codex.lastTask.status}{view.codex.lastTask.detail ? `（${view.codex.lastTask.detail}）` : ''}，{when(view.codex.lastTask.updatedAt)}</p>}
        <footer>
          {installButton('codex', view.codex)}
          {view.settings.codex.apiKeyConfigured && <button type="button" disabled={busy || stale} onClick={() => void action('clear-secret', { coder: 'codex', revision: view.settings.revision })}>清除 API key</button>}
        </footer>
        {installActivity('codex')}
      </article>
      <article className="nexus-channel-card">
        <header><h3>Claude Code</h3><Status status={view.claude} /></header>
        <p><Install label="托管安装" status={view.claude.managed} />；<Install label="系统安装" status={view.claude.system} />{view.claude.system.executable ? `（${view.claude.system.executable}）` : ''}</p>
        {view.claude.login && <p className="nexus-channel-account">凭据：{view.claude.login}</p>}
        {view.claude.problem && <p role="alert">{view.claude.problem}</p>}
        {view.claude.platformProblem && view.claude.platformProblem !== view.claude.problem && <p className="nexus-channel-hint">{view.claude.platformProblem}</p>}
        <label htmlFor="claude-source">来源</label>
        <select id="claude-source" value={draft.claude.source} disabled={busy} onChange={event => edit(d => ({ ...d, claude: { ...d.claude, source: event.target.value as 'managed' | 'system' } }))}>
          <option value="managed">Nexus 托管的 Claude Code</option><option value="system">系统安装（使用本机可用的 Claude Code）</option></select>
        <p className="nexus-channel-hint">来源决定使用哪个程序。两种来源均使用下方的端点和凭据，以及 Nexus 专用配置目录；不会自动沿用终端中 Claude Code 的登录。</p>
        <label htmlFor="claude-model">模型（可选）</label>
        <input id="claude-model" maxLength={128} value={draft.claude.model} disabled={busy} autoComplete="off" placeholder="例如 deepseek-flash"
          onChange={event => edit(d => ({ ...d, claude: { ...d.claude, model: event.target.value } }))} />
        <label htmlFor="claude-endpoint">兼容端点（可选）</label>
        <input id="claude-endpoint" maxLength={512} value={draft.claude.baseUrl} disabled={busy} autoComplete="off" placeholder="https://api.deepseek.com/anthropic"
          onChange={event => edit(d => ({ ...d, claude: { ...d.claude, baseUrl: event.target.value } }))} />
        <label htmlFor="claude-header">认证方式</label>
        <select id="claude-header" value={draft.claude.authHeader} disabled={busy} onChange={event => edit(d => ({ ...d, claude: { ...d.claude, authHeader: event.target.value as 'auth-token' | 'api-key' } }))}>
          <option value="auth-token">Bearer token（ANTHROPIC_AUTH_TOKEN，兼容端点常用）</option><option value="api-key">x-api-key（ANTHROPIC_API_KEY，官方 API key）</option></select>
        <label htmlFor="claude-token">Token</label>
        <input id="claude-token" type="password" maxLength={4096} value={draft.claude.token} disabled={busy} autoComplete="new-password"
          placeholder={view.settings.claude.tokenConfigured ? '已保存，留空保留当前 token' : '输入端点的 token 或 API key'}
          onChange={event => edit(d => ({ ...d, claude: { ...d.claude, token: event.target.value } }))} />
        <p className="nexus-channel-hint">Claude Code 配置目录：<code>{view.claudeHome}</code>。{view.claude.platformProblem ? '请先解决上面的运行平台限制，再配置登录。' : view.claudeLogin ? <>要用官方 OAuth 登录，在 DSH 所在电脑的 {view.claudeLogin.shell} 中执行以下命令，然后把 token 留空：</> : '安装可用的 Claude Code 后，这里会显示官方 OAuth 登录命令；也可以直接填写上方的端点和 token。'}</p>
        {!view.claude.platformProblem && view.claudeLogin && <pre className="nexus-channel-hint"><code>{view.claudeLogin.command}</code></pre>}
        {view.claude.lastTask && <p className="nexus-channel-hint">最近任务 {view.claude.lastTask.id}：{view.claude.lastTask.statusLabel ?? taskStatus[view.claude.lastTask.status] ?? view.claude.lastTask.status}{view.claude.lastTask.detail ? `（${view.claude.lastTask.detail}）` : ''}，{when(view.claude.lastTask.updatedAt)}</p>}
        <footer>
          {installButton('claude', view.claude)}
          {view.settings.claude.tokenConfigured && <button type="button" disabled={busy || stale} onClick={() => void action('clear-secret', { coder: 'claude', revision: view.settings.revision })}>清除 token</button>}
        </footer>
        {installActivity('claude')}
      </article>
      {stale && <p role="alert">{explain('configuration_changed')} <button type="button" onClick={reload}>重新载入</button></p>}
      <footer className="nexus-channel-card" style={{ borderStyle: 'none', paddingTop: 0 }}>
        <button type="submit" className="primary" disabled={busy || stale}>保存设置</button>
        {dirty && <button type="button" disabled={busy} onClick={reload}>放弃修改</button>}
      </footer>
    </form>
    <article className="nexus-channel-card">
      <header><h3>习惯规则</h3></header>
      <p>编码工具的请求先经过写死的硬规则：凭据和破坏性命令直接拒绝，git push、sudo、写任务目录之外、网络和提问在聊天里问你。其余常规操作默认放行，这里的规则用来收紧或代答：在聊天里说“不许动 migrations 目录”会加一条拒绝规则，“问到包管理器就回答 pnpm”会加一条回答规则。</p>
      {view.rules.length === 0 && <p className="nexus-channel-hint">还没有习惯规则。项目 AGENTS.md 或 CLAUDE.md 里的 coder-rules 块在派发时读取，不在此列出。</p>}
      {view.rules.map(rule => <p key={rule.id} className="nexus-channel-account">{rule.text}{' '}
        <button type="button" disabled={busy} onClick={() => void action('rules/remove', { id: rule.id })}>删除</button></p>)}
    </article>
    <article className="nexus-channel-card">
      <header><h3>最近任务</h3></header>
      {view.project && <p className="nexus-channel-hint">当前项目：{view.project.path}。列出此目录及子目录中的最近 10 项任务。</p>}
      {view.recentTasks.length === 0 && <p className="nexus-channel-hint">还没有编码任务。</p>}
      {view.recentTasks.map(task => <div key={task.id} className="nexus-channel-account">
        <p>{task.id} · {names[task.coder]} · {task.statusLabel ?? taskStatus[task.status] ?? task.status}<br />{task.description}</p>
        {task.objective && <p className="nexus-channel-hint">总体目标：{task.objective}</p>}
        <p className="nexus-channel-hint">{task.cwd ? `${task.cwd} · ` : ''}最后更新：{when(task.updatedAt)}</p>
        {navigation?.()?.openTask && <button type="button" disabled={busy || dirty} onClick={() => { navigation?.()?.openTask?.(task.id); close?.(); }}>查看任务与验收</button>}
      </div>)}
    </article>
  </section>;
}
