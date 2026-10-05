import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ModelSelection, SessionSummary } from '@deepseek-ai/dsh-api-session-controller';
import { realpathNormalize } from '@deepseek-ai/dsh-workspace';
import { baseSessionOf, sessionIdAt, type NavigationCommand } from '../channels/protocol.js';
import type { SessionRosterView } from '../sessions/index.js';
import { redact } from '../coders/normalize.js';

const safe = (value: string) => redact(value).replace(/[\r\n\t]/g, ' ').slice(0, 100);
const modelName = (model: ModelSelection) => `${safe(model.provider)}/${safe(model.model)}`;
const MODEL_NOTICE = '只切换聊天助手；已派发的编码任务不变。DSH 同时会保存新会话的默认模型。';
const BUSY = '当前或目标会话仍在执行、等待审批或回答，请先完成或取消后再切换。';

/** Explicit channel controls over native cold reads and model selection; never rebuilds or replays history. */
export class ChannelNavigation {
  private readonly modelMenus = new Map<string, { at: number; choices: ModelSelection[] }>();
  constructor(private readonly ctx: Context, private readonly workspace: string, private readonly roster: SessionRosterView | undefined,
    private readonly signal: AbortSignal, private readonly now: () => number,
    private readonly waiting: (chatId: string, sessions: readonly string[]) => Promise<boolean>,
    private readonly selected: (base: string, chatId: string) => void) {}

