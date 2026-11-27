import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGeminiTask } from '../src/coders/gemini.js';
import { spawnGeminiAcp, type GeminiSpawn } from '../src/coders/gemini-process.js';
import { findGeminiSession, parseGeminiSession } from '../src/coders/transcript.js';
import type { CoderRequest } from '../src/coders/types.js';
import { geminiTask, type GeminiRpc } from './gemini-fixture.js';

// Opt in with a downloaded official CLI entry. FakeContentGenerator is selected before
// the Google client is created; this checks the real protocol without an account/model request.
const entry = process.env.NEXUS_GEMINI_CLI;
const chunk = (parts: unknown[]) => ({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] });
const call = (name: string, args: unknown) => ({ method: 'generateContentStream', response: [chunk([{ functionCall: { name: `mcp_nexus_coder_${name}`, args } }])] });

test('official Gemini CLI uses the private MCP tools and restores the same saved native conversation', {
  skip: entry ? false : 'set NEXUS_GEMINI_CLI to an official Gemini CLI JS entry to run the native fake-provider check', timeout: 120_000,
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-native-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project'), home = join(root, 'gemini-home');
  await mkdir(cwd); await mkdir(home);
  await mkdir(join(cwd, '.gemini'));
  await writeFile(join(cwd, '.gemini/settings.json'), JSON.stringify({
    tools: { core: ['run_shell_command'] }, hooksConfig: { enabled: true },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node project-hook.cjs' }] }] },
  }));
  await writeFile(join(cwd, 'project-hook.cjs'), 'require("node:fs").writeFileSync("project-hook-ran", "bad");');
  await writeFile(join(cwd, 'check.cjs'), 'const fs = require("node:fs"); if (fs.readFileSync("notes.txt", "utf8") !== "native fixture") process.exit(1); console.log("native fixture verified");');
  const requests: CoderRequest[] = [], incoming: GeminiRpc[] = [], outgoing: GeminiRpc[] = [], sessions: string[] = [];
  const diagnostics: (() => string | undefined)[] = [];
  const spawn: GeminiSpawn = (directory, launch) => {
    const native = spawnGeminiAcp(directory, launch);
    diagnostics.push(() => native.diagnostic);
    return { ...native,
      get diagnostic() { return native.diagnostic; },
      write(line) { outgoing.push(JSON.parse(line)); native.write(line); },
      lines: (async function* () { for await (const line of native.lines) {
        try { incoming.push(JSON.parse(line)); } catch { /* startup diagnostics are not ACP messages */ }
        yield line;
      } })(),
    };
  };
  const run = async (resume?: string) => {
    const responses = join(root, resume ? 'resume-responses.jsonl' : 'new-responses.jsonl');
    const records = [
      ...(resume ? [call('read_file', { path: 'notes.txt' })] : [
        call('write_file', { path: 'notes.txt', content: 'native fixture' }),
        call('ask_question', { question: 'Which database?', options: [{ label: 'SQLite' }, { label: 'PostgreSQL' }] }),
        call('command', { command: 'node check.cjs' }),
      ]),
      call('report_result', { status: 'completed', text: resume ? 'native conversation resumed' : 'native MCP work completed' }),
      { method: 'generateContentStream', response: [chunk([{ text: 'Finished the requested work.' }])] },
      ...Array.from({ length: 80 }, () => ({ method: 'countTokens', response: { totalTokens: 100 } })),
      ...Array.from({ length: 40 }, () => ({ method: 'generateContent', response: chunk([{ text: '{"next_speaker":"user"}' }]) })),
    ];
    await writeFile(responses, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const hooks = runGeminiTask(geminiTask(cwd, resume ? { coderSessionId: resume, description: 'Continue the native fixture' } : {}), {
      launch: { command: process.execPath, args: [entry!, '--fake-responses-non-strict', responses], home, authMethod: 'gemini-api-key', model: 'gemini-2.5-flash',
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GEMINI_API_KEY: 'fixture-key-never-sent-to-a-model' } },
      spawn, onSession: id => sessions.push(id), decide: async request => {
        requests.push(request);
        return request.kind === 'question' ? { behavior: 'allow', updatedInput: { answers: { 'Which database?': 'SQLite' } } } : { behavior: 'allow' };
      },
    });
    const deadline = setTimeout(() => hooks.cancel('native fixture exceeded its deadline'), 50_000);
    try { return await hooks.done; } finally { clearTimeout(deadline); }
  };
  const first = await run();
  assert.equal(first.status, 'completed', JSON.stringify({ outcome: first, diagnostic: diagnostics.map(read => read()), requests: requests.map(request => request.kind), updates: incoming.filter(message => message.method === 'session/update').map(message => {
    const update = message.params.update;
    return { type: update.sessionUpdate, title: update.title, status: update.status, content: update.content };
  }) }));
  assert.equal(first.result, 'native MCP work completed');
  assert.equal(await readFile(join(cwd, 'notes.txt'), 'utf8'), 'native fixture');
  assert.deepEqual(requests.map(request => request.kind), ['file-write', 'question', 'command']);
  assert.equal(requests.at(-1)?.command, 'node check.cjs');
  await assert.rejects(readFile(join(cwd, 'project-hook-ran')), 'project settings cannot re-enable unmonitored startup hooks');
  // ACP can allow bridge access directly; actual file/command/user decisions
  // above must still pass Nexus. Any native permission request stays scoped.
  for (const permission of incoming.filter(message => message.method === 'session/request_permission')) {
    assert.equal(permission.params.toolCall._meta['gemini-cli'].mcp.server_name, 'nexus_coder');
    assert.equal(outgoing.find(message => message.id === permission.id && !message.method)?.result?.outcome.outcome, 'selected');
  }
  const id = sessions[0]!;
  assert.ok(id);
  const nativeFile = await findGeminiSession([join(home, '.gemini')], id, cwd);
  assert.ok(nativeFile, 'the real CLI saved the complete native session identity');
  const firstHistory = parseGeminiSession(await readFile(nativeFile, 'utf8'), { from: 0, to: Infinity });
  assert.ok(firstHistory.some(entry => entry.kind === 'user'));
  const second = await run(id);
  assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.equal(second.result, 'native conversation resumed');
  assert.deepEqual(sessions, [id, id]);
  assert.deepEqual(outgoing.filter(message => ['session/new', 'session/load'].includes(message.method ?? '')).map(message => message.method), ['session/new', 'session/load']);
  assert.equal(requests.at(-1)?.kind, 'file-read');
  assert.equal(await findGeminiSession([join(home, '.gemini')], id, cwd), nativeFile);
});
