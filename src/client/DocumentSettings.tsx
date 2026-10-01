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
  const writing = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || writing.current) return;
      pending = true;
      try { const next = await api('list', {}, controller.signal); if (!controller.signal.aborted) { setView(next); setReadError(undefined); } }
      catch (failure) { if (!controller.signal.aborted) setReadError(explain((failure as Error).message)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);
  const action = async (method: string) => {
    writing.current = true; setBusy(true); setError(undefined);
    try { setView(await api(method)); }
    catch (failure) { setError(explain((failure as Error).message)); }
    finally { writing.current = false; setBusy(false); }
  };
  if (!view) {
    return <section className="nexus-channel-settings" aria-label="文档工具"><h2>文档工具</h2>
      {readError ? <p role="alert" className="nexus-channel-error">{readError}</p> : <p role="status">正在检测文档工具…</p>}</section>;
  }
  const installing = view.pandoc?.phase === 'installing';
  const hasPandoc = view.converters.some(item => item.kind === 'pandoc');
  const hasOffice = view.converters.some(item => item.kind === 'soffice' || item.kind === 'msoffice' || item.kind === 'wps');
  const hasPdf = view.converters.some(item => item.kind === 'pdftotext' || item.kind === 'ghostscript');
  return <section className="nexus-channel-settings" aria-label="文档工具">
    <h2>文档工具</h2>
    <p>助理可以读、生成和修改 Word、Excel、PowerPoint 文件，这部分不需要任何额外软件。转成 PDF、读 PDF 文字和旧格式互转用的是这台机器上已经装好的软件，Nexus 不打包它们。</p>
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
        ? '装了 Microsoft Office 或 WPS 时，Nexus 通过它们转 PDF，效果和你自己在电脑上“另存为 PDF”一样；没有的话装 LibreOffice 也行。'
        : view.platform === 'darwin' ? '装 LibreOffice（libreoffice.org）后重新检测即可转 PDF。'
        : 'Linux 上装 LibreOffice 即可：sudo apt install libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui fonts-noto-cjk，装完点“重新检测”。'}
        {hasPdf ? '' : view.platform === 'win32' ? ' 读 PDF 文字需要 Ghostscript 或 poppler 的 pdftotext。' : ' 读 PDF 文字需要 poppler-utils（pdftotext）或 ghostscript。'}</p>
    </article>
  </section>;
}
