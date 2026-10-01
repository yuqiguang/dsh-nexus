import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { DshChannelBridge, TRANSCRIBED_NOTE } from '../src/dsh/bridge.js';
import { ChannelError } from '../src/channels/types.js';
import { sessionIdFor, type ChannelTransport, type InboundMessage } from '../src/channels/protocol.js';

const owner = { channel: 'wechat' as const, accountId: 'attach-bot', ownerId: 'attach-owner' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const inbound = (messageId: string, text: string, extra: Partial<InboundMessage> = {}): InboundMessage =>
  ({ messageId, text, chatId: owner.ownerId, senderId: owner.ownerId, chatType: 'p2p', ...extra });

async function fixture(t: { after(fn: () => unknown): void }, rejectImages = false, transcribe?: (wav: Buffer) => Promise<string>) {
  const workspace = await mkdtemp(join(tmpdir(), 'nexus-attach-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const prompts: { content: { type: string; text?: string; mediaType?: string; name?: string }[] }[] = [];
  const texts: string[] = [];
  const session = { id: sessionIdFor(owner.accountId, owner.ownerId, owner.ownerId, 'wechat'), snapshotEvents: () => [] };
  const ctx = {
    sessionController: { async create() {}, async resolveAgent() { return { agent: { id: session.id, session } }; },
      async prompt(input: { content: { type: string }[] }) {
        if (rejectImages && input.content.some(part => part.type === 'image')) {
          throw Object.assign(new Error('Model does not support image input.'), { code: 'session/attachment-invalid', details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' } });
        }
        prompts.push(input as typeof prompts[number]);
      } },
    sessions: { async flush() { return true; } }, sandboxPolicy: { resolve: () => ({ mode: 'workspace-write' }) },
  } as unknown as Context;
  const transport: ChannelTransport = { async start() {}, stop() {}, async sendFile() {}, async sendText(_chatId, text) { texts.push(text); } };
  const bridge = new DshChannelBridge(ctx, transport, owner, workspace, () => {}, undefined, undefined, transcribe ? { transcribe } : {});
  t.after(() => bridge.close());
  return { bridge, prompts, texts, workspace };
}

test('pictures reach the native prompt as image parts and every attachment is saved and described by path', async t => {
  const f = await fixture(t);
  await f.bridge.receive(inbound('m1', '这两个文件帮我看看', { attachments: [
    { kind: 'image', bytes: png }, { kind: 'file', name: '合同.pdf', bytes: Buffer.from('%PDF-1.4') }] }));
  assert.equal(f.prompts.length, 1);
  const [text, image, ...rest] = f.prompts[0]!.content;
  assert.equal(rest.length, 0);
  assert.equal(text!.type, 'text');
  assert.match(text!.text!, /^这两个文件帮我看看\n\[附件\] 图片 image-\d{6}\.png（\d+ B）已保存到 inbox\/\d{4}-\d{2}-\d{2}\/image-\d{6}\.png\n\[附件\] 文件 合同\.pdf（8 B）已保存到 inbox\/\d{4}-\d{2}-\d{2}\/合同\.pdf$/);
  assert.equal(image!.type, 'image');
  assert.equal(image!.mediaType, 'image/png');
  assert.match(image!.name!, /^image-\d{6}\.png$/);
  const saved = /已保存到 (inbox\/\S+合同\.pdf)/.exec(text!.text!)![1]!;
  assert.equal(await readFile(join(f.workspace, saved), 'utf8'), '%PDF-1.4');
  assert.deepEqual(f.texts, []);
});

test('a model that cannot see pictures still gets the task as text with the saved path', async t => {
  const f = await fixture(t, true);
  await f.bridge.receive(inbound('m2', '', { attachments: [{ kind: 'image', bytes: png }] }));
  assert.equal(f.prompts.length, 1);
  assert.deepEqual(f.prompts[0]!.content.map(part => part.type), ['text']);
  assert.match(f.prompts[0]!.content[0]!.text!, /当前模型不能直接看图/);
  assert.match(f.prompts[0]!.content[0]!.text!, /inbox\//);
});

test('a picture captioned with a control word is a task, and dropped attachments are reported once', async t => {
  const f = await fixture(t);
  await f.bridge.receive(inbound('m3', '允许', { attachments: [{ kind: 'image', bytes: png }] }));
  assert.equal(f.prompts.length, 1, 'a caption never settles an approval');
  await f.bridge.receive(inbound('m4', '', { dropped: [{ kind: 'voice', reason: 'unsupported' }] }));
  assert.equal(f.prompts.length, 1, 'a message that was only an unsupported item starts no task');
  assert.match(f.texts.at(-1)!, /语音未能接收/);
  await f.bridge.receive(inbound('m5', '顺便看下', { dropped: [{ kind: 'file', reason: 'download_failed' }] }));
  assert.equal(f.prompts.length, 2);
  assert.match(f.texts.at(-1)!, /文件未能接收：下载失败/);
});

test('a voice clip without a transcript goes through the speech service, is kept in the inbox, and can even be a control word', async t => {
  const heard: Buffer[] = [];
  const answers = ['允许', '明天下午三点和张老师开会'];
  const f = await fixture(t, false, async wav => { heard.push(wav); return answers.shift()!; });
  const wav = Buffer.from('RIFF....WAVEfmt fixture');
  await f.bridge.receive(inbound('v1', '', { attachments: [{ kind: 'voice', bytes: wav, seconds: 2 }] }));
  assert.equal(f.prompts.length, 0, 'a spoken 允许 is an approval reply, not a task');
  assert.match(f.texts.at(-1)!, /没有匹配的待审批操作/);
  await f.bridge.receive(inbound('v2', '', { attachments: [{ kind: 'voice', bytes: wav, seconds: 5 }] }));
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0]!.content[0]!.text, '明天下午三点和张老师开会' + TRANSCRIBED_NOTE);
  assert.equal(heard.length, 2);
  const day = new Date().toISOString().slice(0, 10);
  const files = (await readdir(join(f.workspace, 'inbox'))).length ? await readdir(join(f.workspace, 'inbox', (await readdir(join(f.workspace, 'inbox')))[0]!)) : [];
  assert.ok(files.some(name => /^voice-\d{6}\.wav$/.test(name)), `voice clips are kept: ${files.join(',')} (${day})`);
  // A transcript the channel supplied is marked the same way, and its text still parses as typed text.
  await f.bridge.receive(inbound('v3', '记个待办，周五前交报告', { transcribed: true }));
  assert.equal(f.prompts[1]!.content[0]!.text, '记个待办，周五前交报告' + TRANSCRIBED_NOTE);
});

test('without a speech service a bare voice clip only gets a hint, and a failing service is explained', async t => {
  const plain = await fixture(t);
  const wav = Buffer.from('RIFF....WAVEfmt fixture');
  await plain.bridge.receive(inbound('v4', '', { attachments: [{ kind: 'voice', bytes: wav }] }));
  assert.equal(plain.prompts.length, 0);
  assert.match(plain.texts.at(-1)!, /长按语音选“转文字”/);
  await plain.bridge.receive(inbound('v5', '顺便', { attachments: [{ kind: 'voice', bytes: wav }, { kind: 'image', bytes: png }] }));
  assert.equal(plain.prompts.length, 1, 'the rest of the message still goes on');
  assert.match(plain.prompts[0]!.content[0]!.text!, /^顺便\n\[附件\] 图片/);
  const failing = await fixture(t, false, async () => { throw new ChannelError('speech_unauthorized'); });
  await failing.bridge.receive(inbound('v6', '', { attachments: [{ kind: 'voice', bytes: wav }] }));
  assert.equal(failing.prompts.length, 0);
  assert.match(failing.texts.at(-1)!, /语音转写失败：转写服务拒绝了密钥/);
});
