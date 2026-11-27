import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { GeminiProcess } from '../src/coders/gemini-process.js';
import type { GeminiLaunch } from '../src/coders/gemini-config.js';
import type { TaskRecord } from '../src/coders/types.js';
import { join } from 'node:path';

export interface GeminiRpc { id?: number | string; method?: string; params?: any; result?: any; error?: any }
export function fakeGemini(handler: (message: GeminiRpc, io: { push(message: GeminiRpc): void; reply(message: GeminiRpc, result: unknown): void }) => void | Promise<void>) {
  const sent: GeminiRpc[] = [], queue: string[] = [];
  let wake: (() => void) | undefined, closed = false, finish: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>(resolve => { finish = resolve; });
  const push = (message: GeminiRpc) => { if (!closed) { queue.push(JSON.stringify(message)); wake?.(); } };
  const io = { push, reply: (message: GeminiRpc, result: unknown) => push({ id: message.id, result }) };
  const transport: GeminiProcess = {
    write(line) {
      const message = JSON.parse(line) as GeminiRpc; sent.push(message);
      void Promise.resolve().then(() => handler(message, io)).catch(error => push({ id: message.id, error: { message: (error as Error).message } }));
    },
    lines: (async function* () { while (!closed) { if (queue.length) { yield queue.shift()!; continue; } await new Promise<void>(resolve => { wake = resolve; }); } })(),
    kill() { closed = true; wake?.(); finish(0); }, exited,
  };
  return { transport, sent, io, get closed() { return closed; } };
}

export async function geminiToolsClient(connection: { url: string; token: string } | { mcpServers: { name: string; url: string; headers: { name: string; value: string }[] }[] }): Promise<Client> {
  const server = 'mcpServers' in connection ? connection.mcpServers.find(server => server.name === 'nexus_coder')! : undefined;
  const url = server?.url ?? (connection as { url: string }).url;
  const headers = server ? Object.fromEntries(server.headers.map(header => [header.name, header.value])) : { Authorization: `Bearer ${(connection as { token: string }).token}` };
  const client = new Client({ name: 'nexus-gemini-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

export function geminiLaunch(root: string): GeminiLaunch {
  return { command: 'scripted-gemini', home: join(root, 'gemini-home'), authMethod: 'gemini-api-key',
    env: { PATH: process.env.PATH, GEMINI_API_KEY: 'fixture-key-never-sent-to-a-model' } };
}

export function geminiTask(cwd: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { id: 'ct-gemini', coder: 'gemini', cwd, description: 'implement the requested feature', ownerSession: 'owner', status: 'running', createdAt: Date.now(), updatedAt: Date.now(), escalations: 0, decisions: [],
    permissions: { version: 1, mode: 'unattended', securityMode: 'standard', writableRoots: [cwd], network: 'ask', autoApproveSafe: false, allowedNetworkDomains: [], maxDurationMs: 60_000, maxRepeatedDenials: 3, isolation: 'dsh-supervised' }, ...overrides };
}
