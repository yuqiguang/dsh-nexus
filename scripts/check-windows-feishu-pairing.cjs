/** Run the pairing lifecycle fixtures on Desktop's native Windows Node runtime; no network/account access. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire, registerHooks, isBuiltin } = require('node:module');
const { pathToFileURL } = require('node:url');
assert.equal(process.platform, 'win32');
const runtime = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh');
const host = createRequire(path.join(runtime, 'package.json'));
const plugin = createRequire(path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'nexus-next', 'package.json'));
let resolving = false;
registerHooks({ resolve(specifier, context, next) {
  if (resolving || isBuiltin(specifier)) return next(specifier, context);
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
    for (const resolver of [host, plugin]) {
      try { resolving = true; return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true }; }
      catch {} finally { resolving = false; }
    }
  }
  return next(specifier, context);
} });
import(pathToFileURL(path.join(path.resolve(process.argv[2]), 'test', 'feishu-pairing.test.js')).href)
  .catch(() => { console.error('Could not load Windows pairing fixtures.'); process.exitCode = 1; });
