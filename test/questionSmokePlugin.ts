/** Native ask_user_question pauses and resumes the same turn through a local channel. */
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
import { SessionId } from '@deepseek-ai/dsh-session';
import { access, writeFile } from 'node:fs/promises';
import { installBridge } from '../src/dsh/bridge.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';
import { until } from './helpers.js';

export const name = 'nexus-question-smoke';
export const inject = ['llm', 'sessionController', 'sessions', 'sessionPersistence', 'tools', 'sandboxPolicy', 'agents', 'userQuestions'];
const owner = { channel: 'wechat' as const, accountId: 'wx-question-bot', ownerId: 'wx-question-owner' };
const sessionId = SessionId(sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'));
const inbound = (messageId: string, text: string): InboundMessage => ({ messageId, text,
  chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p' });

class FixtureModel extends LlmAdapter {
  calls = 0;
  async resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> {
    return { provider, id, name: 'Local question fixture', context: { contextWindow: 128000 }, defaultMaxTokens: 2048 };
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted();
    assert.ok(options.tools?.some(tool => tool.name === 'ask_user_question'));
    const step = this.calls++;
    if (step === 0) {
      const block = { type: 'tool-call' as const, id: ToolCallId('native-question'), name: 'ask_user_question', arguments: JSON.stringify({
        questions: [{ id: 'format', question: '采用哪种格式？', options: [{ label: 'Markdown' }, { label: 'PDF' }] },
          { id: 'title', question: '报告标题是什么？' }],
      }) };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      assert.equal(step, 1);
      const result = options.messages.find(message => message.role === 'tool' && message.toolCallId === 'native-question');
      assert.ok(result);
      const text = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      assert.deepEqual(JSON.parse(text), { answers: [{ id: 'format', selected: ['PDF'] },
        { id: 'title', selected: [], custom: '本地验收报告' }] });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '按回答完成原任务。' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '按回答完成原任务。' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}

export function apply(ctx: Context, config: { phase: number; workspace: string; triggerFile: string; reportFile: string }): void {
  const model = new FixtureModel();
  ctx.effect(() => ctx.llm.registerAdapter(['nexus-fixture'], model));
  const texts: string[] = [];
  const failures: string[] = [];
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {},
    async sendText(_chatId, text) { texts.push(text); } };
  const bridge = installBridge(ctx, transport, owner, config.workspace, code => failures.push(code));
  let running = false;
  const timer = setInterval(() => {
    void access(config.triggerFile).then(() => {
      if (running) return;
      running = true;
      clearInterval(timer);
      void run().catch(async error => {
        await writeFile(config.reportFile, JSON.stringify({ passed: false, error: String(error), failures }));
      });
    }).catch(() => {});
  }, 100);
  ctx.effect(() => () => clearInterval(timer));

  async function run() {
    await bridge.receive(inbound('initial-task', '按我的回答生成报告。'));
    const prompts = () => texts.filter(text => text.startsWith('需要你补充信息'));
    await until(() => prompts().length === 1, 'native question not presented', 10_000);
    await bridge.receive(inbound('waiting-status', '状态'));
    assert.match(texts.at(-1)!, /等待你的回答/);
    await bridge.receive({ ...inbound('foreign', '回答 1'), senderId: 'stranger' });
    await bridge.receive(inbound('invalid', '回答 9'));
    assert.equal(model.calls, 1);
    await bridge.receive(inbound('answer-1', '回答 2'));
    await until(() => prompts().length === 2, 'second native question not presented', 10_000);
    await bridge.receive(inbound('answer-1', '回答 2'));
    assert.equal(model.calls, 1);
    await bridge.receive(inbound('answer-2', '回答 本地验收报告'));
    const agent = ctx.agents.get(sessionId)!;
    await agent.whenIdle();
    await bridge.drain();
    const events = agent.session.snapshotEvents();
    assert.equal(events.filter(event => event.type === 'turn/start').length, 1);
    assert.equal(events.filter(event => event.type === 'turn/end' && event.data.reason.kind === 'completed').length, 1);
    assert.equal(model.calls, 2);
    assert.ok(texts.includes('按回答完成原任务。'));
    await bridge.receive(inbound('completed-status', '状态'));
    assert.match(texts.at(-1)!, /已完成/);
    assert.equal(model.calls, 2);
    assert.equal(await ctx.sessions.flush(agent.session), true);
    assert.deepEqual(failures, []);
    await bridge.close();
    await writeFile(config.reportFile, JSON.stringify({ passed: true, phase: config.phase, modelCalls: model.calls,
      checks: ['native_ask_user_question_tool', 'question_batch_answers_in_native_history', 'question_answer_resumes_same_turn',
        'question_duplicate_and_invalid_replies_isolated', 'native_waiting_and_completed_status'],
    }, null, 2));
  }
}
