import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { ChannelError } from '../src/channels/types.js';
import { inspectPackage, ReleasePackages, sha256, type UpdatePackage } from '../src/updates/package.js';
import { UpdatesManager, type UpdatesDeps } from '../src/updates/manager.js';
import { nativeInstaller } from '../src/updates/native.js';
import { MemoryRecords } from './helpers.js';

function archive(version = '0.2.40', peers = '0.2.0-rc.2', extra: Record<string, unknown> = {}) {
  const files: Record<string, string> = {
    'package/package.json': JSON.stringify({ name: 'dsh-nexus', version, exports: { '.': './dist/src/plugin.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh-session': peers }, ...extra }),
    'package/dist/build-info.json': JSON.stringify({ commit: 'b'.repeat(40), dirty: false }),
    'package/dist/src/plugin.js': 'export const apply = () => {};', 'package/dist/client.js': '', 'package/cordis.patch.yml': '[]',
  };
  const parts: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    header.write(name); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header[156] = 48;
    header.fill(32, 148, 156); header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}
function pkg(version: string, commit = 'b'.repeat(40)): UpdatePackage {
  return { version, commit, sha256: version === '0.2.39' ? 'a'.repeat(64) : 'b'.repeat(64), path: '/fixture/'+version+'.tgz', compatible: true, dshVersion:'0.2.0-rc.2', releaseUrl:'https://github.com/yuqiguang/dsh-nexus/releases/tag/v'+version };
}
async function fixture(options: { fail?: string; missingRollback?: boolean; busy?: boolean; corruptBackup?: boolean } = {}) {
  const records = new MemoryRecords(); let disk: string | undefined = '0.2.39'; let idle = !options.busy;
  let fail = options.fail; const installs: string[] = []; const old = pkg('0.2.39','a'.repeat(40)), target = pkg('0.2.40');
  const deps: UpdatesDeps = { records, currentVersion: old.version, currentCommit: old.commit, dshVersion: old.dshVersion,
    packages: { async latest(){return target.version;}, async get(version){ if(options.missingRollback && version===old.version) throw new Error('not found');return version===old.version ? old : target; },async verify(value){if(options.corruptBackup && value===old) throw new ChannelError('update_checksum_invalid');} },
    installer:()=>({ async installed(){return disk;},async install(value,signal){
      installs.push(value.version); disk=value.version;
      if(fail && value.version===target.version) {const code=fail;fail=undefined;throw new ChannelError(code);}
      if(signal.aborted)throw new ChannelError('update_cancelled');return 'restart-required';
    }}),isIdle:async()=>idle,now:()=>1_000_000 };
  const manager = new UpdatesManager(deps);await manager.load();
  const check = async()=>{await manager.handle('check');await manager.settle();};
  const auto = async()=>{const view=await manager.view();await manager.handle('save',{revision:view.revision,autoCheck:true,autoInstall:true});};
  const install=async()=>{await manager.handle('install',{version:target.version});await manager.settle();};
  return {manager,deps,records,installs,old,target,check,auto,install,setIdle(value:boolean){idle=value;},setDisk(value:string|undefined){disk=value;}};
}

