import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow,lessonNewsRecoveryPolicy,lessonNewsResearchRequest,NEWS_PUBLICATION_GAP} from '../server/lessonWorkflow';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {newsSourceParserHash} from '../server/newsSourceVersion';
import {validatePlan} from '../server/core';
import {hashBytes} from '../server/narrativeScenes';
import {createNewsPublicationAnnotation} from '../server/newsTime';
import {createNewsPublicationCandidate} from '../server/newsPublicationProof';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import type {AudioAnalysis,LessonChapter,MediaItem,RenderReview} from '../src/types';

const gap=NEWS_PUBLICATION_GAP+'：正文发布日期无法核实，不在原指令24小时报道窗口。';
test('fixed topic publication gaps preserve the requested model/version and never broaden the topic',()=>{
  const prompt='制作实时新闻资讯视频讲述 Fable5.5，渲染紧迫氛围';
  const policy=lessonNewsRecoveryPolicy(prompt,gap,0,1);assert.equal(policy.scope,'fixed-topic');assert.deepEqual(policy.anchors,['Fable5.5']);assert.equal(policy.reselect,false);assert.equal(policy.strictToday,false);
  const query=lessonNewsResearchRequest(prompt,gap,'Fable5.5 当前报道','换成其他AI应用',[],0,1,['旧题']);
  assert.ok(query.startsWith(prompt+'\n'));assert.match(query,/研究方向：制作实时新闻资讯视频讲述 Fable5.5/);assert.match(query,/只补查已选新闻「Fable5.5 当前报道」.*不得更换事件/);assert.doesNotMatch(query,/研究方向：换成/);
  assert.equal(lessonNewsRecoveryPolicy(prompt,gap,0,3).exhausted,true);
});
test('an authorized AI domain may reselect inside its original publication window with the existing two-reselection budget',()=>{
  const prompt='选一条最近24小时的大模型新闻做成30秒视频，画面显示真实报道日期';
  const policy=lessonNewsRecoveryPolicy(prompt,gap,0,1);assert.equal(policy.scope,'user-domain');assert.equal(policy.reselect,true);assert.equal(policy.strictToday,false);
  const query=lessonNewsResearchRequest(prompt,gap,'旧选题','改成体育热点',[gap],0,1,['旧选题']);
  assert.ok(query.startsWith(prompt+'\n研究方向：'+prompt));assert.match(query,/原用户授权领域/);assert.match(query,/原指令时点往前的报道时间窗/);assert.match(query,/旧选题/);assert.doesNotMatch(query,/研究方向：改成体育/);assert.doesNotMatch(query,/用户时效要求|用户要求的当日实际事件证据/);
  assert.equal(lessonNewsRecoveryPolicy(prompt,gap,1,3).reselect,true);assert.equal(lessonNewsRecoveryPolicy(prompt,gap,2,3).reselect,false);assert.equal(lessonNewsRecoveryPolicy(prompt,gap,2,3).exhausted,true);
});
test('strict today-event recovery retains today requirement separately from a publication-date gap',()=>{
  const prompt='制作今天发生的大模型新闻视频',feedback='用户时效要求：缺少今天发生的事件';
  const policy=lessonNewsRecoveryPolicy(prompt,feedback,0,1);assert.equal(policy.strictToday,true);assert.equal(policy.todayGap,true);assert.equal(policy.publicationGap,false);assert.equal(policy.reselect,true);
  assert.match(lessonNewsResearchRequest(prompt,feedback,'旧事件','新话题',[],0,1,[]),/用户要求的当日实际事件证据/);
  assert.equal(lessonNewsRecoveryPolicy('制作最新大模型新闻视频',feedback,0,1).reselect,false,'an unrelated marker does not invent a stricter calendar contract');
});

/** Controlled state/hash fixtures only. Their bytes are not a rendered video
 * and these tests do not count as production video acceptance. */
