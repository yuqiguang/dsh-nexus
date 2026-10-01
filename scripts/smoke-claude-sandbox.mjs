/** Real Claude CLI + local scripted Messages API. No account, model, or channel traffic.
 * Requires bubblewrap and socat; run serially with DSH stopped on small hosts.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadClaudeQuery, runClaudeTask } from '../dist/src/coders/claude.js';
import { taskPermissions } from '../dist/src/coders/permissions.js';
import { decideLayers } from '../dist/src/coders/decide.js';

for (const command of ['bwrap', 'socat']) {
  try { execFileSync(command, command === 'bwrap' ? ['--version'] : ['-V'], { stdio: 'ignore' }); }
  catch { throw new Error(`Missing ${command}; install Ubuntu packages bubblewrap and socat first.`); }
}
const root = await mkdtemp(join(tmpdir(), 'nexus-claude-sandbox-'));
// Outside /tmp: Claude intentionally gives commands scratch space in /tmp.
const outside = await mkdtemp(join(homedir(), '.nexus-sandbox-probe-'));
const cwd = join(root, 'workspace'), home = join(root, 'claude');
await mkdir(cwd); await mkdir(home);
let blockedHits = 0, turns = 0, approvals = 0;
const probeLogs = [];
const blocked = createServer((_req, res) => { blockedHits++; res.end('should not be reached'); });
const api = createServer(async (req, res) => {
  try {
    let data = '';
    for await (const chunk of req) data += chunk;
    if (!req.url?.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
    if (req.url.includes('count_tokens')) { res.setHeader('content-type', 'application/json'); res.end('{"input_tokens":100}'); return; }
    const request = JSON.parse(data);
    const toolResult = request.messages?.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
    if (++turns > 6) throw new Error('unexpected repeated model request');
    const block = toolResult ? { type: 'text', text: 'Sandbox probe finished.' }
      : { type: 'tool_use', id: 'sandbox_probe', name: 'Bash', input: { command: `python3 ${join(cwd, 'probe.py')}`, description: 'Run local sandbox boundary checks' } };
    const message = { id: `msg_${turns}`, type: 'message', role: 'assistant', model: request.model, content: [block], stop_reason: toolResult ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } };
    if (!request.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    event('message_start', { message: { ...message, content: [], stop_reason: null } });
    event('content_block_start', { index: 0, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    event('content_block_delta', { index: 0, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 50 } });
    event('message_stop', {}); res.end();
  } catch { res.writeHead(500).end('fixture failed'); }
});
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let timer, hooks;
try {
  await listen(blocked); await listen(api);
  await writeFile(join(cwd, 'probe.py'), `import os,json,urllib.request\nfrom pathlib import Path\nr={}\nPath('inside.txt').write_text('ok')\nr['inside']=True\ntry:\n Path(${JSON.stringify(join(outside, 'escaped'))}).write_text('bad')\n r['outsideBlocked']=False\nexcept OSError:\n r['outsideBlocked']=True\ntry:\n urllib.request.urlopen('http://127.0.0.1:${blocked.address().port}/blocked',timeout=3).read()\n r['networkBlocked']=False\nexcept Exception:\n r['networkBlocked']=True\nr['secretHidden']='NEXUS_PROBE_SECRET' not in os.environ\nPath('result.json').write_text(json.dumps(r))\nprint(json.dumps(r))\n`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|API_KEY|AUTH|^ANTHROPIC_|^CLAUDE|^HTTP_PROXY$|^HTTPS_PROXY$|^ALL_PROXY$/i.test(key)));
  Object.assign(env, { CLAUDE_CONFIG_DIR: home, ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.address().port}`, ANTHROPIC_API_KEY: 'local-fixture-only', NEXUS_PROBE_SECRET: 'fixture-secret', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', NO_PROXY: '127.0.0.1,localhost' });
  const permissions = await taskPermissions(cwd, [cwd], 'claude', undefined, 1, []);
  hooks = runClaudeTask({ id: 'ct-sandbox-probe', coder: 'claude', cwd, description: 'Run the local probe once, then report completion.', permissions }, {
    onLog: text => probeLogs.push(text),
    query: await loadClaudeQuery(), env, executable: process.env.NEXUS_CLAUDE_BINARY ?? 'claude',
    decide: async request => {
      const verdict = decideLayers(request, [cwd], [], cwd);
      approvals++;
      return verdict.layer === 'auto' ? { behavior: 'allow', updatedInput: request.raw } : { behavior: 'deny', message: 'Probe does not grant additional permissions.' };
    },
  });
  timer = setTimeout(() => hooks.cancel('Sandbox smoke timed out'), 60_000);
  const outcome = await hooks.done;
  assert.equal(outcome.status, 'completed', outcome.detail);
  const result = JSON.parse(await readFile(join(cwd, 'result.json'), 'utf8').catch(() => { throw new Error('Probe did not produce its result: ' + probeLogs.join('\n')); }));
  assert.deepEqual(result, { inside: true, outsideBlocked: true, networkBlocked: true, secretHidden: true });
  assert.equal(blockedHits, 0);
  await assert.rejects(readFile(join(outside, 'escaped')));
  assert.ok(approvals > 0);
  console.log('Claude native sandbox: workspace write, outside write denial, network denial, secret filtering and supervisor callback passed.');
} finally {
  clearTimeout(timer); hooks?.cancel('cleanup');
  api.closeAllConnections(); blocked.closeAllConnections();
  await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => blocked.close(resolve))]);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}
