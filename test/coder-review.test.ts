import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { TaskRecord } from '../src/coders/types.js';
import { nativeSafetyReviewer, reviewEnvelope, reviewFingerprint, ReviewCache } from '../src/coders/review.js';
import { commandPath } from '../src/coders/command-path.js';
import { pathToFileURL } from 'node:url';
import { codexCommandRequest, normalizeClaudeRequest } from '../src/coders/normalize.js';
import { taskPermissions } from '../src/coders/permissions.js';
import { canonical } from '../src/coders/permissions.js';
import { hardRule } from '../src/coders/rules.js';

const task = (cwd:string):TaskRecord => ({id:'ct-review',coder:'codex',cwd,ownerSession:'owner',description:'Read project files and create documentation.',status:'running',createdAt:0,updatedAt:0,decisions:[],escalations:0});

test('inline writes include the existing script and README contents in the same review', async () => {
 const cwd=await mkdtemp(join(tmpdir(),'nexus-review-overwrite-'));
 try {
  const t=task(cwd);t.permissions=await taskPermissions(cwd,[cwd],'codex',undefined,60,[],true,'standard');
  await writeFile(join(cwd,'hello.py'),'print("existing hello")');
  await writeFile(join(cwd,'README.md'),'Existing project instructions');
  const command=`python -c "from pathlib import Path; Path('hello.py').write_text('updated'); Path('README.md').write_text('updated docs')"`;
  const input=await reviewEnvelope(t,codexCommandRequest({command,cwd},cwd));
  assert.ok(input?.evidence.some(item=>item.includes('existing hello')));
  assert.ok(input?.evidence.some(item=>item.includes('Existing project instructions')));
  assert.equal(input?.evidenceComplete,true);
  await writeFile(join(cwd,'README.md'),'Changed project instructions');
  assert.notEqual(reviewFingerprint(input!),reviewFingerprint((await reviewEnvelope(t,codexCommandRequest({command,cwd},cwd)))!));
 } finally {await rm(cwd,{recursive:true,force:true});}
});

