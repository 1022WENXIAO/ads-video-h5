import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getModelConfig } from '../server/modelRegistry';
import { runLessonWorkflow } from '../server/lessonWorkflow';
import { createAudioUnderstanding } from '../server/audioUnderstanding';
import { renderPlan } from '../server/core';
import { reviewRender } from '../server/renderReview';
import { runWithJobSignal } from '../server/jobExecution';
import { executionDiagnostics, traceValue } from '../server/toolTrace';
import { initialEvaluationCases } from '../server/evaluationCases';
import { validateHotBrief } from '../server/hotResearch';
import type { MediaItem, WorkflowEvent } from '../src/types';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),value=(flag:string)=>args.includes(flag)?args[args.indexOf(flag)+1]:undefined;
if(!args.includes('--live')||args.includes('--help')){
  console.log('pnpm eval:production --live --case case-id [--model registry-id] [--through script|movie] [--resume checkpoint-directory | --research verified-research.json] [--redraw] [--requested-at original-ISO-time] --out report.json\nRuns the actual production workflow and, in movie mode, real audio recognition, HTML scenes, FFmpeg rendering and independent review. --resume reuses an unchanged checkpoint. --research starts authoring from common verified news evidence and records its hash; no new search is claimed. News freshness is enforced. --redraw reuses hash-verified speech to rebuild visuals, render and review after a renderer change; it does not claim a fresh search or voice generation. This is direct workflow integration, not browser or deployed-server acceptance.');process.exit(args.includes('--help')?0:1);
}
const through=value('--through')||'movie';if(!['script','movie'].includes(through))throw new Error('Invalid --through');
const fixture=JSON.parse(await readFile(path.join(root,'tests/fixtures/workflow-entry.json'),'utf8')) as {cases:{id:string;prompt:string}[]};
fixture.cases.push(...initialEvaluationCases().filter(c=>c.messages.length===1&&c.category!=='multi-video').map(c=>({id:c.id,prompt:c.messages[0]})));
const selected=fixture.cases.find(c=>c.id===value('--case'));if(!selected)throw new Error('Specify a valid --case');
if(args.includes('--redraw')&&(!value('--resume')||through!=='movie'))throw new Error('--redraw requires --resume in movie mode');
const id=value('--model')||'ark-text',config=await getModelConfig('text',id),audioConfig=await getModelConfig('audio');
if(!config)throw new Error('Requested text model is unavailable');
const out=path.resolve(value('--out')||path.join(root,'data/production-evaluations',Date.now()+'.json'));
const directory=out.replace(/\.json$/,'')+'-runs',mediaDir=path.join(directory,'media'),exportDir=path.join(directory,'exports');
await mkdir(mediaDir,{recursive:true});await mkdir(exportDir,{recursive:true});
const checkpointKey=id+'-'+selected.id,work=path.join(directory,'lesson-workflows',checkpointKey);
if(value('--resume')&&value('--research'))throw new Error('Choose --resume or --research');
if(value('--resume')&&path.resolve(value('--resume')!)!==work)await cp(path.resolve(value('--resume')!),work,{recursive:true,errorOnExist:true,force:false});
let inputResearch:unknown;
if(value('--research')){
  const bytes=await readFile(path.resolve(value('--research')!)),research=JSON.parse(bytes.toString());
  if(!research.current?.topics?.length)throw new Error('Common evidence must contain actual verified news topics');
  validateHotBrief(research.current.topics,research.references,research.current.signals);
  await mkdir(work,{recursive:true});
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'workflow-entry-evaluation',prompt:selected.prompt,export:through==='movie'})).digest('hex');
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint,phase:'budget',research,researchRounds:1}),{flag:'wx',mode:0o600});
  inputResearch={path:path.resolve(value('--research')!),hash:createHash('sha256').update(bytes).digest('hex'),asOf:research.current.asOf,scope:'Common previously verified research, not a new search in this evaluation.'};
}
const implementation=createHash('sha256');
for(const file of ['server/workflowDriver.ts','server/creationBrief.ts','server/creativeResearch.ts','server/lessonResearch.ts','server/narrativeWorkflow.ts','server/editorialWorkflow.ts','server/lessonAudio.ts','server/audioUnderstanding.ts','server/audioQuality.ts','server/lessonWorkflow.ts','server/lessonAcceptance.ts','server/hotResearch.ts','server/hotSources.ts','server/newsPage.ts','server/publicResearch.ts','server/narrativeResearch.ts','server/core.ts','server/requiredTool.ts','server/lessonSpec.ts','server/lessonScenes.ts','server/timeline.ts','server/narrativeScenes.ts','server/visualRecovery.ts','server/barChart.ts','server/taskPool.ts','shared/types.ts','server/renderReview.ts','server/reviewAudio.ts','server/reviewResults.ts','server/reviewAssets.ts','server/semanticReview.ts'])implementation.update(await readFile(path.join(root,file)));
const report:any={createdAt:new Date().toISOString(),case:selected,through,scope:'Direct production workflow integration using real providers. Browser playback and production deployment are separate acceptance checks.',revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),workingTreeDirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root}).toString().trim()),implementationHash:implementation.digest('hex'),model:{id,modelId:config.modelId},resumed:Boolean(value('--resume')),redrawn:args.includes('--redraw'),inputResearch,passed:false};
const requestedAt=value('--requested-at')?Date.parse(value('--requested-at')!):Date.parse(report.createdAt);if(!Number.isFinite(requestedAt))throw new Error('Invalid --requested-at');report.requestedAt=new Date(requestedAt).toISOString();
let media:MediaItem[]=[];
try{media=JSON.parse(await readFile(path.join(directory,'media.json'),'utf8'));}catch{}
const registeredMedia=new Map(media.map(item=>[item.id,item]));
let mediaSave=Promise.resolve();
const seen=new Map<string,string>(),started=Date.now(),controller=new AbortController();
let timedOut=false;
let interrupted=false;const stop=()=>{interrupted=true;controller.abort();};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const timer=setTimeout(()=>{timedOut=true;controller.abort();},30*60000),understanding=createAudioUnderstanding(directory);
const save=()=>writeFile(out,JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
  const result=await runWithJobSignal(controller.signal,()=>runLessonWorkflow({prompt:selected.prompt,requestedAt,config,audioConfig,media,dataDir:directory,mediaDir,ownerId:'workflow-entry-evaluation',checkpointKey,export:through==='movie',rebuildScenes:args.includes('--redraw'),
    analyze:(item,file,options)=>understanding.analyze(item,file,undefined,options),register:async item=>{
      registeredMedia.set(item.id,item);
      const snapshot=JSON.stringify([...registeredMedia.values()],null,2);
      mediaSave=mediaSave.then(()=>writeFile(path.join(directory,'media.json'),snapshot,{mode:0o600}));
      await mediaSave;
    },
    persist:plan=>writeFile(path.join(directory,'plan.json'),JSON.stringify(plan,null,2),{mode:0o600}),
    saveDraft:draft=>writeFile(path.join(directory,'script.json'),JSON.stringify(draft,null,2),{mode:0o600}),
    progress:async events=>{
      report.workflow=structuredClone(events);report.diagnostics=executionDiagnostics(events);
      for(const e of events)if(e.callId&&seen.get(e.callId)!==e.status){seen.set(e.callId,e.status);console.log(JSON.stringify({tool:e.tool,stage:e.stage,status:e.status,...(e.detail?{detail:e.detail}: {})}));}
      await save();
    },stage:async stage=>{report.stage=stage;await save();},
    render:(plan,bgm)=>renderPlan(plan,media,mediaDir,exportDir,undefined,bgm),
    review:(file,plan)=>reviewRender(file,plan,media,selected.prompt+'，字幕和声音一致性检查',undefined,requestedAt)
  }));
  report.passed=Boolean(result.report.factReview&&!result.report.factReview.needsRepair&&(through==='script'||result.review?.status==='passed'));
  report.factReview=result.report.factReview;report.review=result.review;report.rendered=result.rendered;
  report.research={asOf:result.report.hotResearch?.asOf,topics:result.report.hotResearch?.topics,references:result.report.references};
  await writeFile(path.join(directory,'media.json'),JSON.stringify(media,null,2),{mode:0o600});
}catch(error){report.timedOut=timedOut;report.interrupted=interrupted;report.error=timedOut?'真实集成评测超过30分钟，已停止本次测试并保留检查点。':interrupted?'评测由控制端停止，已保留检查点；本次未完成验收。':traceValue(error instanceof Error?error.message:String(error),[config.apiKey,audioConfig?.apiKey||'']);}
finally{clearTimeout(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);report.elapsedMs=Date.now()-started;await save();}
console.log(JSON.stringify({passed:report.passed,error:report.error,review:report.review,rendered:report.rendered,elapsedMs:report.elapsedMs}));
if(!report.passed)process.exitCode=1;
