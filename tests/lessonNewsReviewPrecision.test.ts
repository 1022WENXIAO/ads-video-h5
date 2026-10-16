import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {createLessonPrecisionBaseline} from '../server/lessonEvidenceConcordance';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {newsSourceParserHash} from '../server/newsSourceVersion';
import {hashBytes} from '../server/narrativeScenes';
import {createNewsPublicationAnnotation} from '../server/newsTime';
import {createNewsPublicationCandidate} from '../server/newsPublicationProof';
import {validatePlan} from '../server/core';
import {withModelSnapshot} from '../server/modelContext';
import {JobCancelledError,runWithJobSignal,throwIfJobCancelled} from '../server/jobExecution';
import type {AudioAnalysis,LessonReport,MediaItem,RenderReview,WorkflowEvent} from '../shared/types';

// Minimal public P34 projection, not a copied owner checkpoint or wire body.
// Only the clock conflict, user scope and original failed disposition are used.
// Callback media below are identity placeholders, not playable/accepted movies.
const prompt='想请你做一条新闻短讯，就选最近24小时里真实媒体已经报道出来、正在被讨论的一条热点。画面上请直接标出这篇报道的实际报道日期；如果事情发生在更早的时候，也把事件时间和报道时间分开。没被确认的说法不要讲成定论。做成30秒竖屏视频，配音和字幕，画面用动态示意。';
const requestedAt=Date.parse('2026-10-16T09:58:29.119Z');
const config={id:'controlled-text',name:'Controlled',provider:'ark',kind:'text' as const,modelId:'controlled',baseUrl:'https://example.invalid',apiKey:'controlled-only',enabled:true};
const independent={...config,id:'controlled-independent',kind:'understanding' as const};
const originalFailure={score:86,status:'needs-review',checks:[{name:'教学目标时长',passed:false,detail:'目标30秒，实际32.230秒'}],findings:['ch1：事件时间与报道时间未完全分开；新增实际地震标签，例如“实际地震：堪察加当地约12:35”。']};
const currentRaw={score:82,needsRepair:false,findings:[],suggestions:[]};

