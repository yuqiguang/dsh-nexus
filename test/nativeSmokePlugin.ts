/** Loaded only by scripts/smoke.mjs. No model provider or messaging service is contacted. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import type {} from '@deepseek-ai/dsh-tools';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installBridge, type DshChannelBridge } from '../src/dsh/bridge.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage, type OutboundFile } from '../src/channels/protocol.js';
import { until } from './helpers.js';

export const name = 'nexus-native-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'tools', 'agents', 'sandboxPolicy'];
const owner = { channel: 'feishu' as const, accountId: 'cli_smoke', ownerId: 'ou_smoke' };
const chatId = 'oc_smoke';
const filePath = 'outputs/result.txt';
const fileContent = 'nexus-native-tool-history\n';
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, chatId));

/**
 * The instruction baseline's identity records the project root relative to the session cwd, so `''` is the
 * workspace itself. Anything else means DSH walked out of it — which it does by default, because the smoke
 * workspace lives inside this repository and `.git` marks the repository as the project root, putting the
 * repository's developer rules in every channel session (see scripts/setup.mjs).
 */
function instructionProjectRoot(events: readonly SessionEvent[]): string | undefined {
  const baseline = events.findLast(event => event.type === 'user/message'
    && (event.data.source as { kind?: string; baseline?: boolean }).kind === 'agent-instructions'
    && (event.data.source as { baseline?: boolean }).baseline === true);
  if (baseline?.type !== 'user/message') return '';
  const identity = (baseline.data.source as { baselineIdentity?: string }).baselineIdentity;
  return JSON.parse(identity ?? '{}').projectRoot as string | undefined;
}

class FixtureModel extends LlmAdapter {
  calls = 0;
  restoredToolHistory = false;
  constructor(private readonly phase: number) { super(); }

