import { useEffect, useRef, useState } from 'react';
import type { CodersView } from '../coders/manager.js';

/** Public host navigation, supplied by the DSH client when available. */
export interface CodingNavigation {
  pickDirectory(): Promise<string | null>;
  openProject(path: string): Promise<void>;
  openTask?(id: string): void;
}

export function CodingStart({ view, disabled, action, navigation, close }: {
  view: CodersView;
  disabled: boolean;
  action: (method: string, payload?: unknown) => Promise<boolean>;
  navigation?: () => CodingNavigation | undefined;
  close?: () => void;
}) {
  const [path, setPath] = useState(view.project?.path ?? '');
  const [revision, setRevision] = useState(view.settings.revision);
  const [edited, setEdited] = useState(false);
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const writing = useRef(false);
  useEffect(() => {
    if (!edited) { setPath(view.project?.path ?? ''); setRevision(view.settings.revision); }
  }, [view.project?.path, view.settings.revision, edited]);
  const change = (next: string) => {
    if (!edited) setRevision(view.settings.revision);
    setPath(next); setEdited(true); setAllow(false); setProblem(undefined);
  };
  const operate = async (run: () => Promise<void>) => {
    if (writing.current) return;
    writing.current = true; setBusy(true); setProblem(undefined);
    try { await run(); }
    catch { setProblem('目录选择或会话打开失败，请检查目录后重试。也可以从 DSH 工作区列表打开项目。'); }
    finally { writing.current = false; setBusy(false); }
  };
  const save = () => operate(async () => {
    if (await action('project/select', { path, revision, allow })) { setEdited(false); setAllow(false); }
  });
  const pick = () => operate(async () => {
    const selected = await navigation?.()?.pickDirectory();
    if (selected) change(selected);
  });
  const open = () => operate(async () => {
    const nav = navigation?.();
    if (!nav || !view.project?.allowed || view.project.problem || edited) return;
    await nav.openProject(view.project.path);
    close?.();
  });
  const coder = view[view.settings.defaultCoder];
  const coderName = view.settings.defaultCoder === 'codex' ? 'Codex' : 'Claude Code';
  const stale = edited && revision !== view.settings.revision;
  const locked = disabled || busy;
  const nav = navigation?.();
  const prepared = view.project?.allowed && !view.project.problem && coder.ready && coder.credentialState === 'configured';
  return <article className="nexus-channel-card nexus-coding-start">
    <header><h3>开始编码</h3><span className="nexus-channel-state">{prepared ? '配置已准备' : '完成以下准备'}</span></header>
    <p>选择代码项目，再检查默认编码工具。无需连接微信或飞书，可以先在本机完成任务。</p>
    <label htmlFor="nexus-known-project">从 DSH 工作区选择</label>
    <select id="nexus-known-project" value={view.workspaces?.some(item => item.path === path) ? path : ''} disabled={locked}
      onChange={event => change(event.target.value)}>
      <option value="">选择已有工作区，或在下方填写目录</option>
      {(view.workspaces ?? []).map(item => <option key={item.id} value={item.path}>{item.title} · {item.path}</option>)}
    </select>
    <label htmlFor="nexus-project-path">代码项目目录</label>
    <input id="nexus-project-path" value={path} disabled={locked} maxLength={1024}
      placeholder={view.platform === 'win32' ? 'C:\\Projects\\demo' : '/home/user/projects/demo'} onChange={event => change(event.target.value)} />
    <p className="nexus-channel-hint">填写 DSH 所在电脑上已有目录的绝对路径。项目可以保留在原位置，收件工作区和 DSH 数据目录可独立设置。</p>
    <label className="nexus-channel-manual"><input type="checkbox" checked={allow} disabled={locked} onChange={event => setAllow(event.target.checked)} />
      如不在允许范围，将所选目录及其子目录加入编码工具允许范围</label>
    <p className="nexus-channel-hint">仅对新任务生效；已有任务和续接保持原目录与权限。已选项目：{view.project?.path ?? '尚未选择'}。</p>
    {view.project?.problem && <p role="alert">已选项目目录不可用，请检查是否移动或删除。</p>}
    {view.project && !view.project.problem && !view.project.allowed && <p role="alert">已选项目不在当前允许范围内，请重新选择并保存。</p>}
    {stale && <p role="alert">配置已更新，请重新载入项目选择后再保存。<button type="button" disabled={locked} onClick={() => { setEdited(false); setAllow(false); }}>重新载入项目</button></p>}
    {problem && <p role="alert">{problem}</p>}
    <footer>
      {nav && <button type="button" disabled={locked} onClick={() => void pick()}>选择目录</button>}
      <button type="button" disabled={locked || stale || !path.trim()} onClick={() => void save()}>使用此项目</button>
    </footer>
    <ul className="nexus-readiness" aria-label="编码准备状态">
      <li>项目：{view.project?.allowed && !view.project.problem ? '已选择且位于允许范围内' : '待选择或配置'}</li>
      <li>{coderName}：{coder.active === 'none' ? '待安装，请在下方配置' : `已检测到${coder.active === 'managed' ? '托管' : '系统'}安装`}</li>
      <li>凭据：{coder.credentialState === 'configured' ? '已检测到配置，实际可用性以任务结果为准' : coder.credentialState === 'missing' ? '尚未配置，请在下方登录或填写凭据' : '尚未确认，请检查下方登录状态后重新检查'}</li>
      <li>运行配置：{coder.ready ? '检查通过' : coder.problem ?? '请先完成安装与平台配置'}</li>
    </ul>
    <p className="nexus-channel-hint">以上仅检查本机配置，没有发起模型任务。进入项目会话后，交代目标、约束和需要运行的检查；DSH 的模型配置仍由原生会话管理。</p>
    <footer>
      <button type="button" disabled={locked || stale} onClick={() => void action('refresh')}>重新检查</button>
      {nav && <button type="button" className="primary" disabled={locked || edited || !view.project?.allowed || !!view.project.problem}
        onClick={() => void open()}>打开项目会话</button>}
    </footer>
    <p className="nexus-channel-hint">需要手机跟进时，从已绑定的渠道会话发起任务。相同项目目录不会自动合并桌面与渠道会话。</p>
  </article>;
}
