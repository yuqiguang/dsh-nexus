import { CODER_WORK_GUIDANCE } from './prompt.js';
import { sameChat } from '../channels/protocol.js';
import { analyzeChange, type BriefChange } from './change.js';
import { recoveryReport } from './recovery.js';
import { acceptanceDeferralKey, briefTasks, criterionEvidence, deliveryReport, reviewDeferred, type AcceptanceReview } from './delivery.js';
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
import { acceptanceChecksParameter } from './acceptance-checks.js';
import { currentArtifactEvidence, expectedArtifacts } from './artifacts.js';

export const briefSnapshotSchema = z.object({
  id: z.string(), revision: z.number().int().positive(), objective: z.string().min(1).max(4000), constraints: z.string().max(4000),
  cwd: z.string().min(1).optional(),
  requireUserReview: z.boolean().optional(),
  acceptance: z.array(z.object({ id: z.string(), text: z.string().min(1).max(500) })).min(1).max(20),
});
export type BriefSnapshot = z.infer<typeof briefSnapshotSchema>;
const briefSchema = briefSnapshotSchema.extend({ answers: z.array(z.object({ key: z.string(), answers: z.record(z.string(), z.string()) })).optional(), reviews: z.array(z.object({ criterion: z.string(), evidence: z.string(), accepted: z.boolean(), note: z.string(), at: z.number() })).optional(), plan: planSchema.optional(), ownerSession: z.string(), createdAt: z.number(), updatedAt: z.number() });
export type CoderBrief = z.infer<typeof briefSchema>;
const inputSchema = z.object({ objective: z.string().trim().min(1).max(4000), constraints: z.string().trim().max(4000).default(''),
  cwd: z.string().trim().min(1).optional(),
  requireUserReview: z.boolean().optional(),
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
    const parsed = inputSchema.safeParse({ ...fieldsInput, cwd: fieldsInput.cwd ?? existing?.cwd, constraints: fieldsInput.constraints ?? existing?.constraints ?? '', requireUserReview: fieldsInput.requireUserReview ?? existing?.requireUserReview });
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
      if (!sameChat(current.ownerSession, owner) || current.revision !== revision || this.changing.has(id)) throw new Error('验收期间目标已变化，请重新核对。');
      return { ...current, updatedAt: Date.now(), reviews: [...(current.reviews ?? []).filter(item => item.criterion !== review.criterion), review],
        answers: current.answers?.filter(item => item.key !== acceptanceDeferralKey(review.criterion, review.evidence)) };
    });
  }
  async deferReview(id: string, owner: string, revision: number, criterion: string, evidence: string): Promise<void> {
    this.get(id, owner);
    await this.table.update(id, current => {
      if (!sameChat(current.ownerSession, owner) || current.revision !== revision || this.changing.has(id)) throw new Error('验收期间目标已变化，请重新核对。');
      const key = acceptanceDeferralKey(criterion, evidence);
      return { ...current, updatedAt: Date.now(),
        // A new uncertain answer replaces a positive verdict, while unresolved negative feedback still needs work.
        reviews: current.reviews?.filter(review => !(review.criterion === criterion && review.evidence === evidence && review.accepted)),
        answers: [...(current.answers ?? []).filter(item => item.key !== key), { key, answers: { accept: '暂时无法判断' } }].slice(-50) };
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
      ? '有失败、取消或中断，需复核' : criterionEvidence(brief, records, criterion.id).checked ? `本项独立检查通过，人工验收${brief.requireUserReview ? '按用户要求确认' : '可选'}` : '任务执行结束，本项检查未通过或未登记';
    lines.push(`- ${criterion.id}：${criterion.text} — ${state}${related.length ? `（${related.map(task => task.id).join('、')}）` : ''}`);
  }
  if (brief.plan) lines.push('步骤计划（依赖顺序；尚未派发不代表已执行）：', ...brief.plan.map(step => `${step.id}：${step.description}；验收项 ${step.acceptance_ids.join('、')}；前置步骤 ${step.depends_on.join('、') || '无'}；验证 ${step.verify}`));
  const obsolete = records.filter(task => sameChat(task.ownerSession, brief.ownerSession) && task.brief?.id === brief.id && task.brief.revision !== brief.revision && isActive(task));
  if (obsolete.length) lines.push(`旧版本仍有活动任务：${obsolete.map(task => task.id).join('、')}。运行中的任务仍按原说明执行；修改说明单不会自动调整已运行任务，请明确停止或调整它们。`);
  lines.push('任务结果：', ...(tasks.length ? tasks.slice(0, 50).map(task => {
    const changes = changeSummary(task.result?.changedFiles ?? [], expectedArtifacts(task));
    return `${task.id}${task.planStep ? `（步骤 ${task.planStep}）` : ''} ${taskStatusLabel(task)}：${task.description.slice(0, 160)}${task.verify ? `；验证：${[task.verify, ...(task.verifyCommands ?? [])].join('；')}` : ''}${task.result ? `；项目文件 ${changes.project.length}，依赖 ${changes.dependencies.length}，测试/缓存产物 ${changes.generated.length}；${(task.result.detail || task.result.summary).slice(0, 240)}` : ''}`;
  }) : ['尚无本版本的关联任务。']),
    ...(tasks.length > 50 ? [`另有 ${tasks.length - 50} 个任务未展开；验收覆盖仍统计全部关联任务。`] : []),
    '以上汇总任务与检查证据；未关联的要求和实际业务效果仍需主助手核对。默认按自动检查交付，人工验收仅按用户明确要求进行。');
  return lines.join('\n');
}

export function coderPrompt(task: Pick<TaskRecord, 'description' | 'continuation' | 'brief' | 'verify' | 'verifyCommands' | 'verifyCwd' | 'permissions' | 'outputs' | 'acceptanceChecks'>): string {
  const description = task.description + CODER_WORK_GUIDANCE + (task.continuation ? `\n\n[本次续接说明]\n${task.continuation}\n仍须满足已保存的目标、共同约束和完整验收；不能用续接说明替换或缩小它们。` : '')
    + (task.permissions?.securityMode === 'full' ? '\n\n[执行权限]\n本任务已由设置授予完全权限：可用当前系统用户权限访问项目外文件、联网和运行命令，无执行沙箱或逐项权限审批；不需要为常规执行再申请权限。仍按用户目标工作，实质歧义应澄清；避免在输出中暴露密钥。' : '\n\n[环境配置与执行检查]\n' + (task.permissions?.securityMode === 'standard' ? '本任务工作区内经真实路径核验的 .env 及 .env.* 可以按项目配置读取、创建和修改，优先用原生文件工具，无需仅因文件名再次申请用户确认。读取结果仅用于本任务配置处理，不得把配置值复制到对话回复、普通日志、代码提交或交付物；工作区外凭据和受保护目录仍禁止访问。涉及配置的命令仍按具体行为审核，source / 点加载会执行文件内容，不能视为普通读取。' : '项目内 .env.example、.env.sample、.env.template 可用原生文件工具创建或修改，只填空值、占位符及本地非敏感配置。严格模式下实际 .env 仍受保护，不读取或打印已有密钥，不用 shell 绕过文件限制。') + '运行测试优先指定测试文件或目录，使用可检查的项目脚本；避免反复申请同一被拒操作。')
    + (task.brief ? '\n先核对实际项目目录和所需运行环境。发现环境或依赖加载失败，先定位并采用可恢复的修复，不通过删除依赖、改写测试或换技术栈掩盖真实启动失败。' : '')
    + (task.verify ? `\n\n[DSH 独立验证约定]\n任务结束后宿主将在 ${task.verifyCwd ?? '任务目录'} 按顺序运行：\n${[task.verify, ...(task.verifyCommands ?? [])].map(command => `- ${command}`).join('\n')}\n请准备这些验证所需的文件。修改中先做必要的针对性自测，不为收尾形式再重复整套验收；宿主会独立执行上述命令。任何一项失败或未执行都不能报告全部验收通过。` : '')
    + (task.acceptanceChecks?.length ? `\n逐项检查：\n${task.acceptanceChecks.map(check => `${check.criterion}：命令 ${check.commands.join('；') || '无'}；文件 ${check.files.join('、') || '无'}`).join('\n')}` : '')
    + (task.outputs?.length ? `\n声明交付文件（相对任务目录）：${task.outputs.join('、')}。宿主会检查实际文件；报告中声明存在的交付物应真实生成，文档更新和复现分支须各有对应证据。` : '');
  if (!task.brief) return description;
  return `${description}\n\n[派发时的任务说明单 ${task.brief.id}，版本 ${task.brief.revision}]\n总体目标：${task.brief.objective}\n共同约束：${task.brief.constraints || '无补充'}\n本任务负责的验收项：\n${task.brief.acceptance.map(item => `${item.id}. ${item.text}`).join('\n')}\n只完成本任务负责的部分，不把单个子任务完成表述为整个目标已完成。已明确的目标不重复澄清；技术细节先查项目，只有影响目标、范围或授权的新问题才反馈。说明单不会扩大工具权限。`;
}

export async function installBriefs(ctx: Context, records: () => TaskRecord[], stopTasks?: (tasks: TaskRecord[]) => Promise<void>, askUser?: (request: Parameters<typeof ctx.userQuestions.ask>[0]) => ReturnType<typeof ctx.userQuestions.ask>, resolveDirectory?: (path: string, exec: ToolRunContext) => Promise<string>): Promise<BriefStore> {
  const store = new BriefStore(await ctx.storageDomain.open(briefDomain));
  const reviewing = new Set<string>();
  ctx.effect(() => () => { void store.close(); });
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'coder_brief',
    description: '记录和查看编码需求的目标、共同约束与验收项。复杂需求先保存说明单，局部小改动或普通修复无需创建；需要派发时以完整工作为单位，确需独立验收或阶段依赖时才 plan 拆分，每步声明验收项、前置步骤、验证和 outputs。先核实运行环境，项目初始化不能用改写测试掩盖服务启动失败。已有说明单的续接保留计划、约束和验收；目标变更先 impact 再 amend，失败用 recover，交付用 delivery。默认自动检查通过即可按约定交付，不自动发起人工验收；仅用户明确要求时才 review。同一结果默认不重复询问，未满足反馈仍需处理。它不启动任务，也不创建、完成或恢复原生 goal；查询汇总当前版本任务和验证证据，不能把子任务完成当作整个目标完成。',
    parameters: {
      action: { type: 'string', enum: ['save', 'plan', 'get', 'list', 'delivery', 'review', 'recover', 'impact', 'amend'], required: true, description: 'save 新建或修改（清除旧步骤计划）；plan 保存完整步骤计划并检查覆盖、引用和循环依赖；get 查询覆盖；list 列表；delivery 交付汇总，不提问；review 按用户明确要求人工验收；recover 恢复清单；impact 预览变更；amend 停止旧版活动任务后应用新版本。' },
      brief_id: { type: 'string', description: 'get 或修改时必填。' },
      revision: { type: 'integer', description: '修改时填写刚读取的版本；旧版本会被拒绝。' },
      cwd: { type: 'string', description: 'save 时可指定项目根目录（相对于当前会话工作区）；新项目应在这里绑定目录。省略时首次派发会固定实际目录。后续步骤默认沿用，不能越出项目或会话边界。' },
      criterion: { type: 'string', description: 'review 必填，向用户确认的具体验收项 ID。' },
      note: { type: 'string', description: 'review 可填，向用户说明核验方式与实际结果，最多 1000 字；不能代替用户确认。' },
      require_user_review: { type: 'boolean', description: '仅 save 使用。只有用户明确要求人工验收作为交付条件时设 true，默认 false。不要因为测试通过、界面或业务效果等字样自行开启。修改时省略会保留原设置。' },
      user_requested: { type: 'boolean', description: '仅 review 使用。只有用户在本次明确要求查看并确认结果时设 true；否则仅说明单已要求人工验收时可提问。' },
      reconfirm: { type: 'boolean', description: '仅 review 使用。同一结果默认不重复询问，包含已满足、未满足和暂时无法判断。仅用户明确要求重新确认时设 true，并同时 user_requested=true。' },
      steps: { type: 'array', description: 'plan 必填，完整步骤列表。保存成功会生成新版本；不启动任务。preflight 登记环境自检；verify_commands 追加 verify 之后的检查；acceptance_checks 对应逐项验收；outputs 列需实际核验的预期交付文件。', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, description: { type: 'string', required: true }, acceptance_ids: { type: 'array', items: { type: 'string' }, required: true }, depends_on: { type: 'array', items: { type: 'string' }, required: true }, verify: { type: 'string', required: true }, verify_commands: { type: 'array', items: { type: 'string' } }, acceptance_checks: acceptanceChecksParameter, preflight: { type: 'string' }, outputs: { type: 'array', items: { type: 'string' } } } } },
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
        const evidenceRecords = await currentArtifactEvidence(briefTasks(brief, records()), exec.signal);
        if (args.action === 'review') {
          if (brief.revision !== args.revision || !args.criterion) throw new Error('review 需要当前 revision 和 criterion。');
          const state = criterionEvidence(brief, evidenceRecords, args.criterion);
          if (!brief.requireUserReview && !args.user_requested) return { text: deliveryReport(brief, evidenceRecords) };
          const previous = brief.reviews?.some(review => review.criterion === args.criterion && review.evidence === state.evidence)
            || reviewDeferred(brief, args.criterion, state.evidence);
          if (previous && !(args.user_requested && args.reconfirm)) return { text: deliveryReport(brief, evidenceRecords) };
          if (!state.settled) throw new Error('该验收项尚未关联任务或任务仍在执行，请先完成工作。');
          const reviewKey = `${brief.id}:${brief.revision}:${args.criterion}`;
          if (reviewing.has(reviewKey)) return { text: `${deliveryReport(brief, evidenceRecords)}\n本项正在等待用户反馈，请在原问题回答。` };
          reviewing.add(reviewKey);
          try {
            const note = (args.note ?? '').slice(0, 1000);
            const files = [...new Set(state.tasks.flatMap(task => task.result?.artifactChecks?.filter(check => check.ok).map(check => check.path) ?? []))];
            const detail = [
              `目标：${brief.objective}`,
              `需要你查看：${brief.acceptance.find(item => item.id === args.criterion)!.text}`,
              note ? `查看方法与结果：${note}` : '查看方法：打开交付文件或查看下方结果摘要，再按这项要求判断；不清楚怎么核对时请选择“暂时无法判断”。',
              state.checked ? '自动检查：本项已通过。' : `自动检查：本项尚未全部通过。${state.gaps.join('；')}`,
              ...state.tasks.slice(0, 10).map(task => `结果摘要（${task.id}）：${(task.result?.detail || task.result?.summary || task.description).slice(0, 240)}`),
              ...(files.length ? ['已核验交付文件：', ...files.slice(0, 20).map(path => `- ${path}`), ...(files.length > 20 ? ['其余文件见交付汇总。'] : [])] : []),
              '请按实际结果反馈；选择“未满足”时可补充哪里有问题。“暂时无法判断”会保留待确认。',
            ].join('\n');
            const answer = await (askUser ?? (request => ctx.userQuestions.ask(request)))({ agent: exec.agent, signal: exec.signal, wait: { callId: exec.callId }, questions: [{ id: 'accept', header: '结果确认', question: `查看结果后，这项要求是否已经做到：${brief.acceptance.find(item => item.id === args.criterion)!.text}`,
              detail, options: [
                { label: '已满足', description: '我已查看结果，符合这项要求。' },
                { label: '未满足', description: '我已查看结果，还有问题；可补充具体原因。' },
                { label: '暂时无法判断', description: '我还没查看，或不清楚怎么核对；保留待确认。' },
              ] }] });
            const current = store.get(brief.id, owner);
            if (current.revision !== brief.revision || store.isChanging(brief.id)) throw new Error('验收期间目标已变化，请重新核对。');
            if (criterionEvidence(current, await currentArtifactEvidence(briefTasks(current, records()), exec.signal), args.criterion).evidence !== state.evidence) throw new Error('验收期间任务证据已变化，请重新核对。');
            const selected = answer.answers.find(item => item.id === 'accept');
            if (!selected || selected.selected.length !== 1 || !['已满足', '未满足', '暂时无法判断'].includes(selected.selected[0]!)) throw new Error('未取得有效的人工验收回答。');
            if (selected.selected[0] === '暂时无法判断') {
              await store.deferReview(brief.id, owner, brief.revision, args.criterion, state.evidence);
            } else {
              await store.review(brief.id, owner, brief.revision, { criterion: args.criterion, evidence: state.evidence, accepted: selected.selected[0] === '已满足', note: selected.custom?.slice(0, 1000) ?? note, at: Date.now() });
            }
          } finally { reviewing.delete(reviewKey); }
        }
        return { text: deliveryReport(store.get(brief.id, owner), await currentArtifactEvidence(briefTasks(brief, records()), exec.signal)) };
      }
      let cwd: string | undefined;
      if (args.cwd !== undefined) {
        if (args.action !== 'save' || !resolveDirectory) throw new Error('项目目录只能通过可验证工作区边界的 save 操作设置。');
        cwd = await resolveDirectory(args.cwd, exec);
      }
      const brief = args.action === 'plan' ? await store.plan(args.brief_id!, owner, args.revision, args.steps) : args.action === 'save' ? await store.save(owner, { ...args, cwd, requireUserReview: args.require_user_review }, args.brief_id, args.revision) : store.get(args.brief_id!, owner);
      return { text: briefReport(brief, records()) };
    },
  })));
  return store;
}
