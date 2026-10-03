import { useEffect, useRef, useState } from 'react';
import { saveDownload } from './download.js';
import { MemoryMigration } from './MemoryTransfer.js';
import type { DataPreview, DataExportOptions, DataSummary } from '../data/archive.js';
import type { ImportResult } from '../data/index.js';

/** The server's upload cap; checked here first because the server can only refuse a larger upload by dropping the connection. */
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export interface DataApi {
  capabilities(): Promise<{ importEnabled: boolean }>;
  /** The archive as the server built it, with the name to save it under. */
  exportData(options?: DataExportOptions): Promise<{ blob: Blob; filename: string; summary?: DataSummary }>;
  previewData(file: Blob, password?: string): Promise<DataPreview>;
  importData(file: Blob, password?: string, digest?: string): Promise<ImportResult>;
  /** Hand a blob to the browser as a download. */
  save(blob: Blob, filename: string): void;
}

const messages: Record<string, string> = {
  tasks_running: '有对话或编码任务正在执行，请等待结束后再备份或恢复。',
  preview_required: '请先重新预览所选备份，再确认恢复。',
  invalid_options: '备份选项无效，请检查输入。',
  archive_password_weak: '包含凭据时必须加密，请设置至少 10 个字符的密码。',
  archive_password_required: '这是加密备份，请输入导出时设置的密码。',
  archive_decrypt_failed: '密码不正确或加密备份已损坏。',
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
  async exportData(options) {
    const response = await fetch('/api/nexus-data/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options ?? {}) });
    if (!response.ok || response.headers.get('content-type') !== 'application/zip') throw new Error(await failureCode(response));
    const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? 'nexus-data.zip';
    let summary: DataSummary | undefined;
    try { summary = JSON.parse(decodeURIComponent(response.headers.get('x-nexus-summary') ?? '')) as DataSummary; } catch { summary = undefined; }
    return { blob: await response.blob(), filename, ...(summary ? { summary } : {}) };
  },
  async previewData(file, password = '') {
    const response = await fetch('/api/nexus-data/preview', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip', 'X-Nexus-Archive-Password': encodeURIComponent(password) }, body: file });
    if (!response.ok) throw new Error(await failureCode(response));
    const body = await response.json();
    if (!body.ok) throw new Error(body.error?.code ?? 'connection_failed');
    return body.value;
  },
  async importData(file, password = '', digest = '') {
    const response = await fetch('/api/nexus-data/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/zip', 'X-Nexus-Archive-Password': encodeURIComponent(password), 'X-Nexus-Preview': digest }, body: file });
    if (!response.ok) throw new Error(await failureCode(response));
    const body = await response.json() as { ok: boolean; value?: ImportResult; error?: { code?: string } };
    if (!body.ok || !body.value) throw new Error(body.error?.code ?? 'connection_failed');
    return body.value;
  },
  save: saveDownload,
};

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const counts = (summary: DataSummary) => `${summary.sessions} 个会话、${summary.records} 条存储记录、${summary.credentials} 条凭据，共 ${mib(summary.bytes)}`;

