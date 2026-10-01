/** Explicit live check using the configured coder accounts and native DSH web providers.
 * Stop DSH first on small hosts. Never sends a channel message or changes account settings.
 * Usage: node scripts/smoke-coder-research.mjs --live [--coder=codex|claude]
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local';
import { DeepSeekSearchProvider, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL } from '@deepseek-ai/dsh-web-search-deepseek';
import { HttpFetchProvider, DEFAULT_USER_AGENT } from '@deepseek-ai/dsh-web-fetch-http';
import { networkNodeOptions } from './netflags.mjs';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

if (!process.argv.includes('--live')) throw new Error('This check makes real model/search requests. Pass --live explicitly.');
setDefaultAutoSelectFamilyAttemptTimeout(2000);
const distName = process.env.NEXUS_DIST ?? 'dist';
if (!/^dist(?:\.[a-z0-9-]+)?$/.test(distName)) throw new Error('invalid build directory');
const moduleOf = name => import(pathToFileURL(resolve(distName, 'src/coders', `${name}.js`)).href);
const { CodersManager } = await moduleOf('manager');
const { CoderSettingsStore } = await moduleOf('settings');
const { CoderInstaller, managedLayout } = await moduleOf('install');
const { loadClaudeQuery, runClaudeTask } = await moduleOf('claude');
const { runCodexTask } = await moduleOf('codex');
const { taskPermissions } = await moduleOf('permissions');
const { decideLayers } = await moduleOf('decide');
const { createResearchBridge } = await moduleOf('research');
const dshHome = resolve('.nexus'), filename = join(dshHome, '.credentials.yaml');
const credentials = parseCredentialsDocument(await readFile(filename, 'utf8'), filename);
const store = new CoderSettingsStore({ read: async key => credentials.records.get(`nexus-coders/${key}`)?.payload, modify: async () => { throw new Error('read-only check'); } });
const layout = managedLayout(join(dshHome, 'nexus-coders'));
const env = { ...process.env, DSH_HOME: dshHome, NODE_OPTIONS: networkNodeOptions() }; delete env.CLAUDECODE;
const runtime = await new CodersManager({ store, layout, profileRoots: [resolve('..')], installer: new CoderInstaller(layout), env }).runtime();
// This explicit diagnostic uses the standard provider defaults; production uses ctx.web's configured providers.
const search = new DeepSeekSearchProvider(() => ({ resolveApiKey: async () => credentials.refs.get('DEEPSEEK_API_KEY'), baseURL: DEEPSEEK_DEFAULT_BASE_URL,
  model: DEEPSEEK_DEFAULT_MODEL, apiVersion: '2023-06-01', maxTokens: 2048, maxUses: 1 }));
const fetcher = new HttpFetchProvider({ maxResponseBytes: 1048576, maxBodyChars: 100000, timeoutMs: 30000, maxRedirects: 3, userAgent: DEFAULT_USER_AGENT });
const requested = process.argv.find(arg => arg.startsWith('--coder='))?.slice(8);
if (requested && !['codex', 'claude'].includes(requested)) throw new Error('invalid coder');
for (const coder of requested ? [requested] : ['claude', 'codex']) {
  const launch = runtime[coder];
  if ('error' in launch) throw new Error(`${coder} runtime unavailable`);
  const cwd = await mkdtemp(resolve('workspace/.research-live-'));
  const controller = new AbortController();
  let bridge, hooks, timer, searches = 0, pages = 0, searchAttempts = 0;
  const searchErrors = [];
  try {
    const permissions = await taskPermissions(cwd, runtime.roots, coder, undefined, 2, runtime.allowedNetworkDomains);
    const decide = async request => request.kind === 'network' && decideLayers(request, [cwd], [], cwd, true).layer === 'auto'
      ? { behavior: 'allow', updatedInput: request.raw } : { behavior: 'deny', message: 'Use the read-only research tools only.' };
    bridge = await createResearchBridge({
      async search(request, signal) { searchAttempts++; try { const r = await search.search(request, signal); if (r.sources.length) searches++; return { ...r, sources: r.sources.slice(0, 5) }; } catch (error) { searchErrors.push(error.code ?? error.name); throw error; } },
      async fetch(request, signal) { const r = await fetcher.fetch(request, signal); if (r.statusCode === 200 && r.body.content.length) pages++; return r; },
    }, decide, cwd, controller.signal);
    const task = { id: 'ct-research-live', coder, cwd, permissions,
      description: 'This is a tool integration check: you must call BOTH nexus_web search AND fetch, in that order. Do not skip search even though the URL is supplied. Use the nexus_web MCP search tool to find official Python pathlib documentation, then use its fetch tool to read https://docs.python.org/3/library/pathlib.html. State one feature actually found in that page with its source URL. Use no Bash, local files, or built-in WebSearch/WebFetch tools. If a tool fails, accurately report failure.' };
    const deps = { decide, research: bridge };
    if (coder === 'claude') {
      const query = await loadClaudeQuery(launch.sdkPath);
      hooks = runClaudeTask(task, { ...deps, ...launch, query: args => query({ ...args, options: { ...args.options, maxTurns: 8, maxBudgetUsd: 1 } }) });
    } else hooks = runCodexTask(task, { ...deps, launch: { command: launch.command, env: launch.env }, model: launch.model });
    timer = setTimeout(() => { controller.abort(); hooks.cancel('research check timeout'); }, 120000);
    const result = await hooks.done;
    const report = { coder, status: result.status, searchAttempts, searchErrors, successfulSearches: searches, successfulPages: pages, citesOfficialPage: result.result?.includes('docs.python.org') ?? false };
    console.log(JSON.stringify(report));
    assert.equal(result.status, 'completed');
    assert.ok(searches > 0 && pages > 0 && report.citesOfficialPage, `${coder} did not complete verifiable research`);
  } finally { clearTimeout(timer); controller.abort(); hooks?.cancel('cleanup'); await bridge?.close(); await rm(cwd, { recursive: true, force: true }); }
}
