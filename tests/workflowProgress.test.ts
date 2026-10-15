import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdir,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runLessonWorkflow } from '../server/lessonWorkflow';
import { JobCancelledError,runWithJobSignal } from '../server/jobExecution';
import { ARK_BASE_URL,TEXT_MODEL_PRESETS } from '../shared/textModels';
import type { LessonChapter,WorkflowEvent } from '../src/types';
import type { AudioAnalysis,RenderReview } from '../src/types';
import { lessonPacing, lessonSettings, spokenLessonText, validateLesson } from '../server/lessonSpec';
import { lessonPresentation } from '../server/lessonPresentation';
import { runFFmpeg, validatePlan } from '../server/core';
import { lessonVoiceStyle } from '../server/lessonAudio';
import { NarrationAnalysisError } from '../server/narrationAnalysisRecovery';
import { createNewsPublicationAnnotation } from '../server/newsTime';
import { createNewsPublicationCandidate } from '../server/newsPublicationProof';
import { newsSourceParserHash } from '../server/newsSourceVersion';
import type { EditPlan, MediaItem } from '../src/types';
const newsLayout=()=>({fontSize:24,x:40,y:106,width:1200,height:32,sampledTimes:[0,1,14.99],minimumOpacity:1});
function controlledNewsReview(review:RenderReview,file:string,plan:EditPlan,media:MediaItem[],requestedAt:number,actualHash:string):RenderReview {
  const candidate=createNewsPublicationCandidate(plan,media,requestedAt);assert.ok(candidate,'controlled proof metadata must satisfy the same contract as production');
  return {...review,newsPublication:{...candidate,frameVerified:true,renderedSha256:actualHash,frameEvidence:{chapterId:candidate.chapterId,quote:candidate.label,frameTime:1,sampledTimes:[1]}}};
}

