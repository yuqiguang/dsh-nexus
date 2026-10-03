import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopRestore } from '../src/data/desktop.js';
import { exportData, PENDING_FILE, stageImport } from '../src/data/archive.js';
import { installDataRoutes } from '../src/data/index.js';
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot';

test('the recovery guard is rejected by the public DSH profile loader before storage startup', async t => {
  const home = await mkdtemp(join(tmpdir(), 'nexus-restore-guard-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const patch = join(home, 'cordis.patch.yml');
  await writeFile(patch, '# Nexus desktop recovery\nNexusRecoveryInProgress: [\n');
  assert.throws(() => loadOptionalPatches('dsh', patch));
  await writeFile(patch, '[]\n');
  assert.deepEqual(loadOptionalPatches('dsh', patch), []);
});

async function fixture(t: { after(fn: () => unknown): void }) {
  const home = await mkdtemp(join(tmpdir(), 'nexus-desktop-restore-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home,'storages'), { recursive: true });
  await writeFile(join(home,'storages','fixture.json'),'{}');
  const archive = await exportData(home, { now: 1, dshVersion: '0.2.0-rc.2' });
  return { home, archive };
}
test('desktop preparation binds the staged snapshot, persists recovery instructions and cancellation without restarting the host', async t => {
  const { home, archive } = await fixture(t);
  const pending = await stageImport(home, archive.zip, 2);
  let launched = 0;
  const restore = createDesktopRestore({ home, executable:'C:/DSH/DSH.exe', shell:'C:/Windows/powershell.exe', hostPid:1, dshVersion:'0.2.0-rc.2',
    async launch(script, planPath) {
      launched++; assert.match(script,/restore.ps1$/);
      const plan = JSON.parse(await readFile(planPath,'utf8'));
      assert.equal(plan.home, home); assert.deepEqual(plan.pending.files, pending.files);
      await writeFile(join(home,'nexus-restore',plan.id,'ready'),'');
    } });
  const status = await restore.prepare(pending);
  assert.equal(status.phase,'waiting'); assert.equal(launched,1);
  assert.equal(await readFile(join(home,'storages','fixture.json'),'utf8'),'{}');
  assert.ok((await readFile(join(home,'nexus-restore','continue.cmd'),'utf8')).includes('-PlanPath'));
  await assert.rejects(restore.prepare(pending),/import_in_progress/);
  await assert.rejects(restore.cancel('other-id'),/restore_not_waiting/);
  await restore.cancel(status.id);
  assert.equal(await readFile(join(home,'nexus-restore',status.id,'cancel'),'utf8'),'');
  assert.equal((await restore.status())?.phase,'cancelled');
  await assert.rejects(readFile(join(home,PENDING_FILE)));
});
test('failed preparation can be cancelled only before a recovery journal exists', async t => {
  const { home, archive } = await fixture(t);
  const pending = await stageImport(home, archive.zip, 2);
  const restore = createDesktopRestore({ home, executable:'C:/DSH/DSH.exe', shell:'C:/Windows/powershell.exe', hostPid:1, dshVersion:'0.2.0-rc.2',
    async launch(_script, planPath) {
      const plan = JSON.parse(await readFile(planPath,'utf8'));
      await writeFile(join(home,'nexus-restore',plan.id,'ready'),'');
    } });
  const status = await restore.prepare(pending);
  const task = join(home,'nexus-restore',status.id);
  await writeFile(join(task,'status.json'), JSON.stringify({ ...status, phase:'failed' }));
  await writeFile(join(task,'journal.json'), '{}');
  assert.equal((await restore.status())?.canCancel, false);
  await assert.rejects(restore.cancel(status.id), /restore_not_waiting/);
  assert.ok(await readFile(join(home,PENDING_FILE)));
  await rm(join(task,'journal.json'));
  assert.equal((await restore.status())?.canCancel, true);
  await restore.cancel(status.id);
  assert.equal((await restore.status())?.phase,'cancelled');
  await assert.rejects(readFile(join(home,PENDING_FILE)));
});
test('desktop recovery rejects incompatible versions and source profiles before launching a worker', async t => {
  const { home, archive } = await fixture(t);
  const pending = await stageImport(home,archive.zip,2);
  const restore = createDesktopRestore({home,executable:'C:/DSH/DSH.exe',shell:'C:/Windows/powershell.exe',hostPid:1,dshVersion:'different',async launch(){throw new Error('must not launch');}});
  await assert.rejects(restore.prepare(pending),/desktop_restore_version_mismatch/);
  const same = createDesktopRestore({home,executable:'C:/DSH/DSH.exe',shell:'C:/Windows/powershell.exe',hostPid:1,dshVersion:'0.2.0-rc.2',async launch(){throw new Error('must not launch');}});
  await assert.rejects(same.prepare({...pending, files:[{path:'profiles/nexus/cordis.patch.yml',size:0,sha256:'0'.repeat(64)}]}),/desktop_restore_profile_mismatch/);
});
test('a desktop route stages and starts the offline helper; launch failure cleans up only its own pending staging', async t => {
  const {home,archive}=await fixture(t);
  const routes=new Map<string,(request:Request)=>Promise<Response>>();
  const ctx={connection:{fetch:{register(route:{path:string;fetch(request:Request):Promise<Response>}){routes.set(route.path,route.fetch);}}}} as never;
  let fail=true, staged=0;
  installDataRoutes({ctx,home,dshVersion:'0.2.0-rc.2',isIdle:()=>true,restart(){throw new Error('desktop must not send a restart signal');},desktopRestore:{
    async status(){return undefined;},async cancel(){},async prepare(pending){staged++;assert.ok(pending.files?.length);if(fail)throw new Error('fixture-launch-failed');return {id:'a'.repeat(32),phase:'waiting',replacedDir:pending.replacedDir,recoveryPath:'fixture'};}
  }});
  const { previewData }=await import('../src/data/archive.js');const preview=await previewData(archive.zip);
  const request=()=>new Request('http://x',{method:'POST',headers:{'Content-Type':'application/zip','X-Nexus-Preview':preview.digest},body:new Uint8Array(archive.zip)});
  const first=await (await routes.get('/api/nexus-data/import')!(request())).json() as any;
  assert.equal(first.ok,false);await assert.rejects(readFile(join(home,PENDING_FILE)));
  fail=false;const next=await (await routes.get('/api/nexus-data/import')!(request())).json() as any;
  assert.equal(next.ok,true);assert.equal(next.value.desktop.phase,'waiting');assert.equal(next.value.restarting,false);assert.equal(staged,2);
});
