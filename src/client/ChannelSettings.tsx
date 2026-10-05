import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelsView, ConnectionView, QrView, FeishuPairingView } from '../channels/types.js';

export type ChannelApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<ChannelsView>;
const titles = { wechat: '微信', feishu: '飞书', wecom: '企业微信' };
const phases = { disconnected: '未连接', connecting: '连接中', connected: '已连接', reconnecting: '重连中', error: '连接失败' };
export const errors: Record<string, string> = {
  memory_limit: '超出记忆容量或长度限制，请精简或先删除旧条目。',
  memory_import_invalid: '记忆文件格式不正确或超过 2 MiB，请选择 Nexus 导出的记忆 JSON。',
  memory_import_changed: '目标记忆或导入选项已变化，请重新预览后确认。',
  memory_export_too_large: '所选记忆超过 2 MiB，请分开导出画像、事件和待确认，或先整理内容。',
  memory_import_failed: '导入未能全部保存，可能已有部分生效。请重新预览后重试，重复记录会跳过。',
  not_found: '条目已不存在，页面已刷新。',
  missing_credentials: '请填写账号和密钥，并先完成用户绑定。',
  missing_application_credentials: '请填写飞书 App ID 和 App Secret。',
  feishu_pairing_not_ready: '配对尚未完成或已过期，请重新生成配对码。',
  invalid_configuration: '请检查配置内容。',
  invalid_remind_minutes: '提前提醒的分钟数要在 0 到 1440 之间。',
  invalid_feishu_app_id: 'App ID 应为 cli_ 开头的飞书应用 ID。',
  configuration_changed: '配置已在其他窗口修改，请重新载入后再保存。',
  module_disabled: '此组件已关闭或运行状态已变更，请在 DSH 插件详情的组件列表中确认启用状态后重新发起操作。',
  memory_scope_unavailable: '此记忆范围不可用。请重新载入；模型记忆需要有有效工作目录的原生主会话。',
  memory_legacy_readonly: '旧版未归类记忆不再自动读写，请明确选择目标范围逐条复制，或导出、删除。',
  memory_profile_exists: '目标范围已有同名画像，请先查看和整理目标内容；本次没有覆盖。',
  connection_failed: '连接失败，请检查凭据、应用权限和网络后重试。',
  connection_timeout: '连接超时，请检查网络后重试。',
  authentication_failed: '凭据已失效，请更新密钥或重新扫码。',
  wechat_poller_conflict: '微信拒绝了轮询（403）：这个账号很可能同时被另一个程序（另一套桥接、OpenClaw 等）接收消息，微信只允许一个接收方。停掉那个程序后点“重新连接”；确认没有别的程序时再重新扫码。已停止轮询，凭据保留。',
  rate_limited: '微信请求过于频繁，请稍后重试。',
  server_unavailable: '微信服务暂时不可用，请稍后重试。',
  wechat_request_failed: '微信拒绝了请求，当前记录不能确定具体原因；请查看接口诊断，勿反复重试。',
  wechat_send_rejected: '微信未接受本轮发送，已暂停自动发送。请用原绑定微信账号发一条新消息，收到后会继续尝试未送达部分。若仍失败，请查看接口诊断。',
  invalid_delivery_state: '本机的渠道投递记录无法读取，请在本机检查数据版本。',
  delivery_storage_failed: '投递进度无法保存，已暂停发送，请检查本机数据存储后重试。',
  delivery_uncertain: '无法确认平台是否已接收上一分片，已暂停自动发送。请先查看聊天记录；手动重试可能重复上一分片。',
  delivery_rejected: '平台明确拒绝了发送请求，请检查应用权限或发送限制；达到重试上限后可手动重试。',
  delivery_file_unavailable: '待发文件已变化、不存在或不在原工作区，已暂停发送。请在本机会话重新交付正确文件。',
  delivery_queue_full: '待发回复已达到上限，请先重试发送；本次结果仍可在本机查看。',
  wechat_context_stale: '微信的回复上下文已超过 19 小时，待发消息会在你下次发消息给助理后送达。',
  wechat_upload_failed: '文件上传到微信失败，稍后会自动重试；也可以点“重试发送”。',
  wechat_download_failed: '从微信下载附件失败，请让用户重发。',
  wechat_media_too_large: '附件超过 20 MB 的接收上限。',
  wechat_media_key_invalid: '微信附件的密钥格式无法识别，请检查 DSH 和插件版本。',
  wechat_media_decrypt_failed: '微信附件解密失败，可能已损坏，请让用户重发。',
  not_connected: '请先连接渠道，再重试发送。',
  configuration_failed: '本机配置未能保存，请检查数据目录后重试。',
  wechat_verification_required: '微信要求额外的手机验证码，当前扫码入口尚不支持此验证方式。',
  invalid_qr_response: '微信没有返回完整的授权信息，请重新扫码。',
  invalid_wechat_server: '微信返回了无法识别的服务地址，请稍后重试。',
  invalid_workspace: '工作区目录要写绝对路径，例如 /home/you/nexus-微信。',
  session_expired: '页面登录已失效，请刷新后重新进入设置。',
  invalid_endpoint: '端点地址应是 http(s) 开头的完整 URL，不带查询参数。',
  invalid_root: '工作目录必须是绝对路径，每行一个。',
  project_directory_unavailable: '项目目录不可用，请填写 DSH 所在电脑上已有目录的绝对路径，并检查读取权限。',
  project_permission_required: '该项目不在允许范围内。确认目录后，勾选加入编码工具允许范围，再保存。',
  invalid_revision: '页面状态已过期，请重新载入。',
  invalid_address: '邮箱地址格式不对。',
  invalid_host: '服务器地址只能包含字母、数字、点和连字符。',
  invalid_port: '端口应是 1 到 65535 之间的整数。',
  invalid_poll_interval: '检查间隔应在 30 到 3600 秒之间。',
  invalid_recipient_rule: '免确认的收件人要写完整地址或 @域名，每行一个。',
  missing_mail_settings: '启用邮箱前请填写地址、IMAP 和 SMTP 服务器以及密码。',
  mail_auth_failed: '邮箱拒绝了登录：请检查地址、登录名和授权码，并确认已在邮箱设置里开启 IMAP/SMTP。',
  mail_host_unknown: '找不到邮件服务器，请检查服务器地址。',
  mail_connection_failed: '连不上邮件服务器，请检查端口、TLS 选项和网络。',
  mail_tls_failed: '邮件服务器的证书校验失败，请检查服务器地址和 TLS 选项。',
  mail_request_failed: '邮件服务器返回了错误，稍后再试。',
  invalid_managed_version: '请输入完整版本号，例如 0.155.1；不支持 latest、版本范围或下载地址。',
  install_tasks_active: '编码任务或沙箱配置正在进行，请结束后再安装托管版本。',
  install_in_progress: '已有安装在进行，请等它结束。',
  rule_not_found: '这条规则已不存在，请重新载入。',
  unknown_action: '不支持的操作。',
  invalid_saved_record: '本机保存的设置无法读取，请检查数据版本。',
  invalid_time_zone: '时区应是 IANA 名称，例如 Asia/Shanghai。',
  invalid_clock_time: '时间应写成 HH:MM，例如 08:00。',
  invalid_quiet_hours: '安静时段需要同时填写开始和结束，且两者不能相同。',
  invalid_persona: '助理名字必填且不超过 20 字，称呼不超过 20 字。',
  invalid_speech_url: '转写服务地址应是 http(s) 开头的完整 URL，不带查询参数。',
  invalid_speech_model: '填写了转写服务地址就要填模型名。',
};
export function explain(code?: string) { return errors[code ?? ''] ?? '操作未完成，请重试。'; }