const {cases}=JSON.parse(await readFile(new URL('./fixtures/workflow-entry.json',import.meta.url),'utf8')) as {cases:{id:string;prompt:string}[]};
const config=(i=0)=>({...TEXT_MODEL_PRESETS[i],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'test-private-credential'});
function stream(delta:unknown,finishReason='stop'){
  return new Response([{delta,finish_reason:null},{delta:{},finish_reason:finishReason}].map(c=>`data: ${JSON.stringify({id:'progress-fixture',object:'chat.completion.chunk',created:1,model:config().modelId,choices:[{index:0,...c}]})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
const call=(name:string,args:unknown)=>stream({role:'assistant',tool_calls:[{index:0,id:'fixture-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]},'tool_calls');
function options(directory:string,prompt:string,index=0,progress:((events:WorkflowEvent[])=>Promise<void>)=async()=>{}){
  return {prompt,config:config(index),audioConfig:null,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:false,progress,analyze:async()=>{throw new Error('Unexpected audio analysis');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},render:async()=>{throw new Error('Unexpected render');},review:async()=>{throw new Error('Unexpected movie review');}};
}
async function seedNewsResearch(directory:string,prompt:string){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const now=Date.now(),current={asOf:new Date(now).toISOString(),expiresAt:new Date(now+30*60000).toISOString(),windowHours:24,signals:[],topics:[],failures:[]};
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:false})).digest('hex');
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint,newsSourceParserHash:newsSourceParserHash(),phase:'budget',research:{summary:'受控新闻研究检查点',queries:[],references:[],current},researchRounds:1}));
}

for(let index=0;index<3;index++)for(const c of cases)test(`${TEXT_MODEL_PRESETS[index].modelId}: ${c.id} dispatches research without waiting for a model decision`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-entry-')),original=globalThis.fetch,controller=new AbortController();let requests=0,started=false;
  globalThis.fetch=async()=>{requests++;throw new Error('Research must start before any model turn');};
  try{
    await assert.rejects(()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow(options(directory,c.prompt,index,async events=>{
      const entry=events.find(e=>e.tool==='research_topic'&&e.status==='running');
      if(entry){started=true;assert.equal((entry.input as any).topic,c.prompt);assert.match(entry.callId!,/^server-/);controller.abort();throw new JobCancelledError();}
    }))),JobCancelledError);
    assert.equal(started,true);assert.equal(requests,0);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('later news stages reuse research and stop at three no-progress requests with the actual refusal',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-stalled-')),original=globalThis.fetch;let requests=0;
  await seedNewsResearch(directory,cases[0].prompt);
  globalThis.fetch=async()=>{requests++;return stream({role:'assistant',content:requests===1?'工具未开放 test-private-credential':'',reasoning_content:'PRIVATE-REASONING'});};
  try{
    await assert.rejects(()=>runLessonWorkflow(options(directory,cases[0].prompt)),error=>{
      assert.match(String(error),/新闻制作工作流未完成；阶段script/);
      assert.match(String(error),/连续3轮未调用write_lesson_script/);assert.match(String(error),/最近回复：工具未开放 \[redacted\]/);
      assert.doesNotMatch(String(error),/PRIVATE-REASONING|test-private-credential/);return true;
    });
    assert.equal(requests,4,'three function turns plus one change of submission method');
    const logs=(await readFile(path.join(directory,'lesson-workflows/case/llm-response-meta.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
    assert.deepEqual(logs.map(l=>l.idleTurns),[1,2,3]);assert.ok(logs.every(l=>l.expectedTool==='write_lesson_script'));
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('workflow provider authentication failures retain the actual cause without futile retries',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-provider-')),original=globalThis.fetch;let requests=0;
  await seedNewsResearch(directory,cases[0].prompt);
  globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({error:{message:'invalid API key test-private-credential',type:'authentication_error'}}),{status:401,headers:{'Content-Type':'application/json'}});};
  try{
    await assert.rejects(()=>runLessonWorkflow(options(directory,cases[0].prompt)),error=>{
      assert.match(String(error),/401|invalid API key/);assert.doesNotMatch(String(error),/test-private-credential|模型未调用必要工具/);return true;
    });assert.equal(requests,1);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('a valid script advances directly to independent fact review without another model tool decision',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-stage-progress-')),original=globalThis.fetch,prompt='制作45秒横屏知识图解视频，解释预测误差如何评分，先给脚本';
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=[{id:'r1',title:'Controlled primary source',url:'https://arxiv.org/abs/1708.02001',verification:'primary-page',excerpt:'Controlled fixture: error magnitude and a score.'}];
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:false})).digest('hex');
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint,phase:'script',research:{summary:'受控研究夹具',queries:[],references},researchRounds:2}));
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,role:i===0?'hook':i===1?'foundation':'recap',title:'误差评分'+i,goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
  const requests:Record<string,number>={};
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(!body.stream)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:92,needsRepair:false,findings:[]})}}]}));
    const name=body.tool_choice.function.name;requests[name]=(requests[name]||0)+1;
    assert.match(JSON.stringify(body.messages),new RegExp('本轮已开放且必须调用的工具：'+name));
    if(requests[name]<3)return stream({role:'assistant',content:''});
    return call(name,name==='write_lesson_script'?{title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters}:{});
  };
  try{
    const result=await runLessonWorkflow(options(directory,prompt));
    assert.equal(result.report.factReview?.score,92);assert.deepEqual(requests,{write_lesson_script:3});
    const review=result.events.find(e=>e.tool==='review_lesson_script');
    assert.equal(review?.status,'succeeded');assert.match(review!.callId!,/^server-/);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('missing daily-event evidence after reselection stops instead of repeatedly rewriting an unsupported event',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-daily-gap-')),original=globalThis.fetch,prompt='制作45秒新闻口播视频，介绍今天发生的大模型事件，只要脚本';
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const settings=lessonSettings(prompt),now=Date.now(),current={asOf:new Date(now).toISOString(),expiresAt:new Date(now+30*60000).toISOString(),windowHours:24,signals:[],topics:[],failures:[]};
  const references=['https://news.example.com/story','https://other.example.net/story'].map((url,i)=>({id:'r'+i,title:'Controlled recent reporting',url,verification:'news-page' as const,freshness:'fresh' as const,publishedAt:new Date(now).toISOString(),excerpt:'Controlled fixture: a fresh report about an older event, not evidence of a daily announcement.'}));
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,role:i===0?'hook':i===1?'foundation':'recap',title:'新闻说明'+i,goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(9),reason:'受控检查点',referenceIds:['r0'],claims:[{text:'误差影响评分',referenceIds:['r0']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
  const report=validateLesson({workflowId:'controlled-daily-gap',title:'受控新闻',audience:'初学者',objectives:['理解来源','区分日期'],arc:'核验事件日期',...settings,chapters,references,hotResearch:current,limitations:[]},prompt);
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:false})).digest('hex');
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint,newsSourceParserHash:newsSourceParserHash(),phase:'fact-review',research:{summary:'受控已查证候选',queries:[],references,current},report,researchRounds:3,reselects:2}));
  let requests=0;
  globalThis.fetch=async(_url,init)=>{
    requests++;assert.equal(JSON.parse(String(init?.body)).stream,undefined,'unsupported dates must not trigger another writing turn');
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:94,needsRepair:false,findings:[],todayEvents:[]})}}]}));
  };
  try{await assert.rejects(()=>runLessonWorkflow(options(directory,prompt)),/缺少今天发生的可靠事件证据/);assert.equal(requests,1);}
  finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

async function seedRendered(directory:string,phase='review'){
  const prompt='制作45秒横屏知识图解视频，解释误差如何评分',work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=[{id:'r1',title:'Controlled primary source',url:'https://arxiv.org/abs/1708.02001',verification:'primary-page' as const,excerpt:'Controlled fixture: error magnitude and score.'}];
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,role:i===0?'hook':i===1?'foundation':'recap',title:'误差评分'+i,goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]},mediaId:'media-'+i,duration:15}));
  for(const c of chapters){c.audioHash='audio-'+c.id;c.htmlHash='html-'+c.id;c.speechMatch=1;c.cues=c.visual.items.map((item,i)=>({text:item.cue,start:1+i*3,end:3+i*3}));}
  const report=validateLesson({workflowId:'resume-fixture',...lessonSettings(prompt),title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters,references,limitations:[],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:'fixture-anchor',revision:0,tempo:1},factReview:{score:92,needsRepair:false,findings:[]}},prompt);
  const media=chapters.map(c=>({id:c.mediaId!,kind:'video' as const,name:c.title,mimeType:'video/mp4',url:'',createdAt:'',duration:15,generation:{workflowId:report.workflowId,beatId:c.id,mode:'generated' as const,lineHash:createHash('sha256').update(c.narration).digest('hex'),audioHash:c.audioHash!,htmlHash:c.htmlHash!,referenceHash:'fixture-anchor'},analysis:{status:'ready',duration:15,modelId:'fixture',sourceHash:'fixture',timing:'model-estimated',createdAt:'',transcript:c.narration,pauses:[],warnings:[],sentences:[{id:'s',start:0,end:15,text:c.narration,complete:true,words:[{text:c.narration,start:0,end:15}]}]} as AudioAnalysis}));
  const plan=validatePlan({lesson:report,format:'16:9',targetSeconds:45,summary:'误差评分',clips:chapters.map((c,i)=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:15,purpose:i===0?'hook':i===2?'conclusion':'argument'}))},media);
  const file=path.join(directory,'rendered-fixture.mp4');await writeFile(file,'CONTROLLED HASH FIXTURE — this is not actual video acceptance');
  const rendered={id:'movie-fixture',file},renderedHash=createHash('sha256').update(await readFile(file)).digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})).digest('hex');
  const checkpoint={fingerprint,phase,research:{summary:'受控研究夹具',queries:[],references},researchRounds:2,report,plan,rendered,renderedHash,renders:1};
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
  const o={...options(directory,prompt),export:true,media,audioConfig:{...config(),kind:'audio' as const,modelId:'seed-audio-1.0'}};
  return {o,checkpoint,work};
}
const passedReview:RenderReview={status:'passed',score:94,checks:[{name:'成片语义审查',passed:true,detail:'受控审查'}],semantic:{score:94,findings:[],suggestions:[]},limitations:[],createdAt:new Date().toISOString()};

test('exhausted recognition of an existing waveform cannot multiply through narration-stage retries or trigger another synthesis', async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-recognition-budget-')),original=globalThis.fetch;
  const {o,checkpoint,work}=await seedRendered(directory,'narration'),events:WorkflowEvent[]=[];
  const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex'),voiceStyle=lessonVoiceStyle(lessonPacing(o.prompt),lessonPresentation(o.prompt));
  const anchorLine='接下来，我们从一个简单的例子开始，把问题讲清楚。',anchor=path.join(work,'voice-anchor.mp3');
  await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2',anchor]);
  const anchorHash=hash(await readFile(anchor));
  await writeFile(path.join(work,'voice-anchor.json'),JSON.stringify({seedKey:hash(JSON.stringify({model:o.audioConfig.modelId,revision:0,voiceStyle,anchorLine})),hash:anchorHash}));
  const audioBefore=new Map<string,string>();
  for(const [index,chapter]of checkpoint.report.chapters.entries()){
    const dir=path.join(work,chapter.id);await mkdir(dir,{recursive:true});const file=path.join(dir,'raw-speech.mp3');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i',`sine=frequency=${440+index*110}:sample_rate=48000`,'-t','15',file]);
    const audioHash=hash(await readFile(file));audioBefore.set(file,audioHash);
    await writeFile(path.join(dir,'raw-speech.json'),JSON.stringify({key:hash(JSON.stringify({line:spokenLessonText(chapter.narration),model:o.audioConfig.modelId,anchorHash,voiceRevision:0,chapterRevision:0,voiceStyle})),hash:audioHash}));
  }
  let requests=0;const calls=new Map<string,number>();globalThis.fetch=async()=>{requests++;throw new Error('Recognition retry must never synthesize or rewrite a cached waveform');};
  try{
    await assert.rejects(runLessonWorkflow({...o,analyze:async(_item,file,options)=>{
      assert.equal(options?.purpose,'generated-narration');calls.set(file,(calls.get(file)||0)+1);
      throw new Error('音频理解第1块失败：音频理解结果被截断，请重试。');
    },progress:async updates=>{events.splice(0,events.length,...structuredClone(updates));}}),error=>{
      assert.ok((error as Error).cause instanceof NarrationAnalysisError);assert.match(String(error),/识别或分句未完成/);return true;
    });
    assert.equal(requests,0);assert(calls.size>0);assert([...calls.values()].every(count=>count===2),'each active chapter gets exactly one bounded recognition retry');
    assert.equal(events.filter(event=>event.tool==='synthesize_narration').length,1,'the outer automatic workflow cannot reopen a spent recognition budget');
    assert.equal(events.some(event=>event.stage?.includes('重录')||event.tool==='revise_lesson_script'),false);
    for(const [file,before]of audioBefore)assert.equal(hash(await readFile(file)),before);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

for(const generation of [false,true])test(`a verified subtitle ${generation?'5G spelling':'homophone'} repairs the hashed source and rerenders without another voice or authoring request`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-caption-recovery-')),original=globalThis.fetch;
  const {o,checkpoint,work}=await seedRendered(directory,'repair'),chapter=checkpoint.report.chapters[0];
  for(const item of o.media){const sentence=item.analysis!.sentences[0],chars=[...sentence.text];sentence.words=chars.map((text,i)=>({text,start:i*15/chars.length,end:(i+1)*15/chars.length}));}
  chapter.narration=(generation?'协议覆盖五G网络。':'专家像专项模块。')+'误差变大损失越高。'.repeat(6);
  const item=o.media[0],text=chapter.narration.replace(generation?'五G':'专家像',generation?'五g':'专家项'),bytes=Buffer.from('CONTROLLED SOURCE HASH FIXTURE — not actual media QA');
  item.generation!.lineHash=createHash('sha256').update(chapter.narration).digest('hex');
  item.analysis={...item.analysis!,transcript:text,sourceHash:createHash('sha256').update(bytes).digest('hex'),sentences:[{id:'s',start:0,end:text.length*.2,text,complete:true,words:[...text].map((text,i)=>({text,start:i*.2,end:(i+1)*.2}))}]};
  await writeFile(path.join(directory,item.id),bytes);
  const finding=generation?'c0字幕：五g大小写不一致，统一为五G':'c0字幕：专家项专项模块为同音错写';
  const rejection={...passedReview,status:'needs-review' as const,score:85,checks:[{name:'成片语义审查',passed:false,detail:finding}],semantic:{score:85,findings:[finding],suggestions:[]}};
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({...checkpoint,review:rejection}));
  let renders=0,registrations=0;
  globalThis.fetch=async()=>{throw new Error('Caption recovery must not request authoring or recognition');};
  try{
    const result=await runLessonWorkflow({...o,register:async()=>{registrations++;},render:async plan=>{
      renders++;assert.match(plan.captions!.map(c=>c.text).join(''),generation?/五G网络/:/专家像专项模块/);assert.doesNotMatch(plan.captions!.map(c=>c.text).join(''),generation?/五g/:/专家项/);
      const file=path.join(directory,'corrected-fixture.mp4');await writeFile(file,'CONTROLLED RENDER FIXTURE');return {id:'caption-fixed',file};
    },review:async()=>({...passedReview,score:83,semantic:{score:83,findings:[],suggestions:[]}})});
    assert.equal(renders,1);assert.equal(registrations,1);assert.equal(result.rendered?.id,'caption-fixed');assert.equal(result.review?.status,'passed');assert.equal(result.review?.score,83,'a passed movie wins over an 85-point rejected movie');
    assert.match(item.analysis!.transcript,generation?/五g/:/专家项专项模块/,'raw source ASR is retained');
    assert.deepEqual(await readFile(path.join(directory,result.report.chapters[0].mediaId!)),bytes,'the approved source audio/video bytes are unchanged');
    assert.equal(result.events.some(e=>e.tool==='synthesize_narration'||e.tool==='revise_lesson_script'),false);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

for(const unavailable of [false,true])test(`restart resumes the hashed movie at review and recovers ${unavailable?'an unavailable judgment':'HTTP 503'} without rendering again`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-resume-')),original=globalThis.fetch;let reviews=0;
  const {o}=await seedRendered(directory);globalThis.fetch=async()=>{throw new Error('No authoring-model request is permitted for a known review stage');};
  try{
    const result=await runLessonWorkflow({...o,review:async()=>{
      if(++reviews===1){if(!unavailable)throw new Error('HTTP 503');return {...passedReview,status:'needs-review',score:0,semantic:undefined,checks:[{name:'成片语义审查',passed:false,detail:'暂未完成'}]};}
      return passedReview;
    }});
    assert.equal(reviews,2);assert.equal(result.review?.status,'passed');assert.equal(result.rendered?.id,'movie-fixture');
    assert.ok(result.events.filter(e=>e.tool==='review_lesson').every(e=>e.callId?.startsWith('server-')));assert.equal(result.events.some(e=>e.tool==='render_lesson'),false);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('completed checkpoint returns the independently reviewed file without another model turn',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-complete-')),original=globalThis.fetch;
  const {o,checkpoint,work}=await seedRendered(directory,'done');
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({...checkpoint,review:passedReview}));
  globalThis.fetch=async()=>{throw new Error('Completed work must not request a model');};
  try{const result=await runLessonWorkflow(o);assert.equal(result.review?.score,94);assert.equal(result.rendered?.id,'movie-fixture');}
  finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('changed rendered bytes invalidate resume instead of silently returning a trusted artifact',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-invalid-render-')),controller=new AbortController();
  const {o,checkpoint}=await seedRendered(directory);await writeFile(checkpoint.rendered.file,'changed bytes');let reviewCalled=false;
  try{
    await assert.rejects(()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow({...o,progress:async events=>{
      if(events.some(e=>e.tool==='synthesize_narration'&&e.status==='running')){controller.abort();throw new JobCancelledError();}
    },review:async()=>{reviewCalled=true;return passedReview;}})),JobCancelledError);assert.equal(reviewCalled,false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('resumed content rejection triggers server repair and chapter revision; cancellation never returns the prior rejected movie',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-repair-')),original=globalThis.fetch,controller=new AbortController();
  const {o,checkpoint}=await seedRendered(directory);let revisions=0;const events:WorkflowEvent[]=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(!body.stream)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:93,needsRepair:false,findings:[]})}}]}));
    assert.equal(body.tool_choice.function.name,'revise_lesson_script');revisions++;
    assert.match(JSON.stringify(body.messages),/c0.*图解说明不准确/);
    const chapter=structuredClone(checkpoint.report.chapters[0]);chapter.visual.items[0].detail='实际值与预测值的差';return call('revise_lesson_script',{chapters:[chapter]});
  };
  try{
    await assert.rejects(()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow({...o,review:async()=>({...passedReview,status:'needs-review',score:70,checks:[{name:'成片语义审查',passed:false,detail:'c0：图解说明不准确'}],semantic:{score:70,findings:['c0：图解说明不准确'],suggestions:[]}}),progress:async updates=>{
      events.splice(0,events.length,...structuredClone(updates));if(updates.some(e=>e.tool==='synthesize_narration'&&e.status==='running')){controller.abort();throw new JobCancelledError();}
    }})),JobCancelledError);
    assert.equal(revisions,1);assert.equal(events.find(e=>e.tool==='repair_lesson')?.status,'succeeded');assert.match(events.find(e=>e.tool==='repair_lesson')!.callId!,/^server-/);assert.equal(events.find(e=>e.tool==='review_lesson_script')?.status,'succeeded');
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

for(const mode of ['valid','changed-audio','news','news-binding','news-first','news-specialized','knowledge-first','stale-captions'] as const)test(`visual recovery ${mode==='changed-audio'?'rejects changed audio':mode==='news'?'redraws news visual omissions without rerecording correct speech':mode==='news-binding'?'repairs captured news card attribution without rewriting facts or rerecording voice':mode==='news-first'?'designs the first news scenes from verified facts without stock fallback icons':mode==='news-specialized'?'keeps first news charts formulas and curves on their specialized renderers':mode==='knowledge-first'?'designs first knowledge scenes from their actual entities and relationships':mode==='stale-captions'?'replaces stale ASR despite identical audio and visual hashes':'changes the drawing strategy without rewriting verified speech'}`,async()=>{
  const changedAudio=mode==='changed-audio',news=mode.startsWith('news'),staleCaptions=mode==='stale-captions',first=['news-first','news-specialized','knowledge-first'].includes(mode);
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-visual-repair-')),original=globalThis.fetch;
  const {o,checkpoint,work}=await seedRendered(directory);
  if(first)Object.assign(checkpoint,{rendererHash:'controlled-first-scene-checkpoint'});
  if(mode==='news-specialized'){
    const [chart,formula,curve]=checkpoint.report.chapters;
    chart.visual={...chart.visual,kind:'bar-chart',barChart:{bars:[{label:'甲',value:2},{label:'乙',value:4}],unit:'示意值',illustrative:true,panels:[{title:'从零比较',min:0,max:4}]}};
    formula.visual={...formula.visual,kind:'formula',formula:'误差=预测−实际'};
    curve.visual={...curve.visual,kind:'curve',plot:{xLabel:'误差',yLabel:'评分',xMin:-2,xMax:2,yMin:0,yMax:4,curves:[{label:'平方误差',fn:'mse'}]}};
  }
  if(news){
    o.prompt='制作45秒横屏最新大模型新闻图解视频，每秒4字';
    const now=Date.now(),current={asOf:new Date(now).toISOString(),expiresAt:new Date(now+30*60000).toISOString(),windowHours:72,signals:[],topics:[{title:'Controlled news event',hook:'Controlled event',angle:'Controlled evidence',signalIds:[],facts:[{text:'Controlled fixture: error magnitude and score.',evidence:[{referenceId:'r1',quote:'Controlled fixture: error magnitude and score.'}]}],visualPlan:'Controlled visual',uncertainties:[]}],failures:[]};
    checkpoint.report.hotResearch=current;
    checkpoint.report.references=[...checkpoint.report.references.map(r=>({...r,verification:'news-page' as const,freshness:'fresh' as const,publishedAt:new Date(now).toISOString(),dateEvidence:'Controlled published-time fixture'})),{id:'r2',title:'Controlled independent news source',url:'https://news.example.net/story',verification:'news-page',freshness:'fresh',publishedAt:new Date(now).toISOString(),excerpt:'Controlled fixture: an independently read news body.'}];
    checkpoint.report=validateLesson(checkpoint.report,o.prompt);
    Object.assign(o,{requestedAt:now});Object.assign(checkpoint,{requestedAt:now});
    const annotation=createNewsPublicationAnnotation(checkpoint.report,now)!;assert.ok(annotation);
    for(const chapter of checkpoint.report.chapters){
      const media=o.media.find(m=>m.id===chapter.mediaId)!;chapter.htmlHash=createHash('sha256').update(chapter.id).digest('hex');media.generation!.htmlHash=chapter.htmlHash;media.analysis!.sourceHash=createHash('sha256').update('controlled scene '+chapter.id).digest('hex');
      if(chapter===checkpoint.report.chapters[0])Object.assign(media.generation!,{newsPublication:{...annotation,htmlHash:chapter.htmlHash,sceneHash:media.analysis!.sourceHash,htmlVerified:true,layout:newsLayout()}});
    }
    checkpoint.plan.lesson=structuredClone(checkpoint.report);
    checkpoint.fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'fixture-owner',prompt:o.prompt,export:true})).digest('hex');
    await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({...checkpoint,newsSourceParserHash:newsSourceParserHash(),research:{...checkpoint.research,references:checkpoint.report.references,current}}));
  }else if(first)await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
  const speechHashes=new Map<string,string>();
  for(const chapter of checkpoint.report.chapters){
    const dir=path.join(work,chapter.id);await mkdir(dir,{recursive:true});
    const bytes=Buffer.from('CONTROLLED speech fixture '+chapter.id),analysis={...o.media.find(m=>m.id===chapter.mediaId)!.analysis!,sourceHash:createHash('sha256').update(bytes).digest('hex')};
    for(const sentence of analysis.sentences){const chars=[...sentence.text];sentence.words=chars.map((text,i)=>({text,start:15*i/chars.length,end:15*(i+1)/chars.length}));}
    await writeFile(path.join(dir,'speech.mp3'),changedAudio?Buffer.from('changed voice'):bytes);
    await writeFile(path.join(dir,'speech-analysis.json'),JSON.stringify(analysis));
    speechHashes.set(path.join(dir,'speech.mp3'),createHash('sha256').update(await readFile(path.join(dir,'speech.mp3'))).digest('hex'));
  }
  const {drawingHtml,hashBytes}=await import('../server/narrativeScenes');
  let authors=0,renders=0,reviews=0;
  const events:WorkflowEvent[]=[];
  const drawing={title:'误差示意',nodes:[{id:'axis',kind:'line' as const,x:100,y:450,w:1000,h:0,text:'',tone:'ink' as const,fontSize:24,highlight:false},{id:'bar',kind:'path' as const,pathData:'M300 450V250H400V450Z',x:300,y:250,w:100,h:200,text:'',tone:'blue' as const,fontSize:24,highlight:true},{id:'label',kind:'text' as const,x:300,y:465,w:200,h:70,text:'误差评分',tone:'ink' as const,fontSize:32,highlight:false}]};
  globalThis.fetch=async()=>{throw new Error('A drawing-only repair must not rewrite or synthesize speech');};
  const run=()=>runLessonWorkflow({...o,progress:async updates=>{events.splice(0,events.length,...updates);},
    authorVisual:async(_config,beat,format)=>{authors++;assert.equal(format,'16:9');const affected=!first&&beat.id==='c0';if(affected)assert.match(beat.visualBrief,mode==='news-binding'?/归属误导/:news?/视觉遗漏/:/配图无关/);const chapter=checkpoint.report.chapters.find(c=>c.id===beat.id)!;assert.equal(beat.line,chapter.narration);const brief=JSON.parse(beat.visualBrief);assert.equal(brief.priorVisual.rejected,affected);assert.deepEqual(brief.audienceContent.claims,chapter.claims);assert.equal('reviewFeedback' in brief.audienceContent,false);return drawing;},
    produceScene:async(chapter,_index,_total,format,speechFile,analysis,project,_pacing,_presentation,_news,custom,chart,annotation)=>{
      if(mode==='news-first'||mode==='knowledge-first')assert.ok(custom,'the first topic draft must design every ordinary scene');
      if(mode==='news-specialized'){assert.equal(custom,undefined);if(chapter.visual.kind==='bar-chart')assert.ok(chart);}
      await mkdir(project,{recursive:true});const file=path.join(project,'controlled-scene.mp4'),bytes=Buffer.from('CONTROLLED scene fixture '+chapter.id);await writeFile(file,bytes);
      const htmlHash=hashBytes(custom?drawingHtml(custom,15,format):chapter.id),sceneHash=hashBytes(bytes);
      const result={file,duration:15,audioHash:hashBytes(await readFile(speechFile)),htmlHash,analysis:{...analysis,sourceHash:sceneHash},...(annotation?{publicationEvidence:{...annotation,htmlHash,sceneHash,htmlVerified:true as const,layout:newsLayout()}}:{})};
      if(staleCaptions){
        const id='stale-'+chapter.id;await writeFile(path.join(directory,id),bytes);
        o.media.push({id,kind:'video',mimeType:'video/mp4',name:'Stale caption fixture',url:'',createdAt:'',duration:15,analysis:{...result.analysis,transcript:'STALE CAPTIONS',sentences:[{...result.analysis.sentences[0],text:'STALE CAPTIONS',words:[{text:'STALE CAPTIONS',start:0,end:15}]}]},generation:{workflowId:checkpoint.report.workflowId,beatId:chapter.id,mode:'generated',audioHash:result.audioHash,htmlHash:result.htmlHash,lineHash:hashBytes(chapter.narration),referenceHash:''}});
      }
      return result;
    },render:async plan=>{renders++;assert.deepEqual(plan.lesson!.chapters.map(c=>c.narration),checkpoint.report.chapters.map(c=>c.narration));if(staleCaptions){assert.doesNotMatch(plan.captions!.map(c=>c.text).join(''),/STALE/);assert.ok(plan.clips.every(c=>!c.sourceId.startsWith('stale-')));}const file=path.join(directory,'repaired-movie-fixture.mp4');await writeFile(file,'CONTROLLED rerender fixture');return {id:'redrawn-fixture',file};},
    review:async(file,plan)=>{
      const attach=async(review:RenderReview)=>news?controlledNewsReview(review,file,plan,o.media,(o as typeof o & {requestedAt:number}).requestedAt,hashBytes(await readFile(file))):review;
      if(first){reviews++;return attach({...passedReview,score:83});}
      if(mode==='news-binding'&&reviews++===0){const fixture=JSON.parse(await readFile(new URL('./fixtures/visual-review-misattribution.json',import.meta.url),'utf8'));const review=fixture.firstReview as RenderReview;review.semantic!.findings=review.semantic!.findings.map(f=>f.replaceAll('ch3','c0'));return attach(review);}
      if(mode==='news-binding')return attach({...passedReview,score:83});
      const finding=news?'c0：旁白清晰说出术语，但对应章节所有抽帧均未出现底部摘要提示条，存在重要信息视觉遗漏。':'c0：画面没有柱状图，图标配图无关';
      return attach(++reviews===1?{...passedReview,status:'needs-review',score:90,checks:[{name:'成片语义审查',passed:false,detail:finding}],semantic:{score:90,findings:[finding],suggestions:[]}}:{...passedReview,score:83});
    }});
  try{
    if(changedAudio){await assert.rejects(run,/旁白文件哈希/);assert.equal(authors,0);assert.equal(renders,0);}
    else{const result=await run();assert.equal(result.review?.status,'passed');assert.equal(result.review?.score,83);assert.equal(result.rendered?.id,'redrawn-fixture');assert.equal(authors,mode==='news-specialized'?0:3);assert.equal(renders,1);assert.equal(reviews,first?1:2);assert.equal(result.events.some(e=>e.tool==='synthesize_narration'||e.tool==='revise_lesson_script'||e.tool==='transcribe_chapter'),false);for(const [file,before]of speechHashes)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),before);}
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

for(const wording of ['字幕遗漏了字，实际旁白需要重新核验','实际旁白少字，须重新合成'])test(`speech recovery recognizes the feedback wording: ${wording}`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-wording-')),original=globalThis.fetch,controller=new AbortController();
  const {o,checkpoint,work}=await seedRendered(directory);let revisions=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(!body.stream)return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:93,needsRepair:false,findings:[]})}}]}));
    assert.equal(body.tool_choice.function.name,'revise_lesson_script');revisions++;
    return call('revise_lesson_script',{chapters:[checkpoint.report.chapters[0]]});
  };
  try{
    await assert.rejects(()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow({...o,review:async()=>({...passedReview,status:'needs-review',score:70,checks:[{name:'成片语义审查',passed:false,detail:'c0：'+wording}],semantic:{score:70,findings:['c0：'+wording],suggestions:[]}}),progress:async events=>{
      if(events.some(e=>e.tool==='synthesize_narration'&&e.status==='running')){controller.abort();throw new JobCancelledError();}
    }})),JobCancelledError);
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.chapterVoiceRevisions.c0,1);assert.equal(revisions,0,'correct narration does not need a cosmetic script rewrite');
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});

test('a changed renderer resets the failed cycle and revalidates an invalid legacy script instead of trusting its old fact score',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-invalid-checkpoint-')),original=globalThis.fetch,controller=new AbortController();
  const {o,checkpoint,work}=await seedRendered(directory,'done');
  checkpoint.report.chapters[0].visual.items[0].detail='示意得分，单位：分；字幕完整写作数值和单位';
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({...checkpoint,rendererHash:'old-renderer',renders:2,review:passedReview}));
  globalThis.fetch=async()=>{throw new Error('Invalid cached facts must not reach a provider before checkpoint revalidation');};
  try{
    await assert.rejects(()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow({...o,rebuildScenes:true,progress:async events=>{
      if(events.some(e=>e.tool==='renderer_rebuild'&&e.status==='succeeded')){controller.abort();throw new JobCancelledError();}
    }})),JobCancelledError);
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'script');assert.equal(saved.renders,0);assert.equal(saved.report.factReview,undefined);assert.match(saved.repairRequirements,/c0.*制作指令/);assert.equal(saved.rendered,undefined);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