/** Export the user's data as one zip, or replace it with one; the import takes effect when the service restarts. */
export function DataSettings({ api = dataApi }: { api?: DataApi }) {
  const [purpose, setPurpose] = useState('backup');
  const [busy, setBusy] = useState(false);
  const [importEnabled, setImportEnabled] = useState<boolean>();
  const [capabilityError, setCapabilityError] = useState<string>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setCapabilityError(undefined); setImportEnabled(undefined);
    void api.capabilities().then(value => { if (active) setImportEnabled(value.importEnabled === true); })
      .catch(error => { if (active) setCapabilityError(explain(error.message)); });
    return () => { active = false; };
  }, [api, retry]);
  const [error, setError] = useState<string>();
  const [exported, setExported] = useState<string>();
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [includeSettings, setIncludeSettings] = useState(false);
  const [password, setPassword] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<DataPreview>();
  const [confirming, setConfirming] = useState(false);
  const [imported, setImported] = useState<ImportResult>();
  const input = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const run = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(undefined);
    try { await work(); } catch (failure) { setError(explain((failure as Error).message)); } finally { working.current = false; setBusy(false); }
  };
  const doExport = () => run(async () => {
    if ((includeCredentials || password) && password.length < 10) throw new Error('archive_password_weak');
    const { blob, filename, summary } = await api.exportData({ includeCredentials, includeSettings, ...(password ? { password } : {}) });
    api.save(blob, filename); setPassword('');
    setExported(`已导出 ${filename}${summary ? `：${counts(summary)}` : `（${mib(blob.size)}）`}。`);
  });
  const doPreview = () => run(async () => {
    setPreview(undefined); setConfirming(false);
    if (file!.size > MAX_ARCHIVE_BYTES) throw new Error('archive_too_large');
    setPreview(await api.previewData(file!, importPassword));
  });
  const doImport = () => run(async () => {
    setConfirming(false);
    if (!importEnabled) throw new Error('import_unavailable');
    if (!preview) throw new Error('preview_required');
    setImported(await api.importData(file!, importPassword, preview.digest));
    setFile(undefined); setPreview(undefined); setImportPassword('');
    if (input.current) input.current.value = '';
  });
  return <section className="nexus-channel-settings" aria-label="数据">
    <h2>数据</h2>
    <label htmlFor="data-purpose">操作目的</label>
    <select id="data-purpose" value={purpose} disabled={busy} onChange={event => setPurpose(event.target.value)}>
      <option value="backup">整体备份与恢复</option><option value="memory">迁移指定范围的记忆</option>
    </select>
    {purpose === 'memory' ? <MemoryMigration /> : <>
    <p>导出包含会话记录、原生存储；可选择登录凭据和源码 Nexus profile 配置。桌面端本身的配置需要另行备份。收到的附件和工作区里的文件不在里面。</p>
    {error && <p role="alert" className="nexus-channel-error">{error}</p>}
    <article className="nexus-channel-card">
      <header><h3>导出</h3></header>
      <label><input type="checkbox" checked={includeCredentials} disabled={busy} onChange={event => setIncludeCredentials(event.target.checked)} style={{ width: 'auto' }} /> 包含登录凭据（必须加密）</label>
      <label><input type="checkbox" checked={includeSettings} disabled={busy} onChange={event => setIncludeSettings(event.target.checked)} style={{ width: 'auto' }} /> 包含源码 Nexus profile 配置（若存在）</label>
      <label htmlFor="data-password">备份密码{includeCredentials ? '（必填）' : '（可选，填写后加密）'}</label>
      <input id="data-password" type="password" autoComplete="new-password" maxLength={1024} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} />
      <p className="nexus-channel-hint">加密备份使用 .nxb 文件，密码至少 10 个字符，丢失后无法恢复。默认不包含凭据；会话与存储仍可能含个人信息，请妥善保存。</p>
      {exported && <p role="status" className="nexus-channel-account">{exported}</p>}
      <div className="nexus-channel-actions"><button type="button" disabled={busy} onClick={() => void doExport()}>导出数据</button></div>
    </article>
    <article className="nexus-channel-card">
      <header><h3>检查备份与恢复</h3></header>
      {capabilityError ? <p role="alert">无法确认恢复能力：{capabilityError}<button onClick={() => setRetry(retry + 1)}>重试检查</button></p>
        : importEnabled === undefined ? <p role="status">正在检查恢复能力…</p>
        : !importEnabled ? <p className="nexus-channel-hint">此安装方式暂不支持整体导入数据；可以导出和检查备份。桌面端可使用上方“迁移指定范围的记忆”。</p>
        : <p className="nexus-channel-hint">恢复会替换备份包含的会话与存储，原数据保留在运行数据目录的 replaced-时间/ 中。没有包含的凭据与 profile 配置保持现状。请等待运行任务结束，并停止另一台使用相同渠道账号的实例。</p>}
      <label>选择导出的备份 <input ref={input} type="file" accept=".zip,.nxb,application/zip" disabled={busy}
        onChange={event => { setFile(event.currentTarget.files?.[0]); setPreview(undefined); setConfirming(false); setImported(undefined); setImportPassword(''); setError(undefined); }} /></label>
      {file && <>
        <p>{file.name}（{mib(file.size)}）</p>
        <label htmlFor="data-import-password">加密备份密码（普通 ZIP 留空）</label>
        <input id="data-import-password" type="password" autoComplete="off" maxLength={1024} value={importPassword} disabled={busy}
          onChange={event => { setImportPassword(event.target.value); setPreview(undefined); setConfirming(false); }} />
        <button disabled={busy} onClick={() => void doPreview()}>检查并预览备份</button>
      </>}
      {preview && <div role="group" aria-label="备份预览">
        <p>{when(preview.summary.createdAt)} 导出；DSH {preview.summary.dshVersion ?? '未标注'}；{counts(preview.summary)}。</p>
        <p>包含：会话、存储{!preview.summary.roots || preview.summary.roots.includes('.credentials.yaml') ? '、登录凭据' : '（保留当前登录凭据）'}{preview.summary.roots?.includes('profiles/nexus/cordis.patch.yml') ? '、源码 profile 配置' : ''}。{preview.summary.encrypted ? '密码与完整性校验通过。' : '未加密备份。'}</p>
        <p className="nexus-channel-hint">文件校验通过不代表不同 DSH 版本的数据完全兼容；建议在相同版本恢复。</p>
        {importEnabled && !confirming && <button disabled={busy} onClick={() => setConfirming(true)}>导入并重启</button>}
      </div>}
      {file && preview && confirming && <div className="nexus-channel-actions" role="group" aria-label="确认导入">
        <span>确定用 {file.name} 替换以上范围的数据吗？</span>
        <button type="button" disabled={busy} onClick={() => void doImport()}>确定替换</button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>取消</button></div>}
      {imported && <p role="status" className="nexus-channel-account">
        {`已检查并准备好：${when(imported.pending.summary.createdAt)} 导出，${counts(imported.pending.summary)}。`}
        {imported.restarting ? '已安排服务重启；如有新任务，会等任务结束后生效。请稍后刷新。' : '重启 Nexus 后生效。'}{`原来的数据保留在运行数据目录的 ${imported.pending.replacedDir}/。`}</p>}
    </article>
    </>}
  </section>;
}
