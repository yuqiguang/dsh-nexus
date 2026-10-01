/** Run with Desktop's Electron in Node mode, after exiting Desktop.
 * argv[2]: compiled output directory. No model key or real channel is used.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks, createRequire, isBuiltin } = require('node:module');
const { createServer } = require('node:net');
const { once } = require('node:events');

async function main() {
  assert.equal(process.platform, 'win32');
  const runtime = path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules');
  const resolvers = [createRequire(path.join(runtime, '..', 'package.json')),
    createRequire(path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop', 'node_modules', 'nexus-next', 'package.json'))];
  let resolving = false;
  registerHooks({ resolve(specifier, context, next) {
    if (!resolving && !isBuiltin(specifier) && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')) {
      for (const resolver of resolvers) {
        try { resolving = true; return { url: pathToFileURL(resolver.resolve(specifier)).href, shortCircuit: true }; }
        catch {} finally { resolving = false; }
      }
    }
    return next(specifier, context);
  } });
  const compiled = path.resolve(process.argv[2]);
  const moduleAt = file => import(pathToFileURL(path.join(compiled, 'src', 'coders', file)).href);
  const { spawnTaskProcess, stopTaskProcess, closeTaskProcess } = await moduleAt('process.js');
  const { windowsSandbox, windowsVerifyArgv, windowsVerifyExecutable } = await moduleAt('windows-sandbox.js');
  const { runVerifyCommand } = await moduleAt('verify.js');
  const { requireWindowsFirewall, windowsFirewallEnabled } = await moduleAt('windows-firewall.js');
  const { canonical } = await moduleAt('permissions.js');
  const managed = path.join(process.env.USERPROFILE, '.dsh', 'nexus-coders');
  const codex = path.join(managed, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const node = path.join(process.env.ProgramFiles, 'nodejs', 'node.exe');
  const env = { ...process.env, CODEX_HOME: path.join(managed, 'codex-home'), LOCALAPPDATA: path.join(managed, 'codex-local-app-data') };
  if (process.argv.includes('--guard-only')) {
    assert.equal(await windowsFirewallEnabled(), false);
    await assert.rejects(requireWindowsFirewall(), /防火墙/);
    console.log('PASS disabled firewall blocks strict offline policy'); return;
  }
  const root = await fs.mkdtemp(path.join(process.env.USERPROFILE, 'nexus-native-check-'));
  const workspace = path.join(root, 'work 空 格');
  await fs.mkdir(workspace);
  const active = new Set();
  const previousProxy = process.env.HTTP_PROXY;
  const checks = [];
  const passed = label => { checks.push(label); console.log('PASS ' + label); };
  const wait = child => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('native runner exit timed out')); }, 15_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  const start = args => { const child = spawnTaskProcess(node, args, workspace, env); active.add(child); return child; };
  const server = createServer(socket => { socket.on('error', () => {}); socket.end('fixture'); });
  try {
    let child = start(['-e', 'process.stdout.write("pipe-ok")']);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    assert.equal(await wait(child), 0); assert.equal(output, 'pipe-ok'); passed('native stdio');
    const pidFile = path.join(workspace, 'pid');
    await fs.writeFile(path.join(workspace, 'grandchild.cjs'), 'require("node:fs").writeFileSync("pid", String(process.pid));setInterval(()=>{},1000)');
    for (const mode of ['normal', 'cancel', 'host-disconnect', 'runner-crash']) {
      await fs.rm(pidFile, { force: true });
      child = start(['-e', `const c=require('node:child_process').spawn(process.execPath,['grandchild.cjs'],{detached:true,stdio:'ignore'});c.unref();${mode === 'normal' ? 'setTimeout(()=>process.exit(0),800)' : 'setInterval(()=>{},1000)'}`]);
      const exited = wait(child); let pid;
      for (let i = 0; i < 100; i++) {
        pid = await fs.readFile(pidFile, 'utf8').catch(() => undefined);
        if (pid) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(pid, 'grandchild started');
      if (mode === 'cancel') stopTaskProcess(child);
      if (mode === 'host-disconnect') child.disconnect();
      if (mode === 'runner-crash') child.kill('SIGKILL');
      await exited;
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.throws(() => process.kill(Number(pid), 0)); passed(mode + ' descendant cleanup');
    }
    assert.equal(await canonical(path.join(workspace, 'new', 'file')), path.join(workspace, 'new', 'file'));
    passed('Windows canonical missing ancestors');
    assert.equal(await windowsSandbox({ command: codex, env }, workspace), 'ready'); passed('sandbox readiness through managed process');
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    const fixture = path.join(workspace, 'verify fixture.cjs');
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(fixture, `const fs=require('node:fs'),assert=require('node:assert/strict'),net=require('node:net');
assert.ok(!process.env.NEXUS_FIXTURE_TOKEN,'verification must not inherit secrets');
assert.ok(!process.env.HTTP_PROXY,'verification must not inherit proxy credentials or exceptions');
fs.writeFileSync('inside.txt','ok');
assert.throws(()=>fs.writeFileSync(${JSON.stringify(outside)},'forbidden'));
const socket=net.connect(${port},'127.0.0.1');let done=false;
const finish=connected=>{if(done)return;done=true;socket.destroy();assert.equal(connected,process.argv[2]==='online');console.log('filesystem-and-network-ok')};
socket.on('connect',()=>finish(true));socket.on('error',()=>finish(false));socket.setTimeout(3000,()=>finish(false));`);
    process.env.NEXUS_FIXTURE_TOKEN = 'fixture-value';
    process.env.HTTP_PROXY = 'http://127.0.0.1:' + port;
    const extraEnv = { CODEX_HOME: env.CODEX_HOME, LOCALAPPDATA: env.LOCALAPPDATA };
    const confine = network => async argv => { if (network === 'offline') await requireWindowsFirewall(); return windowsVerifyArgv(codex, await windowsVerifyExecutable(argv, workspace, env), workspace, workspace, network); };
    let result = await runVerifyCommand(`"${node}" "${fixture}" offline`, workspace, undefined, confine('offline'), extraEnv);
    if (await windowsFirewallEnabled()) { assert.equal(result.ok, true, result.output); assert.match(result.output, /filesystem-and-network-ok/); passed('offline verification denies outside writes and host loopback'); }
    else { assert.equal(result.executed, false); assert.match(result.output, /防火墙/); passed('strict offline verification refuses ineffective firewall'); }
    result = await runVerifyCommand(`"${node}" "${fixture}" online`, workspace, undefined, confine('ask'), extraEnv);
    assert.equal(result.ok, true, result.output); assert.equal(await fs.access(outside).then(() => true, () => false), false); passed('approved network retains write confinement');
    await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node "verify fixture.cjs" online' } }));
    result = await runVerifyCommand('npm test', workspace, undefined, confine('ask'), extraEnv);
    assert.equal(result.ok, true, result.output); passed('native npm verification with spaces');
    await fs.writeFile(fixture, 'process.exit(7)');
    result = await runVerifyCommand(`"${node}" "${fixture}"`, workspace, undefined, confine('ask'), extraEnv);
    assert.equal(result.ok, false); passed('failing verification stays failed');
    const abort = new AbortController(); abort.abort();
    result = await runVerifyCommand(`"${node}" "${fixture}"`, workspace, abort.signal, confine('offline'), extraEnv);
    assert.equal(result.ok, false); assert.equal(result.executed, false); passed('cancelled verification never launches');
    result = await runVerifyCommand(`"${node}" "${fixture}"`, workspace, undefined, confine('loopback'), extraEnv);
    assert.equal(result.executed, false); passed('unsupported isolated loopback fails closed');
    // The sandbox's broker must not leave detached descendants behind either.
    await fs.rm(pidFile, { force: true });
    await fs.writeFile(fixture, `const c=require('node:child_process').spawn(${JSON.stringify(node)},['grandchild.cjs'],{detached:true,stdio:'ignore'});c.unref();setTimeout(()=>process.exit(0),1000)`);
    result = await runVerifyCommand(`"${node}" "${fixture}"`, workspace, undefined, confine('ask'), extraEnv);
    assert.equal(result.ok, true, result.output);
    const sandboxPid = Number(await fs.readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(sandboxPid, 0)); passed('sandboxed detached descendant cleanup');
    console.log(JSON.stringify({ ok: true, checks }, null, 2));
  } finally {
    delete process.env.NEXUS_FIXTURE_TOKEN;
    if (previousProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previousProxy;
    if (server.listening) await new Promise(resolve => server.close(resolve));
    for (const child of active) await closeTaskProcess(child);
    await fs.rm(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
