import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * How long one address may take to connect when a host has both IPv6 and
 * IPv4 addresses. Node's default is 250 ms, which on a network without an IPv6
 * route and with slow IPv4 handshakes (this WSL through WARP needs about
 * 600 ms to reach the WeChat CDN) times out every address and reports
 * ETIMEDOUT while curl succeeds. The iLink API host is IPv4-only, so it never
 * hit this.
 */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 3000;

/**
 * A fetch-shaped request over node:http(s) with a per-address connect timeout
 * generous enough for a slow dual-stack path. No redirects are followed; the
 * caller reads the status. Used for the CDN, whose URLs come from the server.
 */
export const dualStackFetch: typeof fetch = (input, init = {}) => new Promise<Response>((resolve, reject) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const signal = init.signal ?? undefined;
  if (signal?.aborted) { reject(signal.reason); return; }
  const headers: Record<string, string> = {};
  new Headers(init.headers ?? {}).forEach((value, key) => { headers[key] = value; });
  // The socket option is accepted at runtime (Node 20+) but missing from the request typings.
  const options = { method: init.method ?? 'GET', headers, autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS } as Parameters<typeof httpsRequest>[1];
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options, response => {
    const responseHeaders = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (typeof value === 'string') responseHeaders.set(key, value);
      else if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
    }
    const status = response.statusCode ?? 0;
    const body = status === 204 || status === 304 || init.method === 'HEAD' ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
    resolve(new Response(body, { status, headers: responseHeaders }));
  });
  const abort = () => { request.destroy(signal?.reason instanceof Error ? signal.reason : new Error('aborted')); };
  signal?.addEventListener('abort', abort, { once: true });
  request.on('error', error => { signal?.removeEventListener('abort', abort); reject(signal?.aborted ? signal.reason : error); });
  request.on('close', () => signal?.removeEventListener('abort', abort));
  const body = init.body;
  if (body === undefined || body === null) request.end();
  else if (typeof body === 'string') request.end(body);
  else if (body instanceof Uint8Array) request.end(body);
  else if (body instanceof ArrayBuffer) request.end(new Uint8Array(body));
  else { request.destroy(); reject(new TypeError('dualStackFetch: unsupported body type')); }
});
