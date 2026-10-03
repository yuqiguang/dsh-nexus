/** Serial native DSH package-manager exercise; every profile and credential is synthetic. */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile), require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = require.resolve('@deepseek-ai/dsh/package.json');
const host = JSON.parse(await readFile(manifestPath, 'utf8'));
const entry = join(dirname(manifestPath), host.bin.dsh);
const task = await mkdtemp(join(tmpdir(), 'nexus-native-update-'));
const home = join(task, 'home'), profile = join(home, 'profiles/nexus');
const env = { ...process.env };
for (const name of Object.keys(env)) if (/(KEY|SECRET|TOKEN|PASSWORD)/i.test(name) || name.startsWith('DSH_') || name.startsWith('NEXUS_')) delete env[name];
Object.assign(env, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--max-old-space-size=384' });
const packages = {};
let child;
try {
  for (const version of ['1.0.0', '1.0.1', '1.0.2']) {
    const dir = join(task, version); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name:'dsh-nexus',version,type:'module',exports:{'.':'./index.js','./off':'./off.js'},dsh:{bundle:{patch:'./cordis.patch.yml'}},peerDependencies:{'@deepseek-ai/dsh-session':host.version} }));
    await writeFile(join(dir, 'index.js'), `export const name='nexus-update-fixture-core';export function apply(ctx){ctx.provide('updateFixture',{version:${JSON.stringify(version)}});}`);
    await writeFile(join(dir, 'off.js'), "export const name='nexus-update-fixture-extra';export function apply(){}");
    await writeFile(join(dir, 'cordis.patch.yml'), version === '1.0.2' ? 'invalid: [\n' : JSON.stringify([{insert:[{id:'update-fixture-core',name:'dsh-nexus'},{id:'update-fixture-extra',name:'dsh-nexus/off',disabled:true}]}]));
    const result = JSON.parse((await exec('npm', ['pack','--json','--ignore-scripts','--pack-destination',task], {cwd:dir,env,timeout:60_000})).stdout)[0];
    packages[version] = join(task, result.filename);
  }
  await mkdir(profile,{recursive:true});
  await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'],patchReload:'startup'}}}));
  await writeFile(join(profile,'pnpm-workspace.yaml'),'autoInstallPeers: false\nnodeLinker: hoisted\noffline: true\nignoreScripts: true\n');
  await exec(process.execPath,['--max-old-space-size=384',entry,'plugin','--profile','nexus','add',packages['1.0.0'],'--offline','--ignore-scripts','--config.auto-install-peers=false'],{cwd:root,env,timeout:120_000});
  const driver=join(task,'driver.mjs'), report=join(task,'report.json');
  await writeFile(driver, `import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {credentialKey} from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials')).href)};
import {nativeInstaller} from ${JSON.stringify(pathToFileURL(join(root,'dist/src/updates/native.js')).href)};
import {UpdatesManager} from ${JSON.stringify(pathToFileURL(join(root,'dist/src/updates/manager.js')).href)};
import {DshRecords} from ${JSON.stringify(pathToFileURL(join(root,'dist/src/dsh/records.js')).href)};
export const name='update-driver';export const inject=['pluginManager','credentials'];
export function apply(ctx){const timer=setTimeout(()=>{void run().catch(async error=>{await writeFile(${JSON.stringify(report)},JSON.stringify({passed:false,error:String(error.stack)}));});},300);ctx.effect(()=>()=>clearTimeout(timer));
async function run(){const service=ctx.pluginManager;const installer=nativeInstaller(service);const checks=[];
const profile=${JSON.stringify(profile)};const packages=${JSON.stringify(packages)};
const packageOf=async version=>{const path=packages[version],bytes=await readFile(path);return {version,path,sha256:createHash('sha256').update(bytes).digest('hex'),commit:(version==='1.0.0'?'a':'b').repeat(40),compatible:true,dshVersion:${JSON.stringify(host.version)},releaseUrl:'https://github.com/yuqiguang/dsh-nexus/releases'};};
const currentVersion=process.env.UPDATE_FIXTURE_PHASE==='1'?'1.0.0':'1.0.1';
const manager=new UpdatesManager({records:new DshRecords(ctx.credentials,'update-fixture-settings'),currentVersion,currentCommit:(currentVersion==='1.0.0'?'a':'b').repeat(40),dshVersion:${JSON.stringify(host.version)},
packages:{latest:async()=>'1.0.1',get:packageOf,verify:async pkg=>assert.equal(createHash('sha256').update(await readFile(pkg.path)).digest('hex'),pkg.sha256)},installer:()=>installer,isIdle:async()=>true});
await manager.load();
if(process.env.UPDATE_FIXTURE_PHASE==='1'){
 assert.equal(await installer.installed(),'1.0.0');assert.equal(ctx.get('updateFixture').version,'1.0.0');
 const row=(await service.listPlugins()).find(row=>row.moduleName==='dsh-nexus/off');
 await service.setPluginEnabled(row.entryId,true);
 await ctx.credentials.modifyRecord(credentialKey('update-fixture','preserve'),async()=>({kind:'grant',payload:{value:'synthetic'}}));
 const patch=await readFile(profile+'/cordis.patch.yml','utf8');const before=JSON.parse(await readFile(profile+'/package.json','utf8')).dsh;
 await manager.handle('check');await manager.settle();
 const available=await manager.view();assert.equal(available.phase,'available');assert.ok(available.lastCheckAt);assert.equal(available.autoInstall,false);checks.push('check_state_saved_by_native_credentials');
 await manager.handle('save',{revision:available.revision,autoCheck:true,autoInstall:true});
 await manager.tick();await manager.settle();assert.equal((await manager.view()).phase,'restart-required');checks.push('opt_in_and_install_transaction_saved_by_native_credentials');
 assert.equal(await installer.installed(),'1.0.1');assert.equal(ctx.get('updateFixture').version,'1.0.0');checks.push('install_requires_restart_and_keeps_running_generation');
 assert.equal(await readFile(profile+'/cordis.patch.yml','utf8'),patch);assert.deepEqual(JSON.parse(await readFile(profile+'/package.json','utf8')).dsh,before);checks.push('profile_and_component_choices_preserved');
 await assert.rejects(installer.install(await packageOf('1.0.2'),new AbortController().signal));checks.push('bad_bundle_refused_after_native_package_operation');
 await installer.install(await packageOf('1.0.1'),new AbortController().signal);assert.equal(await installer.installed(),'1.0.1');checks.push('rollback_reinstalls_original_files_even_after_manifest_restore');
 assert.equal(await readFile(profile+'/cordis.patch.yml','utf8'),patch);checks.push('rollback_preserves_profile');
}else{
 const state=await manager.view();assert.equal(state.outcome,'updated');assert.equal(state.autoInstall,true);assert.equal(state.error,undefined);
 await manager.handle('save',{revision:state.revision,autoCheck:true,autoInstall:false});assert.equal((await manager.view()).autoInstall,false);checks.push('restart_clears_transaction_and_preserves_native_update_settings');
 assert.equal(await installer.installed(),'1.0.1');assert.equal(ctx.get('updateFixture').version,'1.0.1');checks.push('new_generation_activates_after_restart');
 const record=await ctx.credentials.readRecord(credentialKey('update-fixture','preserve'));assert.equal(record.payload.value,'synthetic');checks.push('native_credentials_preserved');
 const row=(await service.listPlugins()).find(row=>row.moduleName==='dsh-nexus/off');assert.equal(row.enabled,true);checks.push('component_choice_survives_restart');
}
await writeFile(${JSON.stringify(report)},JSON.stringify({passed:true,checks}));}}
`);
  await writeFile(join(profile,'cordis.patch.yml'),JSON.stringify([{insert:[{id:'update-driver',name:pathToFileURL(driver).href}]}]));
  const checks=[];
  for(const phase of ['1','2']){
    await rm(report,{force:true});
    child=spawn(process.execPath,['--max-old-space-size=384',entry,'--profile','nexus','--no-open','--port','0'],{cwd:root,env:{...env,UPDATE_FIXTURE_PHASE:phase},stdio:['ignore','pipe','pipe'],detached:true});
    let diagnostics='';
    const collect=bytes=>{diagnostics=(diagnostics+String(bytes).replace(/https?:\/\/\S+/g,'[URL omitted]')).slice(-8000);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    const deadline=Date.now()+120_000;let result;
    while(Date.now()<deadline){try{result=JSON.parse(await readFile(report,'utf8'));break;}catch{if(child.exitCode!==null || child.signalCode!==null || diagnostics.includes('failed to import'))break;await delay(100);}}
    assert.ok(result,'native update fixture did not complete: '+diagnostics);assert.equal(result.passed,true,result.error);
    checks.push(...result.checks);
    process.kill(-child.pid,'SIGTERM');
    for(let i=0;i<100 && child.exitCode===null && child.signalCode===null;i++)await delay(100);
    assert.ok(child.exitCode!==null || child.signalCode!==null,'fixture failed to stop');child=undefined;
  }
  const evidence={passed:true,checks,realAccountDataUsed:false,realChannelMessagesSent:false};
  await mkdir(join(root,'.nexus/smoke'),{recursive:true});
  await writeFile(join(root,'.nexus/smoke/plugin-updates-native.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally {
  if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{}}
  await rm(task,{recursive:true,force:true});
}
