import { firstAvailable, isNativeMirror, nativeApproval, nativeQuestion } from './interaction.js';
import { desktopApprovalReceipt, desktopQuestionReceipt } from './receipts.js';
import { SessionId, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session';
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule';
import type { Context } from '@deepseek-ai/cordis';
// Declares `ctx.workspaceRegistry`, whose archive set decides whether a session this bridge is about to
// write into can still run a step at all.
import { realpathNormalize, type Workspace } from '@deepseek-ai/dsh-workspace';
import type {} from '@deepseek-ai/dsh-workspace';
import type { PromptContentPart, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller';
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionRequest, AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions';
import type {} from '@deepseek-ai/dsh-tool-present/types';
import { ApprovalReplies } from '../channels/approvals.js';
import type { DeliveryMarks } from '../channels/ledger.js';
import type { PushGate } from '../channels/notify.js';
import { readDelivery } from '../channels/files.js';
import { formatBytes, saveInbound, type SavedAttachment } from '../channels/inbox.js';
import type { FileLedgerWriter } from '../files/index.js';
import { baseSessionOf, identity, parseCommand, sessionIdAt, sessionIdFor, type ChannelTransport, type ChannelIdentity, type DroppedAttachment, type InboundMessage } from '../channels/protocol.js';
import { ROTATION_NOTICES, adoptionNotice, sessionDigest, userTurns, type RotationReason, type RotationSettings, type SessionRosterView } from '../sessions/index.js';
import { DEFAULT_TIME_ZONE } from '../assistant/settings.js';
import { imageMediaType } from '../wechat/media.js';
import { ChannelError } from '../channels/types.js';
import { restoreSystemPermission } from './policy.js';
import { describeToolCall, heartbeatText } from './describe.js';
import { QuestionReplies, questionPrompt } from './questions.js';
import { interruptedNotice, interruptedWork } from './recovery.js';
import { activeLegacyReminders, describeReminders, isQuietReply, pluginInitiated } from './schedule.js';
import { storedEvents } from './history.js';
import { ChannelNavigation } from './navigation.js';
import { CHANNEL_HELP } from '../channels/help.js';

/** When a user-started turn is still running, the channel hears about it: once after `firstMs`, then every `everyMs`. */
export interface HeartbeatOptions { firstMs: number; everyMs: number }
export const DEFAULT_HEARTBEAT: HeartbeatOptions = { firstMs: 60_000, everyMs: 5 * 60_000 };

export { describeToolCall, heartbeatText } from './describe.js';

/** Optional collaborators: the delivery ledger for catch-up after a restart, the user's time zone for notices, and speech-to-text for voice clips. */
export interface BridgeExtras {
  ledger?: DeliveryMarks;
  timeZone?: () => string;
  /** WAV in, text out; rejects with `speech_not_configured` when the user set no service. */
  transcribe?: (wav: Buffer, signal: AbortSignal) => Promise<string>;
  /** Every file the user sent or received is noted here with the request it belonged to, so `file_find` can locate it later. */
  files?: FileLedgerWriter;
  /** Which generation of each chat's session is active; without it a chat keeps one session forever. */
  sessions?: SessionRosterView;
  /** @deprecated Retained for integration compatibility; automatic empty-session rotation is disabled. */
  rotation?: () => RotationSettings;
  /** Whether background coding work is active; explicit navigation waits for it. */
  busy?: (baseSessionId: string) => Promise<boolean>;
  /** Where the digest of a session that was just replaced goes (long-term memory). */
  memory?: { remember(text: string, sessionId: string): Promise<unknown> };
  /** The chat's base sessions under earlier bindings of the same person (WeChat: earlier bot accounts); their reminders are carried over once. */
  formerBases?: () => Promise<readonly string[]>;
}

/** A channel adapter over the same Session Controller used by the official Web UI. */
export class DshChannelBridge {
  private readonly heartbeats = new Map<SessionId, { turn: number; startedAt: number; count: number; timer: NodeJS.Timeout }>();
  /** Sessions whose turns this bridge delivers: each chat's active generation and the one before it. */
  private readonly routes = new Map<SessionId, string>();
  /** The chat's base sessions under earlier bindings, read once per mount. */
  private formers?: Promise<readonly string[]>;
  /** Each chat's base session id (generation 0) → chat, so any generation of it can still be addressed. */
  private readonly bases = new Map<SessionId, string>();
  /** Each chat's active session: where its next message goes and where proactive pushes are addressed. */
  private readonly chats = new Map<string, SessionId>();
  /** One admission at a time per chat, so two quick messages cannot both open a new generation. */
  private readonly admissions = new Map<SessionId, Promise<unknown>>();
  private readonly replies = new ApprovalReplies();
  private readonly questions = new QuestionReplies();
  private readonly controlReceipts = new Set<string>();
  /** `session:turn` pairs catch-up delivered in this process, so a live event for the same turn is not sent twice. */
  private readonly caughtUp = new Set<string>();
  private outgoing: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly lifetime = new AbortController();
  private readonly navigation: ChannelNavigation;
  private gate?: PushGate;
  /** The workspace this channel's directory was registered as; see {@link adoptWorkspace}. */
  private registered?: Workspace;

  constructor(
    private readonly ctx: Context,
    private readonly transport: ChannelTransport,
    private readonly config: ChannelIdentity,
    private readonly workspace: string,
    private readonly report: (code: string) => void,
    private readonly heartbeat: HeartbeatOptions = DEFAULT_HEARTBEAT,
    private readonly now: () => number = Date.now,
    private readonly extras: BridgeExtras = {},
  ) {
    this.navigation = new ChannelNavigation(ctx, workspace, extras.sessions, this.lifetime.signal, now,
      async (chatId, base) => this.replies.hasPending(chatId) || this.questions.hasPending(chatId) || await (extras.busy?.(base) ?? Promise.resolve(false)),
      (base, chatId) => { this.route(SessionId(base), chatId); });
    // WeChat and WeCom private chats are addressed by the owner's own id, so their session is routable before any message arrives.
    // Feishu chat ids are only learned from an inbound message.
    if (config.channel !== 'feishu') this.route(SessionId(sessionIdFor(config.accountId, config.ownerId, config.ownerId, config.channel)), config.ownerId);
  }

  /** Bind a chat: its base, its active generation and the previous one become deliverable; the active one receives pushes. */
  private route(base: SessionId, chatId: string): SessionId {
    this.bases.set(base, chatId);
    const record = this.extras.sessions?.get(base);
    const active = SessionId(record?.sessionId ?? base);
    for (const id of [active, record?.previous]) if (id) this.routes.set(SessionId(id), chatId);
    this.chats.set(chatId, active);
    return active;
  }

  /** The chat a session belongs to, whichever generation it is; `undefined` for sessions that are not this bridge's. */
  private chatOf(sessionId: SessionId): string | undefined {
    return this.routes.get(sessionId) ?? this.bases.get(SessionId(baseSessionOf(sessionId)));
  }

  /** History remains addressable for native jobs and scoped interactions, not new desktop conversation. */
  private historicalChannel(sessionId: string): boolean {
    const chatId = this.chatOf(SessionId(sessionId));
    return !!chatId && this.chats.get(chatId) !== sessionId;
  }

  private historicalText(sessionId: string, text: string): string {
    const title = { wechat: '微信', feishu: '飞书', wecom: '企业微信' }[this.config.channel];
    if (!this.historicalChannel(sessionId) || text.startsWith(`[历史${title}会话 `)) return text;
    return `[历史${title}会话 ${sessionId}]\n${text}\n普通聊天回复会进入当前${title}会话；可发送“/s”选择旧会话，或在电脑端打开上述会话。`;
  }

  private deliverableTurn(sessionId: string, events: readonly SessionEvent[], turn: number): boolean {
    if (!this.historicalChannel(sessionId)) return true;
    const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn);
    if (start < 0) return false;
    const typed = events.slice(start).filter(event => event.type === 'user/message');
    // Use native origin metadata, never message wording. A desktop turn mixed with a job notice
    // is still local; a WeChat turn admitted before rotation can finish in its original session.
    return typed.length > 0 && typed.every(event => {
      if (event.type !== 'user/message') return false;
      const rpcId = String((event.data.source as { rpcId?: unknown }).rpcId ?? '');
      return pluginInitiated(event.data) || rpcId.startsWith(`${this.config.channel}-`) || rpcId.includes('-hook-');
    });
  }

  /**
   * Resume the sessions this bridge can route before any message arrives, so
   * pending native work and delivery recovery are attached after a restart. A session that was never
   * created is left alone.
   */
  async resumeBound(): Promise<void> {
    for (const chatId of await this.transport.knownChats?.() ?? []) {
      const base = SessionId(sessionIdFor(this.config.accountId, this.config.ownerId, chatId, this.config.channel));
      this.route(base, chatId);
    }
    for (const [chatId, sessionId] of this.chats) await this.restoreFormerRoutes(baseSessionOf(sessionId), chatId);
    for (const sessionId of this.routes.keys()) {
      if (this.stopped) return;
      try {
        const found = await this.ctx.sessionController.resolveAgent(sessionId);
        if ('error' in found) continue;
        restoreSystemPermission(found.agent.session);
      } catch { /* not persisted yet */ }
    }
  }

  setPushGate(gate: PushGate | undefined): void { this.gate = gate; }

  /**
   * The registered directory this channel's sessions belong to, once the mount
   * has registered it. Until then a session is created and runs as usual; it
   * simply has no group to be shown in. Returns once the sessions that already
   * exist have been put in that group.
   */
  adoptWorkspace(workspace: Workspace): Promise<void> {
    this.registered = workspace;
    return this.groupKnownSessions();
  }

  /**
   * Put a session in the group the Web UI shows for this directory. DSH's own
   * `sessionController.create` attaches a session to a workspace only when the
   * request names a `workspaceId`, and these sessions are created with a `cwd`
   * — so grouping is this bridge's job, right after each session exists.
   * Failing to group a session must never cost the user a reply.
   */
  private async group(sessionId: SessionId): Promise<void> {
    try { await this.registered?.attachSession(sessionId); }
    catch { this.report('channel_session_group_failed'); }
  }

  /**
   * Sessions created before their directory was registered stay in 未分组 for
   * good: a group is only ever joined when something attaches the session. So
   * once the directory is registered, every session this channel already has is
   * attached — the newest generations, the ones from before the attach existed,
   * and the ones belonging to a chat that is no longer the current one — instead
   * of waiting for them to be rotated out.
   *
   * `sessionPersistence.list()` is the store's own view: one stored header per
   * session, no log read. It covers the live sessions, the ones nobody has loaded
   * since the restart, and a generation the roster no longer names, which is why
   * the sweep walks it rather than the bridge's own maps. A header whose cwd is
   * some other directory is left alone: an attach validates a session's cwd
   * against the workspace in exactly this way and refuses it, and the workspace
   * filters such a session out of its membership anyway.
   */
  private async groupKnownSessions(): Promise<void> {
    const mine = `nexus-${this.config.channel}-`;
    let headers: readonly SessionHeader[];
    try { headers = (await this.ctx.sessionPersistence.list({ signal: this.lifetime.signal })).map(({ header }) => header); }
    catch { this.report('channel_session_list_failed'); return; }
    for (const header of headers) {
      if (this.stopped || !header.id.startsWith(mine) || !await this.insideWorkspace(header.cwd)) continue;
      await this.group(SessionId(header.id));
    }
  }

  /** Whether a session's stored cwd is the directory this channel works in — the one check an attach performs. */
  private async insideWorkspace(cwd: string | undefined): Promise<boolean> {
    const registered = this.registered;
    if (!cwd || !registered) return false;
    try { return await realpathNormalize(cwd) === registered.path; }
    catch { return false; }  // The directory is gone or unreadable; an attach refuses it for the same reason.
  }

  /**
   * Deliver what ended while no bridge was listening: turns completed after
   * the last delivered one (the process was down, or the connection was off),
   * and a turn the crash left open, reported as what was pending. Runs on the
   * outgoing chain so a live delivery cannot interleave with it. A session
   * seen for the first time is only marked, so history is never replayed.
   */
  catchUp(sessionId?: SessionId): Promise<void> {
    this.outgoing = this.outgoing.then(async () => {
      if (this.stopped || !this.extras.ledger) return;
      const targets = new Set(sessionId ? [sessionId] : this.routes.keys());
      if (!sessionId) {
        // A host-owned reminder can finish in any old generation while the channel is offline.
        // Enumerate native headers, never rebuild sessions from messages or a tool receipt.
        for (const [chatId, active] of this.chats) await this.restoreFormerRoutes(baseSessionOf(active), chatId);
        if (this.ctx.sessionPersistence?.list) {
          try {
            for (const item of await this.ctx.sessionPersistence.list()) if (this.chatOf(item.header.id)) targets.add(item.header.id);
          } catch { this.report('channel_catch_up_list_failed'); }
        }
      }
      for (const id of targets) {
        if (this.stopped) break;
        const chatId = this.chatOf(id);
        if (!chatId) continue;
        try { await this.catchUpSession(id, chatId, await this.eventsOf(id)); }
        catch { this.report('channel_catch_up_failed'); }
      }
    }).catch(() => { this.report('channel_catch_up_failed'); });
    return this.outgoing;
  }

  /** The session's events after crash repair when it can be resumed, else the stored log as it is. */
  private async eventsOf(sessionId: SessionId): Promise<readonly SessionEvent[]> {
    try {
      const found = await this.ctx.sessionController.resolveAgent(sessionId);
      if (!('error' in found)) return found.agent.session.snapshotEvents();
    } catch { /* never created, or cannot be resumed */ }
    return storedEvents(this.ctx, sessionId, this.lifetime.signal);
  }

  private async catchUpSession(sessionId: SessionId, chatId: string, events: readonly SessionEvent[]): Promise<void> {
    const ledger = this.extras.ledger!;
    const ends = events.filter((event): event is Extract<SessionEvent, { type: 'turn/end' }> => event.type === 'turn/end');
    const last = ends.at(-1);
    const mark = ledger.get(sessionId);
    if (mark === undefined) {
      // First run with a ledger: start from here, whatever the log holds.
      if (last) await ledger.set(sessionId, last.data.turn, this.now());
      return;
    }
    for (const end of ends) {
      if (end.data.turn <= mark || this.stopped) continue;
      const scope = events.filter(event => event.seq <= end.seq);
      this.caughtUp.add(`${sessionId}:${end.data.turn}`);
      if (end.data.reason.kind === 'interrupted') {
        const work = interruptedWork(scope);
        if (work && this.deliverableTurn(sessionId, scope, end.data.turn)) await this.push(sessionId, chatId, interruptedNotice(work, this.extras.timeZone?.()), identity('interrupted', sessionId, String(end.data.turn)));
      } else {
        await this.deliver(chatId, sessionId, end, scope);
      }
      await ledger.set(sessionId, end.data.turn, this.now());
    }
    // A log that still ends inside a turn could not be repaired (the session did not resume): say so once.
    const open = interruptedWork(events);
    if (open && open.turn > mark && !ends.some(end => end.data.turn === open.turn)) {
      this.caughtUp.add(`${sessionId}:${open.turn}`);
      if (this.deliverableTurn(sessionId, events, open.turn)) await this.push(sessionId, chatId, interruptedNotice(open, this.extras.timeZone?.()), identity('interrupted', sessionId, String(open.turn)));
      await ledger.set(sessionId, open.turn, this.now());
    }
  }

  /** A proactive text: held during quiet hours like any push, durable otherwise. */
  private async push(sessionId: SessionId, chatId: string, text: string, deliveryId: string): Promise<void> {
    text = this.historicalText(sessionId, text);
    if (this.gate?.quiet()) { await this.gate.hold(sessionId, text, deliveryId); return; }
    await this.transport.sendText(chatId, text, deliveryId, { durable: true });
  }

  /** The active session of every chat this bridge can reach right now; older generations are not listed, so a push goes out once per chat. */
  bound(): string[] { return [...this.chats.values()]; }

  /**
   * Where the chat's files live: the working directory of its active session.
   * A session keeps the directory it was created with, so a chat whose workspace
   * was changed still has its attachments saved — and its delivered files read —
   * where its model resolves relative paths from. A session that does not exist
   * yet gets this channel's directory, the one `admit` is about to create it with.
   */
  private async workspaceOf(sessionId: SessionId): Promise<string> {
    try {
      const found = await this.ctx.sessionController.resolveAgent(sessionId);
      if (!('error' in found)) return found.agent.session.header?.cwd ?? this.workspace;
    } catch { /* never created, or cannot be resolved */ }
    return this.workspace;
  }

  /**
   * Submit external text (a webhook event) into a bound session the same way a
   * channel message is admitted, so the model's reply reaches the chat.
   */
  async inject(sessionId: string, text: string, requestId: string): Promise<boolean> {
    const chatId = this.chatOf(SessionId(sessionId));
    if (!chatId || this.stopped) return false;
    // An external event joins whatever session is active; only the user's own message opens a new day.
    await this.admit(SessionId(baseSessionOf(sessionId)), chatId, [{ type: 'text', text }], `${this.config.channel}-hook-${identity(requestId)}` as SessionRequestId, false);
    return true;
  }

  /**
   * Proactive send: text for the chat bound to `sessionId`, durable so WeChat
   * keeps it until a usable reply context exists. `false` when this bridge does
   * not hold the session; transport failures propagate.
   */
  async notify(sessionId: string, text: string, deliveryId: string): Promise<boolean> {
    const chatId = this.chatOf(SessionId(sessionId));
    if (!chatId || this.stopped) return false;
    await this.transport.sendText(chatId, this.historicalText(sessionId, text), deliveryId, { durable: true });
    return true;
  }

  async receive(message: InboundMessage): Promise<void> {
    if (this.stopped) throw new ChannelError('connection_cancelled');
    if (message.chatType !== 'p2p' || message.senderId !== this.config.ownerId) return;
    const base = SessionId(sessionIdFor(this.config.accountId, this.config.ownerId, message.chatId, this.config.channel));
    // Control replies and status address the chat's active generation without opening a new one.
    const sessionId = SessionId(this.extras.sessions?.activeFor(base) ?? base);
    // A voice clip becomes text first, so a spoken "允许" or task is handled like a typed one.
    message = await this.resolveVoice(message, SessionId(sessionId));
    // Attachments the channel could not hand over are reported, not silently lost; a message that was only that ends here.
    if (message.dropped?.length) {
      await this.transport.sendText(message.chatId, describeDropped(message.dropped), identity('dropped-reply', message.messageId))
        .catch(() => { this.report('channel_dropped_notice_failed'); });
    }
    // Nothing usable is left (a clip that could not be transcribed, or only refused items): the user has been told.
    if (!message.text.trim() && !message.attachments?.length) return;
    // A picture with a caption is a task, never a control reply.
    const command = message.attachments?.length ? undefined : parseCommand(message.text);
    if (command?.kind === 'help') {
      await this.transport.sendText(message.chatId, CHANNEL_HELP, identity('help-reply', message.messageId), { durable: true });
      return;
    }
    if (command && ['approve', 'deny', 'answer', 'new', 'switch-session', 'switch-model'].includes(command.kind)) {
      const receipt = identity(message.chatId, message.messageId);
      if (this.controlReceipts.has(receipt)) return;
      // A retried control message must never settle a later question or approval.
      this.controlReceipts.add(receipt);
      if (this.controlReceipts.size > 200) this.controlReceipts.delete(this.controlReceipts.values().next().value!);
    }
    if (command?.kind === 'answer') {
      const result = this.questions.answer(message.chatId, command.value, command.token);
      const notice = result.kind === 'accepted' ? (result.last ? '已收到回答，任务继续执行。' : '已收到回答，请继续回答下一题。') : {
        missing: '当前没有匹配的待回答问题，可能已处理或取消；请以最新问题为准。',
        ambiguous: '当前有多项待回答问题，请使用对应提示中的“回答 编号 内容”。',
        sending: '问题详情还在发送，请等完整提示发送完毕后再回答。',
        invalid: '答案格式不正确。请填写有效的选项编号；自由内容可回复“回答 文本 你的内容”。',
      }[result.kind];
      await this.transport.sendText(message.chatId, notice, identity('answer-reply', message.messageId))
        .catch(() => { this.report('channel_answer_ack_failed'); });
      return;
    }
    if (command?.kind === 'approve' || command?.kind === 'deny') {
      const decision = command.kind === 'approve' ? 'allowed-once' : 'rejected';
      const result = command.token
        ? (this.replies.answer(message.chatId, command.token, decision) ? 'accepted' : 'missing')
        : this.replies.answerCurrent(message.chatId, decision);
      const notice = result === 'accepted'
        ? (command.kind === 'approve' ? '已允许本次操作，任务继续执行。' : '已拒绝本次操作。')
        : { missing: '当前没有匹配的待审批操作，可能已处理或过期；请以最新审批提示为准。',
          ambiguous: '当前有多项待审批，请回复对应提示中的“允许 编号”或“拒绝 编号”。',
          sending: '审批详情还在发送，请等完整提示发送完毕后再回复。' }[result];
      await this.transport.sendText(message.chatId, notice, identity('approval-reply', message.messageId))
        .catch(() => { this.report('channel_approval_ack_failed'); });
      return;
    }
    if (command?.kind === 'sessions' || command?.kind === 'switch-session' || command?.kind === 'models' || command?.kind === 'model' || command?.kind === 'switch-model') {
      let notice: string;
      try { notice = await this.chain(base, () => this.navigation.run(base, message.chatId, command)); }
      catch { notice = '操作未能完成，请确认会话空闲后重试，或在本机 DSH 查看会话和模型设置。'; this.report('channel_navigation_failed'); }
      await this.transport.sendText(message.chatId, notice, identity('navigation-reply', message.messageId), { durable: true });
      return;
    }
    if (command?.kind === 'new') {
      let notice: string;
      try {
        const opened = this.extras.sessions ? await this.chain(base, () => {
          if (this.replies.hasPending(message.chatId) || this.questions.hasPending(message.chatId)) throw new Error('interaction_pending');
          return this.open(base, message.chatId, 'user');
        }) : undefined;
        notice = opened ? ROTATION_NOTICES.user : (this.extras.sessions ? '当前会话还没有聊过什么，不用换新。' : '这个渠道没有开启会话换新。');
      } catch { notice = '开新会话失败，请稍后再试。'; this.report('channel_rotation_failed'); }
      await this.transport.sendText(message.chatId, notice, identity('new-reply', message.messageId));
      return;
    }
    if (command?.kind === 'status') {
      let notice: string;
      try { notice = await this.status(base, sessionId, message.chatId); }
      catch { notice = '暂时无法读取任务状态，请在本机 DSH 查看。'; this.report('channel_status_failed'); }
      await this.transport.sendText(message.chatId, notice, identity('status-reply', message.messageId));
      return;
    }
    if (command?.kind === 'cancel') {
      // The route may exist before any message (WeChat, WeCom); the native controller throws when no agent is attached.
      let notice = '已请求停止当前执行；历史记录保留在 DSH。';
      try { this.ctx.sessionController.cancel({ sessionId }); }
      catch { notice = '当前没有正在执行的任务。'; }
      await this.transport.sendText(message.chatId, notice, identity('cancel-reply', message.messageId));
      return;
    }
    // Serialize admission only. The native DSH inbox owns execution and queued turns.
    const waitingOnApproval = this.replies.hasPending(message.chatId);
    const waitingOnQuestion = this.questions.hasPending(message.chatId);
    const requestId = `${this.config.channel}-${identity(this.config.accountId, message.messageId)}` as SessionRequestId;
    try {
      const { content, withoutImages } = await this.contentFor(message, sessionId);
      try { await this.admit(base, message.chatId, content, requestId); }
      catch (error) {
        // The selected model cannot look at pictures: the saved copies are still described, so the task goes on as text.
        if (!withoutImages || (error as { code?: unknown }).code !== 'session/attachment-invalid') throw error;
        await this.admit(base, message.chatId, withoutImages, requestId);
      }
    } catch {
      if (this.stopped) throw new ChannelError('connection_cancelled');
      this.report('channel_prompt_admission_failed');
      await this.transport.sendText(message.chatId, '任务未能提交，请在本机 DSH 检查模型和工作区设置。',
        identity('admission-error', message.messageId)).catch(() => {});
      throw new ChannelError('channel_prompt_admission_failed');
    }
    if (waitingOnApproval && this.replies.hasPending(message.chatId)) {
      await this.transport.sendText(message.chatId,
        '你的消息已排队。当前任务正在等待审批，请先回复“允许”或“拒绝”；多项审批请带上编号。',
        identity('approval-wait', message.messageId)).catch(() => { this.report('channel_queue_notice_failed'); });
    } else if (waitingOnQuestion && this.questions.hasPending(message.chatId)) {
      await this.transport.sendText(message.chatId,
        '你的消息已排队。当前任务正在等待回答，请按最新问题回复“回答 选项编号”或“回答 自由文本”。',
        identity('question-wait', message.messageId)).catch(() => { this.report('channel_queue_notice_failed'); });
    }
  }

  /**
   * Voice clips the channel could not transcribe itself go through the user's
   * speech service; the text joins the message and the clip is kept in the
   * inbox. Without a service, or when it fails, the user is told what to do
   * instead, and a message that was only that clip ends there.
   */
  private async resolveVoice(message: InboundMessage, sessionId: SessionId): Promise<InboundMessage> {
    const voices = message.attachments?.filter(attachment => attachment.kind === 'voice') ?? [];
    if (!voices.length) return message;
    const others = message.attachments!.filter(attachment => attachment.kind !== 'voice');
    const transcripts: string[] = [];
    const workspace = await this.workspaceOf(sessionId);
    let failure: string | undefined;
    for (const voice of voices) {
      if (!this.extras.transcribe) { failure = 'speech_not_configured'; continue; }
      try {
        transcripts.push(await this.extras.transcribe(voice.bytes, this.lifetime.signal));
        await saveInbound(workspace, voice).catch(() => { this.report('channel_voice_save_failed'); });
      } catch (error) {
        if (this.stopped) throw new ChannelError('connection_cancelled');
        failure = error instanceof ChannelError ? error.code : 'speech_failed';
        this.report(`channel_voice_transcription_failed code=${failure}`);
      }
    }
    if (failure) {
      await this.transport.sendText(message.chatId, voiceNotice(failure), identity('voice-notice', message.messageId))
        .catch(() => { this.report('channel_voice_notice_failed'); });
    }
    const text = [message.text.trim(), ...transcripts].filter(Boolean).join('\n');
    const { attachments: _attachments, ...rest } = message;
    return { ...rest, text, ...(others.length ? { attachments: others } : {}), ...(transcripts.length || message.transcribed ? { transcribed: true } : {}) };
  }

  /**
   * Save every attachment under the workspace inbox and build the prompt: the
   * user's text, one line per saved file with its path, and each picture also as
   * a native image part so a vision model sees it directly.
   */
  private async contentFor(message: InboundMessage, sessionId: SessionId): Promise<{ content: PromptContentPart[]; withoutImages?: PromptContentPart[] }> {
    const spoken = message.transcribed ? TRANSCRIBED_NOTE : '';
    if (!message.attachments?.length) return { content: [{ type: 'text', text: message.text + spoken }] };
    const saved: SavedAttachment[] = [];
    const workspace = await this.workspaceOf(sessionId);
    for (const attachment of message.attachments) saved.push(await saveInbound(workspace, attachment));
    for (const file of saved) {
      await this.extras.files?.record({ kind: 'inbound', path: file.path, name: file.name, bytes: file.bytes, sessionId, request: message.text })
        .catch(() => { this.report('channel_file_ledger_failed'); });
    }
    const lines = saved.map(file => `[附件] ${file.kind === 'image' ? '图片' : '文件'} ${file.name}（${formatBytes(file.bytes)}）已保存到 ${file.path}`);
    const text = [message.text.trim() + spoken, ...lines].filter(Boolean).join('\n');
    const images: PromptContentPart[] = [];
    for (const [index, attachment] of message.attachments.entries()) {
      const mediaType = attachment.kind === 'image' ? imageMediaType(attachment.bytes) : undefined;
      if (mediaType) images.push({ type: 'image', mediaType, data: attachment.bytes.toString('base64'), name: saved[index]!.name });
    }
    if (images.length === 0) return { content: [{ type: 'text', text }] };
    return { content: [{ type: 'text', text }, ...images],
      withoutImages: [{ type: 'text', text: `${text}\n（当前模型不能直接看图，需要时用文件工具读取保存的图片路径。）` }] };
  }

  /** Run `task` after everything already queued for this chat. */
  private chain<T>(base: SessionId, task: () => Promise<T>): Promise<T> {
    const previous = this.admissions.get(base) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    this.admissions.set(base, next);
    return next.finally(() => { if (this.admissions.get(base) === next) this.admissions.delete(base); });
  }

  private admit(base: SessionId, chatId: string, content: readonly PromptContentPart[], requestId: SessionRequestId, mayRotate = true): Promise<void> {
    return this.chain(base, async () => {
      if (this.stopped) throw new ChannelError('connection_cancelled');
      const known = this.bases.has(base);
      let sessionId = known ? this.chats.get(chatId)! : this.route(base, chatId);
      if (!known) void this.catchUp();
      // A reply the user is waiting to give keeps the conversation where the question was asked.
      const waiting = this.replies.hasPending(chatId) || this.questions.hasPending(chatId);
      // A rotation that throws must not swallow the message: the misleading "check the model
      // settings" reply is for a prompt that never reached a session. Stay where the chat is.
      let rotated: { sessionId: SessionId; reason: RotationReason } | undefined;
      if (this.extras.sessions && mayRotate && !waiting) {
        try { rotated = await this.open(base, chatId); }
        catch (error) {
          const detail = String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 200);
          this.report(detail ? `channel_rotation_failed: ${detail}` : 'channel_rotation_failed');
        }
      }
      if (rotated) {
        sessionId = rotated.sessionId;
        await this.transport.sendText(chatId, ROTATION_NOTICES[rotated.reason], identity('rotated', sessionId), { durable: true })
          .catch(() => { this.report('channel_rotation_notice_failed'); });
      } else {
        // open() points the chat at the new generation only after that generation is committed.
        // Follow it when a later step threw, so this message is not answered in a session the next one will leave.
        const active = this.chats.get(chatId);
        if (active) sessionId = active;
      }
      // DSH resumes a session only in the directory it was created in, and refuses it under any other. A
      // generation from before the channel's directory changed keeps its own until the chat moves on (an
      // external event does not move it), so it is resumed there, and it cannot join the new directory's group.
      const cwd = await this.workspaceOf(sessionId);
      await this.ctx.sessionController.create({ sessionId, cwd });
      const found = await this.ctx.sessionController.resolveAgent(sessionId);
      if ('error' in found) throw found.error;
      this.lifetime.signal.throwIfAborted();
      restoreSystemPermission(found.agent.session);
      if (cwd === this.workspace) await this.group(SessionId(sessionId));
      await this.adoptFormer(found.agent.session, chatId);
      await this.ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content, clientTimeZone: 'Asia/Shanghai' }, this.lifetime.signal);
      // A transport cursor acknowledges durable admission, not merely an in-memory inbox receipt.
      if (!await this.ctx.sessions.flush(found.agent.session)) throw new ChannelError('native_session_not_persisted');
    });
  }

  /** Whether this session was created in another directory than the one the channel works in now. */
  private async movedAway(sessionId: SessionId): Promise<boolean> {
    return await this.workspaceOf(sessionId) !== this.workspace;
  }

  /** Only account bindings admitted for this configured owner may share delivery routes. */
  private async restoreFormerRoutes(base: string, chatId: string): Promise<readonly string[]> {
    if (!this.extras.formerBases) return [];
    this.formers ??= this.extras.formerBases().catch(() => { this.report('channel_former_sessions_unreadable'); return []; });
    const formers = await this.formers;
    const admitted = new Set([...formers, base]);
    for (const former of formers) {
      // More than one QR rebind can leave A → B → current. Follow only bindings already
      // proven to belong to this owner; a foreign destination or a cycle grants no route.
      let cursor = former;
      const seen = new Set<string>();
      while (cursor !== base && admitted.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        const destination = this.extras.sessions?.get(cursor)?.supersededBy;
        if (!destination) { cursor = base; break; }
        cursor = destination;
      }
      if (former !== base && cursor === base) this.bases.set(SessionId(former), chatId);
    }
    return formers;
  }

  /** Native tasks keep their original Session and history; only delivery metadata follows a rebind. */
  private async adoptFormer(target: Session, chatId: string): Promise<void> {
    const roster = this.extras.sessions;
    if (!this.extras.formerBases) return;
    const base = baseSessionOf(target.id);
    const formers = await this.restoreFormerRoutes(base, chatId);
    if (!roster) return;
    for (const former of formers) {
      if (this.stopped) return;
      if (former === base || roster.get(former)?.supersededBy) continue;
      try {
        const source = SessionId(roster.activeFor(former));
        const events = this.ctx.sessions.get(source)?.snapshotEvents() ?? await storedEvents(this.ctx, source, this.lifetime.signal);
        const reminders = (await this.reminders(target.id)).filter(item => baseSessionOf(item.sessionId) === former);
        const digest = sessionDigest(events, this.extras.timeZone?.() ?? DEFAULT_TIME_ZONE);
        if (digest) await this.extras.memory?.remember(digest, source).catch(() => { this.report('channel_session_digest_failed'); });
        await roster.supersede(former, base, this.now());
        if (reminders.length) await this.transport.sendText(chatId, adoptionNotice(describeReminders(reminders)), identity('adopted', source), { durable: true })
          .catch(() => { this.report('channel_adoption_notice_failed'); });
      } catch { this.report('channel_former_session_not_merged'); }
    }
  }

  /** Same explicitly admitted owner/chat; never derived from a task's text or native task binding. */
  sameChat(first: string, second: string): boolean {
    const chat = this.chatOf(SessionId(first));
    return chat !== undefined && chat === this.chatOf(SessionId(second));
  }

  private async reminders(sessionId: SessionId): Promise<ScheduleCatalogEntry[]> {
    const schedule = typeof this.ctx.get === 'function' ? this.ctx.get('schedule') as Context['schedule'] | undefined : this.ctx.schedule;
    const records = await schedule?.catalog() ?? [];
    return records.filter(record => record.status === 'active' && this.sameChat(sessionId, record.sessionId));
  }

  /** Whether the user archived this session in the Web UI; DSH then rejects every step it is asked to run. */
  private archived(sessionId: SessionId): boolean {
    // Absent where the registry is not composed (a test's stub context): treat that as "nothing archived".
    return this.ctx.workspaceRegistry?.archivedSessionIds.includes(sessionId) === true;
  }

  /**
   * Only explicit new-session requests, archives and workspace changes replace a session.
   * Daily/context rotation used to create an empty history and rely on optional memory.
   * Keep ordinary conversation in its native session; DSH owns context compaction.
   * Native tasks and approvals therefore retain both their binding and their history.
   */
  private async open(base: SessionId, chatId: string, force?: RotationReason): Promise<{ sessionId: SessionId; reason: RotationReason } | undefined> {
    const roster = this.extras.sessions!;
    const current = SessionId(roster.activeFor(base));
    // A session the user archived in the Web UI answers nothing: DSH's archive gate rejects every one of
    // its steps, so the turn ends `blocked` and no model call is made. The chat has to move on, whatever
    // the calendar or the prompt size say — and it does, even when the session never had a user turn,
    // because there is nothing to wait for otherwise. A session created in the directory the channel worked in
    // before cannot follow it there, so the user's first message after the change opens the next generation
    // in the new one, on the same terms.
    const why: RotationReason | undefined = force ?? (this.archived(current) ? 'archived' : await this.movedAway(current) ? 'moved' : undefined);
    if (!why) return undefined;
    const events = await this.eventsOf(current);
    const timeZone = this.extras.timeZone?.() ?? DEFAULT_TIME_ZONE;
    if (why !== 'archived' && why !== 'moved' && userTurns(events) === 0) return undefined;
    // Create the next session before the roster moves. A failure here leaves the chat on the
    // current generation, and admit answers there instead of dropping the message.
    const sessionId = SessionId(sessionIdAt(base, (roster.get(base)?.generation ?? 0) + 1));
    await this.ctx.sessionController.create({ sessionId, cwd: this.workspace });
    const created = await this.ctx.sessionController.resolveAgent(sessionId);
    if ('error' in created) throw created.error;
    await this.group(SessionId(sessionId));
    const next = await roster.rotate(base, why, this.now());
    const active = SessionId(next.sessionId);
    this.routes.set(active, chatId);
    this.chats.set(chatId, active);
    // DSH 0.2 owns task bindings and wakes their original Sessions, including older generations.
    // Keeping the task there preserves its timing, delivery history, and workspace permissions.
    const digest = sessionDigest(events, timeZone);
    if (digest) await this.extras.memory?.remember(digest, current).catch(() => { this.report('channel_session_digest_failed'); });
    return { sessionId: active, reason: why };
  }

  async ask(request: AskUserQuestionRequest, next: (signal?: AbortSignal) => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> {
    const chatId = request.agent && this.chatOf(request.agent.id);
    if (!chatId || this.stopped) return next();
    const prompts = request.questions.map((question, index) => this.historicalText(request.agent!.id, questionPrompt(question, index, request.questions.length)));
    if (prompts.some(prompt => prompt.length > 2500)) {
      const local = new AbortController();
      const signal = AbortSignal.any([local.signal, this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
      void this.transport.sendText(chatId, this.historicalText(request.agent!.id, '这个问题需要在本机 DSH 查看完整内容并回答。'),
        identity('local-question', request.agent!.id, ...request.questions.map(question => question.id)), { signal })
        .catch(() => { if (!signal.aborted) this.promptDeliveryFailed(request, request.agent!.id); });
      try {
        const answer = await next(signal);
        if (!request.signal?.aborted) this.desktopReceipt(chatId, desktopQuestionReceipt(request, answer), identity('desktop-question', request.agent!.id, crypto.randomUUID()), request.agent!.id);
        return answer;
      } finally { local.abort(); this.failedInteractions.delete(request); }
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
    const remote = async () => {
      const answers = [];
      for (const [index, question] of request.questions.entries()) {
        signal.throwIfAborted();
        const pending = this.questions.open(chatId, question, index === request.questions.length - 1, signal);
        // Do not delay native presentation or settlement on a slow channel send.
        void this.transport.sendText(chatId, `${prompts[index]}\n也可在本机 DSH 回答；任一端完成整组回答后另一端失效。\n多项问题同时等待时：回答 ${pending.token} 内容`,
          identity('question', pending.token), { signal }).then(pending.presented, () => {
            if (!signal.aborted) this.promptDeliveryFailed(request, request.agent!.id);
            pending.unavailable();
          });
        answers.push(await pending.outcome);
      }
      return { answers };
    };
    const result = await firstAvailable([
      remote().then(value => ({ source: 'channel', value })),
      Promise.resolve().then(() => next(signal)).then(value => ({ source: 'desktop', value })),
    ], () => true).finally(() => { lifetime.abort(); this.failedInteractions.delete(request); });
    if (result.source === 'desktop' && !request.signal?.aborted) {
      this.desktopReceipt(chatId, desktopQuestionReceipt(request, result.value), identity('desktop-question', request.agent!.id, crypto.randomUUID()), request.agent!.id);
    }
    return result.value;
  }

  /** Queue a produced result before later turn replies; network delivery cannot block the decision. */
  private readonly failedInteractions = new Map<object, { sessionId: string; warning: string }>();

  private promptDeliveryFailed(request: object, sessionId: string): void {
    const channel = this.config.channel === 'wechat' ? '微信' : this.config.channel === 'feishu' ? '飞书' : '企业微信';
    this.failedInteractions.set(request, { sessionId, warning: `本会话有审批或提问未完整送达${channel}，请在电脑端处理。本次提示不会自动补发；渠道发送状态可在设置中查看。` });
    this.report('channel_interaction_delivery_failed');
  }

  interactionWarning(sessionId: string): string | undefined {
    if (this.stopped) return;
    return [...this.failedInteractions.values()].find(item => item.sessionId === sessionId)?.warning;
  }

  private desktopReceipt(chatId: string, text: string | undefined, deliveryId: string, sessionId?: string): void {
    if (!text || this.stopped) return;
    this.outgoing = this.outgoing.then(async () => {
      if (!this.stopped) await this.transport.sendText(chatId, sessionId ? this.historicalText(sessionId, text) : text, deliveryId, { durable: true,
        ...(sessionId ? { batchKey: identity('desktop-receipts', sessionId) } : {}) });
    }).catch(() => { this.report('channel_desktop_receipt_failed'); });
  }

  private async status(base: SessionId, sessionId: SessionId, chatId: string): Promise<string> {
    if (this.replies.hasPending(chatId)) return '当前任务等待审批。回复“允许”或“拒绝”；多项审批请带上对应编号。';
    if (this.questions.hasPending(chatId)) return '当前任务等待你的回答。请按最新问题回复“回答 选项编号”或“回答 自由文本”。';
    if (this.admissions.has(base)) return '消息正在提交到 DSH。';
    const live = this.ctx.sessions.get(sessionId);
    const events = live ? live.snapshotEvents() : await storedEvents(this.ctx, sessionId, this.lifetime.signal);
    const boundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    if (boundary?.type === 'turn/start') return live ? '当前任务正在执行。停止当前执行：/cancel'
      : '上次执行没有结束记录，请在本机 DSH 查看恢复状态。';
    const reminders = describeReminders(await this.reminders(sessionId));
    const legacy = activeLegacyReminders(events).length;
    const tail = (reminders.length ? `\n待触发的提醒（${reminders.length}）：\n${reminders.join('\n')}` : '')
      + (legacy ? `\n此会话还有 ${legacy} 条旧版提醒尚未迁移，新版不会执行；请在本机查看并重新建立。` : '');
    if (boundary?.type === 'turn/end') return (boundary.data.reason.kind === 'completed'
      ? '当前没有执行中的任务，上一轮已完成。' : '上一轮执行未完成，详情可在本机 DSH 查看。') + tail;
    return '当前没有任务记录，发送文字即可开始。' + tail;
  }

  async approve(request: ApprovalRequest, next: (signal?: AbortSignal) => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    const chatId = this.chatOf(request.agent.id);
    if (!chatId || this.stopped) return next();
    const call = request.agent.session.snapshotEvents().findLast(event =>
      event.type === 'tool/call' && event.data.callId === request.callId);
    const args = call?.type === 'tool/call' ? call.data.arguments : undefined;
    let title = request.toolName;
    let parameters = args ?? '';
    if (args && args.length <= 2500) {
      try {
        const parsed = JSON.parse(args);
        parameters = JSON.stringify(parsed, null, 2);
        if (typeof parsed?.description === 'string') title = parsed.description;
      } catch { /* Preserve the exact original arguments if they cannot be formatted. */ }
    }
    const prompt = this.historicalText(request.agent.id, `需要你确认后继续\n操作：${title}\n${request.reason ? `原因：${request.reason}\n` : ''}完整参数：\n${parameters}`);
    // Exact arguments must fit in the remote prompt. Larger or unbound requests remain in the native UI.
    if (!args || prompt.length > 2500) {
      const local = new AbortController();
      const signal = AbortSignal.any([local.signal, this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
      void this.transport.sendText(chatId, this.historicalText(request.agent.id, '此操作需要在本机 DSH 查看完整参数并审批。'),
        identity('local-approval', request.agent.id, String(request.callId)), { signal })
        .catch(() => { if (!signal.aborted) this.promptDeliveryFailed(request, request.agent.id); });
      try {
        const outcome = await next(signal);
        if (!request.signal?.aborted) this.desktopReceipt(chatId, desktopApprovalReceipt(title, outcome), identity('desktop-approval', request.agent.id, String(request.callId), crypto.randomUUID()), request.agent.id);
        return outcome;
      } finally { local.abort(); this.failedInteractions.delete(request); }
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, this.lifetime.signal, ...(request.signal ? [request.signal] : [])]);
    const pending = this.replies.open(chatId, signal);
    void this.transport.sendText(chatId,
      `${prompt}\n\n也可在本机 DSH 审批；任一端处理后另一端失效。\n只有一项待审批时，直接回复“允许”或“拒绝”。\n` +
      `多项待审批时，请回复对应指令：\n允许 ${pending.token}\n拒绝 ${pending.token}\n` +
      (this.historicalChannel(request.agent.id) ? '有效期 10 分钟，仅本次操作。停止此历史任务请在电脑端操作。' : '有效期 10 分钟，仅本次操作。停止当前执行：/cancel'),
      identity('approval', pending.token), { signal }).then(pending.presented, () => {
        if (!signal.aborted) this.promptDeliveryFailed(request, request.agent.id);
        this.replies.answer(chatId, pending.token, 'unavailable');
      });
    const result = await firstAvailable([
      pending.outcome.then(value => ({ source: 'channel', value })),
      Promise.resolve().then(() => next(signal)).then(value => ({ source: 'desktop', value })),
    ], result => result.value !== 'unavailable').finally(() => { lifetime.abort(); this.failedInteractions.delete(request); });
    if (result.source === 'desktop' && !request.signal?.aborted) {
      this.desktopReceipt(chatId, desktopApprovalReceipt(title, result.value), identity('desktop-approval', pending.token), request.agent.id);
    }
    return result.value;
  }

  onEvent(session: Session, event: SessionEvent): void {
    if (this.stopped) return;
    const chatId = this.chatOf(session.id);
    if (!chatId) return;
    if (event.type === 'step/start') { this.armHeartbeat(session, chatId, event.data.turn); return; }
    if (event.type !== 'turn/end') return;
    this.disarmHeartbeat(session.id);
    const events = session.snapshotEvents().filter(item => item.seq <= event.seq);
    this.outgoing = this.outgoing.then(async () => {
      if (this.stopped) return;
      // Catch-up may have sent this turn already while it was being reported live; a mark alone is not enough to skip,
      // since a session seen for the first time is marked at its current end without anything being sent.
      if (this.caughtUp.has(`${session.id}:${event.data.turn}`)) return;
      if (!await this.ctx.sessions.flush(session)) throw new Error('native_session_not_persisted');
      await this.deliver(chatId, session.id, event, events);
      await this.extras.ledger?.set(session.id, event.data.turn, this.now());
    }).catch(() => { this.report('channel_delivery_failed'); });
  }

  async drain(): Promise<void> { await this.outgoing; }

  /**
   * The first model step of a turn the user started arms the heartbeat. A turn a
   * reminder or job notice started is a push and stays silent until it ends.
   */
  private armHeartbeat(session: Session, chatId: string, turn: number): void {
    const existing = this.heartbeats.get(session.id);
    if (existing?.turn === turn) return;
    if (existing) clearTimeout(existing.timer);
    this.heartbeats.delete(session.id);
    const events = session.snapshotEvents();
    if (!this.deliverableTurn(session.id, events, turn)) return;
    const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn);
    const typed = events.slice(Math.max(start, 0)).filter(event => event.type === 'user/message');
    const userStarted = typed.length > 0 && typed.some(event => event.type === 'user/message' && !pluginInitiated(event.data)
      && !String((event.data.source as { rpcId?: unknown }).rpcId ?? '').includes('-hook-'));
    if (!userStarted) return;
    const state = { turn, startedAt: this.now(), count: 0, timer: setTimeout(() => { void this.beat(session, chatId, turn); }, this.heartbeat.firstMs) };
    state.timer.unref?.();
    this.heartbeats.set(session.id, state);
  }

  private disarmHeartbeat(sessionId: SessionId): void {
    const state = this.heartbeats.get(sessionId);
    if (!state) return;
    clearTimeout(state.timer);
    this.heartbeats.delete(sessionId);
  }

  private async beat(session: Session, chatId: string, turn: number): Promise<void> {
    const state = this.heartbeats.get(session.id);
    if (this.stopped || !state || state.turn !== turn) return;
    // One unsolicited progress reminder per WeChat turn leaves room for approvals and results.
    if (this.config.channel === 'wechat' && state.count > 0) return;
    const reschedule = () => { state.timer = setTimeout(() => { void this.beat(session, chatId, turn); }, this.heartbeat.everyMs); state.timer.unref?.(); };
    const events = session.snapshotEvents();
    if (!this.deliverableTurn(session.id, events, turn)) { this.disarmHeartbeat(session.id); return; }
    const boundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    if (!boundary || boundary.type === 'turn/end' || boundary.data.turn !== turn) { this.disarmHeartbeat(session.id); return; }
    // The user already holds a prompt from us; a heartbeat on top would only add noise.
    if (this.replies.hasPending(chatId) || this.questions.hasPending(chatId)) { reschedule(); return; }
    const lastCall = events.findLast(event => event.type === 'tool/call' && event.data.turn === turn);
    const text = heartbeatText(this.now() - state.startedAt, lastCall?.type === 'tool/call' ? describeToolCall(lastCall.data) : undefined);
    state.count++;
    // Not durable: a heartbeat that cannot be sent now is stale by the time it could be.
    await this.transport.sendText(chatId, this.historicalText(session.id, text), identity('heartbeat', session.id, String(turn), String(state.count)))
      .catch(() => { this.report('channel_heartbeat_failed'); });
    if (this.heartbeats.get(session.id) === state) reschedule();
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.lifetime.abort();
    for (const sessionId of [...this.heartbeats.keys()]) this.disarmHeartbeat(sessionId);
    this.replies.close();
    this.questions.close();
    await this.transport.stop();
    await Promise.allSettled([...this.admissions.values(), this.outgoing]);
  }

  private async deliver(chatId: string, sessionId: SessionId,
    end: Extract<SessionEvent, { type: 'turn/end' }>, events: readonly SessionEvent[]): Promise<void> {
    const turn = end.data.turn;
    if (!this.deliverableTurn(sessionId, events, turn)) return;
    const last = events.findLast(event => event.type === 'assistant/message' && event.data.turn === turn);
    const text = last?.type === 'assistant/message'
      ? last.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim() : '';
    const completed = end.data.reason.kind === 'completed';
    // A turn the user did not start (a due reminder, a job notice) is a push: a quiet reply means "nothing to report".
    const start = events.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn);
    const typed = events.slice(Math.max(start, 0)).filter(event => event.type === 'user/message' && event.seq <= end.seq);
    // Hook-injected events arrive as user-sourced messages with a hook request id; they are pushes too.
    const pushed = typed.length > 0 && typed.every(event => event.type === 'user/message' && (pluginInitiated(event.data)
      || String((event.data.source as { rpcId?: unknown }).rpcId ?? '').includes('-hook-')));
    if (pushed && completed && isQuietReply(text)) return;
    const deliveryId = identity('turn', sessionId, String(turn));
    if (pushed && this.gate?.quiet()) {
      // The user asked not to be disturbed: keep the reply for the digest instead of sending it now.
      await this.gate.hold(sessionId, this.historicalText(sessionId, completed ? (text || '本轮已结束，详情可在本机 DSH 查看。') : [text, '本轮执行未完成，详情可在本机 DSH 查看。'].filter(Boolean).join('\n\n')), deliveryId);
      return;
    }
    const notice = completed ? (text || '本轮已结束，详情可在本机 DSH 查看。')
      : [text, '本轮执行未完成，详情可在本机 DSH 查看。'].filter(Boolean).join('\n\n');
    // The words always go out as text. A spoken reply was tried on 2026-09-22 and removed: iLink accepted the voice
    // item but the WeChat client rendered nothing for it, in both upload slots and with either codec it declares.
    await this.transport.sendText(chatId, this.historicalText(sessionId, notice), deliveryId, { durable: true });
    if (!completed) return;
    const files = new Set(events.flatMap(event =>
      event.type === 'deliverables/presented' && event.data.turn === turn ? event.data.files.map(file => file.path) : []));
    const request = typed.flatMap(event => event.type === 'user/message' && !pluginInitiated(event.data)
      ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : []).join('\n');
    const workspace = files.size ? await this.workspaceOf(sessionId) : this.workspace;
    for (const path of files) {
      try {
        const file = await readDelivery(workspace, path);
        await this.transport.sendFile(chatId, file, identity(deliveryId, path));
        await this.extras.files?.record({ kind: 'outbound', path, name: file.name, bytes: file.bytes.length, sessionId, request, note: text })
          .catch(() => { this.report('channel_file_ledger_failed'); });
      } catch {
        this.report('channel_file_delivery_failed');
        await this.transport.sendText(chatId, '有文件未能回传，请在本机 DSH 查看；仅回传工作区内、10 MiB 以内的普通文件。',
          identity(deliveryId, path, 'failed'), { durable: true });
      }
    }
  }
}

/** Appended to a message whose text came from speech, so the model reads it with homophones in mind rather than as typed. */
export const TRANSCRIBED_NOTE = '\n（以上文字由语音转写，可能有同音字或断句错误，按上下文理解。）';

const droppedKinds: Record<DroppedAttachment['kind'], string> = { image: '图片', file: '文件', voice: '语音', video: '视频' };
export function describeDropped(dropped: readonly DroppedAttachment[]): string {
  const reasons: Record<DroppedAttachment['reason'], string> = {
    unsupported: '暂不支持这种消息，请改发文字、图片或文件',
    too_large: '超过 20 MB 的接收上限，请在本机处理或压缩后再发',
    download_failed: '下载失败，请稍后重发',
    decode_failed: '语音解码失败，请重发或改发文字',
  };
  return dropped.map(item => `${droppedKinds[item.kind]}未能接收：${reasons[item.reason]}。`).join('\n');
}

/** What the user hears when a voice clip without a transcript could not be turned into text. */
export function voiceNotice(code: string): string {
  if (code === 'speech_not_configured') {
    return '这条语音没有附带文字，暂时听不懂。可以在微信里长按语音选“转文字”后再发，或改发文字；也可以在设置页“助理 → 语音”里配置转写服务，之后这类语音会自动转写。';
  }
  const reasons: Record<string, string> = { speech_unauthorized: '转写服务拒绝了密钥', connection_timeout: '连接转写服务超时', connection_failed: '连不上转写服务',
    speech_empty: '转写结果为空', speech_failed: '转写服务出错' };
  return `语音转写失败：${reasons[code] ?? '转写服务出错'}。请稍后重发，或改发文字。`;
}

/** DSH's session and approval event shapes are interpreted only in this module. */
export function installBridge(ctx: Context, transport: ChannelTransport,
  identity: ChannelIdentity, workspace: string, report: (code: string) => void, heartbeat?: HeartbeatOptions, extras?: BridgeExtras): DshChannelBridge {
  const bridge = new DshChannelBridge(ctx, transport, identity, workspace, report, heartbeat, undefined, extras);
  ctx.on('approval/request', (request, next) => isNativeMirror(request) ? next() : bridge.approve(request, signal => signal ? nativeApproval(ctx, request, signal) : next()), { prepend: true });
  ctx.on('user-questions/request', (request, next) => isNativeMirror(request) ? next() : bridge.ask(request, signal => signal ? nativeQuestion(ctx, request, signal) : next()), { prepend: true });
  ctx.on('session/event', (session, event) => bridge.onEvent(session, event));
  ctx.effect(() => () => bridge.close());
  return bridge;
}