export const channelApi: ChannelApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-channels/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as ChannelsView;
};

type Action = (method: string, payload?: unknown) => Promise<boolean>;
function Status({ connection }: { connection: ConnectionView }) {
  const label = connection.phase === 'connected' && connection.deliveryError
    ? connection.waitingForReply ? '等待微信回复' : '发送异常' : phases[connection.phase];
  return <span className={`nexus-channel-state ${connection.phase}`}>{label}</span>;
}

function WorkspaceField({ connection, action, busy }: { connection: ConnectionView; action: Action; busy: boolean }) {
  const saved = connection.workspaceRoot ?? '';
  const [draft, setDraft] = useState(saved);
  const [loaded, setLoaded] = useState(connection.revision);
  const dirty = draft !== saved;
  const stale = dirty && loaded !== connection.revision;
  const reload = () => { setDraft(saved); setLoaded(connection.revision); };
  useEffect(() => { if (!dirty) reload(); }, [connection.revision, saved, dirty]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await action('save-workspace', { channel: connection.channel, revision: loaded, workspaceRoot: draft.trim() })) setLoaded(connection.revision);
  };
  return <form className="nexus-channel-workspace" onSubmit={event => { void submit(event); }}>
    <label htmlFor={`${connection.channel}-workspace`}>工作区目录</label>
    <input id={`${connection.channel}-workspace`} value={draft} maxLength={1024} autoComplete="off" spellCheck={false} disabled={busy}
      placeholder="/home/you/nexus-wechat" onChange={event => setDraft(event.target.value)} />
    <p className="nexus-channel-hint">这个渠道的会话在这个目录里读写文件：收到的附件放在 inbox/，要交付的文件从 outputs/ 里取。写绝对路径，目录不存在会自动创建；留空则用服务默认的工作区。改动对新开的会话生效，已经开着的会话仍在原目录继续。</p>
    {stale && <p role="alert">{errors.configuration_changed} <button type="button" onClick={reload}>重新载入</button></p>}
    <footer><button type="submit" disabled={busy || stale || !dirty}>保存工作区</button></footer>
  </form>;
}