function priorReport():LessonReport{
  const observed=Date.now();
  const quote='日本气象厅10月16日发布9.9级地震速报后取消，实际为堪察加6.9级地震。';
  const references=[
    {id:'ref-2',title:'通报后撤回',url:'https://3w.huanqiu.com/a/c36dc8/4TdPFwCbXHo',excerpt:quote,verification:'news-page' as const,retrievedAt:new Date(requestedAt).toISOString(),publishedAt:'2026-10-16T06:58:00Z',dateEvidence:'2026-10-16 14:58',freshness:'fresh' as const},
    {id:'ref-3',title:'误报报道',url:'https://3g.china.com/act/news/10000169/20261016/49798232.html',excerpt:'实际上发生的地震位于俄罗斯堪察加半岛南部，当地时间12点35分左右震动，震级为6.9。',verification:'news-page' as const},
    {id:'ref-8',title:'6.9-magnitude quake hits Russia’s Kamchatka',url:'https://www.chinadailyhk.com/hk/article/641230',excerpt:"A magnitude-6.9 earthquake struck Russia's Kamchatka Peninsula. The quake occurred at 15:35 local time (0335 GMT) at a depth of 127.8 km.",verification:'news-page' as const},
  ];
  const narrations=['报道日期是二零二六年十月十六日。日本气象厅中午十二点四十推送千岛群岛九点九级地震，八分钟后撤回。','当天确认的是，俄罗斯堪察加半岛发生六点九级地震；气象厅下午道歉，称震级位置误判，具体原因仍调查。','所以收到警报，当下先避险，随后看官方取消或更正，别把未确认原因传成黑客攻击，也别把预警误判当成巨震。'];
  return validateLesson({workflowId:'controlled-news-precision',...lessonSettings(prompt),presentation:lessonPresentation(prompt),title:'地震速报撤回',audience:'普通观众',objectives:['分清报道日期与实际地震时刻','区分误报和已确认地震'],arc:'先报道再确认最后行动',limitations:['Controlled state regression; no media acceptance.'],references,
    hotResearch:{asOf:new Date(observed).toISOString(),expiresAt:new Date(observed+1800000).toISOString(),windowHours:24,signals:[],topics:[{title:'速报撤回',hook:'确认信息',angle:'区分误报',signalIds:[],facts:[{text:quote,evidence:[{referenceId:'ref-2',quote}]}],visualPlan:'示意图',uncertainties:[]}],failures:[]},
    factReview:{score:96,needsRepair:false,findings:[],suggestions:['可另列实际地震发生时刻，更完整呈现时间线。']},
    chapters:narrations.map((narration,index)=>({id:'ch'+(index+1),title:'确认信息'+(index+1),role:index===0?'hook':index===1?'foundation':'recap',goal:'理解已确认信息',prerequisites:index?['ch'+index]:[],narration,reason:'先事实后行动',referenceIds:index===0?['ref-2','ref-3']:['ref-2','ref-8'],claims:[{text:quote,referenceIds:['ref-2'],basis:'source'}],visual:{kind:'concept',takeaway:'保留已确认与未知的边界',items:index===0?[{label:'报道日期：2026-10-16',detail:'事件也发生在10月16日',cue:'报道日期是'},{label:'速报撤回',detail:'警报不代表已确认巨震',cue:'八分钟后撤回'}]:index===1?[{label:'实际地震',detail:'堪察加6.9级',cue:'俄罗斯堪察加半岛发生六点九级地震'},{label:'原因仍调查',detail:'不推断最终技术结论',cue:'具体原因仍调查'}]:[{label:'先避险',detail:'收到警报采取防护',cue:'当下先避险'},{label:'看更正',detail:'不把未知当定论',cue:'随后看官方取消或更正'}]}})),
  },prompt);
}
async function seed(directory:string,report:LessonReport,baseline:ReturnType<typeof createLessonPrecisionBaseline>,phase:'fact-review'|'review'){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const raw=Buffer.from(JSON.stringify(originalFailure,null,2));await writeFile(path.join(work,'original-review-projection.json'),raw);
  const checkpoint:any={fingerprint:hashBytes(JSON.stringify({version:1,owner:'controlled-owner',prompt,export:true})),requestedAt,rendererHash:lessonRendererHash(),newsSourceParserHash:newsSourceParserHash(),phase,precisionBaseline:baseline,report,research:{summary:'Controlled public clock evidence projection',queries:[],references:report.references,current:report.hotResearch},renders:phase==='review'?2:1,
    review:{score:originalFailure.score,status:originalFailure.status,checks:structuredClone(originalFailure.checks),semantic:{score:originalFailure.score,findings:structuredClone(originalFailure.findings),suggestions:[]},limitations:['Minimal actual failed-review projection; not the original wire body.'],createdAt:''}};
  const media:MediaItem[]=[];
  if(phase==='review'){
    report.voice={mode:'preset',modelId:'seed-audio-1.0',anchorHash:hashBytes('controlled anchor'),revision:0,tempo:1};
    for(const [index,ch]of report.chapters.entries()){
      ch.mediaId='controlled-scene-'+index;ch.duration=10;ch.audioHash=hashBytes('controlled speech '+index);ch.htmlHash=hashBytes('controlled HTML '+index);ch.speechMatch=1;ch.cues=ch.visual.items.map((item,i)=>({text:item.cue,start:1+i*3,end:3+i*3}));
      const analysis:AudioAnalysis={status:'ready',sourceHash:hashBytes('controlled scene '+index),modelId:'controlled',duration:10,transcript:ch.narration,sentences:[{id:'s',text:ch.narration,complete:true,start:0,end:10,words:[...ch.narration].map((text,i,chars)=>({text,start:10*i/chars.length,end:10*(i+1)/chars.length}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
      media.push({id:ch.mediaId,name:ch.title,kind:'video',mimeType:'video/mp4',url:'',createdAt:'',duration:10,hasAudio:true,analysis,generation:{workflowId:report.workflowId,beatId:ch.id,mode:'generated',lineHash:hashBytes(ch.narration),audioHash:ch.audioHash,htmlHash:ch.htmlHash,referenceHash:report.voice.anchorHash}});
    }
    const annotation=createNewsPublicationAnnotation(report,requestedAt)!;assert.ok(annotation);
    media[0].generation!.newsPublication={...annotation,htmlHash:report.chapters[0].htmlHash!,sceneHash:media[0].analysis!.sourceHash,htmlVerified:true,layout:{fontSize:24,x:40,y:180,width:640,height:34,minimumOpacity:1,sampledTimes:[0,1,9.98]}};
    const plan=validatePlan({lesson:report,format:report.format,targetSeconds:30,summary:'Controlled cached candidate',clips:report.chapters.map(ch=>({sourceId:ch.mediaId!,sceneId:ch.id,start:0,end:10,purpose:'argument'}))},media);
    const file=path.join(directory,'controlled-candidate-not-playable.mp4');await writeFile(file,'CONTROLLED identity placeholder, not an accepted movie');
    Object.assign(checkpoint,{plan,rendered:{id:'controlled-current',file},renderedHash:hashBytes(await readFile(file))});
  }
  const checkpointBytes=Buffer.from(JSON.stringify(checkpoint));await writeFile(path.join(work,'checkpoint.json'),checkpointBytes);return{work,media,checkpoint,raw,checkpointBytes};
}
function options(directory:string,media:MediaItem[],events:WorkflowEvent[]=[]){return{prompt,requestedAt,config,audioConfig:{...config,kind:'audio' as const,modelId:'seed-audio-1.0'},media,dataDir:directory,mediaDir:directory,ownerId:'controlled-owner',checkpointKey:'case',export:true,register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async(value:WorkflowEvent[])=>{events.splice(0,events.length,...value);},analyze:async()=>{throw new Error('No ASR permitted');},render:async()=>{throw new Error('No new render permitted');},review:async()=>{throw new Error('Unexpected media review');}};}

test('a new unsupported local clock remains blocked before TTS after an empty 82-point fact response, preserving the original 86 and duration failure',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-new-clock-gate-')),savedFetch=globalThis.fetch,prior=priorReport(),baseline=createLessonPrecisionBaseline(prior),current=structuredClone(prior),controller=new AbortController(),events:WorkflowEvent[]=[];let calls=0,narrationStages=0;
  current.chapters[0].narration='报道日期是二零二六年十月十六日。堪察加当地约十二点三十五地震，气象厅误推九点九级，八分钟后撤回。';delete current.factReview;
  validateLesson(current,prompt);
  const seeded=await seed(directory,current,baseline,'fact-review');
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.stream){const saved=JSON.parse(await readFile(path.join(seeded.work,'checkpoint.json'),'utf8'));assert.fail('Unexpected decision before bounded fact gate: '+JSON.stringify({calls,phase:saved.phase,feedback:saved.feedback,factReview:saved.report?.factReview}));}calls++;return Response.json({choices:[{message:{content:JSON.stringify(currentRaw)}}]});};
  try{
    await assert.rejects(withModelSnapshot({text:config,understanding:independent,audio:{...config,kind:'audio'},image:null},()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow({...options(directory,seeded.media,events),stage:async(stage)=>{if(/制作统一.*旁白/.test(stage))narrationStages++;if(stage.startsWith('规划')){controller.abort();throwIfJobCancelled();}}}))),JobCancelledError);
    const saved=JSON.parse(await readFile(path.join(seeded.work,'checkpoint.json'),'utf8'));
    assert.equal(saved.report.factReview.score,82);assert.equal(saved.report.factReview.needsRepair,true);assert.ok(saved.report.factReview.findings.length,'source evidence gate must survive empty model findings');
    assert.deepEqual(JSON.parse(await readFile(path.join(seeded.work,'fact-review-response.json'),'utf8')),currentRaw,'the original model false flag and empty findings are retained separately from derived rejection');
    assert.equal(calls,1,'the existing first fact response is enough to block unsupported precision; no extra review is added');assert.equal(narrationStages,0);
    assert.equal(events.some(e=>/synthesize|transcribe|render_lesson/.test(e.tool)),false);
    assert.deepEqual(saved.precisionBaseline,baseline,'unsafe intermediate values never become the precision baseline');assert.equal(saved.renders,1);
    const archived=await readFile(path.join(seeded.work,'news-source-history',hashBytes(seeded.checkpointBytes)+'.json'));assert.deepEqual(archived,seeded.checkpointBytes,'the prior failed-review checkpoint is preserved before persistence');
    assert.equal(JSON.parse(archived.toString()).review.score,86);assert.equal(JSON.parse(archived.toString()).review.checks[0].passed,false);
    assert.deepEqual(await readFile(path.join(seeded.work,'original-review-projection.json')),seeded.raw);assert.equal(originalFailure.score,86);assert.equal(originalFailure.checks[0].passed,false);assert.equal(originalFailure.checks[0].detail,'目标30秒，实际32.230秒');
  }finally{globalThis.fetch=savedFetch;await rm(directory,{recursive:true,force:true});}
});

test('same-day news without an optional exact earthquake clock reaches the existing media review and cannot automatically pass',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-optional-clock-review-')),savedFetch=globalThis.fetch,value=priorReport(),baseline=createLessonPrecisionBaseline(value),events:WorkflowEvent[]=[];let calls=0,reviews=0;
  const seeded=await seed(directory,value,baseline,'review');globalThis.fetch=async()=>{calls++;throw new Error('A cached review resume must not issue provider calls');};
  try{
    const result=await withModelSnapshot({text:config,understanding:independent,audio:{...config,kind:'audio'},image:null},()=>runLessonWorkflow({...options(directory,seeded.media,events),review:async(file,plan):Promise<RenderReview>=>{
      reviews++;assert.equal(file,seeded.checkpoint.rendered.file);assert.equal(plan.lesson!.chapters[0].narration,value.chapters[0].narration);assert.doesNotMatch(plan.lesson!.chapters[0].narration,/三十五/);
      const candidate=createNewsPublicationCandidate(plan,seeded.media,requestedAt)!;assert.ok(candidate);
      return{score:78,status:'needs-review',checks:[{name:'受控未解决的实际视觉缺陷',passed:false,detail:'ch1：受控画面仍需独立审查'}],semantic:{score:78,findings:['ch1：受控画面仍需独立审查'],suggestions:[]},newsPublication:{...candidate,frameVerified:true,renderedSha256:seeded.checkpoint.renderedHash,frameEvidence:{chapterId:'ch1',frameTime:1,sampledTimes:[1],quote:candidate.label}},limitations:['Controlled state callback only; no pixels or audio are accepted.'],createdAt:''};
    }}));
    assert.equal(reviews,1);assert.equal(calls,0);assert.equal(result.review!.score,78);assert.equal(result.review!.status,'needs-review','optional precision never overrides actual media findings or score');
    assert.equal(events.some(e=>/synthesize|transcribe|render_lesson/.test(e.tool)),false);assert.deepEqual(await readFile(path.join(seeded.work,'original-review-projection.json')),seeded.raw);
  }finally{globalThis.fetch=savedFetch;await rm(directory,{recursive:true,force:true});}
});