async function seededNews(directory:string,phase='done'){
  const prompt='制作45秒横屏最新大模型新闻图解视频，每秒4字',requestedAt=Date.now(),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const quote='Controlled fixture: error magnitude and score.';
  const references=['https://news.example.org/report','https://another.example.net/report'].map((url,i)=>({id:'r'+i,title:'Controlled read news body',url,verification:'news-page' as const,freshness:'fresh' as const,publishedAt:new Date(requestedAt-3600000).toISOString(),dateEvidence:'Controlled published-time metadata',excerpt:quote}));
  const hotResearch={asOf:new Date(requestedAt).toISOString(),expiresAt:new Date(requestedAt+1800000).toISOString(),windowHours:24,signals:[],failures:[],topics:[{title:'受控大模型报道',hook:'受控新报道',angle:'核对来源时间',signalIds:[],facts:[{text:quote,evidence:[{referenceId:'r0',quote}]}],visualPlan:'受控图解',uncertainties:[]}]};
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,title:'误差评分'+i,role:i===0?'hook':i===2?'recap':'foundation',goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r0'],claims:[{text:'误差影响评分',referenceIds:['r0']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]},mediaId:'media-'+i,duration:15,audioHash:hashBytes('audio'+i),htmlHash:hashBytes('html'+i),speechMatch:1}));
  for(const c of chapters)c.cues=c.visual.items.map((item,i)=>({text:item.cue,start:1+i*3,end:3+i*3}));
  const report=validateLesson({workflowId:'controlled-news-proof',...lessonSettings(prompt),title:'受控大模型报道',audience:'初学者',objectives:['核实来源','区分日期'],arc:'先来源再日期',chapters,references,hotResearch,limitations:[],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:hashBytes('voice-anchor'),revision:0,tempo:1},factReview:{score:94,needsRepair:false,findings:[]}},prompt);
  const annotation=createNewsPublicationAnnotation(report,requestedAt)!;assert.ok(annotation);
  const media:MediaItem[]=chapters.map((chapter,i)=>({id:chapter.mediaId!,kind:'video',name:'Controlled metadata fixture',mimeType:'video/mp4',url:'',duration:15,createdAt:'',generation:{workflowId:report.workflowId,beatId:chapter.id,mode:'generated',lineHash:hashBytes(chapter.narration),audioHash:chapter.audioHash!,htmlHash:chapter.htmlHash!,referenceHash:report.voice!.anchorHash,...(i===0?{newsPublication:{...annotation,htmlHash:chapter.htmlHash!,sceneHash:hashBytes('scene'+i),htmlVerified:true,layout:{fontSize:24,x:40,y:106,width:1200,height:32,sampledTimes:[0,1,14.99],minimumOpacity:1}}}:{})},analysis:{status:'ready',modelId:'fixture',duration:15,sourceHash:hashBytes('scene'+i),timing:'model-estimated',createdAt:'',transcript:chapter.narration,pauses:[],warnings:[],sentences:[{id:'s',start:0,end:15,text:chapter.narration,complete:true,words:[{text:chapter.narration,start:0,end:15}]}]} as AudioAnalysis}));
  const plan=validatePlan({lesson:report,format:'16:9',targetSeconds:45,summary:'Controlled proof contract fixture',clips:chapters.map((c,i)=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:15,purpose:i===0?'hook':i===2?'conclusion':'argument'}))},media);
  const file=path.join(directory,'controlled-fixture.mp4');await writeFile(file,'CONTROLLED hash fixture; not actual video acceptance');
  const rendered={id:'controlled-movie',file},renderedHash=hashBytes(await readFile(file)),candidate=createNewsPublicationCandidate(plan,media,requestedAt)!;assert.ok(candidate);
  const review:RenderReview={status:'passed',score:95,checks:[{name:'新闻报道日期可见',passed:true,detail:'Controlled contract fixture'}],semantic:{score:95,findings:[],suggestions:[]},limitations:['Not a real acceptance result.'],createdAt:new Date().toISOString(),newsPublication:{...candidate,frameVerified:true,renderedSha256:renderedHash,frameEvidence:{chapterId:'c0',quote:annotation.label,frameTime:1,sampledTimes:[1]}}};
  const checkpoint={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase,rendererHash:lessonRendererHash(),newsSourceParserHash:newsSourceParserHash(),requestedAt,research:{summary:'Controlled sourced news',queries:[],references,current:hotResearch},researchRounds:2,report,plan,rendered,renderedHash,renders:2,review};
  const options={prompt,requestedAt,config:{id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture',modelId:'fixture'},audioConfig:{id:'audio',name:'fixture',kind:'audio' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture',modelId:'seed-audio-1.0'},media,dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,progress:async()=>{},analyze:async()=>{throw new Error('Unexpected ASR');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},render:async()=>{throw new Error('Unexpected render');},review:async()=>review};
  return{options,checkpoint,work};
}
for(const kind of ['valid','missing-proof','wrong-file-hash','wrong-cutoff','changed-first-media'] as const)test('completed news checkpoint performs final current proof/hash validation: '+kind,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-final-gate-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory);
  try{
    globalThis.fetch=async()=>{throw new Error('Final checkpoint validation must not call providers');};
    if(kind==='missing-proof')checkpoint.review.newsPublication=undefined;
    if(kind==='wrong-file-hash')checkpoint.review.newsPublication!.renderedSha256='f'.repeat(64);
    if(kind==='wrong-cutoff')checkpoint.review.newsPublication!.cutoffUtc=new Date(options.requestedAt+1).toISOString();
    if(kind==='changed-first-media')options.media[0].generation!.newsPublication!.sceneHash='f'.repeat(64);
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
    if(kind==='valid'){const result=await runLessonWorkflow(options);assert.equal(result.review!.status,'passed');}
    else{await assert.rejects(runLessonWorkflow(options),/阶段review.*新闻报道日期/);const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.review.status,'needs-review');assert.equal(saved.review.checks.find((c:any)=>c.name==='新闻报道日期可见').passed,false);}
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
test('after-review gate rejects a provider passed status without the current movie date proof and never repairs script or audio',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-review-gate-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory,'review');
  let reviews=0;const events:any[]=[];
  try{
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));globalThis.fetch=async()=>{throw new Error('No provider repair should be reached');};
    await assert.rejects(runLessonWorkflow({...options,progress:async(updates:any[])=>{events.splice(0,events.length,...updates);},review:async()=>{reviews++;return{...checkpoint.review,newsPublication:undefined};}}),/阶段review.*新闻报道日期/);
    assert.equal(reviews,1);assert.equal(events.some(e=>['synthesize_narration','revise_lesson_script','transcribe_chapter'].includes(e.tool)),false);
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.best.review.status,'needs-review');assert.equal(saved.best.review.score,95,'the numerical review score is retained, while required date evidence fails');
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});


