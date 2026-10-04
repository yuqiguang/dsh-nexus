import { useEffect, useState } from 'react';
import type { UpdatesView } from '../updates/manager.js';

export type UpdatesApi = (method: string, payload?: unknown) => Promise<UpdatesView>;
const messages: Record<string, string> = {
  update_network: '无法连接 GitHub，请稍后重试。', update_rate_limited: 'GitHub 暂时限制了检查频率，请稍后重试。',
  update_release_missing: '尚未找到该版本的发布包。', update_release_invalid: '发布信息不完整，未进行安装。',
  update_package_invalid: '安装包内容或版本信息不符合要求。', update_checksum_invalid: '安装包校验值不符，已停止更新。',
  update_package_too_large: '安装包超过允许大小，已停止更新。', update_package_missing: '缓存安装包已不存在，请重新检查。',
  update_incompatible: '新版本要求的 DSH 版本与当前不同，请先确认 DSH 升级要求。',
  update_rollback_unavailable: '无法取得与当前运行版本一致的回退包，未修改插件。',
  update_installed_changed: '安装版本已被其他操作修改，请重启 DSH 后重新检查。',
  update_candidate_changed: '可安装版本已变化，请重新检查更新。', update_restart_required: '更新已安装，请先重启 DSH。',
  update_build_approval: '依赖需要新的安装脚本审批，请在 DSH 官方插件安装流程中处理。',
  update_install_failed: '新版本安装失败。', update_rollback_failed: '自动回退未完成，请从对应版本 Release 下载旧包，通过 DSH 插件页恢复。',
  update_interrupted: '上次更新被中断，请核对安装版本后重试或回退。', update_cancelled: '本次更新已取消。',
  update_tasks_running: '还有任务、安装或数据恢复正在进行，请等待完成。', update_busy: '已有更新操作正在进行。',
  update_unavailable: '当前安装方式不支持桌面自动更新。', update_failed: '更新操作未完成，请重试。',
  configuration_changed: '设置已在其他窗口修改，请刷新后重试。', invalid_configuration: '更新设置无效。',
  session_expired: '登录已过期，请刷新页面。', connection_failed: '无法连接 Nexus 服务。',
};
const explain = (code?: string) => messages[code ?? ''] ?? '操作未完成，请重试。';
export const updatesApi: UpdatesApi = async (method, payload = {}) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-updates/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(response.status === 401 ? 'session_expired' : 'connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId || !message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value;
};
const phases: Record<UpdatesView['phase'], string> = {
  idle: '当前版本无需更新。', checking: '正在检查发布版本与安装包…', available: '发现新版本。',
  waiting: '更新已排队，等待条件满足后继续。',
  preparing: '正在校验安装包并准备回退包…', installing: '正在通过 DSH 安装新版…', 'rolling-back': '安装未完成，正在恢复旧版…',
  'restart-required': '新版已安装，当前仍运行旧版。请从托盘菜单完全退出并重新打开 DSH 后生效。', failed: '本次更新未完成。',
};
const compactPhases: Record<UpdatesView['phase'], string> = {
  idle: '已是最新', checking: '检查中', available: '有新版本', waiting: '等待更新',
  preparing: '准备更新', installing: '安装中', 'rolling-back': '回退中',
  'restart-required': '已安装，待重启', failed: '更新未完成',
};
export function UpdateSettings({ api = updatesApi }: { api?: UpdatesApi }) {
  const [view, setView] = useState<UpdatesView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const result = await api('status'); if (active) { setView(result); setError(undefined); } }
      catch (error) { if (active) setError(explain((error as Error).message)); }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { active = false; clearInterval(timer); };
  }, [api]);
  const action = async (method: string, payload?: unknown) => {
    if (busy) return; setBusy(true); setError(undefined);
    try { setView(await api(method, payload)); } catch (error) { setError(explain((error as Error).message)); } finally { setBusy(false); }
  };
  const working = view && ['checking', 'preparing', 'installing', 'rolling-back'].includes(view.phase);
  const summary = !view ? '读取状态中' : !view.supported ? '由源码服务管理'
    : view.phase === 'idle' && !view.lastCheckAt ? '尚未检查' : compactPhases[view.phase];
  const alert = error ?? (view?.error ? explain(view.error) : undefined);
  return <section className="nexus-channel-settings nexus-update-settings" aria-label="Nexus 更新">
    <details className="nexus-update-details">
      <summary>
        <span className="nexus-update-title">Nexus 更新</span>
        <span className="nexus-update-summary" role="status">{view ? `v${view.currentVersion} · ` : ''}{summary}</span>
      </summary>
      <div className="nexus-update-body">
        {!view ? <p>正在读取更新状态…</p> : <>
          <p>正在运行：{view.currentVersion} · DSH {view.dshVersion || '未识别'}{view.installedVersion && view.installedVersion !== view.currentVersion ? ` · 已安装：${view.installedVersion}` : ''}</p>
          {!view.supported ? <p>当前仅 Windows 桌面安装支持此更新功能。源码 Web 由源码服务的更新器管理。</p> : <>
            <article className="nexus-channel-card">
              <label><input type="checkbox" style={{ width: 'auto' }} checked={view.autoCheck} disabled={busy}
                onChange={event => void action('save', { revision: view.revision, autoCheck: event.target.checked, autoInstall: event.target.checked && view.autoInstall })} /> 自动检查更新</label>
              <p className="nexus-channel-hint">运行期间每六小时检查一次，默认开启；会从 GitHub 获取发布信息，并下载新包进行校验。</p>
              <label><input type="checkbox" style={{ width: 'auto' }} checked={view.autoInstall} disabled={busy || !view.autoCheck}
                onChange={event => void action('save', { revision: view.revision, autoCheck: view.autoCheck, autoInstall: event.target.checked })} /> 空闲时自动安装（重启后生效）</label>
              <p className="nexus-channel-hint">默认关闭。开启后会保留当前版本的回退包，通过 DSH 安装新版本；安装失败时尝试恢复旧版。保留会话、配置与组件开关，不自动批准新的依赖脚本，不强制结束任务或重启桌面端。</p>
              <p role="status">{view.lastCheckAt || working || view.phase !== 'idle' ? phases[view.phase] : '尚未检查更新。'}</p>
              {view.phase === 'waiting' && view.waitReason && <p role="status">等待原因：{view.waitReason}</p>}
              {view.latest && <p>发布版本：{view.latest.version} · 要求 DSH {view.latest.dshVersion} · <a href={view.latest.releaseUrl} target="_blank" rel="noreferrer">查看版本说明</a></p>}
              {view.lastCheckAt && <p>上次检查：{new Date(view.lastCheckAt).toLocaleString('zh-CN')}</p>}
              {view.outcome === 'updated' && <p>上次更新已在本次启动中生效。</p>}
              {view.outcome === 'rolled-back' && <p>已恢复旧版本的安装文件。</p>}
              <div className="nexus-channel-actions">
                <button disabled={busy || working || view.phase === 'restart-required'} onClick={() => void action('check')}>检查更新</button>
                {view.latest?.compatible && view.phase !== 'restart-required' && <button disabled={busy || working || (view.phase === 'waiting' && view.installMode !== 'automatic')}
                  onClick={() => void action('install', { version: view.latest!.version })}>{view.phase === 'waiting' && view.installMode !== 'automatic' ? '等待更新' : '立即更新'}</button>}
                {['waiting', 'preparing', 'installing'].includes(view.phase) && <button disabled={busy} onClick={() => void action('cancel')}>取消本次更新</button>}
                {view.rollbackVersion && <button disabled={busy || working} onClick={() => void action('rollback', { version: view.rollbackVersion })}>回退到 {view.rollbackVersion}</button>}
              </div>
              {view.latest?.compatible && view.phase !== 'restart-required' && <p className="nexus-channel-hint">手动更新会立即尝试安装；有任务、待投递消息或数据恢复时会排队，并显示等待原因。安装完成后需退出并重启 DSH 生效。</p>}
            </article>
          </>}
        </>}
      </div>
    </details>
    {alert && <p role="alert">{alert}</p>}
  </section>;
}
