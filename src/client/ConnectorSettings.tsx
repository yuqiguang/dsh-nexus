import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ConnectorsView } from '../connectors/index.js';
import { POLL_SECONDS, REMIND_MINUTES } from '../connectors/settings.js';
import { explain } from './ChannelSettings.js';

export type ConnectorApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<ConnectorsView>;

export const connectorApi: ConnectorApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-connectors/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(45_000)]) : AbortSignal.timeout(45_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as ConnectorsView;
};

interface Draft {
  revision: number; enabled: boolean; address: string; name: string; user: string; imapHost: string; imapPort: string; imapSecure: boolean;
  smtpHost: string; smtpPort: string; smtpSecure: boolean; password: string; pollSeconds: string; allowRecipients: string;
  agendaEnabled: boolean; remindMinutes: string; todoReminderTime: string;
}

const fromView = (view: ConnectorsView): Draft => {
  const { mail, agenda } = view.settings;
  return { revision: view.settings.revision, enabled: mail.enabled, address: mail.address, name: mail.name ?? '', user: mail.user ?? '', imapHost: mail.imapHost, imapPort: String(mail.imapPort),
    imapSecure: mail.imapSecure, smtpHost: mail.smtpHost, smtpPort: String(mail.smtpPort), smtpSecure: mail.smtpSecure, password: '', pollSeconds: String(mail.pollSeconds),
    allowRecipients: mail.allowRecipients.join('\n'), agendaEnabled: agenda.enabled, remindMinutes: String(agenda.remindMinutes), todoReminderTime: agenda.todoReminderTime };
};

const phases: Record<string, string> = { disabled: '未启用', connecting: '连接中', connected: '已连接', error: '连接失败' };
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });
const whenShort = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const clock = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

/** Common providers, so the user only types the address and the app password. */
const PRESETS: { id: string; label: string; imapHost: string; smtpHost: string; smtpPort: number; hint: string }[] = [
  { id: 'qq', label: 'QQ 邮箱', imapHost: 'imap.qq.com', smtpHost: 'smtp.qq.com', smtpPort: 465, hint: '在 QQ 邮箱网页版“设置 → 账号”开启 IMAP/SMTP 服务并生成授权码，密码栏填授权码。' },
  { id: '163', label: '网易 163 邮箱', imapHost: 'imap.163.com', smtpHost: 'smtp.163.com', smtpPort: 465, hint: '在 163 邮箱网页版“设置 → POP3/SMTP/IMAP”开启 IMAP 并新增授权密码，密码栏填授权密码。' },
  { id: '126', label: '网易 126 邮箱', imapHost: 'imap.126.com', smtpHost: 'smtp.126.com', smtpPort: 465, hint: '同 163 邮箱，密码栏填授权密码。' },
  { id: 'gmail', label: 'Gmail', imapHost: 'imap.gmail.com', smtpHost: 'smtp.gmail.com', smtpPort: 465, hint: '需要开启两步验证并生成“应用专用密码”，密码栏填它。' },
  { id: 'outlook', label: 'Outlook / Hotmail', imapHost: 'outlook.office365.com', smtpHost: 'smtp-mail.outlook.com', smtpPort: 587, hint: '个人账号需要应用密码；SMTP 用 587 端口 STARTTLS，下面“SMTP 直接 TLS”要关掉。' },
  { id: 'icloud', label: 'iCloud 邮箱', imapHost: 'imap.mail.me.com', smtpHost: 'smtp.mail.me.com', smtpPort: 587, hint: '在 Apple ID 里生成“App 专用密码”；SMTP 用 587 端口 STARTTLS，“SMTP 直接 TLS”要关掉。' },
];

