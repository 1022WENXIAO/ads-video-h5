import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,access,rm,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {defoldEnvironment} from '../server/defoldRuntime';
const engine=await defoldEnvironment();
test('real chat queue binds its delivery plan and cancels a superseded task before publication',{skip:!engine.available,timeout:180000},async()=>{
 const data=await mkdtemp(path.join(os.tmpdir(),'reliability-api-')),token=randomBytes(32).toString('hex');
 await writeFile(path.join(data,'auth.json'),JSON.stringify({users:[{id:'reliability-qa',email:'qa@example.invalid',displayName:'QA',createdAt:new Date().toISOString()}],sessions:[{userId:'reliability-qa',tokenHash:createHash('sha256').update(token).digest('hex'),expiresAt:Date.now()+300000}],verifications:[]}),{mode:0o600});
 const reserve=createServer();await new Promise<void>(r=>reserve.listen(0,'127.0.0.1',r));const port=(reserve.address() as any).port;await new Promise<void>(r=>reserve.close(()=>r()));
 const child=spawn(process.execPath,['--import','tsx','tests/fixtures/reliabilityProvider.mts'],{cwd:process.cwd(),env:{...process.env,QINGJIAN_DATA_DIR:data,QINGJIAN_RELEASE_EVAL_STARTUP:'0',PORT:String(port)},stdio:['ignore','pipe','pipe']});let logs='';child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 const origin='http://127.0.0.1:'+port,headers={cookie:'qingjian_session='+token,'content-type':'application/json'};
 const call=async(p:string,body?:unknown)=>{const response=await fetch(origin+p,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 const poll=async<T>(fn:()=>Promise<T|undefined>,timeout=90000)=>{const start=Date.now();while(Date.now()-start<timeout){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,200));}throw Error('Integration deadline exceeded');};
 const done=(id:string)=>poll(async()=>{const r=await call('/api/jobs/'+id);return ['succeeded','failed'].includes(r.body.status)?r.body:undefined;});
 const output=path.resolve('data/agent-audits/20261103-reliability');
 try{
  let state:any=await poll(async()=>{try{const r=await call('/api/state');return r.status===200?r.body:undefined;}catch{return undefined;}});const sessionId=state.activeSessionId;
  const start=await call('/api/chat',{sessionId,message:'@Defold游戏 制作默认接落球游戏，不要口播。'});assert.equal(start.status,200);const firstId=start.body.jobs.at(-1).id,first=await done(firstId);assert.equal(first.status,'succeeded',first.error);
  state=(await call('/api/state')).body;const artifact=state.artifacts.find((a:any)=>a.id===first.artifactId);assert(artifact.creative.artifactHash);
  const playable=await call(artifact.url);assert.equal(playable.status,200);assert.equal((await fetch(origin+playable.body.url)).status,200);assert.equal((await fetch(origin+artifact.url)).status,401);
  const record=await call('/api/jobs/'+firstId+'/runtime');assert.equal(record.status,200);assert(record.body.plan.every((step:any)=>step.status==='passed'));assert(record.body.evidence.requirementsReviewed);assert.equal(record.body.evidence.userAccepted,false);assert.equal((await fetch(origin+'/api/jobs/'+firstId+'/runtime')).status,401);
  const slow=await call('/api/chat',{sessionId,message:'@Defold游戏 制作一个慢速默认接落球游戏，不要口播。'}),oldId=slow.body.jobs.at(-1).id;
  await poll(()=>access(path.join(data,'provider-held')).then(()=>true,()=>undefined));
  const changed=await call('/api/chat',{sessionId,message:'修改为默认接落球游戏，保持不要口播。'}),newId=changed.body.jobs.at(-1).id,last=await done(newId);assert.equal(last.status,'succeeded',last.error);
  const old=(await call('/api/jobs/'+oldId)).body;assert.equal(old.status,'cancelled');assert.equal(old.cancelReason,'superseded');assert.equal(old.artifactId,undefined);assert.equal(last.taskSpec.revision,2);assert.equal((await call('/api/jobs/'+oldId+'/retry',{})).status,409);
  const report={passed:true,provider:'local deterministic fixture',paidRequests:0,nativeDefold:true,initialJob:firstId,revisedJob:newId,supersededJob:oldId,allPlanStepsPassed:true,artifactDigestBound:true,oldRunCannotPublishOrRetry:true,privateRuntimeAnonymous:401};
  await mkdir(output,{recursive:true});await writeFile(path.join(output,'api-integration.json'),JSON.stringify(report,null,2));
 }finally{
  if(child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}
  await mkdir(output,{recursive:true});await writeFile(path.join(output,'api.log'),logs);await rm(data,{recursive:true,force:true});
 }
});
