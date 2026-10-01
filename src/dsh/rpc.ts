import type { Context } from '@deepseek-ai/cordis';
import { clientRequestSchema, type ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection';
import { ChannelError } from '../channels/types.js';

/** Register one RPC family under the shared authenticated /api carrier. */
export function registerRpc(ctx: Context, family: string, methods: readonly string[], handle: (method: string, payload: unknown) => Promise<unknown>): void {
  for (const method of methods) {
    ctx.connection.fetch.register({
      path: `/api/${family}/${method}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        const message = clientRequestSchema.safeParse(await request.json().catch(() => undefined));
        if (!message.success || message.data.method !== method) return new Response('invalid request', { status: 400 });
        let result: ConnectionRpcResult<unknown>;
        try { result = { ok: true, value: await handle(method, message.data.payload) }; }
        catch (error) {
          const code = error instanceof ChannelError ? error.code : 'configuration_failed';
          result = { ok: false, error: { code, message: code, details: {} } };
        }
        return Response.json({ type: 'server-response', rpcId: message.data.rpcId, result }, {
          headers: { 'Cache-Control': 'no-store' },
        });
      },
    });
  }
}