function CredentialCard({ connection, action, busy, pairing }: { connection: ConnectionView; action: Action; busy: boolean; pairing?: FeishuPairingView }) {
  const feishu = connection.channel === 'feishu';
  const [manual, setManual] = useState(false);
  const [copyNote, setCopyNote] = useState('');
  useEffect(() => setCopyNote(''), [pairing?.id]);
  const pairingActive = pairing && ['connecting', 'waiting', 'confirm'].includes(pairing.phase);
  const [draft, setDraft] = useState({ accountId: connection.accountId, ownerId: connection.ownerId, secret: '', revision: connection.revision });
  const [dirty, setDirty] = useState(false);
  const stale = dirty && draft.revision !== connection.revision;
  const reload = () => { setDraft({ accountId: connection.accountId, ownerId: connection.ownerId, secret: '', revision: connection.revision }); setDirty(false); };
  useEffect(() => { if (!dirty) reload(); }, [connection.revision, dirty]);
  const change = (key: 'accountId' | 'ownerId' | 'secret', value: string) => { setDirty(true); setDraft(previous => ({ ...previous, [key]: value, ...(feishu && key === 'accountId' && !manual ? { ownerId: value === connection.accountId ? connection.ownerId : '' } : {}) })); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const connect = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement)?.value === 'connect';
    const config = { accountId: draft.accountId, ownerId: draft.ownerId, ...(draft.secret ? { secret: draft.secret } : {}) };
    if (feishu && connect && !manual && !draft.ownerId) {
      if (await action('feishu/pair/start', { revision: draft.revision, config })) setDirty(false);
    } else if (await action('save', { channel: connection.channel, revision: draft.revision, connect, config })) setDirty(false);
  };
  const pair = async () => {
    if (await action('feishu/pair/start', { revision: draft.revision,
      config: { accountId: draft.accountId, ...(draft.secret ? { secret: draft.secret } : {}) } })) setDirty(false);
  };
  return <article className="nexus-channel-card">
    <header><h3>{titles[connection.channel]}</h3>{pairingActive ? <span className="nexus-channel-state connecting">等待配对</span> : <Status connection={connection} />}</header>
    <p>{feishu ? '填写应用信息后，通过飞书私聊配对码绑定自己，无需查询用户 ID。' : '智能机器人，使用长连接模式。'}</p>
    <form onSubmit={event => { void submit(event); }}>
      <label htmlFor={`${connection.channel}-account`}>{feishu ? 'App ID' : 'Bot ID'}</label>
      <input id={`${connection.channel}-account`} required maxLength={256} value={draft.accountId} autoComplete="off"
        placeholder={feishu ? 'cli_…' : '机器人 ID'} disabled={busy} onChange={event => change('accountId', event.target.value)} />
      <label htmlFor={`${connection.channel}-secret`}>{feishu ? 'App Secret' : 'Secret'}</label>
      <input id={`${connection.channel}-secret`} type="password" required={!connection.secretConfigured || (feishu && draft.accountId !== connection.accountId)} maxLength={4096}
        value={draft.secret} autoComplete="new-password" disabled={busy}
        placeholder={connection.secretConfigured && (!feishu || draft.accountId === connection.accountId) ? '已保存，留空保留当前密钥' : '输入应用密钥'} onChange={event => change('secret', event.target.value)} />
      {feishu && <>
        {connection.ownerId && <div>已绑定飞书用户。<details><summary>查看绑定 ID</summary><code>{connection.ownerId}</code></details></div>}
        <label className="nexus-channel-manual"><input type="checkbox" checked={manual} disabled={busy || !!pairingActive} onChange={event => { setManual(event.target.checked); if (!event.target.checked) change('ownerId', draft.accountId === connection.accountId ? connection.ownerId : ''); }} />手动填写 open_id（高级）</label>
      </>}
      {(!feishu || manual) && <>
        <label htmlFor={`${connection.channel}-owner`}>{feishu ? '允许使用的用户 open_id' : '允许使用的用户 userid'}</label>
        <input id={`${connection.channel}-owner`} required maxLength={256} value={draft.ownerId} autoComplete="off"
          placeholder={feishu ? 'ou_…' : '企业微信用户 ID'} disabled={busy} onChange={event => change('ownerId', event.target.value)} />
      </>}
      <p className="nexus-channel-hint">仅响应这个用户的私聊消息。密钥保存在本机，不会回填到页面。</p>
      {stale && <p role="alert">{errors.configuration_changed} <button type="button" onClick={reload}>重新载入</button></p>}
      {connection.error && <p role="alert">{explain(connection.error)}</p>}
      <footer>
        <button type="submit" value="connect" className="primary" disabled={busy || stale || !!pairingActive}>{feishu && !manual && !draft.ownerId ? '保存并配对' : '保存并连接'}</button>
        <button type="submit" value="save" disabled={busy || stale || !!pairingActive}>仅保存</button>
        {feishu && connection.ownerId && !manual && <button type="button" disabled={busy || stale || !!pairingActive} onClick={() => void pair()}>重新配对用户</button>}
        {connection.configured && !pairingActive && <button type="button" disabled={busy || (dirty && !connection.enabled)}
          onClick={() => void action(connection.enabled ? 'disconnect' : 'connect', { channel: connection.channel, revision: connection.revision })}>
          {connection.enabled ? '断开' : '连接'}</button>}
      </footer>
    </form>
    {feishu && pairing && <div className="nexus-channel-pairing">
      {pairing.phase === 'connecting' && <p role="status">正在连接飞书机器人，连接成功后显示配对码…</p>}
      {pairing.phase === 'waiting' && <>
        <p>在飞书中找到这个应用机器人，私聊发送下方完整配对码，然后回到此页面确认：</p>
        <input aria-label="飞书配对码" value={pairing.code ?? ''} readOnly spellCheck={false} onFocus={event => event.currentTarget.select()} />
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(pairing.code ?? '').then(() => setCopyNote('已复制'), () => setCopyNote('请选中配对码后复制')); if (!navigator.clipboard) setCopyNote('请选中配对码后复制'); }}>复制配对码</button>
        {copyNote && <span role="status">{copyNote}</span>}
        <p className="nexus-channel-hint">有效期 10 分钟，请使用要绑定的飞书账号发送。配对期间不会执行任务或回复审批。</p>
      </>}
      {pairing.phase === 'confirm' && <>
        <p role="status">已收到正确配对码。如果刚才是你发送的，请确认绑定。</p>
        <details><summary>查看待绑定 ID</summary><code>{pairing.candidateOpenId}</code></details>
        <button type="button" className="primary" disabled={busy || dirty} onClick={() => void action('feishu/pair/confirm', { id: pairing.id, revision: pairing.revision })}>确认绑定并连接</button>
        {dirty && <p>请先取消配对，再保存修改后的应用信息。</p>}
      </>}
      {pairing.phase === 'expired' && <p role="alert">配对码已过期，请重新生成。</p>}
      {pairing.phase === 'error' && <p role="alert">{explain(pairing.error)}</p>}
      {pairingActive
        ? <button type="button" disabled={busy} onClick={() => void action('feishu/pair/cancel', { id: pairing.id, revision: pairing.revision })}>取消配对</button>
        : <button type="button" disabled={busy || stale} onClick={() => void pair()}>重新生成配对码</button>}
    </div>}
    {feishu && <p className="nexus-channel-hint">应用需启用机器人，使用长连接接收事件，并订阅 im.message.receive_v1（接收消息）；确保应用已发布或在测试范围内，且你有权使用。</p>}
    {(connection.pendingDeliveries !== undefined || connection.deliveryError) && <div className="nexus-channel-delivery">
      <p>消息投递恢复：待发 {connection.pendingDeliveries ?? 0} 条。仅补发已生成内容，不重跑任务或补发审批提示。</p>
      {connection.deliveryError && <p role="alert">{explain(connection.deliveryError)}</p>}
      {!!connection.pendingDeliveries && <button type="button" disabled={busy || !!pairingActive || !connection.enabled || connection.phase !== 'connected'}
        onClick={() => void action('retry-delivery', { channel: connection.channel, revision: connection.revision })}>
        {connection.deliveryError === 'delivery_uncertain' ? '重试发送（可能重复上一分片）' : '重试发送'}
      </button>}
    </div>}
    <WorkspaceField connection={connection} action={action} busy={busy || !!pairingActive} />
  </article>;
}

