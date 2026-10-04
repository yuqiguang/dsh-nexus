import { CODER_WORK_GUIDANCE } from './prompt.js';
import { sameChat } from '../channels/protocol.js';
import { analyzeChange, type BriefChange } from './change.js';
import { recoveryReport } from './recovery.js';
import { briefTasks, criterionEvidence, deliveryReport, type AcceptanceReview } from './delivery.js';
import { planSchema, validatePlan } from './plan.js';
import type { Context } from '@deepseek-ai/cordis';
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { isActive, type TaskRecord } from './types.js';
import { dependencyPassed } from './dependencies.js';
import { taskStatusLabel } from './status.js';
import { isInside } from './rules.js';
import { changeSummary } from './change-summary.js';

export const briefSnapshotSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), objective: z.string().min(1).max(4000), constraints: z.string().max(4000),
  cwd: z.string().min(1).optional(),
  acceptance: z.array(z.object({ id: z.string(), text: z.string().min(1).max(500) })).min(1).max(20),
});
export type BriefSnapshot = z.infer<typeof briefSnapshotSchema>;
const briefSchema = briefSnapshotSchema.extend({ answers: z.array(z.object({ key: z.string(), answers: z.record(z.string(), z.string()) })).optional(), reviews: z.array(z.object({ criterion: z.string(), evidence: z.string(), accepted: z.boolean(), note: z.string(), at: z.number() })).optional(), plan: planSchema.optional(), ownerSession: z.string(), createdAt: z.number(), updatedAt: z.number() });
export type CoderBrief = z.infer<typeof briefSchema>;
const inputSchema = z.object({ objective: z.string().trim().min(1).max(4000), constraints: z.string().trim().max(4000).default(''),
  cwd: z.string().trim().min(1).optional(),
  acceptance: z.array(z.string().trim().min(1).max(500)).min(1).max(20) });
export const briefDomain = defineDomain({ name: 'nexus_coder_briefs', version: 1, layout: 'per-record',
  tables: { briefs: domainTable<string, CoderBrief>(briefSchema) } });

/**
 * Planning evidence only. No execution lifecycle or autonomous recovery is stored here. A brief belongs to the chat, not to
 * one generation of it: a rotating chat keeps asking about a goal it set earlier, so every generation of the same chat may
 * read and revise it (ct-4c671559).
 */
