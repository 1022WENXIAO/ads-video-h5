import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {validatePlan} from '../server/core';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {JobCancelledError,runWithJobSignal,throwIfJobCancelled} from '../server/jobExecution';
import type {LessonChapter,LessonReport,AudioAnalysis,WorkflowEvent,RenderReview} from '../src/types';

// Actual P14 findings drive a controlled checkpoint/state regression. The
// placeholder media are deliberately not playable and prove no media quality.
const actual=JSON.parse(await readFile(new URL('./fixtures/p14-mixed-review.json',import.meta.url),'utf8')) as {report:LessonReport;review:RenderReview};
const config={id:'controlled',name:'controlled',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'controlled-not-a-secret',modelId:'controlled'};
const prompt='制作45秒竖屏知识图解视频，解释服务状态中的事件时间';
const canonical=(value:unknown)=>JSON.parse(JSON.stringify(value));

async function seedRendered(directory:string){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=actual.report.references.map(reference=>({...reference,title:'Controlled projection of original status source',verification:'primary-page' as const,excerpt:reference.excerpt+' 误差大小影响评分。'}));
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({
    id:'chapter-'+(i+1),role:i===0?'hook':i===1?'foundation':'recap',title:i===1?'处置进度':'误差评分'+i,goal:'区分准确陈述与来源',prerequisites:i?['chapter-'+i]:[],
    narration:i===1?actual.report.chapters[1].narration:'误差变大损失越高。'.repeat(7),reason:'先例子再比较',referenceIds:['ref-7','ref-8'],
    claims:i===1?structuredClone(actual.report.chapters[1].claims):[{text:'误差大小影响评分',referenceIds:['ref-7']}],
    visual:i===1?{kind:'timeline',takeaway:'已定位原因，正在实施修复',items:[{label:'定位原因',detail:'原因已经定位',cue:'官方已定位原因'},{label:'实施修复',detail:'修复仍在进行',cue:'根因和影响范围未披露'}]}:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]},
    mediaId:'media-'+i,duration:15,audioHash:'audio-'+i,htmlHash:'html-'+i,speechMatch:1,
  }));
  for(const chapter of chapters)chapter.cues=chapter.visual.items.map((item,i)=>({text:item.cue,start:1+i*3,end:3+i*3}));
  const report=validateLesson({workflowId:'controlled-p14-mixed',...lessonSettings(prompt),title:'处置状态的准确表达',audience:'初学者',objectives:['读懂状态进度','区分进行与完成'],arc:'先例子再状态最后归纳',chapters,references,limitations:['Controlled state regression only.'],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:'controlled-anchor',revision:0,tempo:1},factReview:{score:92,needsRepair:false,findings:[],suggestions:[]}},prompt);
  const media=report.chapters.map(chapter=>({id:chapter.mediaId!,kind:'video' as const,name:chapter.title,mimeType:'video/mp4',url:'',createdAt:'',duration:15,generation:{workflowId:report.workflowId,beatId:chapter.id,mode:'generated' as const,lineHash:hashBytes(chapter.narration),audioHash:chapter.audioHash!,htmlHash:chapter.htmlHash!,referenceHash:'controlled-anchor'},analysis:{status:'ready',duration:15,modelId:'controlled',sourceHash:'controlled',timing:'model-estimated',createdAt:'',transcript:chapter.narration,pauses:[],warnings:[],sentences:[{id:'s',start:0,end:15,text:chapter.narration,complete:true,words:[...chapter.narration].map((text,i,chars)=>({text,start:15*i/chars.length,end:15*(i+1)/chars.length}))}]} as AudioAnalysis}));
  const hashes:Record<string,string>={};
  for(const chapter of report.chapters){
    const project=path.join(work,chapter.id);await mkdir(project);const bytes=Buffer.from('CONTROLLED verified speech state '+chapter.id);
    const analysis={...structuredClone(media.find(item=>item.id===chapter.mediaId)!.analysis!),sourceHash:hashBytes(bytes)};
    for(const [name,value]of [['speech.mp3',bytes],['speech-analysis.json',JSON.stringify(analysis)]] as const){const file=path.join(project,name);await writeFile(file,value);hashes[file]=hashBytes(await readFile(file));}
  }
  const plan=validatePlan({lesson:report,format:'9:16',targetSeconds:45,summary:'处置进度的准确表达',clips:report.chapters.map((chapter,i)=>({sceneId:chapter.id,sourceId:chapter.mediaId!,start:0,end:15,purpose:i===0?'hook':i===2?'conclusion':'argument'}))},media);
  const file=path.join(directory,'original-rejected-fixture.mp4');await writeFile(file,'CONTROLLED movie identity only; not media acceptance');const rendered={id:'controlled-original',file},renderedHash=hashBytes(await readFile(file));
  const checkpoint={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),requestedAt:Date.parse('2026-10-15T02:52:15.115Z'),rendererHash:lessonRendererHash(),phase:'review',research:{summary:'Controlled prior source-bound research.',queries:[],references},researchRounds:2,report,plan,rendered,renderedHash,renders:1};
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));return {work,checkpoint,media,hashes};
}
function toolStream(chapters:LessonChapter[]){
  return new Response(`data: ${JSON.stringify({id:'controlled-mixed',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'controlled-revise',type:'function',function:{name:'revise_lesson_script',arguments:JSON.stringify({chapters})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
}

test('actual P14 mixed review revises only the false completion chapter and preserves separate layout repair before new narration',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-mixed-workflow-')),originalFetch=globalThis.fetch;
  let revisions=0,factReviews=0,movieReviews=0,mediaCalls=0;const events:WorkflowEvent[]=[],controller=new AbortController();
  try{
    const seeded=await seedRendered(directory),before=canonical(seeded.checkpoint.report),movieHash=seeded.checkpoint.renderedHash;
    const repaired=structuredClone(seeded.checkpoint.report.chapters[1]);repaired.narration=repaired.narration.replace('官方已定位原因并修复','官方已定位原因，正在实施修复');
    for(const key of ['mediaId','duration','audioHash','htmlHash','speechMatch','cues'] as const)delete repaired[key];
    globalThis.fetch=async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      if(body.stream){
        assert.equal(body.tool_choice?.function?.name,'revise_lesson_script');assert.equal(++revisions,1,'one targeted script repair');
        return toolStream([repaired]);
      }
      assert.equal(body.response_format?.type,'json_object');assert.equal(++factReviews,1,'one fresh fact review after changing narration');
      const context=JSON.parse(body.messages.filter((message:any)=>message.role==='user').at(-1).content);
      assert.match(JSON.stringify(context),/正在实施修复/);assert.doesNotMatch(JSON.stringify(context.report?.chapters||context.chapters),/官方已定位原因并修复/);
      return Response.json({choices:[{message:{content:JSON.stringify({score:94,needsRepair:false,findings:[],suggestions:[]})}}]});
    };
    await assert.rejects(runWithJobSignal(controller.signal,()=>runLessonWorkflow({prompt,config,audioConfig:{...config,kind:'audio',modelId:'seed-audio-1.0'},media:seeded.media,dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,
      analyze:async()=>{mediaCalls++;throw new Error('Unexpected ASR');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async(value)=>{events.splice(0,events.length,...value);},
      stage:async(stage)=>{if(stage==='制作统一教学旁白'){controller.abort();throwIfJobCancelled();}},
      authorVisual:async()=>{mediaCalls++;throw new Error('Unexpected drawing');},produceScene:async()=>{mediaCalls++;throw new Error('Unexpected scene');},render:async()=>{mediaCalls++;throw new Error('Unexpected new movie');},
      review:async(file):Promise<RenderReview>=>{assert.equal(++movieReviews,1);assert.equal(file,seeded.checkpoint.rendered.file);return structuredClone(actual.review);},
    })),JobCancelledError);
    assert.equal(revisions,1);assert.equal(factReviews,1);assert.equal(movieReviews,1);assert.equal(mediaCalls,0);
    const saved=JSON.parse(await readFile(path.join(seeded.work,'checkpoint.json'),'utf8'));
    assert.equal(saved.phase,'narration');assert.equal(saved.renders,1);assert.equal(saved.report.factReview.score,94);assert.equal(saved.report.factReview.needsRepair,false);
    assert.deepEqual(saved.report.chapters.filter((chapter:LessonChapter)=>chapter.id!=='chapter-2'),before.chapters.filter((chapter:LessonChapter)=>chapter.id!=='chapter-2'));
    assert.match(saved.report.chapters[1].narration,/官方已定位原因，正在实施修复/);assert.doesNotMatch(saved.report.chapters[1].narration,/官方已定位原因并修复/);assert.equal(saved.report.chapters[1].mediaId,undefined);
    assert.deepEqual(Object.keys(saved.visualFeedback),['chapter-1']);assert.equal(saved.visualFeedback['chapter-1'],actual.review.semantic!.findings[0]);assert.equal(saved.visualFeedback['chapter-2'],undefined);
    const repair=JSON.parse(await readFile(path.join(seeded.work,'repair-attempt.json'),'utf8'));assert.deepEqual(repair.targets,['chapter-2']);assert.match(repair.requirements,/chapter-2/);assert.doesNotMatch(repair.requirements,/chapter-1|手机设备/);
    assert.equal(saved.best.review.score,82);assert.equal(saved.best.review.status,'needs-review');assert.equal(saved.best.rendered.id,'controlled-original');assert.equal(saved.best.hash,movieHash);assert.equal(hashBytes(await readFile(seeded.checkpoint.rendered.file)),movieHash);
    assert.equal(saved.rendered,undefined);assert.equal(saved.review,undefined);assert.equal(saved.voiceRevision,0);
    assert.equal(events.some(event=>['synthesize_narration','synthesize_chapter','transcribe_chapter','draw_lesson_scenes','render_lesson'].includes(event.tool)),false);
    for(const [file,hash]of Object.entries(seeded.hashes))assert.equal(hashBytes(await readFile(file)),hash,'existing source/analysis bytes stay immutable before narration');
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
