import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import { spawnTaskProcess, closeTaskProcess } from '../src/coders/process.js';
import { localCheck } from '../src/coders/local-check.js';
import { snapshotWorkTree, changedFiles, verifyTask } from '../src/coders/verify.js';

const ctx = { sandbox: { async confine(argv: string[]) { return { argv, enforcement: 'full' }; } } } as unknown as Context;

test('local check connects only within its namespace and cannot write outside the workspace', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-local-'));
  const outside = join(homedir(), `.nexus-outside-${Date.now()}`);
  const host = createServer((_, res) => res.end('host'));
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  const port = (host.address() as { port: number }).port;
  try {
    await writeFile(join(root, 'check.mjs'), `
      import assert from 'node:assert/strict';
      import {createServer} from 'node:http';
      import {writeFileSync} from 'node:fs';
      assert.throws(()=>writeFileSync(${JSON.stringify(outside)},'escape'));
      await assert.rejects(fetch('http://127.0.0.1:${port}', {signal:AbortSignal.timeout(300)}));
      await assert.rejects(fetch('http://192.0.2.1', {signal:AbortSignal.timeout(300)}));
      const server=createServer((q,s)=>s.end('private'));
      await new Promise(r=>server.listen(0,'127.0.0.1',r));
      assert.equal(await fetch('http://127.0.0.1:'+server.address().port).then(r=>r.text()),'private');
      writeFileSync('result.txt','passed');server.closeAllConnections();server.close();console.log('PASS private check');
    `);
    assert.match(await localCheck(ctx, root, 'fixture', 'node check.mjs', undefined, new AbortController().signal), /PASS private check/);
    assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'passed');
    await assert.rejects(localCheck(ctx, root, 'fixture', 'node check.mjs', '..', new AbortController().signal), /目录/);
  } finally { host.closeAllConnections(); await new Promise<void>(resolve => host.close(() => resolve())); await rm(root,{recursive:true,force:true}); await rm(outside,{force:true}); }
});

test('ending a coder process kills detached descendants with inherited pipes', { skip: process.platform !== 'linux' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'nexus-process-'));
  try {
    await writeFile(join(root, 'parent.cjs'), `const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e',\"setInterval(()=>require('fs').appendFileSync('heartbeat','x'),20)\"],{detached:true,stdio:'ignore'});c.unref();setInterval(()=>{},1000);`);
    const child = spawnTaskProcess(process.execPath, ['parent.cjs'], root, process.env);
    child.stderr.resume(); child.stdout.resume();
    try {
      for(let i=0;i<100;i++){if(await readFile(join(root,'heartbeat')).catch(()=>undefined))break;await delay(20);}
      assert.ok((await readFile(join(root,'heartbeat'))).length>0);
      await closeTaskProcess(child);
      await delay(100);
      const before=await readFile(join(root,'heartbeat'),'utf8');await delay(100);
      assert.equal(await readFile(join(root,'heartbeat'),'utf8'),before);
    } finally { await closeTaskProcess(child); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('walk excludes npm and Chromium profiles while retaining check evidence', async () => {
  const root=await mkdtemp(join(tmpdir(),'nexus-profile-'));
  try {
    const baseline=await snapshotWorkTree(root);
    const profile=join(root,'.checks','browser-data');await mkdir(join(profile,'Default'),{recursive:true});
    await writeFile(join(profile,'Local State'),'{}');await writeFile(join(profile,'Default','History'),'cache');
    await mkdir(join(root,'.npm-cache'));await writeFile(join(root,'.npm-cache','blob'),'cache');
    await writeFile(join(root,'.checks','evidence.json'),'{}');
    assert.deepEqual(await changedFiles(root,baseline),[join(root,'.checks','evidence.json')]);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('independent verification binds an explicit project directory and explains parent-directory mistakes', async () => {
  const root=await mkdtemp(join(tmpdir(),'nexus-verify-cwd-'));
  try {
    await mkdir(join(root,'app'));await writeFile(join(root,'app','package.json'),JSON.stringify({scripts:{build:'node -e "process.exit(0)"'}}));
    const failed=await verifyTask({cwd:root,verify:'npm run build'},[root]);
    assert.equal(failed.verifyExecuted,false);assert.match(failed.verifyOutput!,/verify_cwd.*app/);
    const passed=await verifyTask({cwd:root,verifyCwd:join(root,'app'),verify:'npm run build'},[root]);
    assert.equal(passed.verifyOk,true);
    await assert.rejects(verifyTask({cwd:root,verifyCwd:tmpdir(),verify:'true'},[root]),/验证目录/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('cancelling a local check stops its detached background writers', {skip:process.platform!=='linux'}, async () => {
  const root=await mkdtemp(join(tmpdir(),'nexus-check-cancel-'));
  const controller=new AbortController();
  try {
    await writeFile(join(root,'check.cjs'), `const {spawn}=require('child_process');spawn(process.execPath,['-e',\"setInterval(()=>require('fs').appendFileSync('heartbeat','x'),20)\"],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);`);
    const pending=localCheck(ctx,root,'fixture','node check.cjs',undefined,controller.signal);
    const rejection=assert.rejects(pending,/检查失败|取消/);
    for(let i=0;i<100;i++){if(await readFile(join(root,'heartbeat')).catch(()=>undefined))break;await delay(20);}
    assert.ok((await readFile(join(root,'heartbeat'))).length>0);
    controller.abort();await rejection;await delay(100);
    const before=await readFile(join(root,'heartbeat'),'utf8');await delay(100);
    assert.equal(await readFile(join(root,'heartbeat'),'utf8'),before);
  } finally {controller.abort();await rm(root,{recursive:true,force:true});}
});

test('Claude custom spawn drains large stderr and cleans detached children on natural completion', {skip:process.platform!=='linux',timeout:10000}, async () => {
  const {runClaudeTask}=await import('../src/coders/claude.js');
  const {taskPermissions}=await import('../src/coders/permissions.js');
  const root=await mkdtemp(join(tmpdir(),'nexus-claude-process-'));
  let hooks:ReturnType<typeof runClaudeTask>|undefined;
  try {
    await writeFile(join(root,'cli.cjs'),`process.stderr.write('x'.repeat(256000));const {spawn}=require('child_process');spawn(process.execPath,['-e',\"setInterval(()=>require('fs').appendFileSync('heartbeat','x'),10)\"],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>process.exit(0),200);`);
    hooks=runClaudeTask({id:'ct-process',coder:'claude',cwd:root,description:'fixture',ownerSession:'fixture',status:'running',createdAt:0,updatedAt:0,decisions:[],escalations:0,permissions:await taskPermissions(root,[root],'claude')},{
      decide:async()=>({behavior:'allow'}),query:async function*({options}) {
        const child=options.spawnClaudeCodeProcess!({command:process.execPath,args:['cli.cjs'],cwd:root,env:process.env,signal:options.abortController.signal});
        child.stdout.resume();await new Promise<void>((resolve,reject)=>{child.once('exit',code=>code===0?resolve():reject(new Error('fixture failed')));child.once('error',reject);});
        yield {type:'result',subtype:'success',result:'done'};
      },
    });
    assert.equal((await hooks.done).status,'completed');
    const before=await readFile(join(root,'heartbeat'),'utf8');await delay(100);assert.equal(await readFile(join(root,'heartbeat'),'utf8'),before);
  } finally {hooks?.cancel('cleanup');await hooks?.done;await rm(root,{recursive:true,force:true});}
});
