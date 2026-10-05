import test from 'node:test';
import assert from 'node:assert/strict';
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session';
import { channelWorkFixture } from './channel-work-fixture.js';

export function workEvents(channel: string, remote: boolean, callId: string, turn = 1): SessionEvent[] {
  return [
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { source: { kind: 'user', ...(remote ? { rpcId: `${channel}-admitted` } : {}) }, content: [{ type: 'text', text: 'body is irrelevant' }] } },
    { type: 'tool/call', data: { turn, callId, name: 'run_code', arguments: '{}' } },
  ].map((event, seq) => ({ ...event, seq, time: 100 + seq })) as SessionEvent[];
}

for (const channel of ['wechat', 'feishu', 'wecom']) test(`${channel}: persistent task origin isolates local dispatch, scoped interactions and native notices`, async () => {
  const owner = `nexus-${channel}-${'a'.repeat(32)}`, viewer = `${owner}-1`;
  const fixture = channelWorkFixture({ activeFor: () => viewer }), work = fixture.work;
  const events = workEvents(channel, true, 'root');
  const session = { id: owner, snapshotEvents: () => events } as unknown as Session;
  await work.record('ct-11111111', session, 'root', '/workspace'); await work.bindJob('ct-11111111', 'coder-1');
  events.push(...workEvents(channel, false, 'desktop', 2));
  await work.record('ct-22222222', session, 'desktop', '/workspace');
  assert.equal(work.visibleHistory('ct-11111111', viewer, '/workspace'), true);
  assert.equal(work.visibleHistory('ct-22222222', viewer, '/workspace'), false);
  assert.equal(work.visibleHistory('ct-11111111', viewer, '/elsewhere'), false);
  assert.equal(work.visibleHistory('ct-11111111', `nexus-${channel}-${'b'.repeat(32)}`, '/workspace'), false);
  assert.equal(work.visibleHistory('ct-11111111', `${owner}-2`, '/workspace'), false);
  assert.equal(work.visibleHistory('missing', viewer, '/workspace'), false);
  assert.equal(work.remoteCall(owner, events, 'root'), true, 'later desktop turns cannot rewrite dispatch origin');
  assert.equal(work.remoteCall(owner, events, 'desktop'), false);
  assert.equal(work.remoteCall(owner, events, 'unknown'), false);
  const questions: object = [];
  await work.withQuestions('ct-11111111', questions, async () => { assert.equal(work.questionOrigin(questions, owner), true); assert.equal(work.questionOrigin(questions, viewer), false); });
  assert.equal(work.questionOrigin(questions, owner), undefined);
  await work.withQuestions('ct-22222222', questions, async () => assert.equal(work.questionOrigin(questions, owner), false));
  await work.withCall({ agent: { id: owner, session }, callId: 'nested', rootCallId: 'root' } as never, async () => assert.equal(work.remoteCall(owner, [], 'nested'), true));
  assert.equal(work.remoteCall(owner, [], 'nested'), false);
  const restarted = fixture.reopen();
  const notice = (task: string, job = 'coder-1') => ({ source: { kind: 'tool-jobs', form: 'notice' }, content: [{ type: 'text', text: `background job ${job} (coder: Codex [${task}]: build) completed` }] }) as unknown as UserMessage;
  assert.equal(restarted.remoteMessage(owner, notice('ct-11111111')), true);
  assert.equal(restarted.remoteMessage(owner, notice('ct-22222222')), false);
  assert.equal(restarted.remoteMessage(owner, notice('ct-11111111', 'coder-2')), false);
  const forged = { ...notice('ct-11111111'), source: { kind: 'user' } } as UserMessage;
  assert.equal(restarted.remoteMessage(owner, forged), false, 'prose is not a native job notice');
  assert.equal(restarted.remoteMessage(owner, { source: { kind: 'schedule' }, content: [] } as unknown as UserMessage), true);
  for (const [callId, expected] of [['root', true], ['desktop', false], ['unknown', false]] as const) {
    const late = workEvents(channel, false, 'followup', 3).map(event => event.type === 'user/message'
      ? { ...event, data: { ...event.data, source: { kind: 'user-question-reply', callId, outcome: 'answered' } as UserMessage['source'] } } : event);
    const message = late.find(event => event.type === 'user/message')!;
    assert.ok(message.type === 'user/message');
    assert.equal(restarted.remoteMessage(owner, message.data), false, 'a late reply without its original call cannot authorize delivery');
    assert.equal(restarted.remoteTurn(owner, [...events, ...late], 3), expected, 'late replies keep the original question scope');
    assert.equal(restarted.remoteCall(owner, [...events, ...late], 'followup'), expected, 'tasks dispatched after a late reply inherit that scope');
  }
});

test('native job notices persist by message identity across job counter reuse, concurrent calls and restart', async () => {
  const owner = `nexus-wechat-${'c'.repeat(32)}`;
  const fixture = channelWorkFixture(), work = fixture.work;
  const events = [...workEvents('wechat', true, 'remote'), ...workEvents('wechat', false, 'desktop', 2)];
  const session = { id: owner, snapshotEvents: () => events };
  const exec = (id: string) => ({ agent: { id: owner, session }, callId: id, rootCallId: id }) as never;
  const registered = (id: string) => ({ type: 'registered', job: { id, owner } }) as never;
  const notice = (id: string, job = 'bash-1') => ({ id, source: { kind: 'tool-jobs', form: 'notice' }, content: [{ type: 'text', text: `background job ${job} (bash: local check) finished completed.` }] }) as unknown as UserMessage;
  let release!: () => void;
  const remote = work.withCall(exec('remote'), async () => {
    await new Promise<void>(resolve => { release = resolve; });
    work.jobEvent(registered('bash-1'));
  });
  await work.withCall(exec('desktop'), async () => { work.jobEvent(registered('bash-2')); });
  release(); await remote;
  const original = notice('original'), desktop = notice('desktop', 'bash-2');
  work.noticeMessage(owner, original); work.noticeMessage(owner, desktop);
  assert.equal(work.remoteMessage(owner, original), true);
  assert.equal(work.remoteMessage(owner, desktop), false);
  assert.equal(work.remoteMessage(owner, notice('unknown')), false, 'job prose alone cannot establish notice identity');
  await work.close();
  const restored = fixture.reopen();
  assert.equal(restored.remoteMessage(owner, original), true);
  await restored.withCall(exec('desktop'), async () => restored.jobEvent(registered('bash-1')));
  const reused = notice('reused'); restored.noticeMessage(owner, reused);
  assert.equal(restored.remoteMessage(owner, reused), false, 'counter reuse does not inherit a previous remote grant');
  assert.equal(restored.remoteMessage(owner, original), true, 'counter reuse does not rewrite an old queued notice');
  const forged = { ...original, source: { kind: 'user' } } as UserMessage;
  assert.equal(restored.remoteMessage(owner, forged), false);
  assert.equal(restored.remoteMessage(`${owner}-1`, original), false);
  await restored.close();
});