test('release packages validate the checksum and immutable version, then reuse a hash-named cache', async t => {
  const home=await mkdtemp(join(tmpdir(),'nexus-update-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const bytes=archive();let downloads=0;const urls:string[]=[];
  const transport:typeof fetch=async input=>{const url=String(input);urls.push(url);if(url.endsWith('/install'))return Response.json({tag_name:'install',draft:false,body:'<!-- nexus-install-source: v0.2.40 -->'});
    if(url.endsWith('/SHA256SUMS'))return new Response(sha256(bytes)+'  dsh-nexus-0.2.40.tgz\n');downloads++;return new Response(new Uint8Array(bytes));};
  const source=new ReleasePackages(home,'0.2.0-rc.2',transport),signal=new AbortController().signal;
  assert.equal(await source.latest(signal),'0.2.40');const item=await source.get('0.2.40',signal);await source.verify(item);
  assert.equal(item.compatible,true);assert.deepEqual(await readFile(item.path),bytes);await source.get('0.2.40',signal);assert.equal(downloads,1);
  assert.ok(urls.every(url=>url.startsWith('https://api.github.com/repos/yuqiguang/dsh-nexus/')||url.startsWith('https://github.com/yuqiguang/dsh-nexus/releases/download/v0.2.40/')));
});
test('metadata rejects wrong packages and install scripts, and flags DSH version mismatch',()=>{
  assert.equal(inspectPackage(archive(),'0.2.40','0.2.0-rc.2').compatible,true);
  assert.equal(inspectPackage(archive('0.2.40','0.3.0'),'0.2.40','0.2.0-rc.2').compatible,false);
  assert.throws(()=>inspectPackage(archive('0.2.40',undefined,{name:'another-plugin'}),'0.2.40','0.2.0-rc.2'),/update_package_invalid/);
  assert.throws(()=>inspectPackage(archive('0.2.40',undefined,{scripts:{install:'run'}}),'0.2.40','0.2.0-rc.2'),/update_package_invalid/);
  assert.throws(()=>inspectPackage(Buffer.from('not gzip'),'0.2.40','0.2.0-rc.2'),/update_package_invalid/);
});
test('checks are on by default but never imply permission to install',async()=>{
  const f=await fixture();await f.manager.tick();await f.manager.settle();await f.manager.tick();
  const view=await f.manager.view();assert.equal(view.autoCheck,true);assert.equal(view.autoInstall,false);assert.equal(view.latest?.version,'0.2.40');assert.deepEqual(f.installs,[]);
});
test('automatic installation waits for idle and reports installed separately from running until restart',async()=>{
  const f=await fixture({busy:true});await f.auto();await f.check();await f.manager.tick();assert.equal((await f.manager.view()).phase,'waiting');assert.deepEqual(f.installs,[]);
  f.setIdle(true);await f.manager.tick();await f.manager.settle();const view=await f.manager.view();
  assert.equal(view.currentVersion,'0.2.39');assert.equal(view.installedVersion,'0.2.40');assert.equal(view.phase,'restart-required');
  const restarted=new UpdatesManager({...f.deps,currentVersion:f.target.version,currentCommit:f.target.commit});await restarted.load();
  assert.equal((await restarted.view()).outcome,'updated');assert.equal((await restarted.view()).phase,'idle');
});
test('turning automatic installation off cancels an idle wait; settings survive restart',async()=>{
  const f=await fixture({busy:true});await f.auto();await f.check();await f.manager.tick();const before=await f.manager.view();
  await f.manager.handle('save',{revision:before.revision,autoCheck:false,autoInstall:false});f.setIdle(true);await f.manager.tick();assert.deepEqual(f.installs,[]);
  const reload=new UpdatesManager(f.deps);await reload.load();assert.equal((await reload.view()).autoInstall,false);assert.equal((await reload.view()).autoCheck,false);
  await assert.rejects(f.manager.handle('save',{revision:0,autoCheck:true,autoInstall:true}),/configuration_changed/);
});
test('installation failure restores the old artifact and does not retry the same failed release automatically',async()=>{
  const f=await fixture({fail:'update_install_failed'});await f.auto();await f.check();await f.manager.tick();await f.manager.settle();
  assert.deepEqual(f.installs,['0.2.40','0.2.39']);const view=await f.manager.view();assert.equal(view.outcome,'rolled-back');assert.equal(view.installedVersion,'0.2.39');
  await f.manager.tick();await f.manager.settle();assert.equal(f.installs.length,2);
});
test('a missing or corrupted rollback artifact blocks installation before native mutation',async()=>{
  for(const options of [{missingRollback:true},{corruptBackup:true}]){const f=await fixture(options);await f.auto();await f.check();await f.install();await f.manager.tick();await f.manager.settle();assert.deepEqual(f.installs,[]);assert.equal((await f.manager.view()).phase,'failed');}
});
test('a cancelled queued update and an explicit uninstall are never reinstalled by the timer',async()=>{
  const f=await fixture({busy:true});await f.auto();await f.check();await f.install();await f.manager.handle('cancel');f.setIdle(true);await f.manager.tick();assert.deepEqual(f.installs,[]);
  const removed=await fixture();await removed.check();removed.setDisk(undefined);await removed.install();assert.deepEqual(removed.installs,[]);assert.equal((await removed.manager.view()).error,'update_installed_changed');
});
test('native installer preserves activation and grants no new build-script permissions',async()=>{
  let options:any;let cancelled=false;
  const service={async listBundles(){return [{name:'dsh-nexus',installed:true,version:'0.2.39'}];},async installBundle(_path:string,input:unknown){options=input;return {bundle:'dsh-nexus',application:'restart-required',packageResult:{exitCode:0}};},async cancelInstall(){cancelled=true;}};
  const installer=nativeInstaller(service as never, async value=>value.path);assert.equal(await installer.installed(),'0.2.39');await installer.install(pkg('0.2.40'),new AbortController().signal);
  assert.equal(options.enabled,false);assert.equal(options.approvedBuilds,undefined);assert.equal(cancelled,false);
  const abort=new AbortController();abort.abort();await assert.rejects(installer.install(pkg('0.2.40'),abort.signal),/update_cancelled/);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
test('new activity during native installation cancels and restores the old version before waiting', async () => {
  const f = await fixture(); const entered = deferred();
  const native = f.deps.installer()!;
  f.deps.installer = () => ({ ...native, async install(value, signal) {
    if (value.version === f.target.version) {
      f.setDisk(value.version); entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new ChannelError('update_cancelled');
    }
    return native.install(value, signal);
  } });
  await f.auto(); await f.check(); await f.manager.tick(); await entered.promise;
  f.setIdle(false); f.manager.activity(); await f.manager.settle();
  const view = await f.manager.view();
  assert.equal(view.phase, 'waiting'); assert.equal(view.installedVersion, f.old.version);
  assert.equal(view.error, undefined); assert.deepEqual(f.installs, [f.old.version]);
  await f.manager.tick(); assert.deepEqual(f.installs, [f.old.version]);
});
test('disabling auto install while preparing cancels without changing installed files', async () => {
  const f = await fixture(); await f.auto(); await f.check();
  const entered = deferred(), nativeGet = f.deps.packages.get;
  f.deps.packages.get = async (version, signal) => {
    if (version === f.old.version) {
      entered.resolve();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new ChannelError('update_cancelled');
    }
    return nativeGet(version, signal);
  };
  await f.manager.tick(); await entered.promise;
  const view = await f.manager.view();
  await f.manager.handle('save', { revision: view.revision, autoCheck: true, autoInstall: false });
  await f.manager.settle();
  assert.deepEqual(f.installs, []); assert.equal((await f.manager.view()).phase, 'available');
  assert.equal((await f.manager.view()).error, undefined);
});
test('failed rollback survives restart and can repair the installed files without an automatic retry', async () => {
  const f = await fixture(); const native = f.deps.installer()!;
  f.deps.installer = () => ({ ...native, async install(value) {
    f.setDisk(value.version); throw new ChannelError('update_install_failed');
  } });
  await f.auto(); await f.check(); await f.install();
  assert.equal((await f.manager.view()).error, 'update_rollback_failed');
  const restarted = new UpdatesManager(f.deps); await restarted.load();
  assert.equal((await restarted.view()).phase, 'failed');
  assert.equal((await restarted.view()).rollbackVersion, f.old.version);
  assert.equal(restarted.busy, true); await restarted.tick(); assert.deepEqual(f.installs, []);
  f.deps.installer = () => native;
  await restarted.handle('rollback', { version: f.old.version }); await restarted.settle();
  assert.equal((await restarted.view()).outcome, 'rolled-back'); assert.equal(restarted.busy, false);
  assert.deepEqual(f.installs, [f.old.version]);
});
test('disposal during an installation never re-adds an uninstalled plugin', async () => {
  const f = await fixture(); const entered = deferred(), native = f.deps.installer()!;
  f.deps.installer = () => ({ ...native, async install() {
    entered.resolve(); await new Promise<void>(resolve => setTimeout(resolve, 10));
    throw new ChannelError('update_cancelled');
  } });
  await f.check(); await f.manager.handle('install', { version: f.target.version });
  await entered.promise; f.setDisk(undefined); await f.manager.close();
  assert.deepEqual(f.installs, []); assert.equal((await f.manager.view()).error, 'update_interrupted');
});
test('a changed DSH compatibility requirement blocks native installation', async () => {
  const f = await fixture(); f.target.compatible = false;
  await f.auto(); await f.check(); await f.manager.tick();
  await assert.rejects(f.manager.handle('install', { version: f.target.version }), /update_candidate_changed/);
  assert.deepEqual(f.installs, []); assert.equal((await f.manager.view()).error, 'update_incompatible');
});
