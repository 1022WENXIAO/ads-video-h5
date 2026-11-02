import { Router, type Express, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Job, Session, Artifact } from '../shared/types';
import type { TemplateTestRun, TemplateSelection } from '../shared/videoTemplates';
import type { AdminAuth } from './adminAuth';
import { adminTemplate, templateSelection, type LoadedVideoTemplate } from './videoTemplates';
import { createJsonStateWriter } from './jsonStateWriter';

interface StoredRun { id:string;template:TemplateSelection;caseId:string;prompt:string;createdAt:string;sessionId:string;jobId:string }
interface Options {
  dataDir:string;templates:LoadedVideoTemplate[];adminAuth:AdminAuth;
  start:(id:string,prompt:string,modelId?:string)=>Promise<{session:Session;job:Job}>;
  job:(id:string)=>Job|undefined;
  artifact:(job:Job)=>Artifact|undefined;
  stop:(sessionId:string,ownerId:string)=>Promise<void>;
  asset:(artifact:Artifact,kind:'video'|'cover'|'project'|'report')=>string|undefined;
  preview?:(artifact:Artifact)=>string|undefined;
  dispatch:()=>void;
}
export async function mountTemplateTestRoutes(app:Express,o:Options) {
  const directory=path.join(o.dataDir,'template-tests'),file=path.join(directory,'index.json');
  await mkdir(directory,{recursive:true});let runs:StoredRun[]=[];
  try{const loaded=JSON.parse(await readFile(file,'utf8'));if(!Array.isArray(loaded)||loaded.some(r=>!r||typeof r.id!=='string'||typeof r.jobId!=='string'||typeof r.sessionId!=='string'||!r.template))throw new Error('模板测试记录损坏，已保留原文件。');runs=loaded;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const persist=createJsonStateWriter(file,()=>runs);
  const publicRun=(r:StoredRun):TemplateTestRun=>{
    const job=o.job(r.jobId),artifact=job&&o.artifact(job);
    return {...r,status:job?.status||'failed',stage:job?.stage,progress:job?.progress,error:job?.error||(!job?'运行任务已不存在。':undefined),workflow:job?.workflow,
      ...(artifact?{artifact:{kind:artifact.kind,id:artifact.id,name:artifact.name,duration:artifact.duration,technicalPassed:artifact.creative?.technicalPassed===true||artifact.template?.technicalPassed===true,userAccepted:false as const,animationMode:artifact.template?.animationMode,sourceHash:artifact.creative?.sourceHash||artifact.template?.sourceHash,motion:artifact.template?.motion}}:{})};
  };
  const find=(id:string)=>{const run=runs.find(r=>r.id===id);if(!run)throw Object.assign(new Error('模板测试记录不存在。'),{status:404});return run;};
  const respond=async(response:Response,action:()=>unknown|Promise<unknown>,status=200)=>{try{response.status(status).json(await action());}catch(error){response.status((error as {status?:number}).status||400).json({error:error instanceof Error?error.message:'模板操作失败。'});}};
  const router=Router();router.use(o.adminAuth.requireAdmin);
  router.get('/templates',(_q,r)=>r.json({templates:o.templates.map(adminTemplate)}));
  router.get('/template-tests',(_q,r)=>r.json({runs:runs.slice(-100).reverse().map(publicRun)}));
  let starting=false;
  router.post('/templates/:id/tests/:caseId/run',(q,r)=>respond(r,async()=>{
    if(starting||runs.some(run=>['queued','running','stopping'].includes(o.job(run.jobId)?.status||'')))throw Object.assign(new Error('已有模板测试正在运行，请等待完成或停止后重试。'),{status:409});
    const template=o.templates.find(t=>t.id===q.params.id),test=template?.testCases.find(t=>t.id===q.params.caseId);
    if(!template||!test)throw Object.assign(new Error('模板或测试案例不存在。'),{status:404});
    if(q.body?.modelId!==undefined&&(typeof q.body.modelId!=='string'||q.body.modelId.length>100))throw new Error('测试模型格式无效。');
    starting=true;
    try {
      const id=randomUUID(),{session,job}=await o.start(id,test.prompt,q.body?.modelId);
      const run:StoredRun={id,template:templateSelection(template),caseId:test.id,prompt:test.prompt,createdAt:new Date().toISOString(),sessionId:session.id,jobId:job.id};
      runs.push(run);
      try{await persist();}catch(error){runs=runs.filter(r=>r.id!==run.id);await o.stop(session.id,job.ownerId!);throw error;}
      o.dispatch();return {run:publicRun(run)};
    }finally{starting=false;}
  },202));
  router.post('/template-tests/:id/stop',(q,r)=>respond(r,async()=>{const run=find(q.params.id),job=o.job(run.jobId);if(job)await o.stop(run.sessionId,job.ownerId!);return {run:publicRun(run)};},202));
  router.get('/template-tests/:id/assets/:kind',async(q,r)=>{
    try{
      const run=find(q.params.id),job=o.job(run.jobId),kind=q.params.kind;
      if(!['video','cover','project','report','preview'].includes(kind))return r.status(404).json({error:'文件不存在。'});
      const artifact=job&&o.artifact(job);if(kind==='preview'){const url=artifact&&o.preview?.(artifact);return url?r.json({url}):r.status(404).json({error:'试玩尚未生成。'});}
      const file=artifact&&o.asset(artifact,kind as 'video'|'cover'|'project'|'report');
      if(!file)return r.status(404).json({error:'本次测试尚未生成该文件。'});
      if(kind==='project')r.attachment(`${artifact!.name.replace(/\.mp4$/,'')}-工程.zip`);
      else r.type(kind==='video'?'video/mp4':kind==='cover'?artifact!.coverMimeType||'image/png':'application/json');
      r.sendFile(file,error=>{if(error&&!r.headersSent)r.status(404).json({error:'测试文件不存在。'});});
    }catch(error){r.status((error as {status?:number}).status||400).json({error:error instanceof Error?error.message:'无法读取测试文件。'});}
  });
  app.use('/api/admin',router);
}
