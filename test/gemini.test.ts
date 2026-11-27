import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm, symlink, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { runGeminiTask } from '../src/coders/gemini.js';
import { createGeminiToolsBridge } from '../src/coders/gemini-tools.js';
import { geminiTaskSettings, geminiSessionWorkspace, geminiAcpArgs, prepareGeminiLaunch, GEMINI_STRICT_PROBLEM } from '../src/coders/gemini-config.js';
import { findGeminiSession, parseGeminiSession } from '../src/coders/transcript.js';
import { redact } from '../src/coders/normalize.js';
import type { CoderRequest } from '../src/coders/types.js';
import type { RetryNotice } from '../src/coders/retry.js';
import { fakeGemini, geminiLaunch, geminiTask, geminiToolsClient } from './gemini-fixture.js';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'fixture reached the expected state'); await delay(2); }
}
const allow = async () => ({ behavior: 'allow' as const });

test('Gemini startup isolates its tool configuration from project settings and gives concurrent runs independent homes with persistent sessions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const launch = { ...geminiLaunch(root), args: ['bundle/gemini.js'], model: 'fixture-model' };
  const a = await prepareGeminiLaunch(launch, root), b = await prepareGeminiLaunch(launch, root);
  t.after(() => Promise.all([a.close(), b.close()]));
  assert.notEqual(a.cwd, b.cwd);
  assert.equal(a.launch.env.GEMINI_CLI_HOME, a.cwd);
  assert.equal(a.workspace, b.workspace); assert.equal(a.workspace, geminiSessionWorkspace(launch.home, root));
  assert.notEqual(a.workspace, root);
  assert.equal(await realpath(join(a.cwd, '.gemini/tmp')), join(launch.home, '.gemini/tmp'));
  assert.equal(a.launch.env.GEMINI_CLI_NO_RELAUNCH, '1');
  const settings = JSON.parse(await readFile(join(a.cwd, '.gemini/settings.json'), 'utf8'));
  await assert.rejects(readFile(a.launch.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!));
  assert.deepEqual(settings.tools.core, []);
  assert.deepEqual(settings.tools.allowed, [
    'mcp_nexus_coder_read_file', 'mcp_nexus_coder_write_file', 'mcp_nexus_coder_replace_text',
    'mcp_nexus_coder_command', 'mcp_nexus_coder_ask_question', 'mcp_nexus_coder_report_result',
    'mcp_nexus_web_search', 'mcp_nexus_web_fetch', 'mcp_nexus_web_local_check',
  ]);
  assert.equal(settings.hooksConfig.enabled, false);
  assert.equal(settings.admin.extensions.enabled, false);
  assert.equal(settings.advanced.ignoreLocalEnv, true);
  assert.equal(settings.security.auth.selectedType, 'gemini-api-key');
  assert.equal((geminiTaskSettings('oauth-personal').security as any).auth.selectedType, 'oauth-personal');
  assert.deepEqual(geminiAcpArgs(launch), ['bundle/gemini.js', '--acp', '--approval-mode', 'default', '--allowed-mcp-server-names', 'nexus_coder,nexus_web', '--model', 'fixture-model']);
  assert.ok(!JSON.stringify(settings).includes(launch.env.GEMINI_API_KEY!), 'keys stay out of startup files');
});

test('Gemini OAuth refresh persists atomically without overwriting newer credentials from concurrent runs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-oauth-')); t.after(() => rm(root, { recursive: true, force: true }));
  const launch = { ...geminiLaunch(root), authMethod: 'oauth-personal' as const };
  const persistent = join(launch.home, '.gemini');
  await mkdir(persistent, { recursive: true });
  const original = JSON.stringify({ refresh_token: 'fixture-original' });
  await writeFile(join(persistent, 'oauth_creds.json'), original);
  await writeFile(join(persistent, 'google_accounts.json'), JSON.stringify({ active: 'fixture@example.invalid' }));
  const a = await prepareGeminiLaunch(launch, root), b = await prepareGeminiLaunch(launch, root), unchanged = await prepareGeminiLaunch(launch, root);
  t.after(() => Promise.all([a.close(), b.close(), unchanged.close()]));
  assert.equal(await readFile(join(a.cwd, '.gemini/oauth_creds.json'), 'utf8'), original);
  const refreshed = JSON.stringify({ refresh_token: 'fixture-refreshed' });
  await writeFile(join(a.cwd, '.gemini/oauth_creds.json'), refreshed);
  await writeFile(join(b.cwd, '.gemini/oauth_creds.json'), JSON.stringify({ refresh_token: 'fixture-stale-refresh' }));
  await a.close(); await Promise.all([b.close(), unchanged.close()]);
  assert.equal(await readFile(join(persistent, 'oauth_creds.json'), 'utf8'), refreshed);
  await assert.rejects(readFile(join(a.cwd, '.gemini/settings.json')));
  const invalid = await prepareGeminiLaunch(launch, root);
  await writeFile(join(invalid.cwd, '.gemini/oauth_creds.json'), 'null');
  await assert.rejects(invalid.close(), /JSON 对象/);
  assert.equal(await readFile(join(persistent, 'oauth_creds.json'), 'utf8'), refreshed);
  await assert.rejects(readFile(join(invalid.cwd, '.gemini/settings.json')));
});

