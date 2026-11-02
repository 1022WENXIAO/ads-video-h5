import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdminAuth } from '../server/adminAuth';
import { mountTemplateTestRoutes } from '../server/templateTestRoutes';
import { loadVideoTemplates } from '../server/videoTemplates';
import type { Job } from '../shared/types';

test('admin one-click template tests require admin auth, serialize execution and retain restart-readable job references',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'qj-template-routes-')),jobs:Job[]=[];
  const app=express();app.use(express.json());const auth=createAdminAuth(directory,{initialPassword:'QA-template-initial-123'});await auth.load();auth.mount(app);
  const templates=await loadVideoTemplates();let dispatched=0;
  await mountTemplateTestRoutes(app,{dataDir:directory,templates,adminAuth:auth,
    start:async(id,prompt)=>{const session={id:'s-'+id,ownerId:'evaluation:template:'+id,title:prompt,modelId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),messages:[],plan:null};const job:Job={id:'j-'+id,sessionId:session.id,messageId:'m-'+id,ownerId:session.ownerId,kind:'export',status:'queued',createdAt:session.createdAt,updatedAt:session.updatedAt};jobs.push(job);return {session,job};},
    job:id=>jobs.find(j=>j.id===id),artifact:()=>undefined,asset:()=>undefined,
    stop:async(sessionId,ownerId)=>{const job=jobs.find(j=>j.sessionId===sessionId&&j.ownerId===ownerId);if(job)job.status='cancelled';},dispatch:()=>{dispatched++;},
  });
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/admin`;
  async function call(url:string,body?:unknown,token='') {const r=await fetch(base+url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json() as any};}
  try{
    assert.equal((await call('/templates')).status,401);assert.equal((await call('/templates/animated-science-video/tests/llm-prompt/run',{})).status,401);
    const first=await call('/auth/login',{username:'admin',password:'QA-template-initial-123'});
    const changed=await fetch(base+'/auth/password',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+first.body.token},body:JSON.stringify({password:'QA-template-initial-123',newPassword:'QA-template-personal-456'})});assert.equal(changed.status,200);const {token}=await changed.json() as any;
    const catalog=await call('/templates',undefined,token);assert.equal(catalog.status,200);assert.equal(catalog.body.templates[0].testCases[0].prompt,'@动态图科普视频 制作一个LLM Prompt的原理视频');assert.ok(!JSON.stringify(catalog).includes(directory));
    assert.equal((await call('/templates/animated-science-video/tests/unknown/run',{},token)).status,404);assert.equal(jobs.length,0);
    const start=await call('/templates/animated-science-video/tests/llm-prompt/run',{},token);assert.equal(start.status,202);assert.equal(start.body.run.status,'queued');assert.equal(dispatched,1);
    assert.equal((await call('/templates/animated-science-video/tests/llm-prompt/run',{},token)).status,409);assert.equal(jobs.length,1);
    const list=await call('/template-tests',undefined,token);assert.equal(list.body.runs[0].jobId,jobs[0].id);
    const saved=JSON.parse(await readFile(path.join(directory,'template-tests/index.json'),'utf8'));assert.equal(saved[0].jobId,jobs[0].id);assert.ok(saved[0].template.skillHash);
    const stop=await call('/template-tests/'+start.body.run.id+'/stop',{},token);assert.equal(stop.body.run.status,'cancelled');
    assert.equal((await call('/template-tests/'+start.body.run.id+'/assets/video',undefined,token)).status,404);
    assert.equal((await call('/templates/animated-science-video/tests/llm-prompt/run',{},token)).status,202);assert.equal(jobs.length,2);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
