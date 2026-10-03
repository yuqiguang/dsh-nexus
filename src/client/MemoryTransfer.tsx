import { useEffect, useState } from 'react';
import type { MemoryView } from '../memory/index.js';
import type { MemoryImportPreview, MemorySelection } from '../memory/transfer.js';
import { saveDownload } from './download.js';
import { memoryApi } from './memory-api.js';
import { explain } from './ChannelSettings.js';

export function MemoryTransfer({ view, busy, action }: { view: MemoryView; busy: boolean;
  action(method: string, payload?: unknown): Promise<MemoryView | undefined> }) {
  const [selection, setSelection] = useState<MemorySelection>({ profile: true, events: true, proposals: true });
  const [json, setJson] = useState('');
  const [exported, setExported] = useState<string>();
  const [conflict, setConflict] = useState('keep');
  const [preview, setPreview] = useState<MemoryImportPreview>();
  const [notice, setNotice] = useState('');
  const [reading, setReading] = useState(false);
  const disabled = busy || reading;
  const reset = () => { setPreview(undefined); setNotice(''); };
  return <div className="nexus-channel-card">
    <header><h3>记忆迁移</h3></header>
    <p className="nexus-channel-hint">只迁移上方所选范围的记忆，适用于桌面端和 Web。目标：{view.scope?.label ?? '当前范围'}。不会导入账号、会话绑定或写入策略；待确认内容仍需采纳。</p>
    {(['profile', 'events', 'proposals'] as const).map(key => <label key={key}>
      <input type="checkbox" checked={selection[key]} disabled={disabled} style={{ width: 'auto', marginRight: 8 }}
        onChange={event => { setSelection({ ...selection, [key]: event.target.checked }); reset(); }} />
      {{ profile: '画像', events: '事件', proposals: '待确认' }[key]}</label>)}
    <footer><button type="button" disabled={disabled || !Object.values(selection).some(Boolean)} onClick={() => {
      void action('export', { selection }).then(next => setExported(next?.exportJson));
    }}>导出 JSON</button></footer>
    {exported !== undefined && <>
      <button type="button" onClick={() => saveDownload(new Blob([exported], { type: 'application/json' }), 'nexus-memory.json')}>下载 JSON 文件</button>
      <textarea aria-label="导出的记忆" readOnly value={exported} rows={6} />
    </>}
    {view.scope?.kind !== 'legacy' && <>
      <label>选择记忆 JSON <input type="file" accept=".json,application/json" disabled={disabled} onChange={event => {
        reset(); const file = event.target.files?.[0]; setJson('');
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { setNotice('文件超过 2 MiB，请减少导出内容。'); return; }
        setReading(true);
        void file.text().then(setJson).catch(() => setNotice('无法读取文件，请重新选择。')).finally(() => setReading(false));
      }} /></label>
      <label htmlFor="memory-import-json">或粘贴导出的 JSON</label>
      <textarea id="memory-import-json" value={json} disabled={disabled} rows={4} maxLength={2 * 1024 * 1024}
        onChange={event => { setJson(event.target.value); reset(); }} />
      <label htmlFor="memory-import-conflict">同名画像冲突</label>
      <select id="memory-import-conflict" value={conflict} disabled={disabled} onChange={event => { setConflict(event.target.value); reset(); }}>
        <option value="keep">保留已有内容</option><option value="overwrite">用导入内容覆盖</option>
      </select>
      <p className="nexus-channel-hint">相同事件和待确认内容会跳过。JSON 含个人记忆，请自行妥善保存。</p>
      <footer><button type="button" disabled={disabled || !json.trim() || !Object.values(selection).some(Boolean)} onClick={() => {
        reset(); void action('import/preview', { json, selection, conflict }).then(next => setPreview(next?.importPreview));
      }}>预览记忆导入</button></footer>
      {preview && <div role="group" aria-label="记忆导入预览">
        <p>来源：{preview.source}，{new Date(preview.exportedAt).toLocaleString('zh-CN')} 导出。</p>
        <p>目标：{view.scope?.label ?? '当前范围'}；画像 {preview.profile} 条、事件 {preview.events} 条、待确认 {preview.proposals} 条。</p>
        <p>新增 {preview.add} 条，覆盖 {preview.overwrite} 条，跳过 {preview.skip} 条，同名冲突 {preview.conflicts} 条。</p>
        <button type="button" disabled={disabled} onClick={() => {
          void action('import/apply', { json, selection, conflict, token: preview.token }).then(next => {
            setPreview(undefined); if (next?.imported) { setNotice('记忆已导入当前范围。'); setJson(''); }
          });
        }}>确认导入记忆</button>
        <button type="button" disabled={disabled} onClick={reset}>取消</button>
      </div>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}

/** Migration entry in Data settings, using the same authenticated scope catalog and routes. */
export function MemoryMigration() {
  const [view, setView] = useState<MemoryView>();
  const [scope, setScope] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); setView(undefined); setError(undefined);
    void memoryApi('list', scope ? { scopeId: scope } : {}, controller.signal).then(next => {
      if (!controller.signal.aborted) setView(next);
    }).catch(error => { if (!controller.signal.aborted) setError(explain(error.message)); });
    return () => controller.abort();
  }, [scope]);
  return <>
    {error && <p role="alert">{error}</p>}
    {!view ? <p>正在读取记忆范围…</p> : <>
      <label htmlFor="data-memory-scope">迁移的记忆范围</label>
      <select id="data-memory-scope" value={view.scope?.id} disabled={busy} onChange={event => setScope(event.target.value)}>
        {view.scopes?.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      <MemoryTransfer key={view.scope?.id} view={view} busy={busy} action={async (method, payload = {}) => {
        setBusy(true); setError(undefined);
        try { const next = await memoryApi(method, { ...payload as object, scopeId: view.scope?.id }); setView(next); return next; }
        catch (error) { setError(explain((error as Error).message)); return undefined; }
        finally { setBusy(false); }
      }} />
    </>}
  </>;
}