test('Gemini drives native ACP and complete MCP operations through the same task decider', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-flow-')); t.after(() => rm(root, { recursive: true, force: true }));
  const requests: CoderRequest[] = [], sessions: string[] = [], activity: string[] = [];
  let successes = 0;
  let connection: any;
  const fake = fakeGemini(async (message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    if (message.method === 'session/new') { connection = message.params; io.reply(message, { sessionId: 'native-gemini-session' }); }
    if (message.method === 'session/prompt') {
      const client = await geminiToolsClient(connection);
      try {
        const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'report_result'));
        assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'notes.txt', content: 'fixture result' } })).isError, undefined);
        assert.match(JSON.stringify(await client.callTool({ name: 'read_file', arguments: { path: 'notes.txt' } })), /fixture result/);
        assert.match(JSON.stringify(await client.callTool({ name: 'ask_question', arguments: { question: 'Which database?', options: [{ label: 'SQLite' }] } })), /SQLite/);
        assert.equal((await client.callTool({ name: 'report_result', arguments: { status: 'completed', text: 'work and self-checks done' } })).isError, undefined);
        io.push({ method: 'session/update', params: { sessionId: 'native-gemini-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Delivery is ready.' } } } });
        io.reply(message, { stopReason: 'end_turn' });
      } finally { await client.close(); }
    }
  });
  const result = await runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport, onSession: id => sessions.push(id), onActivity: text => activity.push(text), onSuccess: () => { successes++; },
    decide: async request => { requests.push(request); return request.kind === 'question' ? { behavior: 'allow', updatedInput: { answers: { 'Which database?': 'SQLite' } } } : { behavior: 'allow' }; } }).done;
  assert.deepEqual(result, { status: 'completed', result: 'work and self-checks done' });
  assert.deepEqual(sessions, ['native-gemini-session']);
  assert.deepEqual(requests.map(request => request.kind), ['file-write', 'file-read', 'question']);
  assert.equal(requests[0]!.raw.content, 'fixture result');
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'fixture result');
  assert.ok(activity.some(text => text.includes('Gemini 写入')));
  assert.equal(successes, 2, 'successful reads count as real progress alongside writes');
  assert.equal(fake.closed, true);
});

test('Gemini native retry metadata resets an interrupted answer without guessing retries from prose', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-native-retry-')); t.after(() => rm(root, { recursive: true, force: true }));
  const notices: (RetryNotice | undefined)[] = [];
  const fake = fakeGemini((message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
    if (message.method === 'session/new') io.reply(message, { sessionId: 'retry-session' });
    if (message.method === 'session/prompt') {
      const update = (value: unknown) => io.push({ method: 'session/update', params: { sessionId: 'retry-session', update: value } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'retry network is ordinary task prose' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"status":"completed","text":"interrupted' } });
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'retrying' }, _meta: { retry: true } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ status: 'completed', text: 'fresh response' }) }, _meta: { retry: true, reset: true } });
      io.reply(message, { stopReason: 'end_turn' });
    }
  });
  const result = await runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport, decide: allow, onRetry: notice => notices.push(notice) }).done;
  assert.equal(result.status, 'completed'); assert.equal(result.result, 'fresh response');
  assert.deepEqual(notices.filter(Boolean), [{ failure: { kind: 'network' } }]);
  assert.equal(notices.at(-1), undefined);
});

