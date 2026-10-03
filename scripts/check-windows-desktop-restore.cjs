/** Run with Electron in Node mode while the real Desktop is closed. All data is synthetic. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run(script, args = []) {
  const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({ code, output })); });
  return { child, done };
}
(async () => {
  assert.equal(process.platform, 'win32');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-restore-fixture-'));
  let checks = 0;
  const worker = process.argv[2]; assert.ok(worker);
  const fixtureExe = path.join(root, 'NexusFixture.exe');
  const compile = path.join(root, 'compile.ps1');
  await fs.writeFile(compile, '$ErrorActionPreference="Stop"\nAdd-Type -OutputType ConsoleApplication -OutputAssembly $args[0] -TypeDefinition \'public class Fixture { public static void Main(string[] args) { System.Threading.Thread.Sleep(args.Length > 0 ? 60000 : 50); } }\'\n');
  assert.equal((await (await run(compile, [fixtureExe])).done).code, 0);
  async function fixture(label, sourcePid = 9999999) {
    const home = path.join(root, label + ' 中文 空格');
    const id = crypto.randomBytes(16).toString('hex');
    const task = path.join(home, 'nexus-restore', id);
    const before = { 'sessions/old/session': 'original-session', 'storages/old.json': 'original-storage', '.credentials.yaml': 'original-fixture-credential' };
    const incoming = { 'sessions/new/session': 'imported-session', 'storages/new.json': 'imported-storage', '.credentials.yaml': 'imported-fixture-credential' };
    const write = async (rel, text) => { await fs.mkdir(path.dirname(path.join(home, rel)), { recursive: true }); await fs.writeFile(path.join(home, rel), text); };
    for (const [rel, text] of Object.entries(before)) await write(rel, text);
    for (const [rel, text] of Object.entries(incoming)) await write('import-staging/' + rel, text);
    const profile = 'profiles/desktop/cordis.patch.yml'; await write(profile, '- id: fixture\n  disabled: true\n');
    await fs.mkdir(task, { recursive: true });
    const pending = { stagedAt: Date.now(), replacedDir: 'replaced-20261003-000000-' + id.slice(0,6), roots: ['sessions','storages','.credentials.yaml'],
      files: Object.entries(incoming).map(([p, text]) => ({ path:p, size:Buffer.byteLength(text), sha256:crypto.createHash('sha256').update(text).digest('hex') })) };
    const plan = { version:1, id, home, executable:fixtureExe, hostPid:sourcePid, pending };
    await write('import-pending.json', JSON.stringify(pending));
    await fs.writeFile(path.join(task,'plan.json'), JSON.stringify(plan));
    await fs.writeFile(path.join(task,'status.json'), JSON.stringify({id,phase:'waiting',replacedDir:pending.replacedDir}));
    const start = () => run(worker, ['-PlanPath',path.join(task,'plan.json')]);
    const status = async () => JSON.parse(await fs.readFile(path.join(task,'status.json'),'utf8'));
    const read = rel => fs.readFile(path.join(home,rel),'utf8');
    return { home, task, profile, plan, before, incoming, write, start, status, read };
  }
  async function assertOriginal(f) {
    for (const [p, text] of Object.entries(f.before)) assert.equal(await f.read(p), text);
    assert.equal(await f.read(f.profile), '- id: fixture\n  disabled: true\n');
  }
  try {
    const success = await fixture('success');
    const result = await (await success.start()).done;
    assert.equal(result.code,0,result.output); assert.equal((await success.status()).phase,'completed');
    for(const [p,text] of Object.entries(success.incoming)) assert.equal(await success.read(p),text);
    for(const [p,text] of Object.entries(success.before)) assert.equal(await success.read(success.plan.pending.replacedDir+'/'+p),text);
    assert.equal(await success.read(success.profile),'- id: fixture\n  disabled: true\n'); checks++;

    const corrupt = await fixture('corrupt'); await corrupt.write('import-staging/storages/new.json','tampered');
    assert.equal((await (await corrupt.start()).done).code,1);
    assert.equal((await corrupt.status()).code,'restore_staging_changed'); await assertOriginal(corrupt); checks++;

    const cancelled = await fixture('cancel'); await fs.writeFile(path.join(cancelled.task,'cancel'),'');
    assert.equal((await (await cancelled.start()).done).code,0);
    assert.equal((await cancelled.status()).phase,'cancelled'); await assertOriginal(cancelled); checks++;

    // Simulate process death at each rename boundary. The persisted guard remains until rollback is complete.
    for (const movedIncoming of [false,true]) {
      const f = await fixture('interrupted-'+movedIncoming);
      await fs.writeFile(path.join(f.task,'profile.before'),await f.read(f.profile));
      await f.write(f.profile,'# Nexus recovery\nNexusRecoveryInProgress: [\n');
      const rows=f.plan.pending.roots.map(root=>({root,existed:true,incoming:true}));
      await fs.writeFile(path.join(f.task,'journal.json'),JSON.stringify({phase:'moving',profileExisted:true,rows}));
      await fs.mkdir(path.join(f.home,f.plan.pending.replacedDir));
      await fs.rename(path.join(f.home,'sessions'),path.join(f.home,f.plan.pending.replacedDir,'sessions'));
      if(movedIncoming) await fs.rename(path.join(f.home,'import-staging','sessions'),path.join(f.home,'sessions'));
      const r=await (await f.start()).done; assert.equal(r.code,0,r.output);
      assert.equal((await f.status()).phase,'rolled-back'); await assertOriginal(f); checks++;
    }

    const busy = await fixture('busy');
    const holderScript=path.join(root,'holder.ps1');
    await fs.writeFile(holderScript,'$ErrorActionPreference="Stop"\n$h=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None)\n[IO.File]::WriteAllText($args[1],"ready")\nStart-Sleep -Seconds 30\n$h.Dispose()');
    const heldPath=path.join(busy.home,'storages','old.json');const marker=path.join(root,'held');
    const holder=await run(holderScript,[heldPath,marker]);
    try {
      for(let i=0;i<100;i++){if(await fs.access(marker).then(()=>true,()=>false))break;await pause(50);}
      const r=await(await busy.start()).done;assert.equal(r.code,1,r.output);
      assert.equal((await busy.status()).phase,'rolled-back');checks++;
    } finally { holder.child.kill(); await holder.done; }
    await assertOriginal(busy);
    const waiting = await fixture('waiting-host');
    const host = spawn(fixtureExe,['hold'],{windowsHide:true});
    const hostExit=new Promise(resolve=>host.on('exit',resolve));
    const waiter=await waiting.start();
    try {
      for(let i=0;i<100;i++){if(await fs.access(path.join(waiting.task,'ready')).then(()=>true,()=>false))break;await pause(50);}
      await pause(600);assert.equal((await waiting.status()).phase,'waiting');await assertOriginal(waiting);checks++;
      const duplicate=await(await waiting.start()).done;assert.equal(duplicate.code,1);assert.equal((await waiting.status()).phase,'waiting');checks++;
      await fs.writeFile(path.join(waiting.task,'cancel'),'');assert.equal((await waiter.done).code,0);
      assert.equal(host.exitCode,null,'the helper must never terminate the desktop');checks++;
    } finally { host.kill();await hostExit; }

    const preserved=await fixture('preserve-credentials');
    preserved.plan.pending.roots=['sessions','storages'];preserved.plan.pending.files=preserved.plan.pending.files.filter(f=>f.path!=='.credentials.yaml');
    await fs.unlink(path.join(preserved.home,'import-staging','.credentials.yaml'));
    await fs.writeFile(path.join(preserved.task,'plan.json'),JSON.stringify(preserved.plan));
    assert.equal((await(await preserved.start()).done).code,0);assert.equal(await preserved.read('.credentials.yaml'),preserved.before['.credentials.yaml']);checks++;

    const rollback=await fixture('retry-rollback');
    await fs.writeFile(path.join(rollback.task,'profile.before'),await rollback.read(rollback.profile));
    await rollback.write(rollback.profile,'NexusRecoveryInProgress: [\n');
    await fs.writeFile(path.join(rollback.task,'journal.json'),JSON.stringify({phase:'moving',profileExisted:true,rows:rollback.plan.pending.roots.map(root=>({root,existed:true,incoming:true}))}));
    await fs.mkdir(path.join(rollback.home,rollback.plan.pending.replacedDir));
    await fs.rename(path.join(rollback.home,'sessions'),path.join(rollback.home,rollback.plan.pending.replacedDir,'sessions'));
    await fs.rename(path.join(rollback.home,'import-staging','sessions'),path.join(rollback.home,'sessions'));
    const held=path.join(rollback.home,rollback.plan.pending.replacedDir,'sessions','old','session'),heldMarker=path.join(root,'rollback-held');
    const locked=await run(holderScript,[held,heldMarker]);
    try {
      for(let i=0;i<100;i++){if(await fs.access(heldMarker).then(()=>true,()=>false))break;await pause(50);}
      assert.equal((await(await rollback.start()).done).code,1);
      assert.equal((await rollback.status()).code,'restore_rollback_failed');assert.match(await rollback.read(rollback.profile),/NexusRecoveryInProgress/);checks++;
    } finally {locked.child.kill();await locked.done;}
    assert.equal((await(await rollback.start()).done).code,0);await assertOriginal(rollback);checks++;

    const commit=await fixture('committed-interruption');
    await fs.writeFile(path.join(commit.task,'profile.before'),await commit.read(commit.profile));
    await commit.write(commit.profile,'NexusRecoveryInProgress: [\n');
    await fs.writeFile(path.join(commit.task,'journal.json'),JSON.stringify({phase:'committed',profileExisted:true,rows:commit.plan.pending.roots.map(root=>({root,existed:true,incoming:true}))}));
    await fs.mkdir(path.join(commit.home,commit.plan.pending.replacedDir));
    for(const root of commit.plan.pending.roots) {
      await fs.rename(path.join(commit.home,root),path.join(commit.home,commit.plan.pending.replacedDir,root));
      await fs.rename(path.join(commit.home,'import-staging',root),path.join(commit.home,root));
    }
    assert.equal((await(await commit.start()).done).code,0);assert.equal((await commit.status()).phase,'completed');
    for(const [p,text] of Object.entries(commit.incoming)) assert.equal(await commit.read(p),text);
    await assert.rejects(fs.access(path.join(commit.home,'import-pending.json')));checks++;

    // Reject case aliases and junctions before changing live data.
    const alias=await fixture('case-alias');alias.plan.pending.files.push({...alias.plan.pending.files[0],path:'SESSIONS/new/session'});
    await fs.writeFile(path.join(alias.task,'plan.json'),JSON.stringify(alias.plan));
    assert.equal((await(await alias.start()).done).code,1);await assertOriginal(alias);checks++;
    const reparse=await fixture('junction');
    const outside=path.join(root,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'untouched'),'outside');
    await fs.symlink(outside,path.join(reparse.home,'import-staging','unexpected'),'junction');
    assert.equal((await(await reparse.start()).done).code,1);await assertOriginal(reparse);
    assert.equal(await fs.readFile(path.join(outside,'untouched'),'utf8'),'outside');checks++;
    console.log(JSON.stringify({passed:true,checks,realAccountDataUsed:false,realMessagesSent:false}));
  } finally { await pause(200); await fs.rm(root,{recursive:true,force:true,maxRetries:3}); }
})().catch(error=>{console.error(error.stack);process.exit(1);});
