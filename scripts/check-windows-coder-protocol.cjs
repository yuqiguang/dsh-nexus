/** Native Desktop/Electron integration with local model fixtures; no account data or remote model calls. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');
const { registerHooks, createRequire, isBuiltin } = require('node:module');

async function main() {
  assert.equal(process.platform, 'win32');
  const runtime = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh');
  const runtimeRequire = createRequire(path.join(runtime, 'package.json'));
  const pluginRequire = createRequire(path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-nexus', 'package.json'));
  let resolving = false;
  registerHooks({ resolve(specifier, context, next) {
    if (resolving || isBuiltin(specifier)) return next(specifier, context);
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
      for (const resolver of [runtimeRequire, pluginRequire]) {
        try { resolving = true; return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true }; } catch {} finally { resolving = false; }
      }
    }
    return next(specifier, context);
  } });
  const compiled = path.resolve(process.argv[2]);
  const moduleAt = file => import(pathToFileURL(path.join(compiled, 'src', 'coders', file)).href);
  const { runClaudeTask, loadClaudeQuery } = await moduleAt('claude.js');
  const { runCodexTask } = await moduleAt('codex.js');
  const { taskPermissions } = await moduleAt('permissions.js');
  const { windowsSandbox, windowsVerifyArgv, windowsVerifyExecutable } = await moduleAt('windows-sandbox.js');
  const { runVerifyCommand, verifyTask } = await moduleAt('verify.js');
  const { packageFiles } = await moduleAt('package.js');
  const { hostInstructions } = await moduleAt('instructions.js');
  const { loadCoderRuntime, verificationReviewCommand, commandRuntimeEvidence } = await moduleAt('runtime.js');
  const { codexConfigToml } = await moduleAt('install.js');
  const { reviewEnvelope, ReviewCache } = await moduleAt('review.js');
  const { normalizeClaudeRequest, codexCommandRequest } = await moduleAt('normalize.js');
  const { decideLayers } = await moduleAt('decide.js');
  const root = await fs.mkdtemp(path.join(process.env.USERPROFILE, 'nexus-protocol-check-'));
  const savedDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = path.join(root, '.dsh');
  const workspace = path.join(process.env.DSH_HOME, 'nexus-workspace', 'hello world');
  await fs.mkdir(workspace, { recursive: true });
  const managed = path.join(process.env.USERPROFILE, '.dsh', 'nexus-coders');
  const codex = path.join(managed, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const node = path.join(process.env.ProgramFiles, 'nodejs', 'node.exe');
  const { apply: installDependencyTool } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-tool-workspace-dependencies')).href);
  const { Context } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/cordis')).href);
  const { SystemPrompt } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-system-prompt')).href);
  const { ToolRuntime, defineTool } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-tools')).href);
  const { ToolCallId } = await import(pathToFileURL(runtimeRequire.resolve('@deepseek-ai/dsh-llm/brand')).href);
  const context = new Context();
  new SystemPrompt(context, {});
  const tools = new ToolRuntime(context);
  installDependencyTool(context, { source: path.join(process.env.USERPROFILE, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime') });
  const originalEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|KEY|AUTH|PROXY|^DSH_/i.test(key)));
  let env, runtimeExecutables;
  tools.register(defineTool({ name: 'fixture_prepare_coder', description: 'Prepare local fixture environment', parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ready: { type: 'boolean', required: true } } }, render: () => [] },
    async execute(_args, exec) { const loaded = await loadCoderRuntime(context, exec, originalEnv); env = loaded.env; runtimeExecutables = loaded.executables; return { ready: true }; } }));
  const prepared = await tools.execute({ callId: ToolCallId('fixture-runtime'), name: 'fixture_prepare_coder', arguments: {}, signal: AbortSignal.timeout(30000) });
  assert.equal(prepared.isError, false, prepared.error?.message); assert.ok(env);
  await context.fiber.dispose();
  let hooks;
  const parallelHooks = [];
  const checks = [];
  const passed = name => { checks.push(name); console.log('PASS ' + name); };
  passed('registered DSH dependency tool prepares the coder environment through the native nested dispatch pipeline');
  let anthropicCalls = 0, codexCalls = 0, expectedTool = '';
  let parallelClaudeCalls = 0, parallelCodexCalls = 0;
  const parallelClaudeWorkspace = path.join(process.env.DSH_HOME, 'nexus-workspace', 'parallel-claude');
  const parallelCodexWorkspace = path.join(process.env.DSH_HOME, 'nexus-workspace', 'parallel-codex');
  const arrivals = new Set();
  let releaseParallel;
  const parallelReady = new Promise(resolve => { releaseParallel = resolve; });
  const arrive = async coder => { arrivals.add(coder); if (arrivals.size === 2) releaseParallel(); await parallelReady; };
  const command = 'python hello.py';
  const server = createServer(async (req, res) => {
    try {
      const buffers = []; for await (const part of req) buffers.push(part);
      const body = JSON.parse(Buffer.concat(buffers).toString() || '{}');
      const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const parallel = req.url.startsWith('/parallel/');
      if (req.url.startsWith('/v1/messages') || req.url.startsWith('/parallel/v1/messages')) {
        const isTask = body.tools?.some(tool => tool.name === 'Bash');
        const index = isTask ? parallel ? parallelClaudeCalls++ : anthropicCalls++ : 100;
        if (parallel && index === 0) await arrive('claude');
        const activeWorkspace = parallel ? parallelClaudeWorkspace : workspace;
        const block = index === 0 ? { type: 'tool_use', id: 'fixture-write', name: 'Write', input: { file_path: path.join(activeWorkspace, 'hello.py'), content: 'print("Hello, World!")\n' } }
          : index === 1 ? { type: 'tool_use', id: 'fixture-read', name: 'Read', input: { file_path: path.join(activeWorkspace, 'hello.py') } }
          : index === 2 ? { type: 'tool_use', id: 'fixture-bash', name: 'Bash', input: { command, description: 'Run with task interpreter' } }
          : !parallel && (index === 3 || index === 4) ? { type: 'tool_use', id: 'fixture-large-' + index, name: 'Bash', input: { command: 'node _selftest.js', description: 'Read and check the local page' } }
          : { type: 'text', text: 'Native Claude fixture completed.' };
        emit('message_start', { type: 'message_start', message: { id: 'msg_fixture_' + index, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        emit('message_stop', { type: 'message_stop' });
      } else if (req.url.startsWith('/responses') || req.url.startsWith('/parallel/responses')) {
        const index = parallel ? parallelCodexCalls++ : codexCalls++;
        if (parallel && index === 0) await arrive('codex');
        expectedTool = body.tools?.find(tool => ['exec_command', 'shell_command', 'shell'].includes(tool.name))?.name ?? expectedTool;
        const codexCommand = `Set-Content -LiteralPath codex.py -Value 'print("Hello, Codex!")' -Encoding utf8; if (-not $?) { exit 1 }; python codex.py; exit $LASTEXITCODE`;
        const args = expectedTool === 'exec_command' ? { cmd: codexCommand, max_output_tokens: 1000 } : expectedTool === 'shell_command' ? { command: codexCommand } : { command: ['powershell.exe', '-NoProfile', '-Command', codexCommand] };
        const patch = '*** Begin Patch\n*** Add File: patched.txt\n+native patch works\n*** End Patch';
        const patchTool = body.tools?.find(tool => tool.name === 'apply_patch');
        if (!parallel && index === 1) assert.ok(patchTool, 'native apply_patch tool advertised');
        const patchBlock = patchTool?.type === 'custom'
          ? { type: 'custom_tool_call', id: 'patch_fixture', call_id: 'patch_fixture', name: 'apply_patch', input: patch, status: 'completed' }
          : { type: 'function_call', id: 'patch_fixture', call_id: 'patch_fixture', name: 'apply_patch', arguments: JSON.stringify({ patch }), status: 'completed' };
        const block = !parallel && index === 1 ? patchBlock : index === 0 ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: expectedTool, arguments: JSON.stringify(args), status: 'completed' }
          : { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'Native Codex fixture completed.', annotations: [] }], status: 'completed' };
        const response = { id: 'resp_fixture_' + index, object: 'response', created_at: 1, status: 'completed', model: body.model, output: [block], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        emit('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
        emit('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: block });
        emit('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: block });
        emit('response.completed', { type: 'response.completed', response });
      } else throw new Error('Unexpected fixture API path');
      res.end();
    } catch { res.destroy(); }
  });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const standardTask = async coder => ({ id: 'ct-fixture-' + coder, coder, cwd: workspace, description: 'Create and run a minimal Python program.', ownerSession: 'fixture', status: 'running', createdAt: 0, updatedAt: 0, escalations: 0, decisions: [],
      permissions: await taskPermissions(workspace, [workspace], coder, undefined, 2, [], true, 'standard') });
    const bounded = async hooks => {
      const timer = setTimeout(() => hooks.cancel('fixture timeout'), 60000);
      try { return await hooks.done; } finally { clearTimeout(timer); }
    };
    const claudeTask = await standardTask('claude');
    await fs.writeFile(path.join(process.env.DSH_HOME, 'AGENTS.md'), 'Fixture owner guidance.');
    const instructions = await hostInstructions(workspace);
    assert.match(instructions, /Fixture owner guidance/);
    assert.equal(decideLayers(normalizeClaudeRequest('Read', {file_path: path.join(process.env.DSH_HOME, 'AGENTS.md')}, {}, workspace), [workspace], [], workspace, true, true).layer, 'hard');
    passed('Windows host provides ancestor guidance while protected directory reads remain denied');
    const runtimeEvidence = (await commandRuntimeEvidence('python --version; node --version', workspace, env)).join('\n');
    assert.match(runtimeEvidence, /PATH 解析：python/); assert.match(runtimeEvidence, /PATH 解析：node/);
    passed('Windows reviewer receives host-resolved Python and Node identities');
    const archiveRoot = path.join(workspace, 'archive-fixture'); await fs.mkdir(archiveRoot);
    await fs.writeFile(path.join(archiveRoot, 'index.html'), '<script src="app.js"></script>');
    await fs.writeFile(path.join(archiveRoot, 'app.js'), 'console.log("fixture");');
    await assert.rejects(packageFiles(archiveRoot, ['index.html']), /缺少关联资源/);
    const archive = await packageFiles(archiveRoot, ['index.html', 'app.js']);
    assert.ok((await fs.stat(archive.path)).size > 0); assert.equal(archive.files.length, 2);
    passed('Windows default workspace archives explicit resources and refuses an incomplete HTML delivery');
    const suite = await verifyTask({cwd: archiveRoot, verify: 'node --check app.js', verifyCommands: ['node app.js']}, [archiveRoot], undefined, undefined,
      argv => windowsVerifyExecutable(argv, archiveRoot, env), env);
    assert.equal(suite.verifyOk, true, suite.verifyOutput); assert.equal(suite.verifyChecks.length, 2);
    passed('Windows independent verification records each command in a sequential suite');

    await fs.writeFile(path.join(workspace, 'index.html'), `<html><!--${'fixture '.repeat(4000)}--><p>local page</p></html>`);
    await fs.writeFile(path.join(workspace, '_selftest.js'), `/*${'fixture '.repeat(2000)}*/\nconst html = require('fs').readFileSync('index.html','utf8'); if (!html.includes('local page')) throw new Error('missing page'); console.log('large-check-ok');`);
    const page = path.join(workspace, 'index.html');
    const msys = value => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase());
    for (const value of [page, msys(page), pathToFileURL(page).href]) {
      const request = normalizeClaudeRequest('Bash', { command: `cat "${value}"` }, {}, workspace);
      assert.equal(decideLayers(request, [workspace], [], workspace, true, true).layer, 'user', value);
      assert.equal(decideLayers(request, [workspace], [], workspace, true, false).layer, 'hard', 'strict policy unchanged');
      const envelope = await reviewEnvelope(claudeTask, request, env);
      assert.ok(envelope?.evidence.some(item => item.includes('<p>local page</p>')), value);
    }
    for (const value of [path.join(workspace, '.env'), path.join(process.env.DSH_HOME, 'credentials', 'saved.json')]) {
      for (const alias of [value, msys(value), pathToFileURL(value).href]) {
        const request = normalizeClaudeRequest('Bash', { command: `cat "${alias}"` }, {}, workspace);
        assert.equal(decideLayers(request, [workspace], [], workspace, true, true).layer, 'hard', alias);
      }
    }
    passed('Windows drive paths, Git Bash paths and file URLs identify the same workspace and retain credential protection');
    const cache = new ReviewCache();
    const claudeOutput = [];
    let reviews = 0, successfulCommands = 0, largeChecks = 0, reusedChecks = 0;
    const decide = async request => {
      const verdict = decideLayers(request, [workspace], [], workspace, true, true);
      if (request.kind === 'file-read' || request.kind === 'file-write') { assert.equal(verdict.layer, 'auto'); return { behavior: 'allow' }; }
      assert.equal(verdict.layer, 'user');
      const envelope = await reviewEnvelope(claudeTask, request, env);
      assert.ok(envelope); assert.match(envelope.scope, /当前用户权限/); reviews++;
      if (request.command === 'node _selftest.js') {
        assert.ok(envelope.evidence.some(item => item.includes('fixture '.repeat(2000))));
        assert.ok(envelope.evidence.some(item => item.includes('<p>local page</p>')));
        largeChecks++;
        if (cache.get(claudeTask, envelope)) reusedChecks++;
        else cache.set(claudeTask, envelope, { safe: true, reason: 'local fixture reads inspected page', repeatable: true });
      }
      return { behavior: 'allow' };
    };
    const sdkQuery = await loadClaudeQuery(path.join(managed, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')).catch(error => { throw error.cause ?? error; });
    hooks = runClaudeTask(claudeTask, { instructions, query: params => sdkQuery({ ...params, options: { ...params.options, persistSession: false } }),
      env: { ...env, CLAUDE_CONFIG_DIR: path.join(root, 'claude-home'), ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: 'local-fixture',
        CLAUDE_CODE_GIT_BASH_PATH: path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
      model: 'claude-sonnet-4-5-20250929', decide, onSuccess() { successfulCommands++; }, onLog(text) { claudeOutput.push(text); } });
    let outcome = await bounded(hooks);
    assert.equal(outcome.status, 'completed', outcome.detail);
    assert.ok(reviews > 0, 'native Claude command must reach DSH review'); assert.ok(successfulCommands > 0, 'native Claude command must succeed');
    assert.ok(anthropicCalls >= 4); assert.equal(await fs.readFile(path.join(workspace, 'hello.py'), 'utf8'), 'print("Hello, World!")\n');
    passed('native Claude writes and reads the real default .dsh workspace and reaches DSH command review');
    assert.ok(largeChecks >= 2 && reusedChecks >= 1);
    assert.match(claudeOutput.join('\n'), /large-check-ok/);
    passed('native Claude runs a large local test with full HTML evidence and reuses only the unchanged task review');
    let verified = await runVerifyCommand('python hello.py', workspace, undefined, argv => windowsVerifyExecutable(argv, workspace, env), env);
    assert.equal(verified.ok, true, verified.output); assert.match(verified.output, /Hello, World!/);
    passed('Claude independent verification uses the same working bundled Python and native Job');
    // Reuse only the dedicated sandbox runtime cache, never account files.
    const codexHome = path.join(root, 'codex-home'); await fs.mkdir(codexHome);
    await fs.writeFile(path.join(codexHome, 'config.toml'), codexConfigToml({ model: 'gpt-5.4', baseUrl: base, wireApi: 'responses', apiKey: 'fixture', source: 'managed' }));
    const codexEnv = { ...env, CODEX_HOME: codexHome, NEXUS_CODEX_API_KEY: 'local-fixture', LOCALAPPDATA: path.join(managed, 'codex-local-app-data') };
    assert.equal(await windowsSandbox({ command: codex, env: codexEnv }, workspace, true), 'ready');
    passed('isolated Codex fixture sandbox configured without account data');
    const codexTask = await standardTask('codex');
    successfulCommands = 0;
    const codexOutput = []; let codexFailures = 0;
    hooks = runCodexTask(codexTask, { instructions, launch: { command: codex, env: codexEnv },
      decide: async request => { assert.ok(['command', 'file-write'].includes(request.kind)); assert.notEqual(decideLayers(request, [workspace], [], workspace, true, true).layer, 'hard'); if (request.kind === 'command') assert.ok(await reviewEnvelope(codexTask, request, codexEnv)); return { behavior: 'allow' }; }, onSuccess() { successfulCommands++; }, onFailure() { codexFailures++; }, onLog(text) { codexOutput.push(text); } });
    outcome = await bounded(hooks);
    assert.equal(outcome.status, 'completed', outcome.detail);
    assert.ok(codexCalls >= 2); assert.ok(expectedTool); assert.ok(successfulCommands > 0, 'native Codex command must succeed: ' + codexOutput.join('\n').slice(-5000));
    passed('native Codex thread and turn accept standard policy, execute command and clean up');
    assert.equal(codexFailures, 0, codexOutput.join('\n').slice(-3000));
    assert.match(await fs.readFile(path.join(workspace, 'patched.txt'), 'utf8'), /native patch works/);
    passed('native Codex apply_patch file helper writes within the workspace without sandbox refresh errors');
    verified = await runVerifyCommand('python codex.py', workspace, undefined, async argv => windowsVerifyArgv(codex, await windowsVerifyExecutable(argv, workspace, codexEnv), workspace, workspace, 'ask'), codexEnv);
    assert.equal(verified.ok, true, verified.output); assert.match(verified.output, /Hello, Codex!/);
    passed('Codex independent Python verification retains native workspace sandbox');
    const absoluteVerify = `"${runtimeExecutables.python}" codex.py`;
    const reviewCommand = await verificationReviewCommand(absoluteVerify, [runtimeExecutables.python, 'codex.py'], runtimeExecutables);
    assert.equal(reviewCommand, 'python codex.py');
    const request = { ...codexCommandRequest({ command: reviewCommand, cwd: workspace }, workspace), tool: 'verify.command' };
    assert.notEqual(decideLayers(request, [workspace], [], workspace, true, true).layer, 'hard');
    assert.ok(await reviewEnvelope(codexTask, request, codexEnv));
    verified = await runVerifyCommand(absoluteVerify, workspace, undefined, async argv => windowsVerifyArgv(codex, await windowsVerifyExecutable(argv, workspace, codexEnv), workspace, workspace, 'ask'), codexEnv);
    assert.equal(verified.ok, true, verified.output); assert.match(verified.output, /Hello, Codex!/);
    passed('native absolute bundled Python passes review and executes inside the Codex workspace sandbox');
    await fs.mkdir(parallelClaudeWorkspace); await fs.mkdir(parallelCodexWorkspace);
    await fs.writeFile(path.join(codexHome, 'config.toml'), codexConfigToml({ model: 'gpt-5.4', baseUrl: base + '/parallel', wireApi: 'responses', apiKey: 'fixture', source: 'managed' }));
    const parallelTask = async (coder, cwd) => ({ ...(await standardTask(coder)), id: 'ct-parallel-' + coder, cwd,
      permissions: await taskPermissions(cwd, [cwd], coder, undefined, 2, [], true, 'standard') });
    const ct = await parallelTask('claude', parallelClaudeWorkspace), cx = await parallelTask('codex', parallelCodexWorkspace);
    const gate = task => async request => {
      const verdict = decideLayers(request, [task.cwd], [], task.cwd, true, true);
      assert.notEqual(verdict.layer, 'hard');
      if (verdict.layer !== 'auto') assert.ok(await reviewEnvelope(task, request));
      return { behavior: 'allow' };
    };
    let toolFailures = 0;
    parallelHooks.push(runClaudeTask(ct, { query: params => sdkQuery({ ...params, options: { ...params.options, persistSession: false } }),
      env: { ...env, CLAUDE_CONFIG_DIR: path.join(root, 'claude-parallel-home'), ANTHROPIC_BASE_URL: base + '/parallel', ANTHROPIC_AUTH_TOKEN: 'local-fixture',
        CLAUDE_CODE_GIT_BASH_PATH: path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
      model: 'claude-sonnet-4-5-20250929', decide: gate(ct), onFailure() { toolFailures++; } }));
    parallelHooks.push(runCodexTask(cx, { launch: { command: codex, env: codexEnv }, decide: gate(cx), onFailure() { toolFailures++; } }));
    const concurrent = await Promise.all(parallelHooks.map(bounded));
    assert.equal(arrivals.size, 2, 'both real CLIs must reach the model barrier before either can finish');
    for (const result of concurrent) assert.equal(result.status, 'completed', result.detail);
    assert.equal(toolFailures, 0);
    assert.match(await fs.readFile(path.join(parallelClaudeWorkspace, 'hello.py'), 'utf8'), /Hello, World!/);
    assert.match(await fs.readFile(path.join(parallelCodexWorkspace, 'codex.py'), 'utf8'), /Hello, Codex!/);
    assert.equal(await fs.stat(path.join(parallelClaudeWorkspace, 'codex.py')).then(() => true, () => false), false);
    assert.equal(await fs.stat(path.join(parallelCodexWorkspace, 'hello.py')).then(() => true, () => false), false);
    passed('native Claude and Codex run concurrently in separate Windows workspaces without mixing files');
    console.log(JSON.stringify({ ok: true, checks }));
  } finally {
    releaseParallel();
    for (const item of parallelHooks) item.cancel('fixture complete');
    await Promise.all(parallelHooks.map(item => item.done));
    hooks?.cancel('fixture complete');
    if (hooks) await hooks.done;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    if (savedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDshHome;
  }
}
main().catch(error => { console.error(String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, '[url]')); process.exitCode = 1; });