  override async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local smoke fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    const step = this.calls++;
    assert.ok(options.tools?.some(tool => tool.name === 'read'), 'native read tool must be present');
    const history = options.messages.filter(message => message.role === 'tool');
    if (this.phase === 2 && step === 0) {
      this.restoredToolHistory = JSON.stringify(history).includes('result.txt');
      assert.ok(this.restoredToolHistory, 'resume must retain native tool results');
    }
    const calls = this.phase === 1 ? [
      { name: 'read', arguments: { file_path: filePath } },
      { name: 'write', arguments: { file_path: filePath, content: fileContent } },
      { name: 'present', arguments: { files: [{ path: filePath, description: '测试交付文件' }] } },
      { name: 'read', arguments: { file_path: filePath } },
      { name: 'read', arguments: { file_path: filePath } },
    ] : [{ name: 'read', arguments: { file_path: filePath } }];
    const call = calls[step];
    if (call) {
      const block = { type: 'tool-call' as const, id: ToolCallId(`fixture-${this.phase}-${step}`),
        name: call.name, arguments: JSON.stringify(call.arguments) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      assert.equal(step, calls.length, 'unexpected extra model call');
      const text = this.phase === 1 ? '测试文件已生成并交付。' : '已恢复原会话并重新读取文件。';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

export async function apply(ctx: Context, config: {
  phase: number; workspace: string; triggerFile: string; reportFile: string;
}): Promise<void> {
  const model = new FixtureModel(config.phase);
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  const texts: string[] = [];
  const files: OutboundFile[] = [];
  const failures: string[] = [];
  let approvalToken: string | undefined;
  let bridge: DshChannelBridge;
  const inbound = (id: string, text: string): InboundMessage => ({
    messageId: id, chatId, chatType: 'p2p', senderId: owner.ownerId, text,
  });
  const transport: ChannelTransport = {
    async start() {}, stop() {},
    async sendText(target, text) {
      assert.equal(target, chatId);
      texts.push(text);
      approvalToken ??= /^允许 ([a-f0-9]{32})$/m.exec(text)?.[1];
    },
    async sendFile(target, file) { assert.equal(target, chatId); files.push(file); },
  };
  bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  // Force a real native approval for the fixture's write. No tool or loop is replaced.
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.callId === 'fixture-1-3') {
      setApprovalPolicy(execution.agent!.session, 'never');
      return { kind: 'ask', reason: 'The native never policy must reject this request.' };
    }
    if (execution.callId === 'fixture-1-4') {
      setSandboxMode(execution.agent!.session, 'danger-full-access');
      return { kind: 'allow' };
    }
    if (execution.name === 'write') {
      // Simulate the local operator selecting bounded writes, so this write goes through a real native approval.
      setSandboxMode(execution.agent!.session, 'workspace-write');
      return { kind: 'ask', reason: 'Approve the local fixture file write.' };
    }
    return next();
  }, { prepend: true });
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error),
          stack: error instanceof Error ? error.stack : undefined, failures }, null, 2));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    const first = inbound('message-1', '创建并交付一个测试文件。');
    await bridge.receive({ ...first, senderId: 'ou_stranger' });
    await bridge.receive({ ...first, chatType: 'group' });
    assert.equal(ctx.agents.get(sessionId), undefined);
    if (config.phase === 1) {
      await ctx.sessionController.create({ sessionId, cwd: config.workspace });
      const before = await ctx.sessionController.resolveAgent(sessionId);
      if ('error' in before) throw before.error;
      // Full access, as a system default of 完全权限 gives a new session; the bridge must leave it that way.
      setSandboxMode(before.agent.session, 'danger-full-access');
    }
    await bridge.receive(first);
    const found = await ctx.sessionController.resolveAgent(sessionId);
    if ('error' in found) throw found.error;
    const agent = found.agent;
    if (config.phase === 1) {
      await until(() => approvalToken !== undefined, 'native approval prompt was not sent', 10_000);
      // A user reply arrives after sendText returns and the full prompt is presented.
      await new Promise<void>(resolve => setImmediate(resolve));
      await assert.rejects(access(join(config.workspace, filePath)), { code: 'ENOENT' });
      await bridge.receive({ ...inbound('wrong-owner-approval', `允许 ${approvalToken}`), senderId: 'ou_stranger' });
      await bridge.receive(inbound('stale-approval', `/approve ${'0'.repeat(32)}`));
      await assert.rejects(access(join(config.workspace, filePath)), { code: 'ENOENT' });
      await bridge.receive(inbound('approval-fixture', '允许'));
    }
    await agent.whenIdle();
    await bridge.drain();
    // No instruction file may be loaded from above the workspace: the assistant is told this repository's
    // developer rules otherwise, in every session of every channel.
    assert.equal(instructionProjectRoot(agent.session.snapshotEvents()), '', 'the workspace must be its own project root');
    if (config.phase === 1) {
      assert.equal(model.calls, 6, 'the native loop must continue after tool and policy failures');
      assert.equal(files.length, 1);
      assert.equal(files[0]!.bytes.toString(), fileContent);
      assert.ok(texts.includes('测试文件已生成并交付。'));
      const events = agent.session.snapshotEvents();
      assert.equal(events.filter(event => event.type === 'turn/start').length, 1, 'the Chinese approval reply must not start another turn');
      const ask = events.find(event => event.type === 'approval/asked');
      const grant = events.find(event => event.type === 'approval/decided' && event.data.outcome === 'allowed-once');
      const write = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'fixture-1-1');
      assert.ok(ask && grant && write && ask.seq < grant.seq && grant.seq < write.seq);
      assert.ok(events.some(event => event.type === 'tool/result' && event.data.message.isError));
      const modes = events.filter(event => event.type === 'sandbox/mode');
      const unrestricted = modes.find(event => event.data.mode === 'danger-full-access')!;
      const admitted = events.find(event => event.type === 'agent/inbox/spliced' && event.data.inserted.length > 0)!;
      assert.ok(unrestricted && admitted && unrestricted.seq < admitted.seq);
      assert.deepEqual(modes.filter(event => event.seq > unrestricted.seq && event.seq < admitted.seq), [], 'a remote session is admitted with the permission it has');
      const neverAsk = events.find(event => event.type === 'approval/asked' && event.data.callId === 'fixture-1-3');
      assert.ok(neverAsk?.type === 'approval/asked');
      assert.ok(events.some(event => event.type === 'approval/decided' && event.data.id === neverAsk.data.id && event.data.outcome === 'rejected'));
      assert.equal(texts.filter(text => text.startsWith('需要你确认后继续\n')).length, 1, 'never must not dispatch another approval prompt');
      const unguarded = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === 'fixture-1-4');
      assert.ok(unguarded?.type === 'tool/result');
      assert.ok(!unguarded.data.message.isError, `full access runs in a remote session as it does locally: ${JSON.stringify(unguarded)}`);
      assert.match(JSON.stringify(unguarded), /nexus-native-tool-history/);
      setSandboxMode(agent.session, 'read-only');
      setApprovalPolicy(agent.session, 'ask');
      await bridge.receive(first);
      await agent.whenIdle();
      await bridge.drain();
      assert.equal(model.calls, 6, 'duplicate Feishu delivery must not execute another turn');
      assert.equal(files.length, 1);
    } else {
      assert.equal(model.calls, 0, 'duplicate input after process restart must remain deduplicated');
      assert.equal(texts.length, 0, 'resuming must not replay old replies');
      await bridge.receive(inbound('message-2', '继续，重新读取刚才的文件。'));
      await agent.whenIdle();
      await bridge.drain();
      assert.equal(model.calls, 2);
      assert.equal(model.restoredToolHistory, true);
      assert.ok(texts.includes('已恢复原会话并重新读取文件。'));
      assert.equal(files.length, 0);
      assert.equal(await readFile(join(config.workspace, filePath), 'utf8'), fileContent);
    }
    assert.deepEqual(failures, []);
    assert.equal(await ctx.sessions.flush(agent.session), true);
    const events = agent.session.snapshotEvents();
    await bridge.close();
    await assert.rejects(bridge.receive(first), /connection_cancelled/);
    await writeFile(config.reportFile, JSON.stringify({
      passed: true, phase: config.phase, sessionId, modelCalls: model.calls,
      nativeEvents: events.length,
      completedTurns: events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length,
      fileDeliveries: files.length, restoredToolHistory: model.restoredToolHistory,
      checks: config.phase === 1
        ? ['owner_filter', 'group_filter', 'native_read_error_recovery', 'native_approval_order', 'chinese_approval_stays_in_current_turn', 'write_then_continue',
          'explicit_file_delivery', 'native_message_deduplication', 'remote_session_keeps_its_permission',
          'native_never_policy_rejects', 'remote_full_access_runs', 'invalid_approval_replies_do_not_grant', 'closed_bridge_rejects_admission']
        : ['same_native_session', 'restart_message_deduplication', 'no_old_reply_replay', 'native_tool_history_restored', 'continued_file_read'],
    }, null, 2));
  }
}
