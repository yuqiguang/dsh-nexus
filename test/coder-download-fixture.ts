import type { TestContext } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * npm gives environment variables higher precedence than any `.npmrc`, and `npm run <script>`
 * exports its whole resolved config to the script as `npm_config_*`. So `npm test` on a machine
 * whose `~/.npmrc` points `registry` at a mirror (`https://registry.npmmirror.com` is the common
 * one) hands every fixture an environment that outranks the project `.npmrc` the test just wrote:
 * npm then installs from the public mirror, the fixture server sees no request, and the test fails
 * for a reason its own output never mentions. It passes under a bare `node --test` and fails under
 * `npm test`, which is exactly how this stayed hidden.
 *
 * Drop the inherited `npm_config_*` and point both config files at empty fixtures for the duration
 * of the test, so the project `.npmrc` under test is the only thing that can decide.
 */
export async function hermeticNpmConfig(t: TestContext, root: string): Promise<void> {
  const saved = new Map<string, string>();
  for (const name of Object.keys(process.env)) {
    if (!/^npm_config_/i.test(name)) continue;
    saved.set(name, process.env[name]!);
    delete process.env[name];
  }
  await writeFile(join(root, 'npmrc-user'), 'audit=false\nfund=false\n');
  await writeFile(join(root, 'npmrc-global'), 'audit=false\nfund=false\n');
  process.env.NPM_CONFIG_USERCONFIG = join(root, 'npmrc-user');
  process.env.NPM_CONFIG_GLOBALCONFIG = join(root, 'npmrc-global');
  t.after(() => {
    for (const name of Object.keys(process.env)) if (/^npm_config_/i.test(name)) delete process.env[name];
    for (const [name, value] of saved) process.env[name] = value;
  });
}

export async function registry(t: TestContext, mode: 'normal' | 'unknown-size' | 'corrupt' | 'reset-once' | 'hanging' = 'normal', version = '0.155.1') {
  const root = await mkdtemp(join(tmpdir(), 'nexus-download-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'fixture/package'), { recursive: true });
  await writeFile(join(root, 'fixture/package/package.json'), JSON.stringify({ name: '@openai/codex', version }));
  await writeFile(join(root, 'fixture/package/data'), randomBytes(192 * 1024));
  const archive = join(root, 'fixture.tgz');
  await exec('tar', ['-czf', archive, '-C', join(root, 'fixture'), 'package']);
  const bytes = await readFile(archive);
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  let tarRequests = 0, authed = false;
  const server = createServer((request, response) => {
    authed ||= request.headers.authorization === 'Bearer fixture-secret';
    const manifest = { name: '@openai/codex', version, dist: { tarball: `${url}/package.tgz`, integrity } };
    response.setHeader('cache-control', 'public, max-age=3600');
    if (request.url !== '/package.tgz') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(request.url?.includes('/' + version) ? manifest : { name: '@openai/codex', 'dist-tags': { latest: version }, versions: { [version]: manifest } }));
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

