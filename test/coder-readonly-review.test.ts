import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readonlyReview } from '../src/coders/readonly-review.js';
import { codexCommandRequest } from '../src/coders/normalize.js';
import { taskPermissions } from '../src/coders/permissions.js';
import type { TaskRecord } from '../src/coders/types.js';

test('deterministic reads allow only explicit project files with an OS program and no extra grants', {skip:process.platform !== 'linux'}, async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'nexus-readonly-'));
 try {
  await writeFile(join(cwd,'source.txt'),'fixture');await writeFile(join(cwd,'.env'),'fixture');
  await symlink('/etc/passwd',join(cwd,'outside'));
  const task={id:'test',cwd,permissions:await taskPermissions(cwd,[cwd],'codex',undefined,60,[],true,'standard')} as TaskRecord;
  const check=(command:string,raw:Record<string,unknown>={},env:NodeJS.ProcessEnv={})=>readonlyReview(task,codexCommandRequest({command,cwd,...raw},cwd),env);
  assert.equal((await check('/usr/bin/cat source.txt'))?.safe,true);
  assert.equal((await check('/usr/bin/head -n 20 source.txt'))?.safe,true);
  for(const command of ['cat source.txt','/usr/bin/cat .','/usr/bin/cat .env','/usr/bin/cat outside','/usr/bin/cat /etc/passwd','/usr/bin/cat source.txt > out','/usr/bin/cat source.txt; touch out','/usr/bin/cat $(touch out)','/usr/bin/cat -','/usr/bin/head --follow source.txt','bash -c "/usr/bin/cat source.txt"'])assert.equal(await check(command),undefined,command);
  for(const raw of [{env:{}},{additionalPermissions:{}},{reason:'outside sandbox'},{unknownGrant:true}])assert.equal(await check('/usr/bin/cat source.txt',raw),undefined);
  assert.equal(await check('/usr/bin/cat source.txt',{}, {LD_PRELOAD:'/tmp/library.so'}),undefined);
  if (await lstat('/usr/bin/rg').then(()=>true,()=>false)) {
   assert.equal((await check("/usr/bin/rg --no-config -n -- 'const key' source.txt"))?.safe,true);
   for(const cmd of ['rg -n key source.txt','/usr/bin/rg key source.txt','/usr/bin/rg --no-config --pre script -- key source.txt','/usr/bin/rg --no-config -- key .','/usr/bin/rg --no-config -- key outside'])assert.equal(await check(cmd),undefined,cmd);
  }
  task.permissions!.reviewPolicy={commands:'auto',files:'auto',network:'auto',instructions:'Ask for every read'};
  assert.equal(await check('/usr/bin/cat source.txt'),undefined);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