test('a source-date gap stays in research and never becomes a cosmetic script or voice repair',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-source-gap-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory);
  try{
    checkpoint.report.references[0].dateEvidence=undefined;checkpoint.plan.lesson!.references[0].dateEvidence=undefined;
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));globalThis.fetch=async()=>{throw new Error('No paid call expected while rejecting an old completed proof');};
    await assert.rejects(runLessonWorkflow(options),/阶段research.*新闻报道日期来源缺口/);
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'research');assert.equal(saved.report.factReview.needsRepair,true);assert.match(saved.feedback,/来源缺口/);assert.doesNotMatch(saved.feedback,/用户时效要求|缺少今天发生/);
    assert.deepEqual(saved.report.chapters.map((c:LessonChapter)=>c.narration),checkpoint.report.chapters.map(c=>c.narration));assert.equal(saved.voiceRevision,0);assert.equal(saved.renders,2);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
test('an invalid old best proof cannot override a newly verified review on resume',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-best-recovery-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory);
  try{
    const valid=structuredClone(checkpoint.review);checkpoint.review.newsPublication=undefined;
    Object.assign(checkpoint,{best:{plan:structuredClone(checkpoint.plan),rendered:checkpoint.rendered,review:checkpoint.review,hash:checkpoint.renderedHash}});
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));globalThis.fetch=async()=>{throw new Error('No paid provider expected');};
    await assert.rejects(runLessonWorkflow(options),/阶段review.*新闻报道日期/);
    const invalid=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(invalid.best.review.status,'needs-review');
    let reviews=0;const result=await runLessonWorkflow({...options,review:async()=>{reviews++;return valid;}});assert.equal(reviews,1);assert.equal(result.review!.status,'passed');assert.equal(result.review!.score,95);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
