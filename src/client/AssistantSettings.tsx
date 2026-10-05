import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AssistantView } from '../assistant/index.js';
import { INITIATIVES, PERSONA_LIMITS, PERSONA_TEMPLATES, TONES, type PersonaSettings } from '../assistant/persona.js';
import { SPEECH_LIMITS } from '../assistant/speech.js';
import { explain } from './ChannelSettings.js';
import { applyChatFold, readChatFold, writeChatFold } from './chatFold.js';

export type AssistantApi = (method: string, payload?: unknown, signal?: AbortSignal) => Promise<AssistantView>;

export const assistantApi: AssistantApi = async (method, payload = {}, signal) => {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`/api/nexus-assistant/${method}`, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (response.status === 401) throw new Error('session_expired');
  if (!response.ok) throw new Error('connection_failed');
  const message = await response.json();
  if (message.rpcId !== rpcId) throw new Error('connection_failed');
  if (!message.result?.ok) throw new Error(message.result?.error?.code ?? 'connection_failed');
  return message.result.value as AssistantView;
};

interface Draft { revision: number; timeZone: string; quietStart: string; quietEnd: string; briefingTime: string; persona: PersonaSettings; speechUrl: string; speechModel: string; speechKey: string }
const fromView = (view: AssistantView): Draft => ({ revision: view.settings.revision, timeZone: view.settings.timeZone,
  quietStart: view.settings.quietStart ?? '', quietEnd: view.settings.quietEnd ?? '', briefingTime: view.settings.briefingTime ?? '', persona: { ...view.settings.persona },
  speechUrl: view.settings.speech.baseUrl, speechModel: view.settings.speech.model, speechKey: '' });
const when = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });

export function AssistantSettings({ api = assistantApi }: { api?: AssistantApi }) {
  const [view, setView] = useState<AssistantView>();
  const [draft, setDraft] = useState<Draft>();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [readError, setReadError] = useState<string>();
  const [token, setToken] = useState<string>();
  const [fold, setFold] = useState(() => readChatFold());
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
  const action = async (method: string, payload: unknown = {}): Promise<AssistantView | undefined> => {
    writing.current = true; generation.current++;
    setBusy(true); setError(undefined);
    try { const next = await api(method, payload); setView(next); return next; }
    catch (failure) { setError(explain((failure as Error).message)); return undefined; }
    finally { writing.current = false; setBusy(false); }
  };
  if (!view || !draft) {
    return <section className="nexus-channel-settings" aria-label="助理"><h2>助理</h2>
      {readError ? <p role="alert" className="nexus-channel-error">{readError}</p> : <p role="status">正在读取助理设置…</p>}</section>;
  }
  const stale = dirty && draft.revision !== view.settings.revision;
  const edit = (change: Partial<Draft>) => { setDirty(true); setDraft(previous => previous && { ...previous, ...change }); };
  const reload = () => { setDraft(fromView(view)); setDirty(false); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await action('save', { revision: draft.revision, config: { timeZone: draft.timeZone, quietStart: draft.quietStart, quietEnd: draft.quietEnd, briefingTime: draft.briefingTime, persona: draft.persona,
      speech: { baseUrl: draft.speechUrl, model: draft.speechModel, apiKey: draft.speechKey } } })) setDirty(false);
  };
  const editPersona = (change: Partial<PersonaSettings>) => edit({ persona: { ...draft.persona, ...change } });
  const toggleFold = (value: boolean) => { writeChatFold(value); applyChatFold(value); setFold(value); };
  const rotate = async (enabled: boolean) => {
    const next = await action('hook/rotate', { revision: view.settings.revision, enabled });
    setToken(next?.hookToken);
  };
  return <section className="nexus-channel-settings" aria-label="助理">
    <h2>助理</h2>
    <p>助理是谁、怎样说话，以及它主动联系你的方式：什么时候不打扰、每天什么时候发简报、外部系统怎样把事件交给它。当前本地时间 {view.localTime}。</p>
    {(error || readError) && <p role="alert" className="nexus-channel-error">{error || readError}</p>}
    <form onSubmit={event => { void submit(event); }}>
      <article className="nexus-channel-card">
        <header><h3>人设</h3></header>
        <label htmlFor="assistant-template">模板</label>
        <select id="assistant-template" value="" disabled={busy} onChange={event => { const template = PERSONA_TEMPLATES.find(item => item.id === event.target.value); if (template) editPersona(template.persona); }}>
          <option value="">选一个模板填入下面的字段…</option>
          {PERSONA_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.label}（{template.persona.name}，{TONES[template.persona.tone]}，{INITIATIVES[template.persona.initiative]}）</option>)}
        </select>
        <label htmlFor="assistant-name">助理的名字</label>
        <input id="assistant-name" maxLength={PERSONA_LIMITS.nameChars} value={draft.persona.name} disabled={busy} autoComplete="off" placeholder="Nexus"
          onChange={event => editPersona({ name: event.target.value })} />
        <label htmlFor="assistant-user-name">怎么称呼你（留空则不固定称呼）</label>
        <input id="assistant-user-name" maxLength={PERSONA_LIMITS.userNameChars} value={draft.persona.userName} disabled={busy} autoComplete="off" placeholder="老于"
          onChange={event => editPersona({ userName: event.target.value })} />
        <label htmlFor="assistant-tone">语气</label>
        <select id="assistant-tone" value={draft.persona.tone} disabled={busy} onChange={event => editPersona({ tone: event.target.value as PersonaSettings['tone'] })}>
          {Object.entries(TONES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <label htmlFor="assistant-initiative">主动程度</label>
        <select id="assistant-initiative" value={draft.persona.initiative} disabled={busy} onChange={event => editPersona({ initiative: event.target.value as PersonaSettings['initiative'] })}>
          {Object.entries(INITIATIVES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <p className="nexus-channel-hint">人设写进每个会话的系统提示开头，保存后下一条回复生效；回复默认简短、不描述工具过程，这两条不随人设改变。</p>
      </article>
      <article className="nexus-channel-card">
        <header><h3>时间与安静时段</h3>{view.quietNow && <span className="nexus-channel-state">安静时段中</span>}</header>
        <label htmlFor="assistant-zone">时区</label>
        <input id="assistant-zone" maxLength={64} value={draft.timeZone} disabled={busy} autoComplete="off" placeholder="Asia/Shanghai"
          onChange={event => edit({ timeZone: event.target.value })} />
        <label htmlFor="assistant-quiet-start">安静时段开始（HH:MM，留空关闭）</label>
        <input id="assistant-quiet-start" maxLength={5} value={draft.quietStart} disabled={busy} autoComplete="off" placeholder="23:00"
          onChange={event => edit({ quietStart: event.target.value })} />
        <label htmlFor="assistant-quiet-end">安静时段结束（HH:MM）</label>
        <input id="assistant-quiet-end" maxLength={5} value={draft.quietEnd} disabled={busy} autoComplete="off" placeholder="07:00"
          onChange={event => edit({ quietEnd: event.target.value })} />
        <p className="nexus-channel-hint">安静时段内，提醒、监控结果、任务完成通知和简报会保留，结束后合并成一条发送；你自己发消息得到的回复不受影响。
          {view.heldPushes > 0 && ` 当前保留 ${view.heldPushes} 条。`}</p>
        {view.heldPushes > 0 && <footer><button type="button" disabled={busy} onClick={() => void action('flush')}>现在发送保留的消息</button></footer>}
      </article>
      <article className="nexus-channel-card">
        <header><h3>每日简报</h3></header>
        <label htmlFor="assistant-briefing">发送时间（HH:MM，留空关闭）</label>
        <input id="assistant-briefing" maxLength={5} value={draft.briefingTime} disabled={busy} autoComplete="off" placeholder="08:00"
          onChange={event => edit({ briefingTime: event.target.value })} />
        <p className="nexus-channel-hint">简报汇总当天待触发的提醒、之后的提醒和进行中的监控，由 Nexus 直接发送，不调用模型。
          {view.nextBriefingAt !== undefined && ` 下次：${when(view.nextBriefingAt)}。`}</p>
        <footer><button type="button" disabled={busy} onClick={() => void action('briefing/send')}>现在发一份</button></footer>
      </article>
      <article className="nexus-channel-card">
        <header><h3>会话连续性</h3></header>
        <p className="nexus-channel-hint">日常对话持续使用同一个 DSH 会话，长上下文由 DSH 原生压缩管理，不依赖长期记忆是否开启或确认。旧版的按天、按 token 数自动换新设置不再生效。</p>
        <p className="nexus-channel-hint">回复“/new”、归档当前会话或更换工作目录会开启独立的新会话，不自动继承旧对话。旧会话保留在会话列表里；发送“/s”和“/s 编号”可返回原会话，原生任务仍绑定原会话。</p>
      </article>
      <article className="nexus-channel-card">
        <header><h3>语音</h3><span className={`nexus-channel-state ${view.settings.speech.baseUrl ? 'connected' : ''}`}>{view.settings.speech.baseUrl ? '已配置' : '未配置'}</span></header>
        <p>微信语音通常自带转写文字，直接按文字处理。没有带文字的语音（长按语音没选“转文字”时）会解码后交给这里的服务转写；不配置时会提示你改发文字。任何提供 OpenAI 兼容 <code>/audio/transcriptions</code> 接口的服务都可以，例如 SiliconFlow 的 SenseVoice、OpenAI 的 whisper-1，或本机的 whisper 服务。</p>
        <label htmlFor="assistant-speech-url">服务地址（到 /v1 为止，留空表示不用）</label>
        <input id="assistant-speech-url" maxLength={SPEECH_LIMITS.urlChars} value={draft.speechUrl} disabled={busy} autoComplete="off" placeholder="https://api.siliconflow.cn/v1"
          onChange={event => edit({ speechUrl: event.target.value })} />
        <label htmlFor="assistant-speech-model">转写模型名</label>
        <input id="assistant-speech-model" maxLength={SPEECH_LIMITS.modelChars} value={draft.speechModel} disabled={busy} autoComplete="off" placeholder="FunAudioLLM/SenseVoiceSmall"
          onChange={event => edit({ speechModel: event.target.value })} />
        <label htmlFor="assistant-speech-key">API Key</label>
        <input id="assistant-speech-key" type="password" maxLength={SPEECH_LIMITS.keyChars} value={draft.speechKey} disabled={busy} autoComplete="new-password"
          placeholder={view.settings.speech.apiKeyConfigured ? '已保存，留空保留当前密钥' : '输入密钥（本机服务可留空）'} onChange={event => edit({ speechKey: event.target.value })} />
        {view.settings.speech.baseUrl && <footer><button type="button" disabled={busy} onClick={() => void action('speech/clear', { revision: view.settings.revision })}>清除语音服务</button></footer>}
      </article>
      {stale && <p role="alert">{explain('configuration_changed')} <button type="button" onClick={reload}>重新载入</button></p>}
      <footer className="nexus-channel-card" style={{ borderStyle: 'none', paddingTop: 0 }}>
        <button type="submit" className="primary" disabled={busy || stale}>保存设置</button>
        {dirty && <button type="button" disabled={busy} onClick={reload}>放弃修改</button>}
      </footer>
    </form>
    <article className="nexus-channel-card">
      <header><h3>对话页显示</h3></header>
      <p>DSH 的紧凑模式会把已完成轮次的思考和工具调用收成一行；打开这项后，系统提示词和放在你消息前面的上下文注入（记忆、时间）也一并隐藏，每轮只剩你的消息、一行过程摘要和回复。只影响这个浏览器；完整过程仍可在轨迹视图里看。</p>
      <label htmlFor="assistant-chat-fold" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input id="assistant-chat-fold" type="checkbox" checked={fold} onChange={event => toggleFold(event.target.checked)} style={{ width: 'auto', margin: 0 }} />
        已完成的轮次只保留一行过程摘要
      </label>
    </article>
    <article className="nexus-channel-card">
      <header><h3>外部事件入口</h3><span className={`nexus-channel-state ${view.settings.hookEnabled ? 'connected' : ''}`}>{view.settings.hookEnabled ? '已启用' : '未启用'}</span></header>
      <p>外部系统用 POST 把事件交给助理：请求头 <code>Authorization: Bearer 令牌</code>，正文 <code>{'{"text":"事件内容","source":"来源"}'}</code>。事件作为一条带来源标记的消息进入你的聊天会话，助理按你事先的要求处理，无关时保持安静。</p>
      {view.hookUrl && <p className="nexus-channel-account">地址：<code>{view.hookUrl}</code>（只在本机监听；从外网访问需要你自己做转发）</p>}
      {token && <p role="status" className="nexus-channel-account">新令牌只显示这一次：<code>{token}</code></p>}
      <footer>
        <button type="button" className="primary" disabled={busy} onClick={() => void rotate(true)}>{view.settings.hookEnabled ? '更换令牌' : '启用并生成令牌'}</button>
        {view.settings.hookEnabled && <button type="button" disabled={busy} onClick={() => void rotate(false)}>停用</button>}
      </footer>
    </article>
  </section>;
}
