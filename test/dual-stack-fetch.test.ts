import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { dualStackFetch } from '../src/wechat/http.js';

test('the CDN fetch posts bytes, exposes status and headers, streams the body, and honours abort', async t => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.url === '/slow') await new Promise(resolve => setTimeout(resolve, 2000));
    response.writeHead(request.url === '/upload' ? 200 : 400, { 'x-encrypted-param': `echo-${Buffer.concat(chunks).length}-${request.method}` });
    response.end(Buffer.from([1, 2, 3]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const posted = await dualStackFetch(`${origin}/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(7) });
  assert.equal(posted.status, 200);
  assert.equal(posted.headers.get('x-encrypted-param'), 'echo-7-POST');
  assert.deepEqual(Buffer.from(await posted.arrayBuffer()), Buffer.from([1, 2, 3]));
  const got = await dualStackFetch(`${origin}/x`, { method: 'GET' });
  assert.equal(got.status, 400);
  await assert.rejects(dualStackFetch(`${origin}/slow`, { signal: AbortSignal.timeout(200) }), (error: Error) => error.name === 'TimeoutError');
});
