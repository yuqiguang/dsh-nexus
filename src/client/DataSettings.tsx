import { useEffect, useRef, useState } from 'react';
import type { DataSummary } from '../data/archive.js';
import type { ImportResult } from '../data/index.js';

/** The server's upload cap; checked here first because the server can only refuse a larger upload by dropping the connection. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export interface DataApi {
  capabilities(): Promise<{ importEnabled: boolean }>;
  /** The archive as the server built it, with the name to save it under. */
  exportData(): Promise<{ blob: Blob; filename: string; summary?: DataSummary }>;
  importData(file: Blob): Promise<ImportResult>;
  /** Hand a blob to the browser as a download. */
  save(blob: Blob, filename: string): void;
}

const messages: Record<string, string> = {
  session_expired: '登录已过期，请刷新页面重新打开。',
  connection_failed: '连不上 Nexus 服务，请稍后再试。',
  archive_too_large: '文件太大（上限 256 MiB）。',
  data_too_large: '数据超过 512 MiB，没法打成一个包。',
  archive_unreadable: '这不是一个能打开的 zip 文件。',
  manifest_invalid: '这个 zip 里缺少 Nexus 的清单，或者清单坏了。',
  not_a_nexus_archive: '这不是 Nexus 导出的数据包。',
  archive_version_unsupported: '这个数据包来自更新的 Nexus，当前版本读不了。',
  archive_path_rejected: '数据包里有不该有的文件路径，已拒绝。',
  archive_incomplete: '数据包不完整：清单里列的文件缺了。',
  archive_corrupt: '数据包里有文件和清单对不上，可能损坏或被改过。',
  credentials_invalid: '数据包里的凭据文件格式不对。',
  credentials_missing: '数据包里没有凭据文件。',
  import_in_progress: '上一个导入还在处理，请稍等。',
  update_in_progress: '自动更新正在进行，等它结束再导入。',
  export_failed: '导出失败，服务日志里有原因。',
  import_failed: '导入失败，服务日志里有原因。',
  import_unavailable: '此安装方式暂不支持整体导入数据；可以导出备份。',
};
const explain = (code?: string) => messages[code ?? ''] ?? '操作未完成，请重试。';

async function failureCode(response: Response): Promise<string> {
  if (response.status === 401) return 'session_expired';
  try { return ((await response.json()) as { error?: { code?: string } }).error?.code ?? 'connection_failed'; } catch { return 'connection_failed'; }
}

