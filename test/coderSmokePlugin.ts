import type { TaskSummary } from '../src/coders/presentation.js';
import { localCheck } from '../src/coders/local-check.js';
import { nativeSafetyReviewer, reviewEnvelope } from '../src/coders/review.js';
import { normalizeClaudeRequest } from '../src/coders/normalize.js';
import { CoderStore } from '../src/coders/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
/** A coder task dispatched from a channel: the fake Claude asks, the user answers from WeChat, the job wakes the agent, the report reaches the channel. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installCoders, type TaskDetailView } from '../src/coders/index.js';
import type { ClaudeQuery, ClaudeStreamMessage } from '../src/coders/claude.js';
import { installBridge } from '../src/dsh/bridge.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { until } from './helpers.js';

export const name = 'nexus-coder-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'sandbox', 'web', 'agents', 'userQuestions',
  'jobs', 'storageDomain', 'systemPrompt'];
const owner = { channel: 'wechat' as const, accountId: 'wx-coder-bot', ownerId: 'wx-coder-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text,
  chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });

function toolResultText(options: GenerateOptions, callId: string): string {
  const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === callId);
  assert.ok(result, `tool result ${callId} missing`);
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
}

class FixtureModel extends LlmAdapter {
  calls = 0;
  jobId = '';
  briefId = '';
  coderCwd = '';
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local coder fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
  }
  private *toolCall(id: string, name: string, args: Record<string, unknown>): Iterable<StreamChunk> {
    const block = { type: 'tool-call' as const, id: ToolCallId(id), name, arguments: JSON.stringify(args) };
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  }
  private *text(text: string): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  emptyReviewNext = false;
  errors: string[] = [];
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    try { yield* this.script(options); }
    catch (error) { this.errors.push(String((error as Error)?.stack ?? error)); throw error; }
  }
  private async *script(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    if (options.system?.includes('你是 DSH 的安全授权审核器')) {
      assert.deepEqual(options.tools, []);
      if (this.emptyReviewNext) {
        this.emptyReviewNext = false;
        yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 2048, reasoningTokens: 2048 } };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      yield* this.text('{"safe":true,"reason":"本次仅读取项目文档"}');
      return;
    }
    assert.ok(options.tools?.some(tool => tool.name === 'coder_task'), `coder_task missing from ${options.tools?.map(tool => tool.name).join(',')}`);
    assert.ok(options.tools?.some(tool => tool.name === 'job_output'), 'job_output missing');
    assert.ok(options.tools?.some(tool => tool.name === 'coder_rules'), 'coder_rules missing');
    // DSH projects the assembled system prompt into the message history, so look at both places.
    const prompt = [options.system ?? '', ...options.messages.flatMap(message => message.content.flatMap(block =>
      block.type === 'text' ? [block.text] : []))].join('\n');
    assert.match(prompt, /用 coder_task[^\n]*本机编码工具/, 'system prompt must describe coder_task');
    const step = this.calls++;
    if (step === 0) {
      yield* this.toolCall('brief', 'coder_brief', { action: 'save', objective: '检查目录并准备后续工作', constraints: '不修改已有文件', acceptance: ['目录检查通过', '后续业务验收'] });
    } else if (step === 1) {
      const match = /cb-[a-f0-9]+/.exec(toolResultText(options, 'brief'));
      assert.ok(match); this.briefId = match[0];
      yield* this.toolCall('plan', 'coder_brief', { action: 'plan', brief_id: this.briefId, revision: 1, steps: [
        { id: 'inspect', description: '列出目录内容并报告', acceptance_ids: ['a1'], depends_on: [], verify: 'true' },
        { id: 'business', description: '后续业务验收', acceptance_ids: ['a2'], depends_on: ['inspect'], verify: 'true' },
      ] });
    } else if (step === 2) {
      assert.match(toolResultText(options, 'plan'), /步骤计划/);
      yield* this.toolCall('dispatch', 'coder_task', { coder: 'claude', verify_network: 'ask', brief_id: this.briefId, brief_revision: 2, plan_step: 'inspect' });
    } else if (step === 3) {
      const text = toolResultText(options, 'dispatch');
      assert.ok(text.includes(`实际项目目录：${this.coderCwd}`));
      const match = /后台 job ([^，\s]+)，/.exec(text);
      assert.ok(match, text);
      this.jobId = match[1]!;
      yield* this.text('任务已交给 Claude Code 在后台执行，完成后我再汇报。');
    } else if (step === 4) {
      const notice = options.messages.find(message => message.role === 'user' && message.source?.kind !== 'user' && message.content.some(block =>
        block.type === 'text' && block.text.includes(`background job ${this.jobId}`) && block.text.includes('coder:')));
      assert.ok(notice, 'job completion notice must reach the model');
      yield* this.toolCall('read', 'job_output', { job_id: this.jobId });
    } else if (step === 5) {
      yield* this.toolCall('brief-report', 'coder_brief', { action: 'get', brief_id: this.briefId });
    } else {
      assert.equal(step, 6);
      const coverage = toolResultText(options, 'brief-report');
      assert.match(coverage, /a1：目录检查通过 — 关联任务验证通过，待需求验收/);
      assert.match(coverage, /a2：后续业务验收 — 尚未安排/);
      const report = toolResultText(options, 'read');
      assert.match(report, /编码任务 ct-[0-9a-f]{8} 执行结束/);
      assert.match(report, /Claude Code 的结果（编码工具自述）：\n目录里有 1 个文件。/);
      assert.match(report, /验证命令 true：通过/);
      assert.match(report, /升级给用户 1 次，硬规则自动拒绝 1 次，习惯规则自动决定 0 次，DSH 自动审核 2 次，常规操作自动放行 2 次。/);
      assert.match(report, /\[硬规则·拒绝\] Bash: cat ~\/.ssh\/id_rsa — 命令涉及凭据或密钥文件/);
      assert.match(report, /\[用户·允许\] Claude wants to run git push — git push/);
      assert.match(report, /\[DSH 审核·允许\] Claude wants to run ls -la/, 'standard command review must be recorded');
      assert.match(report, /\[status: completed\]/);
      yield* this.text('Claude Code 已完成：目录里有 1 个文件，验证通过。它想读取 SSH 私钥被监工拒绝，ls 自动放行，git push 由你批准。');
    }
  }
}

export function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): void {
  const model = new FixtureModel();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  const texts: string[] = [];
  const failures: string[] = [];
  const claude = { started: 0, decisions: [] as string[], releaseGate: () => {}, gate: Promise.resolve() };
  claude.gate = new Promise<void>(resolve => { claude.releaseGate = resolve; });
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {},
    async sendText(_chatId, text) { texts.push(text); } };
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  // The fake Claude only asks after the dispatching turn has ended, so escalation must find the idle agent on its own.
  const query: ClaudeQuery = ({ prompt, options }) => (async function* (): AsyncIterable<ClaudeStreamMessage> {
    claude.started++;
    assert.ok(options.resume ? prompt.includes('不要重复已成功') : prompt.startsWith('列出目录内容并报告'));
    assert.match(prompt, /nexus_web/);
    assert.equal(options.cwd, model.coderCwd);
    yield { type: 'system', subtype: 'init', session_id: 'claude-smoke-session' };
    if (options.resume) {
      assert.equal(options.resume, 'claude-smoke-session');
      yield { type: 'result', subtype: 'success', result: '目录里有 1 个文件。' };
      return;
    }
    await claude.gate;
    // A credential read is denied by the hard rules without asking anyone.
    const secret = await options.canUseTool('Bash', { command: 'cat ~/.ssh/id_rsa' }, { signal: options.abortController.signal });
    claude.decisions.push(secret.behavior);
    assert.equal(secret.behavior, 'deny');
    // A routine command is allowed without asking anyone.
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la' } }] } };
    const ls = await options.canUseTool('Bash', { command: 'ls -la' }, { signal: options.abortController.signal, title: 'Claude wants to run ls -la' });
    claude.decisions.push(ls.behavior);
    assert.equal(ls.behavior, 'allow');
    // A push is escalated by the hard rules and waits for the user.
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git push origin main' } }] } };
    const push = await options.canUseTool('Bash', { command: 'git push origin main' }, { signal: options.abortController.signal, title: 'Claude wants to run git push' });
    claude.decisions.push(push.behavior);
    assert.equal(push.behavior, 'allow');
    yield { type: 'assistant', message: { content: [{ type: 'text', text: '看了一下目录。' }] } };
    const mcp = options.mcpServers?.nexus_web;
    assert.ok(mcp, 'the task must receive its own DSH research connection');
    const client = new Client({ name: 'coder-fixture', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url), { requestInit: { headers: mcp.headers } }));
      assert.match(JSON.stringify(await client.callTool({ name: 'search', arguments: { query: 'fixture docs' } })), /fixture source/);
      assert.match(JSON.stringify(await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com' } })), /fixture page/);
    } finally { await client.close(); }
    yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 0, error_status: 503, error: 'server_error' };
    yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['provider unavailable'] };
  })();
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        const agent = ctx.agents.get(sessionId);
        const ends = agent?.session.snapshotEvents().filter(event => event.type === 'turn/end').map(event => event.data.reason) ?? [];
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error?.stack ?? error), failures, texts,
          modelErrors: model.errors, turnEnds: ends }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    model.coderCwd = config.workspace;
    await writeFile(join(model.coderCwd, 'README.md'), 'smoke\n');
    ctx.web.registerSearchProvider({ id: 'nexus-research-fixture', available: () => true, async search() { return { sources: [{ url: 'https://example.com', title: 'fixture source' }], truncated: false }; } });
    ctx.web.registerFetchProvider({ id: 'nexus-research-fixture', available: () => true, async fetch({ url }) { return { url, statusCode: 200, body: { kind: 'text', content: 'fixture page' }, truncated: false }; } });
    let readTask: ((method: string, payload: unknown) => Promise<unknown>) | undefined;
    const store = await installCoders(ctx, { roots: [join(config.workspace, 'channel-default')], query, web: () => ctx.web,
      registerRpc: (family, _methods, handle) => { if (family === 'nexus-coder-tasks') readTask = handle; } });
    await bridge.receive(inbound('dispatch', '帮我看看这个目录里有什么。'));
    const agent = ctx.agents.get(sessionId)!;
    await agent.whenIdle();
    await bridge.drain();
    assert.equal(model.calls, 4);
    assert.ok(texts.includes('任务已交给 Claude Code 在后台执行，完成后我再汇报。'));
    await until(() => store.list().some(task => task.coderSessionId === 'claude-smoke-session'), 'queued coder did not start its native session', 10_000);
    assert.equal(claude.started, 1);
    const [task] = store.list();
    assert.ok(task);
    assert.equal(task.status, 'running');
    assert.equal(task.coderSessionId, 'claude-smoke-session');
    await bridge.receive(inbound('status-running', '状态'));
    assert.match(texts.at(-1)!, /已完成/);
    claude.releaseGate();
    const prompts = () => texts.filter(text => text.startsWith('需要你补充信息'));
    await until(() => prompts().length === 1, 'coder escalation not presented', 10_000);
    const prompt = prompts()[0]!;
    assert.match(prompt, /编码任务 ct-[0-9a-f]{8}/);
    assert.match(prompt, /Claude Code 请求：Claude wants to run git push/);
    assert.match(prompt, /1\. 允许/);
    assert.match(prompt, /2\. 拒绝/);
    assert.doesNotMatch(prompt, /允许并记住/);
    assert.equal(store.get(task.id)!.status, 'waiting-user');
    assert.equal(store.get(task.id)!.pending?.summary, 'Claude wants to run git push');
    assert.ok(readTask);
    const waitingDetail = await readTask('get', { id: task.id }) as TaskDetailView;
    assert.match(waitingDetail.recovery!.nextStep, /旧消息中的审批回复不能用于新的请求/);
    assert.deepEqual(claude.decisions, ['deny', 'allow']);
    // The second step fell inside the throttle window; it is written when the window closes.
    await until(() => (store.get(task.id)!.trace?.length ?? 0) >= 6, 'steps not recorded while waiting', 5_000);
    assert.deepEqual(store.get(task.id)!.trace!.map(step => step.text).filter(text => !text.startsWith('DSH ')), ['监工拒绝：Bash: cat ~/.ssh/id_rsa（命令涉及凭据或密钥文件：~/.ssh/id_rsa）',
      '执行：ls -la', '执行：git push origin main', '等待用户：Claude wants to run git push']);
    await bridge.receive(inbound('status-waiting', '状态'));
    assert.match(texts.at(-1)!, /等待你的回答/);
    await bridge.receive({ ...inbound('foreign', '回答 1'), senderId: 'stranger' });
    assert.deepEqual(claude.decisions, ['deny', 'allow']);
    await bridge.receive(inbound('answer', '回答 1'));
    await until(() => claude.decisions.length === 3, 'allow did not reach the fake Claude', 10_000);
    assert.deepEqual(store.rules(), []);
    await until(() => model.calls === 7, 'job completion did not wake the idle agent', 20_000);
    await agent.whenIdle();
    await bridge.drain();
    const done = store.get(task.id)!;
    // The job's own panel reads the ring without the model cursor: every step is there on the observer-only channel.
    const panel = ctx.jobs.readAt(done.jobId! as Parameters<typeof ctx.jobs.readAt>[0], 0, sessionId);
    const panelText = panel.chunks.map(chunk => chunk.text).join('');
    assert.ok(panel.chunks.length > 0 && panel.chunks.every(chunk => chunk.channel === 'log'), JSON.stringify(panel.chunks.map(chunk => chunk.channel)));
    for (const line of [`Claude Code 编码任务 ${task.id}`, '监工拒绝：Bash: cat ~/.ssh/id_rsa', '执行：ls -la', '等待用户：Claude wants to run git push',
      '用户允许：Claude wants to run git push', '说明：看了一下目录。', '结束：执行结束，改动文件 0 个，验证通过']) assert.ok(panelText.includes(line), `${line} missing from the job panel:\n${panelText}`);
    assert.equal(done.status, 'completed');
    assert.equal(claude.started, 2);
    assert.equal(done.retry?.phase, 'recovered');
    assert.match(panelText, /自动续接（第 1\/2 次）/);
    assert.equal(done.escalations, 1);
    assert.equal(prompts().length, 1, 'safe commands and verification must not ask the owner');
    assert.equal(done.permissions?.securityMode, 'standard');
    assert.equal(done.autoAllowed, 2);
    assert.equal(done.activity, undefined);
    assert.deepEqual(done.decisions.map(decision => [decision.layer, decision.outcome]), [['hard', 'deny'], ['supervisor', 'allow'], ['user', 'allow'], ['supervisor', 'allow']]);
    assert.equal(done.result!.verifyOk, true);
    assert.ok(readTask);
    const detail = await readTask('get', { id: done.id }) as TaskDetailView;
    assert.equal(detail.ownerSession, sessionId);
    assert.equal(detail.goal?.revision, done.brief?.revision);
    assert.match(detail.goal!.report, /业务验收待确认/);
    assert.match(detail.goal!.report, /尚未完成全部验收/);
    assert.equal(detail.recovery?.title, '指定检查已通过');
    assert.match(detail.goal!.recovery!, /保留已通过的结果/);
    assert.ok(detail.result!.verifyChecks?.every(check => check.ok && check.executed));
    assert.equal((await readTask('get', { id: done.id, brief: true }) as TaskDetailView).goal, undefined);
    const taskList = await readTask('list', { ownerSession: sessionId }) as TaskSummary[];
    const placed = taskList.find(item => item.id === done.id)!;
    assert.ok(placed.completionNotice, 'native completion event links the task card');
    const nativeHistory = await ctx.sessionController.inspect(sessionId);
    const nativeNotice = nativeHistory.events.find(event => event.seq === placed.completionNotice!.seq)!;
    assert.equal(nativeNotice.type, 'user/message');
    assert.equal((await readTask('notice', { ownerSession: sessionId, seq: nativeNotice.seq }) as TaskSummary).id, done.id);
    assert.equal(await readTask('notice', { ownerSession: 'foreign-session', seq: nativeNotice.seq }), null);
    assert.equal(store.get(done.id)!.updatedAt, done.updatedAt, 'UI placement does not change execution timestamps');
    assert.equal(claude.started, 2, 'presentation reads do not restart the coder');
    assert.equal(prompts().length, 1, 'presentation reads do not replay approval prompts');
    assert.equal(done.pending, undefined);
    assert.ok(texts.includes('Claude Code 已完成：目录里有 1 个文件，验证通过。它想读取 SSH 私钥被监工拒绝，ls 自动放行，git push 由你批准。'));
    const events = agent.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === 'turn/start').length, 2);
    assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 2);
    const input = await reviewEnvelope(done, normalizeClaudeRequest('Read', { file_path: join(model.coderCwd, 'README.md') }, {}, model.coderCwd));
    assert.ok(input);
    model.emptyReviewNext = true;
    assert.equal((await nativeSafetyReviewer(ctx, record => store.auditReview(record))(done, input, new AbortController().signal)).safe, true);
    const audits = store.get(done.id)!.safetyReviews!;
    assert.equal(audits.length, 8);
    assert.equal(audits[5]!.failure, 'truncated');
    assert.equal(audits[5]!.usage?.reasoningTokens, 2048);
    assert.equal(audits[6]!.attempt, 2);
    assert.equal(audits[6]!.input, audits[4]!.input, 'retry uses identical evidence without dispatching work');
    assert.deepEqual(JSON.parse(audits[4]!.input!), input);
    assert.match(audits[1]!.output!, /"safe":true/);
    assert.equal(agent.session.snapshotEvents().length, events.length, 'auxiliary review does not change the conversation log');
    assert.equal(model.calls, 7, 'the tool-less reviewer does not create another agent turn');
    assert.equal(await ctx.sessions.flush(agent.session), true);
    const persisted = await ctx.sessionPersistence.open(sessionId, 'read');
    try { assert.equal((await persisted.read()).events.length, events.length); }
    finally { await persisted.close(); }
    assert.deepEqual(failures, []);
    await bridge.close();
    await writeFile(join(model.coderCwd, 'local-check.cjs'), `const http=require('http'); const s=http.createServer((q,r)=>r.end('native-local')); s.listen(0,'127.0.0.1',async()=>{ const value=await fetch('http://127.0.0.1:'+s.address().port).then(r=>r.text()); if(value!=='native-local')process.exit(1);console.log(value);s.closeAllConnections();s.close(); });`);
    assert.match(await localCheck(ctx, model.coderCwd, sessionId, 'node local-check.cjs', undefined, new AbortController().signal), /native-local/);
    await store.close();
    const reopened = await CoderStore.open(ctx.storageDomain);
    try { assert.equal(reopened.get(done.id)!.brief?.cwd, done.cwd, 'bound project snapshot survives native storage reopening');
      assert.deepEqual(reopened.get(done.id)!.safetyReviews, audits, 'native task audit survives closing and reopening storage');
      assert.deepEqual(reopened.get(done.id)!.retry, done.retry, 'retry state survives native storage reopening');
      assert.deepEqual(reopened.get(done.id)!.completionNotice, placed.completionNotice, 'notification placement survives reopening'); }
    finally { await reopened.close(); }
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, modelCalls: model.calls, sessionId,
      checks: ['planned_dispatch_uses_saved_description', 'bound_project_snapshot_survives_native_storage_reopen', 'empty_review_retries_once_through_native_llm_without_new_turn_or_prompt', 'review_failure_and_usage_audit_survives_native_storage_reopen', 'task_cards_link_native_notice_by_owner_and_stable_task_id', 'task_card_placement_survives_storage_reopen_without_replay', 'transient_failure_resumes_same_native_job_and_session', 'automatic_resume_audit_survives_native_storage_reopen', 'task_recovery_keeps_native_approval_scope', 'task_recovery_preserves_verified_steps_and_exposes_checks', 'task_detail_reads_owner_and_goal_acceptance_without_new_execution', 'native_safety_review_uses_owner_model_and_task_audit_without_changing_history', 'local_check_uses_native_sandbox_and_private_loopback', 'coder_task_dispatches_native_job', 'brief_links_task_without_claiming_entire_goal_complete', 'validated_plan_supplies_native_job_verification', 'hard_rule_denies_credential_read_without_user', 'escalation_reaches_channel_after_turn_end',
        'standard_command_reviewed_without_user', 'steps_recorded_while_waiting', 'job_panel_shows_steps_outside_the_model_read', 'channel_answer_resumes_claude', 'online_verification_gets_scoped_dsh_review', 'coder_research_uses_native_web_providers', 'job_completion_wakes_idle_agent', 'report_delivered_to_channel'],
    }, null, 2));
  }
}