export function ConnectorSettings({ api = connectorApi }: { api?: ConnectorApi }) {
  const [view, setView] = useState<ConnectorsView>();
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [hint, setHint] = useState<string>();
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
        if (!controller.signal.aborted && started === generation.current) { setView(next); setReadError(undefined); }
      } catch (failure) { if (!controller.signal.aborted && started === generation.current) setReadError(explain((failure as Error).message)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);
  useEffect(() => { if (view && !dirty) setDraft(fromView(view)); }, [view, dirty]);
  const action = async (method: string, payload: unknown = {}): Promise<ConnectorsView | undefined> => {
    writing.current = true; generation.current++;
    setBusy(true); setError(undefined);
    try { const next = await api(method, payload); setView(next); return next; }
    catch (failure) { setError(explain((failure as Error).message)); return undefined; }
    finally { writing.current = false; setBusy(false); }
  };
  if (!view || !draft) {
    return <section className="nexus-channel-settings" aria-label="邮箱与日程"><h2>邮箱与日程</h2>
      {readError ? <p role="alert" className="nexus-channel-error">{readError}</p> : <p role="status">正在读取邮箱与日程设置…</p>}</section>;
  }
  const stale = dirty && draft.revision !== view.settings.revision;
  const edit = (change: Partial<Draft>) => { setDirty(true); setDraft(previous => previous && { ...previous, ...change }); };
  const reload = () => { setDraft(fromView(view)); setDirty(false); };
  const config = (d: Draft) => ({ mail: { enabled: d.enabled, address: d.address, name: d.name, user: d.user, imapHost: d.imapHost, imapPort: d.imapPort, imapSecure: d.imapSecure,
    smtpHost: d.smtpHost, smtpPort: d.smtpPort, smtpSecure: d.smtpSecure, pollSeconds: d.pollSeconds, allowRecipients: d.allowRecipients, ...(d.password ? { password: d.password } : {}) },
    agenda: { enabled: d.agendaEnabled, remindMinutes: d.remindMinutes, todoReminderTime: d.todoReminderTime } });
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await action('save', { revision: draft.revision, config: config(draft) })) setDirty(false);
  };
  const applyPreset = (id: string) => {
    const preset = PRESETS.find(item => item.id === id);
    if (!preset) return;
    edit({ imapHost: preset.imapHost, imapPort: '993', imapSecure: true, smtpHost: preset.smtpHost, smtpPort: String(preset.smtpPort), smtpSecure: preset.smtpPort === 465 });
    setHint(preset.hint);
  };
  const { mail, agenda } = view;
  return <section className="nexus-channel-settings" aria-label="邮箱与日程">
    <h2>邮箱与日程</h2>
    <p>配置邮箱收发与邮件提醒，管理日历和待办。邮箱授权码保存在本机凭据中，不会回填到页面；日历和待办由助理保管，无需连接外部服务。</p>
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    <form onSubmit={event => { void submit(event); }}>
      <article className="nexus-channel-card">
        <header><h3>邮箱</h3><span className={`nexus-channel-state ${mail.phase}`}>{phases[mail.phase] ?? mail.phase}{mail.error ? `：${explain(mail.error)}` : ''}</span></header>
        {view.modules?.mail === false && <p role="status">邮箱组件当前关闭，不运行邮件工具、轮询或连接测试。已有账号配置和提醒规则保留；请在 DSH 插件详情的组件列表中启用“邮箱”。宿主提示需要重启时，请等任务结束后重启。</p>}
        {mail.phase !== 'disabled' && <p className="nexus-channel-account">
          {mail.toolsRegistered ? '邮件工具已加入模型的工具集。' : '邮件工具未加入模型的工具集。'}
          {mail.checkedAt !== undefined && ` 上次检查收件箱：${when(mail.checkedAt)}。`}{mail.mailbox && ` 收件箱 ${mail.mailbox.exists} 封${mail.mailbox.unseen !== undefined ? `，未读 ${mail.mailbox.unseen}` : ''}。`}</p>}
        <label htmlFor="mail-enabled"><input id="mail-enabled" type="checkbox" checked={draft.enabled} disabled={busy} style={{ width: 'auto', marginRight: 8 }}
          onChange={event => edit({ enabled: event.target.checked })} />启用邮箱账号（邮箱组件开启后提供邮件工具）</label>
        <label htmlFor="mail-preset">服务商</label>
        <select id="mail-preset" value="" disabled={busy} onChange={event => applyPreset(event.target.value)}>
          <option value="">选一个服务商自动填入服务器…</option>
          {PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
        {hint && <p className="nexus-channel-hint">{hint}</p>}
        <label htmlFor="mail-address">邮箱地址</label>
        <input id="mail-address" maxLength={254} value={draft.address} disabled={busy} autoComplete="off" placeholder="you@example.com"
          onChange={event => edit({ address: event.target.value })} />
        <label htmlFor="mail-password">密码（授权码或应用专用密码）</label>
        <input id="mail-password" type="password" maxLength={1024} value={draft.password} disabled={busy} autoComplete="new-password"
          placeholder={view.settings.mail.passwordConfigured ? '已保存，留空保留当前密码' : '输入授权码'}
          onChange={event => edit({ password: event.target.value })} />
        <label htmlFor="mail-name">发件人显示名（可选）</label>
        <input id="mail-name" maxLength={80} value={draft.name} disabled={busy} autoComplete="off" onChange={event => edit({ name: event.target.value })} />
        <label htmlFor="mail-user">登录名（可选，留空用邮箱地址）</label>
        <input id="mail-user" maxLength={254} value={draft.user} disabled={busy} autoComplete="off" onChange={event => edit({ user: event.target.value })} />
        <label htmlFor="mail-imap-host">IMAP 服务器</label>
        <input id="mail-imap-host" maxLength={253} value={draft.imapHost} disabled={busy} autoComplete="off" placeholder="imap.example.com" onChange={event => edit({ imapHost: event.target.value })} />
        <label htmlFor="mail-imap-port">IMAP 端口</label>
        <input id="mail-imap-port" maxLength={5} value={draft.imapPort} disabled={busy} autoComplete="off" onChange={event => edit({ imapPort: event.target.value })} />
        <label htmlFor="mail-imap-secure"><input id="mail-imap-secure" type="checkbox" checked={draft.imapSecure} disabled={busy} style={{ width: 'auto', marginRight: 8 }}
          onChange={event => edit({ imapSecure: event.target.checked })} />IMAP 直接 TLS（993 端口勾选；143 端口不勾，用 STARTTLS）</label>
        <label htmlFor="mail-smtp-host">SMTP 服务器</label>
        <input id="mail-smtp-host" maxLength={253} value={draft.smtpHost} disabled={busy} autoComplete="off" placeholder="smtp.example.com" onChange={event => edit({ smtpHost: event.target.value })} />
        <label htmlFor="mail-smtp-port">SMTP 端口</label>
        <input id="mail-smtp-port" maxLength={5} value={draft.smtpPort} disabled={busy} autoComplete="off" onChange={event => edit({ smtpPort: event.target.value })} />
        <label htmlFor="mail-smtp-secure"><input id="mail-smtp-secure" type="checkbox" checked={draft.smtpSecure} disabled={busy} style={{ width: 'auto', marginRight: 8 }}
          onChange={event => edit({ smtpSecure: event.target.checked })} />SMTP 直接 TLS（465 端口勾选；587 端口不勾，用 STARTTLS）</label>
        <label htmlFor="mail-poll">收件箱检查间隔（秒，{POLL_SECONDS.min} 到 {POLL_SECONDS.max}）</label>
        <input id="mail-poll" maxLength={4} value={draft.pollSeconds} disabled={busy} autoComplete="off" onChange={event => edit({ pollSeconds: event.target.value })} />
        <label htmlFor="mail-allow">发送时不再确认的收件人（每行一个完整地址，或 @域名）</label>
        <textarea id="mail-allow" rows={3} value={draft.allowRecipients} disabled={busy} placeholder={'zhang@example.com\n@mycompany.com'}
          onChange={event => edit({ allowRecipients: event.target.value })} />
        <p className="nexus-channel-hint">发给名单之外的人时，助理会在聊天里向你确认；在聊天里说“以后发给某某不用问”也会加到这里。</p>
        {view.mailTest && <p className="nexus-channel-account">测试连接成功（{when(view.mailTest.at)}）：收件箱 {view.mailTest.exists} 封{view.mailTest.unseen !== undefined ? `，未读 ${view.mailTest.unseen}` : ''}。</p>}
        <footer>
          <button type="button" disabled={busy || stale || view.modules?.mail === false} onClick={() => void action('mail/test', { revision: view.settings.revision, config: config(draft) })}>测试连接</button>
          {view.settings.mail.passwordConfigured && <button type="button" disabled={busy || stale} onClick={() => void action('clear-secret', { revision: view.settings.revision })}>清除密码并停用</button>}
        </footer>
      </article>
      <article className="nexus-channel-card">
        <header><h3>日历与待办</h3><span className={`nexus-channel-state ${agenda.toolsRegistered ? 'connected' : 'disabled'}`}>{agenda.toolsRegistered ? '已启用' : '未启用'}</span></header>
        {view.modules?.agenda === false && <p role="status">日历模块当前关闭，停止工具、自动提醒与简报中的日程。已有数据保留，仍可管理；请在“Nexus 扩展”启用并重启后使用。</p>}
        <p>由助理自己保管，不接外部服务，不需要授权。在聊天里说“明天下午三点和张老师开会”“记个待办周五前交报告”“今天有什么安排”即可；日程开始前和待办到期时会主动提醒，每日简报里也会列出。</p>
        {agenda.toolsRegistered && <p className="nexus-channel-account">日程 {agenda.events} 条，未完成待办 {agenda.openTodos} 条。
          {agenda.nextReminderAt !== undefined && ` 下一次提醒：${when(agenda.nextReminderAt)}。`}{agenda.lastReminderAt !== undefined && ` 上次提醒：${when(agenda.lastReminderAt)}。`}</p>}
        <label htmlFor="agenda-enabled"><input id="agenda-enabled" type="checkbox" checked={draft.agendaEnabled} disabled={busy} style={{ width: 'auto', marginRight: 8 }}
          onChange={event => edit({ agendaEnabled: event.target.checked })} />启用日历与待办服务（日历模块开启后提供工具和提醒）</label>
        <label htmlFor="agenda-remind">日程开始前几分钟提醒（{REMIND_MINUTES.min} 到 {REMIND_MINUTES.max}，0 表示不提醒）</label>
        <input id="agenda-remind" maxLength={4} value={draft.remindMinutes} disabled={busy} autoComplete="off" onChange={event => edit({ remindMinutes: event.target.value })} />
        <label htmlFor="agenda-todo-time">只写了日期的待办，当天几点提醒（HH:MM）</label>
        <input id="agenda-todo-time" maxLength={5} value={draft.todoReminderTime} disabled={busy} autoComplete="off" placeholder="09:00" onChange={event => edit({ todoReminderTime: event.target.value })} />
      </article>
      {stale && <p role="alert">{explain('configuration_changed')} <button type="button" onClick={reload}>重新载入</button></p>}
      <footer className="nexus-channel-card" style={{ borderStyle: 'none', paddingTop: 0 }}>
        <button type="submit" className="primary" disabled={busy || stale}>保存设置</button>
        {dirty && <button type="button" disabled={busy} onClick={reload}>放弃修改</button>}
      </footer>
    </form>
    <article className="nexus-channel-card">
      <header><h3>邮件提醒</h3></header>
      <p>在聊天里说“有房东的邮件时提醒我”，助理会记下关键词；新邮件命中时它会主动告诉你。</p>
      {mail.watches.length === 0 && <p className="nexus-channel-hint">还没有邮件提醒。</p>}
      {mail.watches.map(watch => <p key={watch.id} className="nexus-channel-account">{watch.id} {watch.description}（关键词：{watch.keywords.join('、')}）{' '}
        <button type="button" disabled={busy} onClick={() => void action('mail/watch/remove', { id: watch.id })}>删除</button></p>)}
    </article>
    <article className="nexus-channel-card">
      <header><h3>未来 7 天的日程</h3></header>
      {agenda.upcoming.length === 0 && <p className="nexus-channel-hint">没有日程。</p>}
      {agenda.upcoming.map(item => <p key={`${item.id}-${item.start}`} className="nexus-channel-account">{whenShort(item.start)}{item.end > item.start ? `–${clock(item.end)}` : ''} {item.title}{item.location ? ` @ ${item.location}` : ''}{item.repeat ? `（${({ daily: '每天', weekly: '每周', monthly: '每月' } as const)[item.repeat]}）` : ''}{' '}
        <button type="button" disabled={busy} onClick={() => void action('agenda/event/remove', { id: item.id })}>删除</button></p>)}
    </article>
    <article className="nexus-channel-card">
      <header><h3>待办</h3></header>
      {agenda.todos.length === 0 && <p className="nexus-channel-hint">没有待办。</p>}
      {agenda.todos.map(todo => <p key={todo.id} className="nexus-channel-account" style={todo.doneAt ? { textDecoration: 'line-through' } : undefined}>{todo.title}
        {todo.due !== undefined && `（${todo.dueAllDay ? whenShort(todo.due).replace(/ .*$/, '') + ' 前' : whenShort(todo.due) + ' 前'}）`}{' '}
        <button type="button" disabled={busy} onClick={() => void action('agenda/todo/done', { id: todo.id, done: !todo.doneAt })}>{todo.doneAt ? '撤销完成' : '完成'}</button>{' '}
        <button type="button" disabled={busy} onClick={() => void action('agenda/todo/remove', { id: todo.id })}>删除</button></p>)}
    </article>
  </section>;
}