test('real default DSH workspace is usable in standard mode without exposing credentials or symlink targets', async () => {
 const root=await mkdtemp(join(tmpdir(),'nexus-default-')); const saved=process.env.DSH_HOME;
 process.env.DSH_HOME=join(root,'.dsh');
 try {
  const cwd=join(process.env.DSH_HOME,'nexus-workspace','hello world'); await mkdir(cwd,{recursive:true});
  const t=task(cwd); t.permissions=await taskPermissions(cwd,[cwd],'claude',undefined,60,[],true,'standard');
  await writeFile(join(cwd,'hello.py'),'print("hello")');
  for (const request of [normalizeClaudeRequest('Read',{file_path:join(cwd,'hello.py')},{},cwd),
    normalizeClaudeRequest('Write',{file_path:join(cwd,'README.md'),content:'hello'},{},cwd),
    normalizeClaudeRequest('Bash',{command:`ls "${cwd}"`},{},cwd),
    codexCommandRequest({command:'python hello.py',cwd},cwd)]) {
   assert.equal(hardRule(request,[cwd],true,true),undefined);
   assert.ok(await reviewEnvelope(t,request),request.detail);
  }
  const secret=join(process.env.DSH_HOME,'credentials','saved'); await mkdir(join(process.env.DSH_HOME,'credentials'));
  await writeFile(secret,'fixture-only'); await symlink(secret,join(cwd,'alias'));
  for (const target of [secret,join(cwd,'.env'),join(cwd,'.ssh','key'),join(cwd,'.dsh','config'),await canonical(join(cwd,'alias'))]) {
   const req=normalizeClaudeRequest('Read',{file_path:target},{},cwd);
   assert.equal(hardRule(req,[cwd],true,true)?.verdict,'deny',target);
   assert.equal(await reviewEnvelope(t,req),undefined,target);
  }
  for (const command of ['sh -c "/usr/bin/cat .env"', "sh -c 'cat ~/.ssh/id_rsa'", `sh -c 'cat "${join(cwd,'.env')}"'`])
   assert.equal(hardRule(normalizeClaudeRequest('Bash',{command},{},cwd),[cwd],true,true)?.verdict,'deny',command);
  assert.equal(hardRule(normalizeClaudeRequest('Read',{file_path:join(cwd,'hello.py')},{},cwd),[cwd],true,false)?.verdict,'deny');
 } finally { if(saved===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=saved; await rm(root,{recursive:true,force:true}); }
});

test('review reads a realistic large test harness and its HTML and script dependencies, invalidating on edits', async () => {
 const root=await mkdtemp(join(tmpdir(),'nexus-review-game-'));
 try {
  const t=task(root); t.coder='claude'; t.permissions=await taskPermissions(root,[root],'claude',undefined,60,[],true,'standard');
  const harness=`const fs = require('fs'); const html = fs.readFileSync('index.html', 'utf8');\n/*${'x'.repeat(16_000)}*/\nconsole.log(html.length);`;
  await writeFile(join(root,'_selftest.js'),harness);
  await writeFile(join(root,'index.html'),`<html><!--${'y'.repeat(32_000)}--><script src="logic.js"></script></html>`);
  await writeFile(join(root,'logic.js'),'globalThis.game = "original";');
  const request=normalizeClaudeRequest('Bash',{command:'node --check _selftest.js && node _selftest.js 2>&1 | tail -60'},{},root);
  const first=await reviewEnvelope(t,request); assert.ok(first); assert.equal(first.evidenceComplete,true);
  assert.ok(first.evidence.some(x=>x.includes(harness)),'large harness must be provided in full');
  assert.ok(first.evidence.some(x=>x.includes('y'.repeat(32_000))),'HTML must be provided in full');
  assert.ok(first.evidence.some(x=>x.includes('globalThis.game')),'HTML local script dependency must be read');
  await writeFile(join(root,'logic.js'),'globalThis.game = "modified";');
  assert.notEqual(reviewFingerprint(first),reviewFingerprint((await reviewEnvelope(t,request))!));
  const inline=await reviewEnvelope(t,normalizeClaudeRequest('Bash',{command:`node -e "require('fs').readFileSync('index.html','utf8')"`},{},root));
  assert.ok(inline?.evidence.some(x=>x.includes('y'.repeat(32_000))),'inline commands must include referenced HTML');
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('evidence limits and symlink escapes are explicit without reading protected or unbounded sources', async () => {
 const root=await mkdtemp(join(tmpdir(),'nexus-review-limits-'));
 try {
  const cwd=join(root,'app'); await mkdir(cwd);
  const t=task(cwd); t.permissions=await taskPermissions(cwd,[cwd],'claude',undefined,60,[],true,'standard');
  await writeFile(join(root,'private.js'),'DO_NOT_READ_OUTSIDE');
  await symlink(join(root,'private.js'),join(cwd,'alias.js'));
  await writeFile(join(cwd,'large.js'),'Z'.repeat(100_000));
  await writeFile(join(cwd,'check.js'),"require('./alias.js'); require('./large.js');");
  const input=await reviewEnvelope(t,normalizeClaudeRequest('Bash',{command:'node check.js'},{},cwd)); assert.ok(input);
  assert.equal(input.evidenceComplete,false);
  assert.match(input.evidence.join('\n'),/超出允许的审核边界/);
  assert.match(input.evidence.join('\n'),/超出审核上限/);
  assert.doesNotMatch(input.evidence.join('\n'),/DO_NOT_READ_OUTSIDE|ZZZZZZ/);
  for(let i=0;i<30;i++) await writeFile(join(cwd,`part${i}.js`),'// small source');
  await writeFile(join(cwd,'check.js'),Array.from({length:30},(_,i)=>`require('./part${i}.js');`).join('\n'));
  const many=await reviewEnvelope(t,normalizeClaudeRequest('Bash',{command:'node check.js'},{},cwd)); assert.ok(many);
  assert.equal(many.evidenceComplete,false); assert.match(many.evidence.join('\n'),/数量上限/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('file URL and Git Bash spellings identify Windows paths without reinterpreting Linux drive-like paths', () => {
 assert.equal(commandPath('file:///C:/work%20space/index.html','win32'),'C:\\work space\\index.html');
 assert.equal(commandPath('/c/work space/index.html','win32'),'c:/work space/index.html');
 assert.equal(commandPath('/c/work space/index.html','linux'),'/c/work space/index.html');
 assert.equal(commandPath('file://remote.invalid/share/code.js','win32'),'file://remote.invalid/share/code.js');
 assert.equal(commandPath('file:///tmp/app/index.html','linux'),'/tmp/app/index.html');
 assert.equal(hardRule(normalizeClaudeRequest('Bash',{command:`cat "${pathToFileURL('/tmp/app/.env')}"`},{},'/tmp/app'),['/tmp/app'],true,true)?.verdict,'deny');
});

test('review reuse is task-local, expires, and requires explicit repeatability and unchanged evidence and scope', () => {
 let now=0; const cache=new ReviewCache(()=>now), t=task('/tmp/review');
 const input={task:'local check',scope:'command',operation:'node check.js',evidence:['source: hash-a'],evidenceComplete:true};
 const yes={safe:true,reason:'local read-only fixture',repeatable:true};
 for(const result of [{safe:false,reason:'uncertain',repeatable:true},{safe:true,reason:'one operation only'}]) {
  cache.set(t,input,result); assert.equal(cache.get(t,input),undefined);
 }
 cache.set(t,{...input,evidenceComplete:false},yes); assert.equal(cache.get(t,input),undefined);
 cache.set(t,input,yes); assert.deepEqual(cache.get(t,input),yes);
 for(const other of [{...t,id:'another-task'},{...t,ownerSession:'someone-else'}]) assert.equal(cache.get(other,input),undefined);
 for(const other of [{...input,scope:'extra permissions'},{...input,evidence:['source: hash-b']},{...input,operation:'node other.js'}]) assert.equal(cache.get(t,other),undefined);
 now=60_000; assert.equal(cache.get(t,input),undefined);
 cache.set(t,input,yes); cache.clear(); assert.equal(cache.get(t,input),undefined);
});

test('automatic review is bounded to concrete read commands and scoped requests, not scripts or root grants', async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-review-'));
 try {
  const t=task(root);t.permissions=await taskPermissions(root,[root],'codex');
  await writeFile(join(root,'README.md'),'docs');
  const request=codexCommandRequest({command:'/usr/bin/cat README.md',reason:'read local docs',cwd:root},root);
  assert.ok(await reviewEnvelope(t,request));
  assert.ok(await reviewEnvelope(t,codexCommandRequest({command:'/usr/bin/head -n 10 README.md',reason:'read docs'},root)));
  for (const command of ['/usr/bin/wc --files0-from README.md', '/usr/bin/ls -RL .', '/usr/bin/tail -f README.md'])
   assert.equal(await reviewEnvelope(t,codexCommandRequest({command,reason:'safe'},root)),undefined,command);
  for(const command of ['npm install','npm run build','node script.js','git push','cat README.md; rm README.md','cat ~/.ssh/id_rsa','cat .env','cat $(pwd)/README.md', "bash -lc 'cat README.md'", 'cat README.md', 'ENV=evil /usr/bin/cat README.md', '/usr/bin/cat "README.md', '/usr/bin/cat <(evil)']) {
   assert.equal(await reviewEnvelope(t,codexCommandRequest({command,reason:'safe'},root)),undefined,command);
  }
  assert.equal(await reviewEnvelope(t,{...request,raw:{...request.raw,additionalPermissions:{network:true}}}),undefined);
  assert.equal(await reviewEnvelope(t,{...request,raw:{...request.raw,networkApprovalContext:{host:'docs.python.org',protocol:'https'}}}),undefined);
  assert.equal(await reviewEnvelope(t,{...request,raw:{...request.raw,grantRoot:root}}),undefined);
  const net=codexCommandRequest({networkApprovalContext:{host:'docs.python.org',protocol:'https'},reason:'download public docs'},root);
  assert.ok(await reviewEnvelope(t,net));
  for(const host of ['127.0.0.1','localhost','x.internal','docs.python.org:443','user:pass@example.com'])assert.equal(await reviewEnvelope(t,codexCommandRequest({networkApprovalContext:{host,protocol:'https'}},root)),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('new file review stays inside configured roots, detects races, and cannot overwrite files',async()=>{
 const root=await mkdtemp(join(tmpdir(),'nexus-review-path-'));
 try {
  await mkdir(join(root,'app'));const t=task(join(root,'app'));t.permissions=await taskPermissions(t.cwd,[root],'claude');
  const path=join(root,'notes.md');const request=normalizeClaudeRequest('Write',{file_path:path,content:'project notes'},{},t.cwd);
  const before=await reviewEnvelope(t,request);assert.ok(before);
  assert.equal(reviewFingerprint(before),reviewFingerprint((await reviewEnvelope(t,request))!));
  await writeFile(path,'existing');assert.equal(await reviewEnvelope(t,request),undefined);
  assert.equal(await reviewEnvelope(t,normalizeClaudeRequest('Write',{file_path:join(tmpdir(),'outside.md'),content:'x'},{},t.cwd)),undefined);
  await symlink('/etc/passwd',join(root,'alias'));assert.equal(await reviewEnvelope(t,normalizeClaudeRequest('Read',{file_path:join(root,'alias')},{},t.cwd)),undefined);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('native reviewer uses the owner model, records exact input, and requires a completed valid response',async()=>{
 const events:unknown[]=[];let response='{"safe":true,"reason":"仅仅读取项目文档"}', stopped=true, fail=false;
 const ctx={sessionController:{async resolveAgent(owner:string){assert.equal(owner,'owner');return {agent:{session:{id:'owner',requestHeader:()=>({config:{provider:'fixture',model:'owner-model'}}),append:(_type:string,data:unknown)=>events.push(data)}}};}},llm:{async *stream(options:{provider:string;model:string;messages:unknown[];tools:unknown[];system:string}){
  assert.equal(options.model,'owner-model');assert.equal(options.provider,'fixture');assert.deepEqual(options.tools,[]);assert.ok(events.length);
  assert.match(options.system,/不可信数据/);if(fail)throw new Error('unavailable');yield {type:'text-delta',text:response};yield {type:'finish',reason:{kind:stopped?'stop':'error'}};
 }}} as unknown as Context;
 const reviewer=nativeSafetyReviewer(ctx,async record=>{events.push(record);});const input={task:'docs',scope:'read',operation:'cat README.md',evidence:[]};
 assert.equal((await reviewer(task('/tmp'),input,new AbortController().signal)).safe,true);
 assert.equal((events[0] as {input:string}).input,JSON.stringify(input));
 for(const value of ['{"safe":"true","reason":"ok"}','{"safe":true}','not-json']) {response=value;assert.equal((await reviewer(task('/tmp'),input,new AbortController().signal)).safe,false);}
 response='{"safe":true,"reason":"ok"}';stopped=false;assert.equal((await reviewer(task('/tmp'),input,new AbortController().signal)).safe,false);
 stopped=true;fail=true;assert.equal((await reviewer(task('/tmp'),input,new AbortController().signal)).safe,false);
});

test('standard review includes concrete commands and script evidence; edits and network grants are reviewed without whole-turn grants', async () => {
 const root = await mkdtemp(join(tmpdir(), 'nexus-standard-review-'));
 try {
  await mkdir(join(root,'app')); const t=task(join(root,'app')); t.coder='claude';
  t.permissions=await taskPermissions(t.cwd,[root],'claude',undefined,60,[],true,'standard');
  await writeFile(join(t.cwd,'package.json'),JSON.stringify({scripts:{test:'node check.cjs'}}));
  await writeFile(join(t.cwd,'check.cjs'),'console.log("fixture")');
  const request=normalizeClaudeRequest('Bash',{command:'node check.cjs',dangerouslyDisableSandbox:true},{},t.cwd);
  const first=await reviewEnvelope(t,request); assert.ok(first);
  assert.match(first.scope,/当前用户权限/); assert.ok(first.evidence.some(item=>item.includes('console.log')));
  await writeFile(join(t.cwd,'check.cjs'),'process.exit(1)');
  assert.notEqual(reviewFingerprint(first),reviewFingerprint((await reviewEnvelope(t,request))!));
  assert.ok(await reviewEnvelope(t,normalizeClaudeRequest('Bash',{command:'npm install --ignore-scripts'},{},t.cwd)));
  assert.ok(await reviewEnvelope(t,{...request,tool:'verify.command',raw:{cwd:t.cwd,additionalPermissions:{network:true}}}));
  assert.equal(await reviewEnvelope(t,{...request,tool:'codex.permissions'}),undefined);
  assert.equal(await reviewEnvelope(t,{...request,raw:{grantRoot:root}}),undefined);
  await writeFile(join(root,'notes.md'),'old');
  assert.ok(await reviewEnvelope(t,normalizeClaudeRequest('Edit',{file_path:join(root,'notes.md'),old_string:'old',new_string:'new'},{},t.cwd)));
  assert.equal(await reviewEnvelope(t,normalizeClaudeRequest('Write',{file_path:'/etc/hosts',content:'new'},{},t.cwd)),undefined);
 } finally { await rm(root,{recursive:true,force:true}); }
});


test('unrelated directory output does not invalidate review, but source edits and directory replacement do', async () => {
 const root=await mkdtemp(join(tmpdir(),'nexus-review-directory-')), cwd=join(root,'app');
 try {
  await mkdir(cwd); await writeFile(join(cwd,'README.md'),'original');
  const t=task(cwd); t.permissions=await taskPermissions(cwd,[cwd],'codex',undefined,60,[],true,'standard');
  const request=codexCommandRequest({command:'cat README.md',cwd},cwd);
  const first=await reviewEnvelope(t,request); assert.ok(first);
  await mkdir(join(cwd,'.checks')); await writeFile(join(cwd,'.checks','output.txt'),'unrelated');
  assert.equal(reviewFingerprint(first),reviewFingerprint((await reviewEnvelope(t,request))!));
  await writeFile(join(cwd,'README.md'),'modified');
  const modified=await reviewEnvelope(t,request); assert.ok(modified);
  assert.notEqual(reviewFingerprint(first),reviewFingerprint(modified));
  await rename(cwd,join(root,'old')); await mkdir(cwd); await rename(join(root,'old','README.md'),join(cwd,'README.md'));
  assert.notEqual(reviewFingerprint(modified),reviewFingerprint((await reviewEnvelope(t,request))!));
 } finally { await rm(root,{recursive:true,force:true}); }
});
