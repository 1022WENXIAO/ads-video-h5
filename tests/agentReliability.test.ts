import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createCreativeWorkspace,creativeHash} from '../server/creativeWorkspace';
import {withAgentRuntime} from '../server/agentRuntime';
import {getAgent} from '../server/core';
import {defaultAgentCapabilities} from '../shared/agentCapabilities';
import {TEXT_MODEL_PRESETS,ARK_BASE_URL} from '../shared/textModels';
import {forkSession} from '../server/sessionFork';
import {runRequiredTool} from '../server/requiredTool';
import {spawnForJob,withExecutionDeadline,jobDelay,JobDeadlineError} from '../server/jobExecution';
import {createTaskSpec,taskContext,assertTaskRevision,priorTaskSpec} from '../server/taskContract';
import {withTaskExecution,currentTaskExecution,OutcomeUnknownError} from '../server/taskRuntime';
import {withFileLock,acquireFileLock} from '../server/durableState';
import {createJobRunner} from '../server/jobRunner';
import {verifyCreativeResearch} from '../server/creativeResearch';
import {defoldStarter} from '../server/defoldProject';
import {buildDefold,defoldEnvironment} from '../server/defoldRuntime';
import {inspectDefold} from '../server/defoldInspect';
import {artifactDigest} from '../server/artifactIntegrity';
import {createCreativePreviews} from '../server/creativePreview';
import express from 'express';
import {createServer} from 'node:http';
import {reviewCreativeCode} from '../server/creativeReview';
import {loadTaskDraft,saveTaskDraft} from '../server/taskDrafts';
import {assertScienceReceipt} from '../server/scienceWorkspace';
import {scienceProgramFixture} from './fixtures/scienceProgram';
import {codeScienceScene} from '../server/scienceCoding';
import {loadVideoTemplates} from '../server/videoTemplates';
import {creativeEditingTools} from '../server/creativeTools';
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'fixture-not-a-real-key'};
const tool=(name:string)=>({name,label:name,description:'fixture',parameters:{type:'object',properties:{}} as any,execute:async()=>({content:[{type:'text' as const,text:'ok'}]})});
const input=()=>({kind:'canvas' as const,title:'Test',entry:'main.js',files:[{path:'main.js',content:'export const main=1;'}],nodes:[]});
async function temporary(t:any){const dir=await mkdtemp(path.join(os.tmpdir(),'agent-reliability-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}

test('reviewer has a separate tool and instruction boundary even when external writes are enabled',async()=>{
 await withAgentRuntime({settings:defaultAgentCapabilities(),tools:[tool('call_mcp_tool')],instructions:'EXTERNAL_UNTRUSTED_SKILL'},async()=>{
  const reviewer=getAgent(config,[tool('submit_code_review')],'Review only',true,{role:'reviewer'});
  assert.deepEqual(reviewer.state.tools.map(t=>t.name),['submit_code_review']);assert.doesNotMatch(reviewer.state.systemPrompt,/EXTERNAL_UNTRUSTED_SKILL/);
  assert(getAgent(config,[tool('write')],'Author').state.tools.some(t=>t.name==='call_mcp_tool'));
 });
});
test('the actual model review loop rejects unverified requirements and nonexistent evidence before approval',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.deepEqual(body.tools.map((t:any)=>t.function.name),['read_review_evidence','read_review_file','submit_code_review']);calls++;
  const name=calls===1?'read_review_evidence':(calls===2||calls===4)?'read_review_file':'submit_code_review',args=calls===1?{}:(calls===2||calls===4)?{path:calls===2?'main.js':'animation.meta.json',startLine:1,endLine:1}:{approved:true,summary:'Checked current code and actual evidence',issues:[],requirementChecks:[{id:'objective',status:calls===5?'unverified':'satisfied',evidence:[calls===6?'inspection:missing':'inspection:framesChecked']}]};
  const chunk={role:'assistant',tool_calls:[{index:0,id:'review-'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}}]};
  return new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:chunk,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 };
 try{await withAgentRuntime({settings:defaultAgentCapabilities(),tools:[tool('call_mcp_tool')],instructions:'Do something else'},async()=>{const review=await reviewCreativeCode({project:{format:1,...input(),files:[...input().files,{path:'animation.meta.json',content:'{}'}],revision:1,updatedAt:'fixture'},config,request:'Validate the current program',diagnostics:[],technicalPassed:true,evidence:{framesChecked:30},progress:async()=>{}});assert.equal(review.approved,true);assert.equal(calls,7);});}finally{globalThis.fetch=original;}
});
test('historical and active forks cannot inherit future template/game/contract state',()=>{
 const source:any={id:'s',ownerId:'u',title:'A',modelId:null,createdAt:'a',updatedAt:'b',plan:null,messages:[{id:'old',role:'user',text:'Old',createdAt:'a'},{id:'new',role:'user',text:'Future',createdAt:'b'}],templateId:'defold-game',templateDraft:{title:'future'},creativeDraft:{title:'future'},taskSpec:{id:'future'},taskRevisions:{future:3},taskSpecsByTemplate:{'defold-game':{id:'future'}}};
 const fork=forkSession(source,[],'old');assert.equal(fork.messages.length,1);for(const key of ['templateId','templateDraft','creativeDraft','taskSpec','taskRevisions','taskSpecsByTemplate'])assert.equal((fork as any)[key],undefined);
});
test('independent stale workspace instances reload and cannot overwrite an accepted revision',async t=>{
 const dir=await temporary(t),a=await createCreativeWorkspace(dir);await a.initialize(input());const b=await createCreativeWorkspace(dir);
 await a.create(1,'a.js','export const a=1;');await assert.rejects(b.create(1,'b.js','export const b=1;'),/版本冲突/);
 assert(b.list().files.some(f=>f.path==='a.js'));await b.create(2,'b.js','export const b=1;');assert(a.list().files.some(f=>f.path==='b.js'));
 const first=JSON.parse(await readFile(path.join(dir,'history/2.json'),'utf8'));assert(first.files.some((f:any)=>f.path==='a.js'));
});
test('exporting a verified project exposes reads but blocks unnecessary source edits',async t=>{
 const dir=await temporary(t),workspace=await createCreativeWorkspace(dir);await workspace.initialize(input());const tools=creativeEditingTools(workspace,()=>{},()=>false);
 await assert.rejects(tools.find(t=>t.name==='create_project_file')!.execute('fixture',{expectedRevision:1,path:'new.js',content:'bad'}),/仅导出/);assert.equal(workspace.snapshot().revision,1);assert.equal((await tools.find(t=>t.name==='list_project_files')!.execute('fixture',{})).details.revision,1);
});
test('simultaneous independent workspace writers have exactly one winner',async t=>{
 const dir=await temporary(t),a=await createCreativeWorkspace(dir);await a.initialize(input());const b=await createCreativeWorkspace(dir);
 const results=await Promise.allSettled([a.create(1,'a.js','export const a=1;'),b.create(1,'b.js','export const b=1;')]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(a.snapshot().revision,2);
});
test('an uncommitted history entry from a crashed save is preserved without blocking a later revision',async t=>{
 const dir=await temporary(t),workspace=await createCreativeWorkspace(dir);await workspace.initialize(input());
 const orphan={...workspace.snapshot(),revision:2,title:'Uncommitted'};await writeFile(path.join(dir,'history/2.json'),JSON.stringify(orphan));await workspace.create(1,'accepted.js','export const accepted=1;');
 assert.equal(workspace.snapshot().revision,2);const {readdir}=await import('node:fs/promises');assert.equal((await readdir(path.join(dir,'history/orphans'))).length,1);assert.equal(JSON.parse(await readFile(path.join(dir,'history/2.json'),'utf8')).title,'Test');
});
test('a live process lock is exclusive and an exited process lock is recoverable',async t=>{
 const dir=await temporary(t),file=path.join(dir,'owner');let active=0,max=0;
 await Promise.all(Array.from({length:5},()=>withFileLock(file,async()=>{max=Math.max(max,++active);await jobDelay(10);active--;})));assert.equal(max,1);
 const script=`import {acquireFileLock} from ${JSON.stringify(new URL('../server/durableState.ts',import.meta.url).href)};await acquireFileLock(${JSON.stringify(file)});process.exit(0);`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:process.cwd(),stdio:'ignore'});assert.equal(await new Promise(r=>child.once('exit',r)),0);
 const release=await acquireFileLock(file);await release();
});
test('reading a file cannot reset repeated validation failure detection',async()=>{
 let turns=0;const agent:any={state:{tools:[tool('read'),tool('validate'),tool('finish')]},steer(){},abort(){},async prompt(){for(let i=0;i<30;i++){turns++;const fail=i%2===0,r=await this.finishTurn({message:{content:[{type:'toolCall',name:fail?'validate':'read'}]},toolResults:[{content:[{type:'text',text:fail?'Same broken reference':'File content'}],details:fail?{passed:false}:{}}]});if(r.action==='end')break;}}};
 await assert.rejects(runRequiredTool(agent,'Fix it',{name:'finish',label:'test',done:()=>false,maxTurns:30,maxRejections:3}),/重复失败/);assert.equal(turns,5);
});
test('a strict child environment does not inherit even a harmless parent canary',async()=>{
 process.env.QJ_RELIABILITY_CANARY='parent-only';try{let result='';await new Promise<void>((resolve,reject)=>{const child=spawnForJob(process.execPath,['-e',"process.stdout.write(process.env.QJ_RELIABILITY_CANARY||'absent')"],{inheritEnv:false,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});child.stdout!.on('data',b=>result+=b);child.once('error',reject);child.once('close',c=>c===0?resolve():reject(Error('child failed')));});assert.equal(result,'absent');}finally{delete process.env.QJ_RELIABILITY_CANARY;}
});
test('a parent deadline cancels nested phase work rather than just the author loop',async()=>{
 const started=Date.now();await assert.rejects(withExecutionDeadline(35,()=>withExecutionDeadline(1000,()=>jobDelay(500))),JobDeadlineError);assert(Date.now()-started<400);
});
test('early constraints remain pinned after a long conversation and superseded runs fail their guard',()=>{
 const history=[{id:'m0',role:'user',text:'全片不要口播，只用Defold。'},...Array.from({length:30},(_,i)=>({id:'m'+(i+1),role:'user',text:'讨论细节 '+i}))];
 const initial=createTaskSpec(history,'制作场景','defold-game');assert.match(taskContext(initial),/不要口播/);const next=createTaskSpec(history,'修改为紫色','defold-game',initial);assert.equal(next.id,initial.id);assert.equal(next.revision,2);assert.throws(()=>assertTaskRevision(initial,{[next.id]:next.revision}),/要求已更新/);
 assert.deepEqual(createTaskSpec(history,'生成成片','defold-game',next),next);assert.deepEqual(createTaskSpec(history,'@Defold游戏 生成成片','defold-game',next),next);
 const jobs:any[]=[{id:'j',ownerId:'u',sessionId:'s',status:'queued',taskSpec:initial}];createJobRunner().supersede(jobs,next,new Date().toISOString());assert.equal(jobs[0].status,'cancelled');assert.equal(jobs[0].cancelReason,'superseded');
});
test('an intervening conversation cannot replace the goal selected for a later template revision',()=>{
 const original=createTaskSpec([{role:'user',text:'制作场景，不要口播'}],'制作场景','defold-game');
 const session={taskSpec:createTaskSpec([],'普通问题'),taskSpecsByTemplate:{'defold-game':original}};
 const prior=priorTaskSpec(session,'defold-game')!,revised=createTaskSpec([{role:'user',text:'修改为紫色'}],'修改为紫色','defold-game',prior);
 assert.equal(revised.id,original.id);assert.equal(revised.revision,2);assert.match(taskContext(revised),/不要口播/);
 const independent=createTaskSpec([{role:'user',text:'制作另一个主题'}],'制作另一个主题','defold-game',revised);assert.notEqual(independent.id,original.id);assert.equal(independent.constraints.length,0);
});
test('drafts are isolated by goal and an older revision cannot overwrite a later saved draft',async t=>{
 const dir=await temporary(t),first=createTaskSpec([],'First','defold-game'),other=createTaskSpec([],'Other','defold-game'),draft:any={title:'first'};
 await saveTaskDraft(dir,first,draft,()=>{});await saveTaskDraft(dir,other,{title:'other'} as any,()=>{});assert.equal((await loadTaskDraft(dir,first))!.title,'first');
 const revised=createTaskSpec([{role:'user',text:'修改当前场景'}],'修改当前场景','defold-game',first);await saveTaskDraft(dir,revised,{title:'revised'} as any,()=>{});
 await assert.rejects(saveTaskDraft(dir,first,draft,()=>{}),/旧任务/);await assert.rejects(loadTaskDraft(dir,first),/版本/);assert.equal((await loadTaskDraft(dir,revised))!.title,'revised');
});
test('external writes retain confirmed receipts and unknown outcomes across a fresh runtime',async t=>{
 const directory=await temporary(t),spec=createTaskSpec([],'External action'),options={directory,spec,environmentHash:'env-1',assertCurrent(){}};let writes=0;
 await withTaskExecution(options,async()=>{const runtime=currentTaskExecution()!;const result=await runtime.external('mcp:create',{a:1,b:2},async()=>{writes++;return {id:'12345678901234567890'};});assert.equal(result.id,'12345678901234567890');await runtime.checkpoint('observed-result',result,async()=>result);await assert.rejects(runtime.external('mcp:uncertain',{},async()=>{writes++;throw Error('response lost');}),/response lost/);});
 await withTaskExecution(options,async()=>{const runtime=currentTaskExecution()!;assert.equal((await runtime.external('mcp:create',{b:2,a:1},async()=>{writes++;return {id:'duplicate'};})).id,'12345678901234567890');await assert.rejects(runtime.external('mcp:uncertain',{},async()=>{writes++;}),OutcomeUnknownError);assert.equal((await runtime.receipts()).find(r=>r.tool==='mcp:uncertain')!.status,'outcome_unknown');});assert.equal(writes,2);
 const saved=JSON.parse(await readFile(path.join(directory,'run.json'),'utf8'));assert.equal(saved.checkpoints[0].status,'completed');
});
test('global tool budgets survive restart and environment drift invalidates recovery',async t=>{
 const directory=await temporary(t),spec=createTaskSpec([],'Work'),options={directory,spec,environmentHash:'old',assertCurrent(){},maxCalls:2};await withTaskExecution(options,async()=>{await currentTaskExecution()!.consume();await currentTaskExecution()!.consume();});
 await withTaskExecution(options,async()=>{await assert.rejects(currentTaskExecution()!.consume(),/共享工具预算/);});await assert.rejects(withTaskExecution({...options,environmentHash:'changed'},async()=>{}),/环境已漂移/);
});
test('the shared wall-clock deadline does not reset when a run is reopened',async t=>{
 const directory=await temporary(t),spec=createTaskSpec([],'Work'),options={directory,spec,environmentHash:'env',assertCurrent(){},timeoutMs:1000};await withTaskExecution(options,async()=>{});await jobDelay(1100);await assert.rejects(withTaskExecution(options,async()=>{assert.fail('must not resume expired run');}),JobDeadlineError);
});
test('continuing a goal in a fresh job cannot replay its unknown external action or silently change a tool schema',async t=>{
 const directory=await temporary(t),ledgerDirectory=path.join(directory,'goal-effects'),spec=createTaskSpec([],'Work'),options={directory:directory+'/job-1',ledgerDirectory,spec,environmentHash:'env',assertCurrent(){}};let writes=0;
 await withTaskExecution(options,async()=>{await currentTaskExecution()!.observeDependency('catalog',{version:1});await assert.rejects(currentTaskExecution()!.external('write',{id:'resource'},async()=>{writes++;throw Error('lost');}),/lost/);});
 const next=createTaskSpec([{role:'user',text:'修改当前目标'}],'修改当前目标',undefined,spec);
 await withTaskExecution({...options,directory:directory+'/job-2',spec:next},async()=>{await assert.rejects(currentTaskExecution()!.external('write',{id:'resource'},async()=>{writes++;}),OutcomeUnknownError);});
 await withTaskExecution(options,async()=>{await assert.rejects(currentTaskExecution()!.observeDependency('catalog',{version:2}),/外部依赖.*变化/);});assert.equal(writes,1);
});
test('delivery checks the current goal and environment and cannot mark unreviewed requirements complete',async t=>{
 const directory=await temporary(t),spec=createTaskSpec([],'Work');let fresh=true;
 await withTaskExecution({directory,spec,environmentHash:'env',assertCurrent(){},assertEnvironment:async()=>{if(!fresh)throw Error('changed');}},async()=>{const runtime=currentTaskExecution()!;await assert.rejects(runtime.accept({projectHash:'project',technicalPassed:true,requirementsReviewed:false}),/需求审查/);fresh=false;await assert.rejects(runtime.accept({projectHash:'project',technicalPassed:true,requirementsReviewed:true}),/changed/);});
});
test('the delivery plan rejects a missing predecessor and binds all steps to one project',async t=>{
 const directory=await temporary(t),spec=createTaskSpec([],'Work');await withTaskExecution({directory,spec,environmentHash:'env',assertCurrent(){}},async()=>{
  const runtime=currentTaskExecution()!;await assert.rejects(runtime.verify('requirements','p',{approved:true}),/前置条件/);
  await runtime.verify('technical','p',{technicalPassed:true});await runtime.verify('requirements','p',{approved:true});
  const receipt=await runtime.accept({projectHash:'p',technicalPassed:true,requirementsReviewed:true});assert.equal(receipt.userAccepted,false);
  await runtime.verify('technical','new-p',{technicalPassed:true});await assert.rejects(runtime.accept({projectHash:'new-p',technicalPassed:true,requirementsReviewed:true}),/计划尚未完成/);
 });
});
test('an explicitly configured cost budget is durable and unknown usage blocks more paid requests',async t=>{
 const directory=await temporary(t),spec=createTaskSpec([],'Work'),options={directory,spec,environmentHash:'env',assertCurrent(){},maxCredits:1};
 await withTaskExecution(options,async()=>{const runtime=currentTaskExecution()!;await runtime.assertModelBudget();await runtime.recordCost('provider-request',1000000);await runtime.recordCost('provider-request',1000000);});
 await withTaskExecution(options,async()=>{await assert.rejects(currentTaskExecution()!.assertModelBudget(),/积分预算/);});
 await withTaskExecution({...options,directory:directory+'/unknown'},async()=>{await currentTaskExecution()!.recordCost('unknown');await assert.rejects(currentTaskExecution()!.assertModelBudget(),/用量尚未确认/);});
});
test('a previous verified flag cannot survive a failed source reread',async()=>{
 const raw:any={summary:'old',queries:[],references:[{id:'ref-1',url:'https://example.com/article',title:'old',excerpt:'old',verification:'primary-page'}]};await assert.rejects(verifyCreativeResearch(raw,'游戏教程',async()=>{throw Error('offline');}),/缺少.*来源/);
});
test('preview capabilities stop serving a modified attested build',async t=>{
 const dir=await temporary(t);await writeFile(path.join(dir,'index.html'),'before');const app=express(),preview=createCreativePreviews();preview.mount(app);const url=preview.issue(dir,'index.html',await artifactDigest(dir)),server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{const origin='http://127.0.0.1:'+(server.address() as any).port;assert.equal((await fetch(origin+url)).status,200);await writeFile(path.join(dir,'index.html'),'changed');assert.equal((await fetch(origin+url)).status,410);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
const engine=await defoldEnvironment();
test('a scene metadata change invalidates the approved receipt even when program source is unchanged',()=>{
 const scene=scienceProgramFixture();scene.program!.selfCheck={approved:true,sourceHash:creativeHash(scene.program!.source),sceneHash:creativeHash(scene),projectHash:'fixture',reviewedAt:'fixture'};assertScienceReceipt(scene);scene.bgm=!scene.bgm;assert.throws(()=>assertScienceReceipt(scene),/元数据已改变/);
});
test('a no-music request is applied before source validation and model self-review',async t=>{
 const directory=await temporary(t),previous=scienceProgramFixture(),[template]=await loadVideoTemplates();previous.bgm=true;const original=globalThis.fetch;globalThis.fetch=async()=>new Response('{}',{status:401});
 try{await assert.rejects(codeScienceScene({template,previous,prompt:'不要背景音乐，沿用当前画面。',config,references:previous.basis.map((url,i)=>({id:'ref-'+i,url,title:'fixture',excerpt:'fixture',verification:'primary-page',retrievedAt:'fixture'})),directory,progress:async()=>{}}),/401/);const saved=JSON.parse(await readFile(path.join(directory,'code-workspace/workspace.json'),'utf8'));assert.equal(JSON.parse(saved.files.find((f:any)=>f.path==='animation.meta.json').content).bgm,false);}finally{globalThis.fetch=original;}
});
test('native Defold rejects a stationary visible player despite moving reported coordinates',{skip:!engine.available},async t=>{
 const dir=await temporary(t),project={...await defoldStarter(),revision:1,updatedAt:'fixture'};project.files[0].content=project.files[0].content.replace('gui.set_position(self.player,vmath.vector3(self.x,80,0))','gui.set_position(self.player,vmath.vector3(480,80,0))');const build=await buildDefold(project,dir);await assert.rejects(inspectDefold(build,path.join(dir,'previews')),/画面验收失败/);
});
test('a changed compiled cache is rebuilt and cannot inherit its old technical receipt',{skip:!engine.available},async t=>{
 const dir=await temporary(t),project={...await defoldStarter(),revision:1,updatedAt:'fixture'},build=await buildDefold(project,dir),index=path.join(build.directory,build.entry);await writeFile(index,(await readFile(index,'utf8'))+'\n<!-- foreign-change -->');const next=await buildDefold(project,dir);assert.doesNotMatch(await readFile(path.join(next.directory,next.entry),'utf8'),/foreign-change/);assert.equal(next.artifactHash,await artifactDigest(next.directory));
});