for (const [code, kind] of [[400, 'permanent'], [401, 'authentication'], [429, 'rate-limit'], [503, 'overloaded'], [-32602, undefined]] as const) {
  test(`Gemini preserves provider HTTP status ${code} while keeping protocol errors and secrets out of recovery`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-rpc-error-')); t.after(() => rm(root, { recursive: true, force: true }));
    const launch = geminiLaunch(root);
    const fake = fakeGemini((message, io) => {
      if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
      if (message.method === 'session/new') io.reply(message, { sessionId: 'error-session' });
      if (message.method === 'session/prompt') io.push({ id: message.id, error: { code, message: `fixture failure ${launch.env.GEMINI_API_KEY}` } });
    });
    const result = await runGeminiTask(geminiTask(root), { launch, spawn: () => fake.transport, decide: allow }).done;
    assert.equal(result.status, 'failed'); assert.equal(result.providerFailure?.kind, kind);
    assert.ok(!result.detail!.includes(launch.env.GEMINI_API_KEY!));
  });
}

for (const update of [{ sessionUpdate: 'tool_call', title: 'fetch (nexus_web MCP Server)' }, { sessionUpdate: 'tool_call_update', status: 'failed' }]) {
  test(`Gemini invalidates a completion report when a later native ${update.sessionUpdate} arrives`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-last-result-')); t.after(() => rm(root, { recursive: true, force: true }));
    let connection: any;
    const fake = fakeGemini(async (message, io) => {
      if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
      if (message.method === 'session/new') { connection = message.params; io.reply(message, { sessionId: 'later-tool' }); }
      if (message.method === 'session/prompt') {
        const client = await geminiToolsClient(connection);
        try {
          await client.callTool({ name: 'report_result', arguments: { status: 'completed', text: 'stale report' } });
          io.push({ method: 'session/update', params: { sessionId: 'later-tool', update } });
          io.reply(message, { stopReason: 'end_turn' });
        } finally { await client.close(); }
      }
    });
    const result = await runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport, decide: allow }).done;
    assert.equal(result.status, 'failed'); assert.match(result.detail!, /未提供有效结构化/);
  });
}