function WechatCard({ connection, qr, action, busy }: { connection: ConnectionView; qr?: QrView; action: Action; busy: boolean }) {
  const waiting = qr?.phase === 'waiting' || qr?.phase === 'scanned';
  return <article className="nexus-channel-card">
    <header><h3>微信</h3><Status connection={connection} /></header>
    <p>使用微信扫码授权，扫码账号将成为唯一允许使用的用户。</p>
    {connection.ownerId && <p className="nexus-channel-account">已绑定：{connection.ownerId}</p>}
    {waiting && <div className="nexus-channel-qr">
      {qr?.image ? <img src={qr.image} alt="微信连接二维码" width={240} height={240} /> : <p role="status">正在获取二维码…</p>}
      <p role="status">{qr?.phase === 'scanned' ? '已扫码，请在微信中确认。' : '请用微信扫码，二维码 5 分钟内有效。'}</p>
    </div>}
    {qr?.phase === 'expired' && <p role="alert">二维码已过期，请重新获取。</p>}
    {(qr?.error || connection.error) && <p role="alert">{explain(qr?.error ?? connection.error)}</p>}
    {!!connection.pendingDeliveries && <section aria-label="消息投递恢复">
      <p role="status">有 {connection.pendingDeliveries} 条回复待发送。消息尚未送达不代表编码任务失败，请在 DSH 的所属会话中查看任务结果。</p>
      <p className="nexus-channel-hint">重试发送只补发已保存的未发送部分，不会重新执行任务，也不会重放审批提示。恢复连接或重启后也按此规则处理。</p>
      <p>{connection.error === 'authentication_failed' ? '请用原绑定账号重新扫码；其他账号不能接收这些回复。'
        : !connection.enabled ? '请先连接原绑定账号，再查看待发状态。'
        : connection.phase === 'error' ? '请先处理连接错误并重新连接，再查看待发状态。'
        : connection.phase !== 'connected' ? '正在等待连接通过认证，恢复连接后再查看待发状态。'
        : connection.waitingForReply || connection.deliveryError === 'wechat_context_stale' ? '收消息连接已认证，发送已暂停。请用原绑定微信账号发送一条新消息后再尝试。电脑端可以继续审批；旧审批提示不会补发。'
        : connection.deliveryError ? '收消息连接已认证，但仍有消息发送失败。请先查看下方原因。'
        : '收消息连接已认证，待发结果尚未全部送达，可点击“重试发送”重新尝试补发。'}</p>
    </section>}
    {connection.deliveryError && <p role="alert">{explain(connection.deliveryError)}</p>}
    {connection.deliveryDiagnostic && <p className="nexus-channel-hint">接口诊断：HTTP {connection.deliveryDiagnostic.httpStatus}
      {connection.deliveryDiagnostic.ret !== undefined ? `，ret=${connection.deliveryDiagnostic.ret}` : ''}
      {connection.deliveryDiagnostic.errcode !== undefined ? `，errcode=${connection.deliveryDiagnostic.errcode}` : ''}。连接认证成功不代表消息发送成功。</p>}
    <p className="nexus-channel-hint">支持文字、图片、文件、审批和提问回复。请用一个专门给助理的微信号扫码：同一个号只能有一个程序接收消息，别的桥接同时在线会互相抢消息。</p>
    <footer>
      <button className="primary" disabled={busy || waiting} onClick={() => void action('qr/start', { revision: connection.revision })}>
        {connection.configured ? '重新扫码' : '扫码连接'}</button>
      {waiting && <button disabled={busy} onClick={() => void action('qr/cancel')}>取消扫码</button>}
      {connection.configured && connection.enabled && connection.phase === 'error' &&
        <button disabled={busy || waiting} onClick={() => void action('connect', { channel: 'wechat', revision: connection.revision })}>重新连接</button>}
      {connection.configured && <button disabled={busy} onClick={() => void action(connection.enabled ? 'disconnect' : 'connect', { channel: 'wechat', revision: connection.revision })}>
        {connection.enabled ? '断开' : '连接'}</button>}
      {!!connection.pendingDeliveries && <button disabled={busy || waiting || !connection.enabled || connection.phase !== 'connected' || connection.waitingForReply || connection.deliveryError === 'wechat_context_stale'}
        onClick={() => void action('retry-delivery', { channel: 'wechat', revision: connection.revision })}>重试发送</button>}
    </footer>
    <WorkspaceField connection={connection} action={action} busy={busy} />
  </article>;
}

export function ChannelSettings({ api = channelApi }: { api?: ChannelApi }) {
  const [view, setView] = useState<ChannelsView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
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
      }
      catch (failure) { if (!controller.signal.aborted && started === generation.current) setReadError(explain((failure as Error).message)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api]);
  const action: Action = async (method, payload = {}) => {
    writing.current = true; generation.current++;
    setBusy(true); setError(undefined);
    try { setView(await api(method, payload)); return true; }
    catch (failure) { setError(explain((failure as Error).message)); return false; }
    finally { writing.current = false; setBusy(false); }
  };
  return <section className="nexus-channel-settings" aria-label="渠道连接">
    <h2>渠道连接</h2>
    <p>从微信、飞书或企业微信发起任务。已启用的连接会在下次启动时恢复。</p>
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    {!view && <p role="status">正在读取连接设置…</p>}
    {view?.connections.map(connection => connection.channel === 'wechat'
      ? <WechatCard key={connection.channel} connection={connection} qr={view.wechatQr} action={action} busy={busy} />
      : <CredentialCard key={connection.channel} connection={connection} pairing={connection.channel === 'feishu' ? view.feishuPairing : undefined} action={action} busy={busy} />)}
  </section>;
}