export class BriefStore {
  constructor(private readonly domain: Domain<typeof briefDomain>) {}
  private readonly changing = new Set<string>();
  isChanging(id: string): boolean { return this.changing.has(id); }
  private get table() { return this.domain.table('briefs'); }
  get(id: string, owner: string): CoderBrief {
    const brief = this.table.get(id);
    if (!brief || !sameChat(brief.ownerSession, owner)) throw new Error('任务说明单不存在或不属于当前会话。');
    return brief;
  }
  list(owner: string): CoderBrief[] { return [...this.table.entries()].map(([, brief]) => brief).filter(brief => sameChat(brief.ownerSession, owner)).sort((a, b) => b.updatedAt - a.updatedAt); }
  async save(owner: string, input: unknown, id?: string, revision?: number): Promise<CoderBrief> {
    if (id && this.changing.has(id)) throw new Error('说明单正在应用变更，请稍后重试。');
    const existing = id ? this.get(id, owner) : undefined;
    const fieldsInput = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const parsed = inputSchema.safeParse({ ...fieldsInput, cwd: fieldsInput.cwd ?? existing?.cwd, constraints: fieldsInput.constraints ?? existing?.constraints ?? '' });
    if (!parsed.success) throw new Error('请提供目标、约束和 1 至 20 条验收标准；目标与约束各最多 4000 字，单条标准最多 500 字。');
    const fields = { ...parsed.data, acceptance: parsed.data.acceptance.map((text, index) => ({ id: `a${index + 1}`, text })) };
    if (id) {
      this.get(id, owner);
      return this.table.update(id, current => {
        if (!sameChat(current.ownerSession, owner) || current.revision !== revision) throw new Error('任务说明单版本已变化，请重新读取后再修改。');
        return { ...current, ...fields, plan: undefined, answers: undefined, reviews: undefined, revision: current.revision + 1, updatedAt: Date.now() };
      });
    }
    const brief = { ...fields, id: `cb-${randomBytes(8).toString('hex')}`, ownerSession: owner, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
    await this.table.put(brief.id, brief);
    return brief;
  }
  async plan(id: string, owner: string, revision: number | undefined, input: unknown): Promise<CoderBrief> {
    if (this.changing.has(id)) throw new Error('说明单正在应用变更。');
    const brief = this.get(id, owner);
    const plan = validatePlan(input, brief.acceptance);
    return this.table.update(id, current => {
      if (!sameChat(current.ownerSession, owner) || current.revision !== revision) throw new Error('任务说明单版本已变化，请重新读取后再保存计划。');
      return { ...current, plan, answers: undefined, reviews: undefined, revision: current.revision + 1, updatedAt: Date.now() };
    });
  }
  /** Bind the first admitted project's directory without changing its goal revision. */
  async bindDirectory(id: string, owner: string, revision: number, cwd: string): Promise<void> {
    this.get(id, owner);
    await this.table.update(id, current => {
      if (!sameChat(current.ownerSession, owner) || current.revision !== revision || this.changing.has(id)) throw new Error('任务说明单版本已变化，请重新读取后再派发。');
      if (current.cwd && !isInside(current.cwd, cwd)) throw new Error(`任务目录必须位于说明单绑定的项目目录内：${current.cwd}`);
      return current.cwd ? current : { ...current, cwd };
    });
  }
  answer(id: string, owner: string, revision: number, key: string): Record<string, string> | undefined {
    const brief = this.get(id, owner);
    return brief.revision === revision ? brief.answers?.find(item => item.key === key)?.answers : undefined;
  }
  async rememberAnswer(id: string, owner: string, revision: number, key: string, answers: Record<string, string>): Promise<void> {
    this.get(id, owner);
    await this.table.update(id, current => current.revision !== revision ? current : { ...current,
      answers: [...(current.answers ?? []).filter(item => item.key !== key), { key, answers }].slice(-50) });
  }
  async review(id: string, owner: string, revision: number, review: AcceptanceReview): Promise<void> {
    this.get(id, owner);
    await this.table.update(id, current => {
      if (!sameChat(current.ownerSession, owner) || current.revision !== revision) throw new Error('验收期间目标已变化，请重新核对。');
      return { ...current, updatedAt: Date.now(), reviews: [...(current.reviews ?? []).filter(item => item.criterion !== review.criterion), review] };
    });
  }
  async amend(id: string, owner: string, revision: number | undefined, change: BriefChange, stop: () => Promise<void>): Promise<CoderBrief> {
    const brief = this.get(id, owner);
    if (brief.revision !== revision || this.changing.has(id)) throw new Error('目标版本已变化或正在修改，请重新读取。');
    if (change.objective === brief.objective && change.constraints === brief.constraints && JSON.stringify(change.acceptance) === JSON.stringify(brief.acceptance.map(item => item.text)) && JSON.stringify(change.steps) === JSON.stringify(brief.plan)) throw new Error('目标和计划没有变化，无需停止任务。');
    const parsed = inputSchema.safeParse(change);
    if (!parsed.success) throw new Error('新目标或验收标准无效。');
    this.changing.add(id);
    try {
      await stop();
      return await this.table.update(id, current => {
        if (current.revision !== revision) throw new Error('目标版本已变化。');
        return { ...current, ...parsed.data, acceptance: parsed.data.acceptance.map((text, index) => ({ id: `a${index + 1}`, text })),
          plan: change.steps, answers: undefined, reviews: undefined, revision: current.revision + 1, updatedAt: Date.now() };
      });
    } finally { this.changing.delete(id); }
  }
  snapshot(id: string, owner: string, revision: number | undefined, ids: string[] | undefined): BriefSnapshot {
    if (this.changing.has(id)) throw new Error('说明单正在应用变更，暂不派发。');
    const brief = this.get(id, owner);
    if (brief.revision !== revision) throw new Error('任务说明单版本不匹配，请重新读取当前目标后再派发。');
    if (!ids?.length || ids.length > 20 || ids.some(id => !brief.acceptance.some(item => item.id === id))) throw new Error('请选择本任务覆盖的验收项 acceptance_ids。');
    return briefSnapshotSchema.parse({ ...brief, acceptance: brief.acceptance.filter(item => ids.includes(item.id)) });
  }
  close(): Promise<void> { return this.domain.close(); }
}

/** Coverage is evidence, never a mechanical claim that the user's whole goal was met. */
export function briefReport(brief: CoderBrief, records: TaskRecord[]): string {
  const tasks = briefTasks(brief, records);
  const lines = [`任务说明单 ${brief.id}，版本 ${brief.revision}`, `目标：${brief.objective}`, `项目目录：${brief.cwd ?? '尚未绑定；首次派发的实际目录将固定为本说明单的项目目录'}`, `约束：${brief.constraints || '未补充'}`, '验收覆盖：'];
  for (const criterion of brief.acceptance) {
    const related = tasks.filter(task => task.brief!.acceptance.some(item => item.id === criterion.id));
    const state = !related.length ? '尚未安排' : related.some(isActive) ? '进行中或等待中' : related.some(task => ['failed', 'cancelled', 'interrupted'].includes(task.status))
      ? '有失败、取消或中断，需复核' : related.every(dependencyPassed) ? '关联任务验证通过，待需求验收' : '任务执行结束，尚未全部独立验证';
    lines.push(`- ${criterion.id}：${criterion.text} — ${state}${related.length ? `（${related.map(task => task.id).join('、')}）` : ''}`);
  }
  if (brief.plan) lines.push('步骤计划（依赖顺序；尚未派发不代表已执行）：', ...brief.plan.map(step => `${step.id}：${step.description}；验收项 ${step.acceptance_ids.join('、')}；前置步骤 ${step.depends_on.join('、') || '无'}；验证 ${step.verify}`));
  const obsolete = records.filter(task => sameChat(task.ownerSession, brief.ownerSession) && task.brief?.id === brief.id && task.brief.revision !== brief.revision && isActive(task));
  if (obsolete.length) lines.push(`旧版本仍有活动任务：${obsolete.map(task => task.id).join('、')}。运行中的任务仍按原说明执行；修改说明单不会自动调整已运行任务，请明确停止或调整它们。`);
  lines.push('任务结果：', ...(tasks.length ? tasks.slice(0, 50).map(task => {
    const changes = changeSummary(task.result?.changedFiles ?? []);
    return `${task.id}${task.planStep ? `（步骤 ${task.planStep}）` : ''} ${taskStatusLabel(task)}：${task.description.slice(0, 160)}${task.verify ? `；验证：${[task.verify, ...(task.verifyCommands ?? [])].join('；')}` : ''}${task.result ? `；项目文件 ${changes.project.length}，依赖 ${changes.dependencies.length}，测试/缓存产物 ${changes.generated.length}；${(task.result.detail || task.result.summary).slice(0, 240)}` : ''}`;
  }) : ['尚无本版本的关联任务。']),
    ...(tasks.length > 50 ? [`另有 ${tasks.length - 50} 个任务未展开；验收覆盖仍统计全部关联任务。`] : []),
    '以上仅汇总任务与检查证据，不代表完整目标已验收；未关联的要求和实际业务效果仍需主助手核对。');
  return lines.join('\n');
}

export function coderPrompt(task: Pick<TaskRecord, 'description' | 'continuation' | 'brief' | 'verify' | 'verifyCommands' | 'verifyCwd' | 'permissions'>): string {
  const description = task.description + CODER_WORK_GUIDANCE + (task.continuation ? `\n\n[本次续接说明]\n${task.continuation}\n仍须满足已保存的目标、共同约束和完整验收；不能用续接说明替换或缩小它们。` : '')
    + (task.permissions?.securityMode === 'full' ? '\n\n[执行权限]\n本任务已由设置授予完全权限：可用当前系统用户权限访问项目外文件、联网和运行命令，无执行沙箱或逐项权限审批；不需要为常规执行再申请权限。仍按用户目标工作，实质歧义应澄清；避免在输出中暴露密钥。' : '\n\n[环境配置与执行检查]\n项目内 .env.example、.env.sample、.env.template 可用原生文件工具创建或修改，只填空值、占位符及本地非敏感配置。实际 .env 写入在标准模式下申请所列文件的单次用户确认，不读取或打印已有密钥。不要用 shell 命令改写配置来绕过文件审批。运行测试优先指定测试文件或目录，使用可检查的项目脚本；避免反复申请同一被拒操作。')
    + (task.brief ? '\n先核对实际项目目录和所需运行环境。发现环境或依赖加载失败，先定位并采用可恢复的修复，不通过删除依赖、改写测试或换技术栈掩盖真实启动失败。' : '')
    + (task.verify ? `\n\n[DSH 独立验证约定]\n任务结束后宿主将在 ${task.verifyCwd ?? '任务目录'} 按顺序运行：\n${[task.verify, ...(task.verifyCommands ?? [])].map(command => `- ${command}`).join('\n')}\n请准备这些验证所需的文件。修改中先做必要的针对性自测，不为收尾形式再重复整套验收；宿主会独立执行上述命令。任何一项失败或未执行都不能报告全部验收通过。` : '');
  if (!task.brief) return description;
  return `${description}\n\n[派发时的任务说明单 ${task.brief.id}，版本 ${task.brief.revision}]\n总体目标：${task.brief.objective}\n共同约束：${task.brief.constraints || '无补充'}\n本任务负责的验收项：\n${task.brief.acceptance.map(item => `${item.id}. ${item.text}`).join('\n')}\n只完成本任务负责的部分，不把单个子任务完成表述为整个目标已完成。已明确的目标不重复澄清；技术细节先查项目，只有影响目标、范围或授权的新问题才反馈。说明单不会扩大工具权限。`;
}

export async function installBriefs(ctx: Context, records: () => TaskRecord[], stopTasks?: (tasks: TaskRecord[]) => Promise<void>, askUser?: (request: Parameters<typeof ctx.userQuestions.ask>[0]) => ReturnType<typeof ctx.userQuestions.ask>, resolveDirectory?: (path: string, exec: ToolRunContext) => Promise<string>): Promise<BriefStore> {
  const store = new BriefStore(await ctx.storageDomain.open(briefDomain));
  ctx.effect(() => () => { void store.close(); });
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_brief',
    description: '记录和查看编码需求的目标、共同约束与验收项。复杂需求先保存说明单，普通修复无需创建；默认一个完整任务，确需独立验收或阶段依赖时才 plan 拆分，每步声明验收项、前置步骤、验证和 outputs。先核实运行环境，项目初始化不能用改写测试掩盖服务启动失败。续接保留计划、约束和验收；目标变更先 impact 再 amend，失败用 recover，交付用 delivery 并按需 review。它不启动任务，也不创建、完成或恢复原生 goal；查询时汇总当前版本的任务和验证证据，不能把子任务完成当作整个目标完成。',
    parameters: {
      action: { type: 'string', enum: ['save', 'plan', 'get', 'list', 'delivery', 'review', 'recover', 'impact', 'amend'], required: true, description: 'save 新建或修改（清除旧步骤计划）；plan 保存完整步骤计划并检查覆盖、引用和循环依赖；get 查询覆盖；list 列表；delivery 交付汇总；review 用户验收；recover 恢复清单；impact 预览变更；amend 停止旧版活动任务后应用新版本。' },
      brief_id: { type: 'string', description: 'get 或修改时必填。' },
      revision: { type: 'integer', description: '修改时填写刚读取的版本；旧版本会被拒绝。' },
      cwd: { type: 'string', description: 'save 时可指定项目根目录（相对于当前会话工作区）；新项目应在这里绑定目录。省略时首次派发会固定实际目录。后续步骤默认沿用，不能越出项目或会话边界。' },
      criterion: { type: 'string', description: 'review 必填，向用户确认的具体验收项 ID。' },
      note: { type: 'string', description: 'review 可填，向用户说明核验方式与实际结果，最多 1000 字；不能代替用户确认。' },
      steps: { type: 'array', description: 'plan 必填，完整步骤列表。保存成功会生成新版本；不启动任务。需要已有运行环境的步骤用 preflight 登记环境自检脚本；outputs 列预期文件以便提前检查保护规则。', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, description: { type: 'string', required: true }, acceptance_ids: { type: 'array', items: { type: 'string' }, required: true }, depends_on: { type: 'array', items: { type: 'string' }, required: true }, verify: { type: 'string', required: true }, preflight: { type: 'string' }, outputs: { type: 'array', items: { type: 'string' } } } } },
      objective: { type: 'string', description: '用户目标，不自行扩大范围。save 必填。' },
      constraints: { type: 'string', description: '用户已明确的范围、约束及关键决定。save 时完整填写。' },
      acceptance: { type: 'array', items: { type: 'string' }, description: '1 至 20 条具体可核验的验收标准。save 必填。修改会生成新版本，旧任务不自动计入新版本。' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('任务说明单只能在会话中使用。');
      const owner = exec.agent.id;
      if (args.action === 'list') return { text: store.list(owner).slice(0, 10).map(brief => `${brief.id} v${brief.revision}：${brief.objective.slice(0, 160)}`).join('\n') || '当前会话还没有任务说明单。' };
      if (['save', 'plan', 'review', 'amend'].includes(args.action) && ctx.sandboxPolicy?.resolve({ session: exec.agent.session }).mode === 'read-only') throw new Error('只读会话不能修改任务说明单。');
      if (['get', 'plan', 'delivery', 'review', 'recover', 'impact', 'amend'].includes(args.action) && !args.brief_id) throw new Error('get 和 plan 需要 brief_id。');
      if (args.action === 'impact' || args.action === 'amend') {
        const brief = store.get(args.brief_id!, owner);
        const change = analyzeChange(brief, args);
        const active = records().filter(task => sameChat(task.ownerSession, owner) && task.brief?.id === brief.id && isActive(task));
        const impact = `受影响步骤：${change.affected.join('、') || '未发现结构变化'}；应用时会停止旧版本活动任务：${active.map(task => task.id).join('、') || '无'}。新版本需要重新核对验收，旧记录保留。`;
        if (args.action === 'impact') return { text: impact };
        const amended = await store.amend(brief.id, owner, args.revision, change, async () => {
          if (active.length && !stopTasks) throw new Error('任务停止服务不可用，未应用变更。');
          await stopTasks?.(active);
        });
        return { text: `${impact}\n${briefReport(amended, records())}` };
      }
      if (args.action === 'recover') return { text: recoveryReport(store.get(args.brief_id!, owner), records()) };
      if (args.action === 'delivery' || args.action === 'review') {
        const brief = store.get(args.brief_id!, owner);
        if (args.action === 'review') {
          if (brief.revision !== args.revision || !args.criterion) throw new Error('review 需要当前 revision 和 criterion。');
          const state = criterionEvidence(brief, records(), args.criterion);
          if (!state.settled) throw new Error('该验收项尚未关联任务或任务仍在执行，请先完成工作。');
          const note = (args.note ?? '').slice(0, 1000);
          const answer = await (askUser ?? (request => ctx.userQuestions.ask(request)))({ agent: exec.agent, signal: exec.signal, questions: [{ id: 'accept', question: `请确认业务验收：${brief.acceptance.find(item => item.id === args.criterion)!.text}`,
            detail: `${state.checked ? '关联任务的独立检查已通过。' : '关联任务尚未全部通过独立检查。'}${note}\n任务：${state.tasks.map(task => task.id).join('、')}`, options: [{ label: '已满足' }, { label: '未满足' }] }] });
          if (criterionEvidence(brief, records(), args.criterion).evidence !== state.evidence) throw new Error('验收期间任务证据已变化，请重新核对。');
          const selected = answer.answers.find(item => item.id === 'accept');
          if (!selected || selected.selected.length !== 1 || !['已满足', '未满足'].includes(selected.selected[0]!)) throw new Error('未取得明确的业务验收回答。');
          await store.review(brief.id, owner, brief.revision, { criterion: args.criterion, evidence: state.evidence, accepted: selected.selected.includes('已满足'), note: selected.custom?.slice(0, 1000) ?? note, at: Date.now() });
        }
        return { text: deliveryReport(store.get(brief.id, owner), records()) };
      }
      let cwd: string | undefined;
      if (args.cwd !== undefined) {
        if (args.action !== 'save' || !resolveDirectory) throw new Error('项目目录只能通过可验证工作区边界的 save 操作设置。');
        cwd = await resolveDirectory(args.cwd, exec);
      }
      const brief = args.action === 'plan' ? await store.plan(args.brief_id!, owner, args.revision, args.steps) : args.action === 'save' ? await store.save(owner, { ...args, cwd }, args.brief_id, args.revision) : store.get(args.brief_id!, owner);
      return { text: briefReport(brief, records()) };
    },
  })));
  return store;
}
