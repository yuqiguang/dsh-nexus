import type { TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function registry(t: TestContext, mode: 'normal' | 'unknown-size' | 'corrupt' | 'reset-once' | 'hanging' = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'nexus-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'fixture/package'), { recursive: true });
  await writeFile(join(root, 'fixture/package/package.json'), JSON.stringify({ name: '@openai/codex', version: '0.155.1' }));
  await writeFile(join(root, 'fixture/package/data'), randomBytes(192 * 1024));
  const archive = join(root, 'fixture.tgz');
  await exec('tar', ['-czf', archive, '-C', join(root, 'fixture'), 'package']);
  const bytes = await readFile(archive);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  let tarRequests = 0, authed = false;
  const server = createServer((request, response) => {
    authed ||= request.headers.authorization === 'Bearer fixture-secret';
    const manifest = { name: '@openai/codex', version: '0.155.1', dist: { tarball: `${url}/package.tgz`, integrity } };
    response.setHeader('cache-control', 'public, max-age=3600');
    if (request.url !== '/package.tgz') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.includes('/0.155.1') ? manifest : { name: '@openai/codex', 'dist-tags': { latest: '0.155.1' }, versions: { '0.155.1': manifest } }));
      return;
    }
    tarRequests++;
    if (mode !== 'unknown-size') response.setHeader('content-length', bytes.length);
    if (mode === 'corrupt') { response.end(Buffer.alloc(bytes.length)); return; }
    let offset = 0;
    response.write(bytes.subarray(0, 4096)); offset = 4096;
    if (mode === 'hanging') return;
    const timer = setInterval(() => {
      if (mode === 'reset-once' && tarRequests === 1) { response.destroy(); return; }
      const end = Math.min(offset + 32768, bytes.length);
      response.write(bytes.subarray(offset, end)); offset = end;
      if (offset === bytes.length) response.end();
    }, 35);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const cache = join(root, 'cache/_cacache');
  const options = { registry: url, cache, preferOffline: true, fetchRetries: 0, [`//127.0.0.1:${(server.address() as { port: number }).port}/:_authToken`]: 'fixture-secret' };
  return { root, bytes, integrity, cache, url, options, tarRequests: () => tarRequests, authed: () => authed };
}