test('choosing an earlier verified best keeps its actual rendered hash synchronized in the checkpoint',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-best-hash-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory);
  try{
    const best={plan:structuredClone(checkpoint.plan),rendered:{...checkpoint.rendered},review:structuredClone(checkpoint.review),hash:checkpoint.renderedHash};
    const other=path.join(directory,'later-rejected-fixture.mp4');await writeFile(other,'Different controlled candidate, not video acceptance');checkpoint.rendered={id:'later-rejected',file:other};checkpoint.renderedHash=hashBytes(await readFile(other));Object.assign(checkpoint,{best});
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));globalThis.fetch=async()=>{throw new Error('No paid provider expected');};
    const result=await runLessonWorkflow(options);assert.equal(result.rendered!.id,best.rendered.id);assert.equal(result.review!.status,'passed');
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.renderedHash,best.hash);assert.equal(saved.renderedHash,hashBytes(await readFile(saved.rendered.file)));
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});


test('a missing review/date protocol preserves the underlying unavailable-review cause without recording new speech',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-unavailable-review-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory,'review');let reviews=0;const events:any[]=[];
  const unavailable:RenderReview={...checkpoint.review,status:'needs-review',semantic:undefined,newsPublication:undefined,checks:[{name:'成片语义审查',passed:false,detail:'实际审查未完成：HTTP 503 private-fixture'},{name:'新闻报道日期可见',passed:false,detail:'日期抽帧审查未完成'}]};
  try{
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));globalThis.fetch=async()=>{throw new Error('No script/TTS/ASR request expected');};
    await assert.rejects(runLessonWorkflow({...options,progress:async(updates:any[])=>{events.splice(0,events.length,...updates);},review:async()=>{reviews++;return unavailable;}}),error=>{assert.match(String(error),/实际审查未完成：HTTP 503 private-/);assert.doesNotMatch(String(error),/private-fixture/);assert.match(String(error),/日期抽帧审查未完成/);assert.match(String(error),/真实成片、HTML与抽帧绑定证据/);return true;});
    assert.equal(reviews,2,'only the existing one review-request retry is used');assert.equal(events.some(e=>['synthesize_narration','revise_lesson_script','transcribe_chapter','draw_lesson_scenes'].includes(e.tool)),false);
    assert.equal(unavailable.checks[1].detail,'日期抽帧审查未完成','the original review object is not overwritten');
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'review');assert.match(saved.review.checks.find((c:any)=>c.name==='成片语义审查').detail,/HTTP 503/);assert.match(saved.review.checks.find((c:any)=>c.name==='新闻报道日期可见').detail,/日期抽帧审查未完成/);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});


test('an old accepted source checkpoint is checked before any paid narration submission',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-news-before-voice-')),original=globalThis.fetch;const{options,checkpoint,work}=await seededNews(directory,'narration');const controller=new AbortController();let calls=0;const events:any[]=[];
  try{
    checkpoint.report.references[0].dateEvidence=undefined;checkpoint.plan.lesson!.references[0].dateEvidence=undefined;
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));globalThis.fetch=async()=>{calls++;throw new Error('No paid call expected before source-date validation');};
    await assert.rejects(runWithJobSignal(controller.signal,()=>runLessonWorkflow({...options,progress:async(updates:any[])=>{events.splice(0,events.length,...updates);if(updates.some(e=>e.tool==='synthesize_narration'&&e.status==='failed'))controller.abort();}})),JobCancelledError);
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'research');assert.match(saved.feedback,/新闻报道日期来源缺口/);assert.equal(calls,0);assert.equal(events.some(e=>['transcribe_chapter','synthesize_chapter','revise_lesson_script','render_html'].includes(e.tool)),false);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