export const dataApi: DataApi = {
  async capabilities() {
    const response = await fetch('/api/nexus-data/capabilities', { credentials: 'same-origin' });
    if (!response.ok) throw new Error(await failureCode(response));
    return response.json();
  },
  async exportData() {
    const response = await fetch('/api/nexus-data/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok || response.headers.get('content-type') !== 'application/zip') throw new Error(await failureCode(response));
    const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'nexus-data.zip';
    let summary: DataSummary | undefined;
    try { summary = JSON.parse(decodeURIComponent(response.headers.get('x-nexus-summary') ?? '')) as DataSummary; } catch { summary = undefined; }
    return { blob: await response.blob(), filename, ...(summary ? { summary } : {}) };
  },
  async importData(file) {
    const response = await fetch('/api/nexus-data/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip' }, body: file });
    if (!response.ok) throw new Error(await failureCode(response));
    const body = await response.json() as { ok: boolean; value?: ImportResult; error?: { code?: string } };
    if (!body.ok || !body.value) throw new Error(body.error?.code ?? 'connection_failed');
    return body.value;
  },
  save(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const counts = (summary: DataSummary) => `${summary.sessions} 个会话、${summary.records} 条存储记录、${summary.credentials} 条凭据，共 ${mib(summary.bytes)}`;

/** Export the user's data as one zip, or replace it with one; the import takes effect when the service restarts. */
export function DataSettings({ api = dataApi }: { api?: DataApi }) {
  const [busy, setBusy] = useState(false);
  const [importEnabled, setImportEnabled] = useState(false);
  useEffect(() => {
    let active = true;
    void api.capabilities().then(value => { if (active) setImportEnabled(value.importEnabled === true); })
      .catch(() => { if (active) setImportEnabled(false); });
    return () => { active = false; };
  }, [api]);
  const [error, setError] = useState<string>();
  const [exported, setExported] = useState<string>();
  const [file, setFile] = useState<File>();
  const [confirming, setConfirming] = useState(false);
  const [imported, setImported] = useState<ImportResult>();
  const input = useRef<HTMLInputElement>(null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await work(); } catch (failure) { setError(explain((failure as Error).message)); } finally { setBusy(false); }
  };
  const doExport = () => run(async () => {
    const { blob, filename, summary } = await api.exportData();
    api.save(blob, filename);
    setExported(`已导出 ${filename}${summary ? `：${counts(summary)}` : `（${mib(blob.size)}）`}。`);
  });
  const doImport = () => run(async () => {
    setConfirming(false);
    if (!importEnabled) throw new Error('import_unavailable');
    if (file!.size > MAX_ARCHIVE_BYTES) throw new Error('archive_too_large');
    setImported(await api.importData(file!));
    setFile(undefined);
    if (input.current) input.current.value = '';
  });
  return <section className="nexus-channel-settings" aria-label="数据">
    <h2>数据</h2>
    <p>导出包含会话记录、原生存储，以及渠道、邮箱、模型的登录凭据；源码启动还包括 Nexus profile 配置。桌面端本身的配置需要另行备份。收到的附件和工作区里的文件不在里面。</p>
    {error && <p role="alert" className="nexus-channel-error">{error}</p>}
    <article className="nexus-channel-card">
      <header><h3>导出</h3></header>
      <p className="nexus-channel-hint"><strong>这个文件里有明文的微信登录、邮箱授权码和模型 API key，等于你所有账号的钥匙。</strong>只存在你自己的设备上，不要发给别人，也不要传到公开的网盘。</p>
      {exported && <p role="status" className="nexus-channel-account">{exported}</p>}
      <div className="nexus-channel-actions"><button type="button" disabled={busy} onClick={() => void doExport()}>导出数据</button></div>
    </article>
    <article className="nexus-channel-card">
      <header><h3>导入</h3></header>
      {!importEnabled ? <p className="nexus-channel-hint">此安装方式暂不支持整体导入数据；可以导出备份。</p> : <>
      <p className="nexus-channel-hint">用一个导出的 zip 整体替换这台机器上的数据。现在的会话、记忆、设置和凭据会原样移到 .nexus/replaced-时间/ 里留着；导入的数据在服务重启后生效，重启会打断正在进行的对话。如果导出它的那台机器还开着同一个微信登录，两边会抢消息，先把那边停掉。</p>
      <label>选择导出的 zip <input ref={input} type="file" accept=".zip,application/zip" disabled={busy}
        onChange={event => { setFile(event.currentTarget.files?.[0]); setConfirming(false); setImported(undefined); setError(undefined); }} /></label>
      {file && !confirming && <div className="nexus-channel-actions"><span className="nexus-channel-account">{file.name}（{mib(file.size)}）</span>
        <button type="button" disabled={busy} onClick={() => setConfirming(true)}>导入并重启</button></div>}
      {file && confirming && <div className="nexus-channel-actions" role="group" aria-label="确认导入">
        <span>确定用 {file.name} 替换现在的全部数据吗？</span>
        <button type="button" disabled={busy} onClick={() => void doImport()}>确定替换</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></div>}
      {imported && <p role="status" className="nexus-channel-account">
        {`已检查并准备好：${when(imported.pending.summary.createdAt)} 导出，${counts(imported.pending.summary)}。`}
        {imported.restarting ? '服务正在重启，半分钟左右后刷新页面。原来的数据会在 .nexus/' + imported.pending.replacedDir + '/ 里。'
          : `重启 Nexus 后生效，原来的数据会移到 .nexus/${imported.pending.replacedDir}/。`}</p>}
      </>}
    </article>
  </section>;
}