for (const replaced of [false, true]) test(`Gemini resumes its exact native session ${replaced ? 'and rejects a replacement' : 'without falling back to a new conversation'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-resume-')); t.after(() => rm(root, { recursive: true, force: true }));
  const seen: string[] = [];
  const fake = fakeGemini((message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
    if (message.method === 'session/load') {
      assert.equal(message.params.sessionId, 'original'); assert.equal(message.params.cwd, geminiSessionWorkspace(geminiLaunch(root).home, root));
      io.push({ method: 'session/update', params: { sessionId: 'original', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old history must not become the new result' } } } });
      io.reply(message, replaced ? { sessionId: 'replacement' } : { modes: { currentModeId: 'default' } });
    }
    if (message.method === 'session/prompt') {
      io.push({ method: 'session/update', params: { sessionId: 'original', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ status: 'completed', text: 'continued' }) } } } });
      io.reply(message, { stopReason: 'end_turn' });
    }
  });
  const result = await runGeminiTask(geminiTask(root, { coderSessionId: 'original' }), { launch: geminiLaunch(root), spawn: () => fake.transport, decide: allow, onSession: id => seen.push(id) }).done;
  assert.equal(result.status, replaced ? 'failed' : 'completed');
  assert.equal(fake.sent.some(message => message.method === 'session/new'), false);
  assert.deepEqual(seen, replaced ? [] : ['original']);
  if (replaced) assert.equal(fake.sent.some(message => message.method === 'session/prompt'), false);
  else assert.equal(result.result, 'continued');
});

test('Gemini refuses unavailable resume support and strict mode before launching work', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-boundary-')); t.after(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  const fake = fakeGemini((message, io) => { if (message.method === 'initialize') io.reply(message, { protocolVersion: 1, agentCapabilities: {} }); });
  const deps = { launch: geminiLaunch(root), spawn: () => { starts++; return fake.transport; }, decide: allow };
  const base = geminiTask(root);
  const strict = await runGeminiTask({ ...base, permissions: { ...base.permissions!, securityMode: 'strict' } }, deps).done;
  assert.equal(strict.detail, GEMINI_STRICT_PROBLEM); assert.equal(starts, 0);
  const resumed = await runGeminiTask({ ...base, coderSessionId: 'original' }, deps).done;
  assert.equal(resumed.status, 'failed'); assert.match(resumed.detail!, /不支持原会话恢复/);
  assert.equal(fake.sent.some(message => message.method === 'session/new' || message.method === 'session/load' || message.method === 'session/prompt'), false);
});

test('Gemini never approves an unmonitored native operation by its display title', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-native-deny-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeGemini((message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
    if (message.method === 'session/new') io.reply(message, { sessionId: 'native' });
    if (message.method === 'session/prompt') io.push({ id: 'permission', method: 'session/request_permission', params: { sessionId: 'native', toolCall: { title: 'npm test', kind: 'execute' }, options: [{ kind: 'allow_once', optionId: 'allow' }] } });
  });
  const result = await runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport, decide: async () => { throw new Error('a display title must not reach execution review'); } }).done;
  assert.equal(result.status, 'failed'); assert.match(result.detail!, /未接入监工/);
  assert.deepEqual(fake.sent.find(message => message.id === 'permission')!.result.outcome, { outcome: 'cancelled' });
});

test('Gemini structured clarification waits for the real answer and continues the same session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-question-')); t.after(() => rm(root, { recursive: true, force: true }));
  const prompts: string[] = [];
  const fake = fakeGemini((message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
    if (message.method === 'session/new') io.reply(message, { sessionId: 'questions' });
    if (message.method === 'session/prompt') {
      assert.equal(message.params.sessionId, 'questions'); prompts.push(message.params.prompt[0].text);
      io.push({ method: 'session/update', params: { sessionId: 'questions', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(prompts.length === 1 ? { status: 'needs_input', text: 'Which database?' } : { status: 'completed', text: 'SQLite implemented' }) } } } });
      io.reply(message, { stopReason: 'end_turn' });
    }
  });
  const result = await runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport,
    decide: async request => ({ behavior: 'allow', updatedInput: { answers: { [request.questions![0]!.question]: 'SQLite' } } }) }).done;
  assert.equal(result.status, 'completed'); assert.equal(prompts[1], 'SQLite');
});

test('Gemini malformed final prose is a protocol failure instead of guessed completion', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-result-')); t.after(() => rm(root, { recursive: true, force: true }));
  const fake = fakeGemini((message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
    if (message.method === 'session/new') io.reply(message, { sessionId: 'missing-result' });
    if (message.method === 'session/prompt') { io.push({ method: 'session/update', params: { sessionId: 'missing-result', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Everything looks good. Optional: add tests?' } } } }); io.reply(message, { stopReason: 'end_turn' }); }
  });
  const result = await runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport, decide: async () => { throw new Error('optional prose cannot ask a blocking question'); } }).done;
  assert.equal(result.status, 'failed'); assert.match(result.detail!, /未提供有效结构化/);
});

test('Gemini cancellation releases a pending native question, closes its bridge and preserves the session', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-cancel-')); t.after(() => rm(root, { recursive: true, force: true }));
  let connection: any, asking = false;
  const fake = fakeGemini(async (message, io) => {
    if (message.method === 'initialize') io.reply(message, { protocolVersion: 1 });
    if (message.method === 'session/new') { connection = message.params; io.reply(message, { sessionId: 'cancelled-session' }); }
    if (message.method === 'session/prompt') {
      const client = await geminiToolsClient(connection);
      try { await client.callTool({ name: 'ask_question', arguments: { question: 'Which database?' } }); io.reply(message, { stopReason: 'cancelled' }); }
      finally { await client.close(); }
    }
  });
  const seen: string[] = [];
  const hooks = runGeminiTask(geminiTask(root), { launch: geminiLaunch(root), spawn: () => fake.transport, onSession: id => seen.push(id),
    decide: (_request, signal) => new Promise((_resolve, reject) => { asking = true; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }) });
  await until(() => asking); hooks.cancel('stop now');
  assert.equal((await hooks.done).status, 'killed'); assert.deepEqual(seen, ['cancelled-session']); assert.equal(fake.closed, true);
  assert.ok(fake.sent.some(message => message.method === 'session/cancel'));
  await assert.rejects(fetch(connection.mcpServers[0].url), 'the task bridge is closed');
});

test('Gemini bridge rejects malformed inputs and denied commands before any subprocess or write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-tools-deny-')); t.after(() => rm(root, { recursive: true, force: true }));
  const requests: CoderRequest[] = [];
  const bridge = await createGeminiToolsBridge(geminiTask(root), { env: { PATH: process.env.PATH }, decide: async request => { requests.push(request); return { behavior: 'deny', message: 'fixture deny' }; } }, new AbortController().signal);
  const client = await geminiToolsClient(bridge); t.after(async () => { await client.close(); await bridge.close(); });
  assert.equal((await client.callTool({ name: 'command', arguments: { command: 'echo bad > marker' } })).isError, true);
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'marker', content: 'bad' } })).isError, true);
  assert.equal((await client.callTool({ name: 'command', arguments: { command: 'echo x', unexpected: true } })).isError, true);
  assert.deepEqual(requests.map(request => request.kind), ['command', 'file-write']);
  await assert.rejects(readFile(join(root, 'marker')));
  const unauthenticated = await fetch(bridge.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 403);
});

test('Gemini foreground commands expose exact input and cwd while keeping provider secrets out of child environments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-command-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'app'));
  await writeFile(join(root, 'app', 'check.cjs'), 'console.log(process.cwd()); console.log(process.env.GEMINI_API_KEY || "no provider key");');
  const requests: CoderRequest[] = [];
  const bridge = await createGeminiToolsBridge(geminiTask(root), { env: geminiLaunch(root).env, decide: async request => { requests.push(request); return { behavior: 'allow' }; } }, new AbortController().signal);
  const client = await geminiToolsClient(bridge); t.after(async () => { await client.close(); await bridge.close(); });
  const result = await client.callTool({ name: 'command', arguments: { command: 'node check.cjs', directory: 'app' } });
  assert.match(JSON.stringify(result), /命令执行成功/); assert.match(JSON.stringify(result), /no provider key/);
  assert.equal(requests[0]!.command, 'node check.cjs'); assert.equal(requests[0]!.raw.cwd, join(root, 'app'));
  assert.equal((await client.callTool({ name: 'command', arguments: { command: 'node check.cjs', directory: '..' } })).isError, true);
});

test('Gemini edits fail on ambiguous replacements and changed paths without altering the original file', { skip: process.platform === 'win32' ? 'fixture requires POSIX symlinks' : undefined }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-edit-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'original.txt'), 'same same'); await writeFile(join(root, 'other.txt'), 'other');
  await symlink(join(root, 'original.txt'), join(root, 'redirect.txt'));
  const bridge = await createGeminiToolsBridge(geminiTask(root), { env: {}, decide: async request => {
    if (request.kind === 'file-write') { await unlink(join(root, 'redirect.txt')); await symlink(join(root, 'other.txt'), join(root, 'redirect.txt')); }
    return { behavior: 'allow' };
  } }, new AbortController().signal);
  const client = await geminiToolsClient(bridge); t.after(async () => { await client.close(); await bridge.close(); });
  assert.equal((await client.callTool({ name: 'replace_text', arguments: { path: 'original.txt', old_text: 'same', new_text: 'different' } })).isError, true);
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'redirect.txt', content: 'new' } })).isError, true);
  assert.equal(await readFile(join(root, 'original.txt'), 'utf8'), 'same same'); assert.equal(await readFile(join(root, 'other.txt'), 'utf8'), 'other');
});

test('Gemini rejects hard-linked writes before truncation and invalidates results followed by further operations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-report-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'source.txt'), 'keep'); await link(join(root, 'source.txt'), join(root, 'alias.txt'));
  const reports: unknown[] = [];
  const bridge = await createGeminiToolsBridge(geminiTask(root), { env: {}, decide: allow, onResult: value => reports.push(value) }, new AbortController().signal);
  const client = await geminiToolsClient(bridge); t.after(async () => { await client.close(); await bridge.close(); });
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'alias.txt', content: 'bad' } })).isError, true);
  assert.equal(await readFile(join(root, 'source.txt'), 'utf8'), 'keep');
  await client.callTool({ name: 'report_result', arguments: { status: 'completed', text: 'done' } });
  await client.callTool({ name: 'write_file', arguments: { path: 'new.txt', content: 'new work' } });
  assert.deepEqual(reports.slice(-2), [{ status: 'completed', text: 'done' }, undefined]);
});

test('Gemini native JSONL transcripts verify session and workspace, apply patches, hide environment content and bound the task window', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-transcript-')); t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, '.gemini'), chats = join(home, 'tmp', 'project-registry-name', 'chats'); await mkdir(chats, { recursive: true });
  const id = '12345678-native', at = '2026-11-26T08:00:00.000Z';
  const rows = [
    { sessionId: id, projectHash: createHash('sha256').update(root).digest('hex') },
    { id: 'old', type: 'user', timestamp: '2025-01-01T00:00:00Z', content: 'old task' },
    { id: 'user', type: 'user', timestamp: at, content: [{ text: 'implement this' }] },
    { id: 'agent', type: 'gemini', timestamp: at, content: [{ text: 'working' }], toolCalls: [
      { id: 'code', name: 'nexus_coder_command', args: { command: 'npm test' } },
      { id: 'env', name: 'nexus_coder_write_file', args: { path: '.env', content: 'APP_SECRET=fixture' }, result: 'private environment fixture' },
    ] },
    { $patch: { id: 'agent', content: [{ text: 'finished' }], toolCalls: [{ id: 'code', result: 'test passed' }] } },
    { id: 'abandoned', type: 'gemini', timestamp: at, content: 'rewound content' },
    { $rewindTo: 'abandoned' },
  ];
  const path = join(chats, 'session-2026-11-26T08-00-12345678.jsonl'); await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n{"partial":');
  assert.equal(await findGeminiSession([home], id, root), path);
  assert.equal(await findGeminiSession([home], id, join(root, 'different')), undefined);
  assert.equal(await findGeminiSession([home], '12345678-other', root), undefined);
  const entries = parseGeminiSession(await readFile(path, 'utf8'), { from: Date.parse(at) - 1, to: Date.parse(at) + 1 });
  const output = JSON.stringify(entries);
  assert.match(output, /finished/); assert.match(output, /test passed/);
  assert.doesNotMatch(output, /old task|rewound content|APP_SECRET|private environment fixture/);
  assert.match(output, /环境配置内容已隐藏/);
  assert.equal(redact('AIza' + 'a'.repeat(35)), '***');
});

test('Gemini cannot accept an unanswered question, a blank result or a result superseded by an invalid operation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-empty-')); t.after(() => rm(root, { recursive: true, force: true }));
  const reports: unknown[] = [];
  const bridge = await createGeminiToolsBridge(geminiTask(root), { env: {}, decide: allow, onResult: result => reports.push(result) }, new AbortController().signal);
  const client = await geminiToolsClient(bridge); t.after(async () => { await client.close(); await bridge.close(); });
  const question = await client.callTool({ name: 'ask_question', arguments: { question: 'Which database?' } });
  assert.equal(question.isError, true); assert.match(JSON.stringify(question), /没有得到用户回答/);
  assert.equal((await client.callTool({ name: 'report_result', arguments: { status: 'completed', text: '  \n  ' } })).isError, true);
  await client.callTool({ name: 'report_result', arguments: { status: 'completed', text: 'done' } });
  assert.deepEqual(reports.at(-1), { status: 'completed', text: 'done' });
  assert.equal((await client.callTool({ name: 'write_file', arguments: { path: 'new.txt', content: 123 } })).isError, true);
  assert.equal(reports.at(-1), undefined);
});

test('Gemini cannot confirm completion while a prior operation waits for review or a later call supersedes its queued result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-gemini-report-order-')); t.after(() => rm(root, { recursive: true, force: true }));
  let reviewing = false, authorize!: () => void;
  const review = new Promise<void>(resolve => { authorize = resolve; });
  const reports: unknown[] = [];
  const bridge = await createGeminiToolsBridge(geminiTask(root), { env: {}, onResult: result => reports.push(result), decide: async () => { reviewing = true; await review; return { behavior: 'allow' }; } }, new AbortController().signal);
  const client = await geminiToolsClient(bridge); t.after(async () => { authorize(); await client.close(); await bridge.close(); });
  const write = client.callTool({ name: 'write_file', arguments: { path: 'new.txt', content: 'authorized' } });
  await until(() => reviewing);
  const report = client.callTool({ name: 'report_result', arguments: { status: 'completed', text: 'premature' } });
  await until(() => reports.length >= 2);
  assert.equal((await client.callTool({ name: 'read_file', arguments: {} })).isError, true);
  authorize();
  assert.equal((await write).isError, undefined);
  assert.equal((await report).isError, true); assert.equal(reports.at(-1), undefined);
  await client.callTool({ name: 'report_result', arguments: { status: 'completed', text: 'all operations finished' } });
  assert.deepEqual(reports.at(-1), { status: 'completed', text: 'all operations finished' });
});
