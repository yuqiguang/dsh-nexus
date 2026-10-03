import { createHash } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { ScheduleInputError, type ScheduleCatalogEntry, type ScheduleRecord, type ScheduleTimingChange } from '@deepseek-ai/dsh-schedule';
import type { BridgeRegistry } from '../channels/notify.js';

/** Compare native task data, excluding changing delivery telemetry. */
function recordOf({ sessionId: _session, status: _status, lastDelivery: _delivery, ...record }: ScheduleCatalogEntry): ScheduleRecord {
  return record;
}
export function automationRevision(entry: ScheduleCatalogEntry): string {
  const record = recordOf(entry);
  return createHash('sha256').update(JSON.stringify([entry.sessionId, entry.status,
    Object.keys(record).sort().map(key => [key, record[key as keyof ScheduleRecord]])])).digest('hex');
}
const view = (entry: ScheduleCatalogEntry) => ({ ...entry, revision: automationRevision(entry), type: 'automation' });
type Args = { action: 'list' | 'update' | 'delete'; id?: string; revision?: string; title?: string; prompt?: string; change?: ScheduleTimingChange };
const failure = (code: string, message: string) => ({ code, message });

/** Management only: DSH keeps the original session, scheduler, inbox and execution. */
export async function manageAutomation(ctx: Context, registry: Pick<BridgeRegistry, 'sameChat'>, args: Args, exec: ToolRunContext): Promise<unknown> {
  const agent = exec.agent;
  const schedule = ctx.get('schedule');
  if (!agent || !schedule || !ctx.tools.get(`schedule_${args.action}`, agent)) {
    return failure('automation_unavailable', '当前会话未启用对应的官方自动化工具，无法查询或修改；不能用日历代替。');
  }
  exec.signal.throwIfAborted();
  if (args.action !== 'list' && ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') {
    return failure('read_only', '只读会话不能修改自动化任务。');
  }
  // Never infer authority from an ID prefix, title, user text or native task state.
  const owns = (entry: ScheduleCatalogEntry) => entry.sessionId === agent.session.id || registry.sameChat(agent.session.id, entry.sessionId);
  const entries = (await schedule.catalog()).filter(owns);
  // Cordis returns traced service wrappers; wrapper identity is not service lifetime.
  const active = ctx.get('schedule');
  if (!active || !ctx.tools.get(`schedule_${args.action}`, agent)) return failure('automation_unavailable', '自动化能力已变化，请重新查询。');
  if (args.action !== 'list' && ctx.sandboxPolicy.resolve({ session: agent.session }).mode === 'read-only') return failure('read_only', '只读会话不能修改自动化任务。');
  if (args.action === 'list') return { type: 'automation', scope: 'current_session_and_configured_chat', tasks: entries.map(view),
    note: '包含同一已绑定聊天的新旧会话；不包含日历或其他聊天。lastDelivery 仅表示进入原会话，不代表工作完成或微信已收到。' };
  const entry = entries.find(item => item.id === args.id);
  if (!entry) return failure('schedule_not_found', '此聊天范围内没有该任务，请先 list；不能据此断言其他会话也没有任务。');
  if (!args.revision || args.revision !== automationRevision(entry)) return failure('schedule_conflict', '任务已变化或缺少 list 返回的 revision，请重新查询后修改。');
  exec.signal.throwIfAborted();
  // A disabled capability or changed route must not grant a stale write.
  if (!ctx.get('schedule') || !ctx.tools.get(`schedule_${args.action}`, agent) || !owns(entry)) {
    return failure('automation_unavailable', '自动化能力或聊天绑定已变化，请重新查询。');
  }
  if (args.action === 'delete') {
    const result = await active.delete({ sessionId: entry.sessionId, id: entry.id }, exec.signal);
    if (!result.deleted) return result;
    if ((await active.catalog()).some(item => item.id === entry.id)) return failure('verification_failed', '删除后核对失败，请先查询，不要声称已删除。');
    return { type: 'automation', id: entry.id, deleted: true, note: '已删除原生自动化；已经进入会话的任务不会撤回。' };
  }
  const result = await active.update({ sessionId: entry.sessionId, id: entry.id, expected: recordOf(entry),
    ...(args.title === undefined ? {} : { title: args.title }), ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    ...(args.change === undefined ? {} : { change: args.change }) }, exec.signal);
  if (!('record' in result)) return result;
  const committed = (await active.catalog()).find(item => item.id === entry.id && item.sessionId === entry.sessionId);
  if (!committed || automationRevision(committed) !== automationRevision({ ...result.record, sessionId: entry.sessionId, status: entry.status })) {
    return failure('verification_failed', '写入后任务再次变化或无法核对，请重新查询；不要重复创建或声称旧值仍有效。');
  }
  return { ...view(committed), updated: result.updated, note: '已核对原生自动化记录；未提供的字段保持原值。' };
}

export function installAutomation(ctx: Context, registry: BridgeRegistry): void {
  const localTime = { time: { type: 'string', required: true }, time_zone: { type: 'string', required: true } } as const;
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'nexus_automation',
    description: '查询和管理同一已绑定聊天的新旧会话中的官方自动化，保留原会话执行和记录。list 返回完整任务和 revision；update/delete 必须使用查询到的 id 与 revision。update 仅替换提供的字段，change 为时间规则。不查询或修改日历。新建仍用 schedule_create，先查重。',
    parameters: {
      action: { type: 'string', enum: ['list', 'update', 'delete'], required: true },
      id: { type: 'string', description: 'list 返回的精确任务 id。' },
      revision: { type: 'string', description: 'list 返回的 revision；过期时重新查询。' },
      title: { type: 'string' }, prompt: { type: 'string', description: '完整执行要求；只改时间时不要提供。' },
      change: { oneOf: [
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'at', required: true }, at: { type: 'string', required: true, description: '带时区偏移的 RFC3339 时间。' } } },
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'every', required: true }, every_seconds: { type: 'integer', required: true } } },
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'daily', required: true }, daily: { type: 'object', additionalProperties: false, required: true, properties: localTime } } },
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'weekly', required: true }, weekly: { type: 'object', additionalProperties: false, required: true, properties: { ...localTime, weekdays: { type: 'array', required: true, items: { type: 'integer' } } } } } },
        { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'cron', required: true }, cron: { type: 'object', additionalProperties: false, required: true, properties: { expression: { type: 'string', required: true }, time_zone: localTime.time_zone } } } },
      ] },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      try { return { text: JSON.stringify(await manageAutomation(ctx, registry, args, exec)) }; }
      catch (error) { return { text: JSON.stringify(error instanceof ScheduleInputError ? failure(error.code, error.message)
        : failure('automation_unconfirmed', '操作结果未能确认，请重新查询；不要重复创建任务或声称已完成。')) }; }
    },
    presentCall: args => ({ card: 'generic', title: '自动化任务', kind: args.action === 'list' ? 'read' : 'other', rawInput: args.id }),
  })));
}