  private async eligible(base: string): Promise<SessionSummary[]> {
    const rows = (await this.ctx.sessionController.list({}, this.signal)).items;
    const cwd = await realpathNormalize(this.workspace);
    const result: SessionSummary[] = [];
    for (const row of rows) {
      if (baseSessionOf(row.sessionId) !== base || this.ctx.workspaceRegistry?.archivedSessionIds.includes(row.sessionId) || !row.cwd) continue;
      try { if (await realpathNormalize(row.cwd) === cwd) result.push(row); } catch { /* inaccessible workspace is not selectable */ }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async idle(row: SessionSummary | undefined): Promise<boolean> {
    if (!row) return true;
    const inbox = row.projections?.values.inbox;
    if (row.running || inbox?.['next-turn'].length || inbox?.['next-step'].length) return false;
    const { events } = await this.ctx.sessionController.inspect(row.sessionId, this.signal);
    const last = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end');
    // A cold interrupted turn must be recovered explicitly on the desktop, not resumed by a selector.
    return last?.type !== 'turn/start';
  }

  async run(base: string, chatId: string, command: NavigationCommand): Promise<string> {
    this.signal.throwIfAborted();
    const current = SessionId(this.roster?.activeFor(base) ?? base);
    if (command.kind === 'sessions' || command.kind === 'switch-session') {
      if (!this.roster) return '这个渠道暂不支持切换会话。';
      const rows = await this.eligible(base);
      if (command.kind === 'sessions') {
        if (!rows.length) return '当前聊天还没有可切换的会话。发送文字开始对话。';
        return '当前聊天的近期会话（仅同一身份、同一目录且未归档）：\n' + rows.slice(0, 20).map(row => {
          const number = row.sessionId === base ? '0' : row.sessionId.slice(base.length + 1);
          return `${number}${row.sessionId === current ? ' [当前]' : ''}${row.running ? ' [执行中]' : ''} ${safe(String(row.projections?.values.title ?? '未命名'))} · ${new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
        }).join('\n') + '\n回复“/s 编号”。编号固定，切换沿用原生历史，不自动恢复旧任务。';
      }
      if (!/^(0|[1-9]\d{0,8})$/.test(command.value)) return '请先发送“/s”，再回复“/s 编号”。';
      const target = SessionId(sessionIdAt(base, Number(command.value)));
      const row = rows.find(item => item.sessionId === target);
      if (!row) return '该会话不可切换：仅允许当前聊天、当前目录下未归档且仍存在的会话。';
      if (target === current) return `当前已经是会话 ${command.value}。`;
      if (await this.waiting(chatId, [current, target]) || !await this.idle((await this.ctx.sessionController.list({}, this.signal)).items.find(item => item.sessionId === current)) || !await this.idle(row)) return BUSY;
      // Revalidate after asynchronous inspection, before making the durable routing change.
      const checked = await this.eligible(base);
      if (!checked.some(item => item.sessionId === target) || checked.some(item => (item.sessionId === target || item.sessionId === current) && item.running) || await this.waiting(chatId, [current, target])) return BUSY;
      this.signal.throwIfAborted();
      // Hold attached agents idle through the routing commit; never resolve a cold target just to switch it.
      const commit = async () => { if (await this.waiting(chatId, [current, target])) throw new Error('navigation_busy'); await this.roster!.select(base, target); this.selected(base, chatId); };
      const targetAgent = this.ctx.agents?.get(target);
      const currentAgent = this.ctx.agents?.get(current);
      const holdTarget = () => targetAgent ? targetAgent.runMaintenance(commit) : commit();
      if (currentAgent) await currentAgent.runMaintenance(holdTarget); else await holdTarget();
      return `已切换到会话 ${command.value}，后续消息将沿用这个会话的上下文。原有任务仍留在各自会话中。`;
    }

    const catalog = await this.ctx.sessionController.modelCatalog();
    const choices = catalog.groups.filter(group => catalog.routableProviders.includes(group.id))
      .flatMap(group => group.models.map(model => ({ provider: group.id, model: model.id })));
    if (command.kind === 'models') {
      this.modelMenus.set(chatId, { at: this.now(), choices: choices.slice(0, 40) });
      return (choices.length ? '聊天模型列表：\n' + choices.slice(0, 40).map((model, index) => `${index + 1}. ${modelName(model)}`).join('\n')
        + '\n回复“/m 编号”（10 分钟内有效），或“/m provider/model”。' : 'DSH 当前没有可用模型，请在电脑端配置。')
        + (catalog.failures.length ? '\n部分提供商的模型暂未读取成功。' : '') + '\n' + MODEL_NOTICE;
    }
    const rows = await this.eligible(base);
    const row = rows.find(item => item.sessionId === current);
    if (command.kind === 'model') {
      const selection = row?.projections?.values.modelSelection?.next;
      return (selection ? `当前会话下一轮模型：${modelName(selection)}` : `未读取到会话独立模型；DSH 默认模型：${modelName(catalog.default)}`) + '\n发送“/ml”查看可切换项。';
    }
    let selection: ModelSelection | undefined;
    if (/^[1-9]\d{0,2}$/.test(command.value)) {
      const menu = this.modelMenus.get(chatId);
      if (!menu || this.now() - menu.at >= 10 * 60_000) return '模型编号已失效，请重新发送“/ml”。';
      selection = menu.choices[Number(command.value) - 1];
    } else selection = choices.find(model => `${model.provider}/${model.model}` === command.value);
    if (!selection || !choices.some(model => model.provider === selection!.provider && model.model === selection!.model)) return '该模型当前不可用，请发送“/ml”重新选择。';
    if (await this.waiting(chatId, [current]) || !await this.idle(row)) return BUSY;
    // Never adopt an excluded (moved/archived) session while selecting a model.
    if (!row) {
      const all = (await this.ctx.sessionController.list({}, this.signal)).items;
      if (all.some(item => item.sessionId === current) || this.ctx.workspaceRegistry?.archivedSessionIds.includes(current)) return '当前会话已归档或不在当前目录，请先发送普通消息建立新会话。';
      await this.ctx.sessionController.create({ sessionId: current, cwd: this.workspace });
    }
    const resolved = await this.ctx.sessionController.resolveAgent(current);
    if ('error' in resolved) throw resolved.error;
    const selected = await resolved.agent.runMaintenance(async signal => {
      signal.throwIfAborted();
      this.signal.throwIfAborted();
      if (await this.waiting(chatId, [current])) throw new Error('navigation_busy');
      if (resolved.agent.inbox.nextTurn.length || resolved.agent.inbox.nextStep.length) throw new Error('navigation_busy');
      const result = await this.ctx.sessionController.selectModel({ sessionId: current, ...selection! });
      if (!await this.ctx.sessions.flush(resolved.agent.session)) throw new Error('model_selection_flush_failed');
      return result;
    });
    return `已切换聊天模型为 ${modelName(selected.selected)}，从下一轮开始使用，当前历史保留。\n${MODEL_NOTICE}`;
  }
}
