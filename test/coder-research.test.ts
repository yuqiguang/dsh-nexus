import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HttpFetchProvider, DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http';
import { createResearchBridge, type ResearchWeb } from '../src/coders/research.js';

const fixture: ResearchWeb = {
  async search() { return { sources: [{ title: 'Example', url: 'https://example.com', snippet: 'Public result' }], truncated: false }; },
  async fetch({ url }) { return { url, statusCode: 200, body: { kind: 'html', content: '<h1>Example Domain</h1><p>Public document</p>' }, truncated: false }; },
};

test('job-scoped research uses DSH providers over authenticated MCP and expires on close', async () => {
  const requests: string[] = [];
  const bridge = await createResearchBridge(fixture, async request => { requests.push(request.tool); return { behavior: 'allow' }; }, process.cwd(), new AbortController().signal);
  const client = new Client({ name: 'test', version: '1' });
  try {
    assert.equal((await fetch(bridge.url, { method: 'POST' })).status, 403);
    assert.equal((await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, origin: 'https://untrusted.example' } })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ['search', 'fetch']);
    const search = await client.callTool({ name: 'search', arguments: { query: 'official documentation' } });
    assert.match(JSON.stringify(search), /Public result/);
    const page = await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com' } });
    assert.match(JSON.stringify(page), /Example Domain/);
    assert.match(JSON.stringify(page), /外部资料/);
    assert.deepEqual(requests, ['WebSearch', 'WebFetch']);
    const invalid = await client.callTool({ name: 'fetch', arguments: { url: 'https://example.com', headers: { Authorization: 'not permitted' } } });
    assert.equal(invalid.isError, true);
    assert.equal(requests.length, 2);
  } finally { await client.close(); await bridge.close(); }
  await assert.rejects(fetch(bridge.url));
});

test('research denial does not call the provider and provider errors never expose authenticated URLs', async () => {
  let calls = 0;
  const client = new Client({ name: 'test', version: '1' });
  const bridge = await createResearchBridge({ ...fixture, async search() { calls++; throw new Error('https://user:secret@example.com'); } }, async request => request.raw.query === 'deny' ? { behavior: 'deny', message: 'no' } : { behavior: 'allow' }, process.cwd(), new AbortController().signal);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
    assert.equal((await client.callTool({ name: 'search', arguments: { query: 'deny' } })).isError, true);
    assert.equal(calls, 0);
    const failed = await client.callTool({ name: 'search', arguments: { query: 'allow' } });
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /WEB_PROVIDER_ERROR/);
    assert.doesNotMatch(JSON.stringify(failed), /secret|user@/);
    assert.equal(calls, 1);
  } finally { await client.close(); await bridge.close(); }
});

test('DSH safe retrieval still rejects private targets even after research permission is granted', async () => {
  const provider = new HttpFetchProvider({ maxResponseBytes: 1000, maxBodyChars: 1000, timeoutMs: 1000, maxRedirects: 1, userAgent: DEFAULT_USER_AGENT });
  const client = new Client({ name: 'test', version: '1' });
  const bridge = await createResearchBridge({ ...fixture, fetch: (request, signal) => provider.fetch(request, signal) }, async () => ({ behavior: 'allow' }), process.cwd(), new AbortController().signal);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:secret@example.com/']) {
      const response = await client.callTool({ name: 'fetch', arguments: { url } });
      assert.equal(response.isError, true, url);
      assert.doesNotMatch(JSON.stringify(response), /secret/);
    }
  } finally { await client.close(); await bridge.close(); }
});

test('task cancellation aborts provider work and revokes the MCP endpoint', async () => {
  const controller = new AbortController();
  let started = () => {};
  const entering = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const bridge = await createResearchBridge({ ...fixture, async search(_request, signal) {
    started();
    await new Promise<void>((_resolve, reject) => { signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); }, { once: true }); });
    return { sources: [], truncated: false };
  } }, async () => ({ behavior: 'allow' }), process.cwd(), controller.signal);
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.token}` } } }));
    const pending = client.callTool({ name: 'search', arguments: { query: 'pending' } }).catch(() => undefined);
    await entering;
    controller.abort();
    await bridge.close();
    await pending;
    assert.equal(aborted, true);
    await assert.rejects(fetch(bridge.url));
  } finally { await client.close(); await bridge.close(); }
});

test('local checks are advertised separately, pass supervisor decisions, and reject extra arguments', async () => {
  let calls=0;
  const bridge=await createResearchBridge(undefined, async request => request.command==='deny' ? {behavior:'deny',message:'denied'} : {behavior:'allow'}, process.cwd(), new AbortController().signal, undefined, async () => { calls++; return 'local passed'; });
  const client=new Client({name:'fixture',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url),{requestInit:{headers:{Authorization:`Bearer ${bridge.token}`}}}));
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['local_check']);
    assert.match(JSON.stringify(await client.callTool({name:'local_check',arguments:{command:'node check.mjs'}})),/local passed/);
    assert.equal((await client.callTool({name:'local_check',arguments:{command:'deny'}})).isError,true);
    assert.equal((await client.callTool({name:'local_check',arguments:{command:'node check.mjs',network:true}})).isError,true);
    assert.equal(calls,1);
  } finally {await client.close();await bridge.close();}
});
