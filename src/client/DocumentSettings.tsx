import { useEffect, useRef, useState } from 'react';
import type { DocumentsView } from '../documents/index.js';
import { explain } from './ChannelSettings.js';

export type DocumentApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<DocumentsView>;

export const documentApi: DocumentApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-documents/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (response.status === 404) throw new Error('document_component_unavailable');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as DocumentsView;
};

const names: Record<string, string> = { soffice: 'LibreOffice', pandoc: 'pandoc', msoffice: 'Microsoft Office', wps: 'WPS Office', pdftotext: 'pdftotext（poppler）', ghostscript: 'Ghostscript' };
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** What this machine can do with documents, and the one thing the page can install: pandoc. */
export function DocumentSettings({ api = documentApi }: { api?: DocumentApi }) {
  const [view, setView] = useState<DocumentsView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const writing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    let absent = false;
    const refresh = async () => {
      if (pending || writing.current || absent) return;
      pending = true;
      try { const next = await api('list', {}, controller.signal); if (!controller.signal.aborted) { setView(next); setUnavailable(false); setReadError(undefined); } }
      catch (failure) {
        if (!controller.signal.aborted) {
          absent = (failure as Error).message === 'document_component_unavailable';
          setUnavailable(absent);
          if (absent) { setView(undefined); setReadError(undefined); }
          else setReadError(explain((failure as Error).message));
        }
      }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, attempt]);
  const action = async (method: string) => {
    writing.current = true; setBusy(true); setError(undefined);
    try { setView(await api(method)); }
    catch (failure) { setError(explain((failure as Error).message)); }
    finally { writing.current = false; setBusy(false); }
  };
  if (!view) {
    return <section className="nexus-channel-settings" aria-label="文档兼容工具"><h2>文档兼容工具</h2>
      {unavailable ? <>
        <p role="status">文档兼容组件当前未运行。请在 DSH 插件详情的组件列表中启用“文档兼容工具”，启用后重新载入；若宿主提示重启，请等任务结束后重启。</p>
        <p>常规 Word、Excel、PPT 任务优先使用 DSH 官方 Office 技能；本组件默认关闭，仅供旧格式、Pandoc 或缺少官方能力的环境选用。关闭本组件不影响官方文档能力、已有文件和已安装的软件。</p>
      </> : readError ? <p role="alert" className="nexus-channel-error">{readError}</p> : <p role="status">正在读取文档兼容工具状态…</p>}
      <button onClick={() => setAttempt(value => value + 1)}>重新载入</button></section>;
  }
  const installing = view.pandoc?.phase === 'installing';
  const hasPandoc = view.converters.some(item => item.kind === 'pandoc');
  const hasOffice = view.converters.some(item => item.kind === 'soffice' || item.kind === 'msoffice' || item.kind === 'wps');
  const hasPdf = view.converters.some(item => item.kind === 'pdftotext' || item.kind === 'ghostscript');
  return <section className="nexus-channel-settings" aria-label="文档兼容工具">
    <h2>文档兼容工具</h2>
    <p>常规 Word、Excel、PPT 任务优先使用 DSH 官方 Office 技能。本页仅列出 Nexus 兼容流程的能力，不代表 DSH 官方预览、PDF 导出或技能的可用状态。</p>
    <p>兼容工具可以读、生成和修改 Word、Excel、PowerPoint 文件，这部分不需要额外软件。兼容流程的 PDF 文字提取和旧格式互转使用本机软件；需要时再安装。组件开关在 DSH 插件详情中管理。</p>
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    <article className="nexus-channel-card">
      <header><h3>本机能力</h3>{view.detectedAt !== undefined && <span className="nexus-channel-state">检测于 {when(view.detectedAt)}</span>}</header>
      <ul>{view.capabilities.map(line => <li key={line}>{line}</li>)}</ul>
      <p className="nexus-channel-account">{view.converters.length ? `找到：${view.converters.map(item => `${names[item.kind] ?? item.kind}（${item.path}）`).join('；')}` : '没有找到任何外部转换工具。'}</p>
      <div className="nexus-channel-actions"><button type="button" disabled={busy} onClick={() => void action('detect')}>重新检测</button></div>
    </article>
    <article className="nexus-channel-card">
      <header><h3>pandoc</h3><span className={`nexus-channel-state ${hasPandoc ? 'connected' : 'disabled'}`}>{hasPandoc ? '可用' : '未安装'}</span></header>
      <p className="nexus-channel-hint">pandoc 负责 Markdown、HTML、odt、rtf 与 Word 之间的互转，约 40 MiB。点下面的按钮从 GitHub 下载固定版本到 Nexus 的数据目录，不影响系统里的安装；已经有的话不用装。</p>
      {view.pandoc && <p role={view.pandoc.phase === 'failed' ? 'alert' : 'status'} className="nexus-channel-account">
        {view.pandoc.phase === 'installing' ? `下载中…${view.pandoc.bytes ? ` 已收到 ${mib(view.pandoc.bytes)}` : ''}` : view.pandoc.phase === 'installed' ? `已安装 pandoc ${view.pandoc.version}（${when(view.pandoc.finishedAt ?? view.pandoc.startedAt)}）` : `安装失败：${view.pandoc.error ?? ''}`}</p>}
      <div className="nexus-channel-actions"><button type="button" disabled={busy || installing} onClick={() => void action('pandoc/install')}>{hasPandoc ? '重新下载 pandoc' : '下载 pandoc'}</button></div>
    </article>
    <article className="nexus-channel-card">
      <header><h3>PDF 与格式转换</h3><span className={`nexus-channel-state ${hasOffice ? 'connected' : 'disabled'}`}>{hasOffice ? '可转 PDF' : '不能转 PDF'}</span></header>
      <p className="nexus-channel-hint">{view.platform === 'win32'
        ? '本机装了 Microsoft Office、WPS 或 LibreOffice 时，兼容工具可尝试转 PDF；需检查字体、分页和内容，不能保证与手工另存完全一致。'
        : view.platform === 'darwin' ? '装 LibreOffice（libreoffice.org）后重新检测即可转 PDF。'
        : 'Linux 上装 LibreOffice 即可：sudo apt install libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-noto-cjk，装完点“重新检测”。'}
        {hasPdf ? '' : view.platform === 'win32' ? ' 读 PDF 文字需要 Ghostscript 或 poppler 的 pdftotext。' : ' 读 PDF 文字需要 poppler-utils（pdftotext）或 ghostscript。'}</p>
    </article>
  </section>;
}
