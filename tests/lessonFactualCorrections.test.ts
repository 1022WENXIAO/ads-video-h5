import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {lessonFactualCorrectionFindings,needsPassedScriptAdjudication} from '../server/lessonFactualCorrections';
import {reviewLessonScript,runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {validatePlan} from '../server/core';
import {withModelSnapshot} from '../server/modelContext';
import {newsSourceParserHash} from '../server/newsSourceVersion';
import type {AudioAnalysis,LessonReport,MediaItem} from '../shared/types';

// Verbatim fragments from the sealed P14 first-accepted script, review and
// source excerpts. These are a deterministic regression, not media acceptance.
const original='官方已定位原因并修复';
const source='正在实施修复';
const claim='官方处置从“正在排查问题、定位原因”更新为“已定位原因，正在实施修复”；具体原因、影响范围和持续时间尚未披露。';
const suggestion='chapter-2：口播“官方已定位原因并修复”与同句后文“根因和影响范围未披露”以及来源中的“正在实施修复”相比，容易被听成已经完成修复；建议改为“官方已定位原因，正在实施修复”，与图解和来源保持完全一致。';
const primary={score:92,needsRepair:false,findings:[],suggestions:[suggestion,'chapter-1：建议增加开场的观察时间说明。']};
const config={id:'controlled-text',name:'controlled text',kind:'text' as const,provider:'ark',baseUrl:'https://provider.example.invalid',modelId:'controlled-model',apiKey:'controlled-only',enabled:true};
const secondary={...config,id:'controlled-independent',kind:'understanding' as const,modelId:'controlled-independent-model'};
const audioConfig={...config,kind:'audio' as const};
function report(script=original,sourceClaim=claim,sourceExcerpt='官方最初表示正在排查问题，随后将处理进度更新为“已定位原因，正在实施修复”。截至记者10时测试时，故障已持续近两小时。'):LessonReport{
  return {workflowId:'controlled-state-correction',title:'处置进度',audience:'普通观众',objectives:['核对事实','区分状态'],arc:'说明事实和边界',requestedSeconds:45,explicitDuration:true,format:'16:9',limitations:[],factReview:structuredClone(primary),chapters:[{id:'chapter-2',title:'进度说明',role:'foundation',goal:'区分已定位与已修复',prerequisites:[],narration:script+'，但根因和影响范围未披露。',reason:'受控来源核验',referenceIds:['ref-7'],claims:[{text:sourceClaim,basis:'source',referenceIds:['ref-7']}],visual:{kind:'concept',takeaway:'核对实际处置进度',items:[{label:'修复进度',detail:'已定位原因，正在实施修复；根因未披露',cue:script}]}}],references:[{id:'ref-7',title:'实际报道摘录',url:'https://source.example.org/report',verification:'news-page',excerpt:sourceExcerpt}]};
}
function validReport(prompt:string):LessonReport{
  const value=report();value.references[0].verification='public-page';
  value.voice={mode:'preset',modelId:'controlled-audio',anchorHash:'controlled-anchor',revision:0,tempo:1};
  value.chapters=Array.from({length:3},(_,i)=>({...structuredClone(value.chapters[0]),id:'chapter-'+(i+1),role:i===0?'hook' as const:i===1?'foundation' as const:'recap' as const,prerequisites:i?['chapter-'+i]:[],narration:(original+'，但根因和影响范围未披露。').repeat(3),visual:{...structuredClone(value.chapters[0].visual),items:[...value.chapters[0].visual.items,{label:'证据边界',detail:'根因和影响范围未披露',cue:'根因和影响范围未披露'}]},mediaId:'source-'+i,duration:15,htmlHash:'controlled-html-'+i,audioHash:'controlled-audio-'+i,speechMatch:1,cues:[{text:original,start:0,end:4},{text:'根因和影响范围未披露',start:4,end:8}]}));
  return validateLesson({...value,...lessonSettings(prompt),presentation:lessonPresentation(prompt)},prompt);
}
function sourceMedia(value:LessonReport):MediaItem[]{
  return value.chapters.map(c=>({id:c.mediaId!,kind:'video',name:c.title,mimeType:'video/mp4',duration:15,url:'',createdAt:'',generation:{workflowId:value.workflowId,beatId:c.id,mode:'generated',lineHash:hashBytes(c.narration),htmlHash:c.htmlHash,audioHash:c.audioHash!,referenceHash:value.voice!.anchorHash},analysis:{status:'ready',modelId:'controlled-analysis',sourceHash:c.audioHash!,duration:15,transcript:c.narration,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',start:0,end:15,text:c.narration,complete:true,words:[{text:c.narration,start:0,end:15}]}]} satisfies AudioAnalysis}));
}

test('actual P14 92/false suggestion becomes one source-bound factual finding without changing source data',()=>{
  const value=report(),before=structuredClone(value),findings=lessonFactualCorrectionFindings(value,primary.suggestions);
  assert.equal(findings.length,1);assert.match(findings[0],/chapter-2.*ref-7.*正在实施修复/);assert.deepEqual(value,before);
  const corrected=report('官方已定位原因，正在实施修复');assert.deepEqual(lessonFactualCorrectionFindings(corrected,primary.suggestions),[],'only the actual changed visible quote releases the anchored contradiction');
});

test('planned versus completed and partial versus all are factual corrections while equivalent style stays optional',()=>{
  for(const [script,evidence] of [['甲平台已经上线应用','甲平台计划下月上线应用'],['甲平台已经向所有用户开放服务','甲平台已经向部分用户开放服务']]){
    const value=report(script,evidence,evidence),issue=`chapter-2：原句“${script}”与来源“${evidence}”不一致，建议改为“${evidence}”。`;
    assert.equal(lessonFactualCorrectionFindings(value,[issue]).length,1,script);
  }
  const announced='甲平台已经宣布将上线应用',planned='甲平台计划下月上线应用';
  assert.deepEqual(lessonFactualCorrectionFindings(report(announced,planned,planned),[`chapter-2：建议把“${announced}”改为“${planned}”。`]),[],'already announced a plan is not already completed');
  assert.deepEqual(lessonFactualCorrectionFindings(report(),['chapter-2：建议增加对服务状态的背景解释。','chapter-2：建议把“根因和影响范围未披露”改为“根因和影响范围尚未披露”。']),[]);
});

test('different actors or historical incidents cannot be joined by a shared repair verb',()=>{
  const cases=[
    ['乙平台已定位原因并修复','甲平台已定位原因，正在实施修复'],
    ['此前官方已定位原因并修复','官方已定位原因，正在实施修复'],
    ['官方已定位原因并修复','此前官方已经完成修复，本次官方正在实施修复'],
  ];
  for(const [script,evidence] of cases){const value=report(script,evidence,evidence);assert.deepEqual(lessonFactualCorrectionFindings(value,[`chapter-2：原句“${script}”与来源“正在实施修复”相比，建议改为“正在实施修复”。`]),[],script);}
  const wrongSource=report(original,claim,'乙平台已定位原因，正在实施修复。');assert.deepEqual(lessonFactualCorrectionFindings(wrongSource,[suggestion]),[],'a model-authored source claim cannot donate the official actor absent from the actual excerpt');
});

test('missing, ambiguous, search-only, unrelated chapter and nonverbatim evidence never manufacture a hard correction',()=>{
  const examples:Array<LessonReport>=[];
  const missing=report();missing.references=[];examples.push(missing);
  const duplicate=report();duplicate.references.push({...duplicate.references[0],url:'https://other.example.net/unrelated'});examples.push(duplicate);
  const search=report();search.references[0].verification='search-cited';examples.push(search);
  const unselected=report();unselected.chapters[0].referenceIds=[];examples.push(unselected);
  const fabricated=report();fabricated.references[0].excerpt='官方仅确认服务存在异常，其他进度暂未披露。';examples.push(fabricated);
  const synthesis=report();synthesis.chapters[0].claims[0].basis='synthesis';examples.push(synthesis);
  for(const value of examples)assert.deepEqual(lessonFactualCorrectionFindings(value,[suggestion]),[]);
  assert.deepEqual(lessonFactualCorrectionFindings(report(),[suggestion.replace('chapter-2','chapter-other')]),[]);
});

test('primary and independent script review cannot drop the same unchanged anchored contradiction',async t=>{
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.match(body.messages[0].content,/改变事实状态或范围/);return Response.json({choices:[{message:{content:JSON.stringify(calls===1?primary:{score:99,needsRepair:false,findings:[],suggestions:[]})}}]});};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const value=report(),first=await reviewLessonScript(config,value,'controlled');assert.equal(first.needsRepair,true);assert.equal(first.findings.length,1);
  const second=await reviewLessonScript(secondary,value,'controlled',undefined,first);assert.equal(second.needsRepair,true);assert.deepEqual(second.findings,first.findings);
  const changed=report('官方已定位原因，正在实施修复');const accepted=await reviewLessonScript(secondary,changed,'controlled',undefined,first);assert.equal(accepted.needsRepair,false);assert.equal(calls,3);
});

test('only passing nonempty suggestions request the new once-only independent adjudication',()=>{
  assert.equal(needsPassedScriptAdjudication(primary),true);
  for(const value of [{...primary,suggestions:[]},{...primary,needsRepair:true},{...primary,score:79},{...primary,adjudication:{modelId:'secondary',primaryScore:92,primaryNeedsRepair:false,primaryFindings:[]}}])assert.equal(needsPassedScriptAdjudication(value),false);
});

test('a newly passing review with optional suggestions receives exactly one independent workflow adjudication',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-once-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const prompt='制作45秒横屏知识图解视频，解释证据与结论，先给脚本',value=validReport(prompt);value.factReview=undefined;
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:false})),phase:'fact-review',report:value,research:{summary:'Controlled original research',queries:[],references:value.references}}));
  const originalFetch=globalThis.fetch,models:string[]=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.stream,undefined);models.push(body.model);return Response.json({choices:[{message:{content:JSON.stringify({score:92,needsRepair:false,findings:[],suggestions:models.length===1?['chapter-1：建议补充通俗背景。']:[]})}}]});};
  try{
    const result=await withModelSnapshot({text:config,understanding:secondary,audio:null,image:null},()=>runLessonWorkflow({prompt,config,audioConfig:null,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:false,progress:async()=>{},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},analyze:async()=>{throw new Error('unexpected ASR');},render:async()=>{throw new Error('unexpected render');},review:async()=>{throw new Error('unexpected media review');}}));
    assert.deepEqual(models,[config.modelId,secondary.modelId]);assert.equal(result.report.factReview!.needsRepair,false);assert.equal(result.report.factReview!.adjudication?.primaryNeedsRepair,false);assert.equal(result.events.filter(e=>e.tool==='adjudicate_lesson_script').length,1);assert.equal(result.events.find(e=>e.tool==='adjudicate_lesson_script')!.status,'succeeded');
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('expired current research cannot crash or reuse a legacy passed script while factual anchors are revoked',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-expired-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const prompt='制作45秒横屏新闻视频，介绍最近24小时的服务进度',value=validReport('制作45秒横屏知识图解视频，解释证据与结论'),now=Date.now();
  const current={asOf:new Date(now-3600000).toISOString(),expiresAt:new Date(now-1800000).toISOString(),windowHours:24,signals:[],topics:[],failures:[]};
  value.hotResearch=current;value.references=value.references.map(ref=>({...ref,verification:'news-page',freshness:'fresh',publishedAt:new Date(now-3600000).toISOString()}));value.references.push({...value.references[0],id:'ref-8',url:'https://other-source.example.net/report'});
  const valid=validateLesson({...value,...lessonSettings(prompt),presentation:lessonPresentation(prompt)},prompt),saved={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'done',rendererHash:lessonRendererHash(),newsSourceParserHash:newsSourceParserHash(),requestedAt:now,report:valid,research:{summary:'Controlled expired research',queries:[],references:valid.references,current},renders:1};
  const bytes=Buffer.from(JSON.stringify(saved,null,2));await writeFile(path.join(work,'checkpoint.json'),bytes);
  const originalFetch=globalThis.fetch,STOP=new Error('controlled stop before expired research fetch');let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('unexpected network or provider');};
  try{
    await assert.rejects(withModelSnapshot({text:config,understanding:null,audio:audioConfig,image:null},()=>runLessonWorkflow({prompt,config,audioConfig,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,stage:async stage=>{assert.equal(stage,'查证新闻与报道');throw STOP;},progress:async()=>{},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},analyze:async()=>{throw new Error('unexpected ASR');},render:async()=>{throw new Error('unexpected render');},review:async()=>{throw new Error('unexpected review');}})),error=>error===STOP);
    const next=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8')),events=JSON.parse(await readFile(path.join(work,'tools.json'),'utf8'));
    assert.equal(next.phase,'research');assert.equal(next.renders,1);assert.equal(next.best,undefined);assert.equal(next.rendered,undefined);assert.equal(next.report.factReview,undefined,'expired evidence still requires new fact review');
    assert.equal(events.find((e:any)=>e.tool==='revalidate_factual_suggestions')?.status,'succeeded');assert.match(JSON.stringify(events),/正在实施修复/);
    assert.deepEqual(await readFile(path.join(work,'news-source-history',hashBytes(bytes)+'.json')),bytes);assert.equal(calls,0);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

for(const [renders,pendingSource] of [[1,false],[2,false],[1,true]] as const)test(`legacy passed movie is revoked before reuse, preserves checkpoint bytes and ${renders} render budget${pendingSource?' across pending source revalidation':''}`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-resume-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const prompt='制作45秒横屏知识图解视频，解释证据与结论',valid=validReport(prompt),media=sourceMedia(valid);
  const plan=validatePlan({lesson:valid,format:'16:9',targetSeconds:45,summary:'Controlled original movie plan',clips:valid.chapters.map(c=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:15,purpose:'argument'}))},media);
  const movie=path.join(directory,'controlled.mp4');await writeFile(movie,'CONTROLLED HASH FIXTURE; NOT REAL VIDEO ACCEPTANCE');const movieHash=hashBytes(await readFile(movie));
  const oldReview={status:'passed',score:94,checks:[{name:'Controlled fixture review',passed:true,detail:'not media acceptance'}],limitations:[],createdAt:new Date().toISOString()};
  const saved={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'done',rendererHash:lessonRendererHash(),requestedAt:Date.now(),report:valid,research:{summary:'Controlled original research',queries:[],references:valid.references},plan,rendered:{id:'old-movie',file:movie},renderedHash:movieHash,review:oldReview,best:{plan,rendered:{id:'old-movie',file:movie},review:oldReview,hash:movieHash},renders,...(pendingSource?{newsSourceRevalidation:{requiresRender:false}}:{})};
  const bytes=Buffer.from(JSON.stringify(saved,null,2)+'\n');await writeFile(path.join(work,'checkpoint.json'),bytes);
  const originalFetch=globalThis.fetch,STOP=new Error('controlled stop at required script repair');let providerCalls=0,mediaCalls=0;
  globalThis.fetch=async()=>{providerCalls++;if(pendingSource)return Response.json({choices:[{message:{content:JSON.stringify({score:99,needsRepair:false,findings:[],suggestions:[]})}}]});throw new Error('must stop before any provider');};
  try{
    await assert.rejects(withModelSnapshot({text:config,understanding:null,audio:audioConfig,image:null},()=>runLessonWorkflow({prompt,config,audioConfig,media,dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,stage:async stage=>{if(stage.includes('定向返修'))throw STOP;},progress:async()=>{},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},analyze:async()=>{mediaCalls++;throw new Error('unexpected ASR');},render:async()=>{mediaCalls++;throw new Error('unexpected render');},review:async()=>{mediaCalls++;throw new Error('unexpected old movie review');}})),error=>error instanceof Error&&(renders===2?/两版渲染预算/.test(error.message):/阶段script：controlled stop at required script repair/.test(error.message)));
    const next=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(next.report.factReview.needsRepair,true);assert.equal(next.renders,renders);assert.equal(next.best,undefined);assert.equal(next.rendered,undefined);assert.equal(next.phase,'script');
    const history=await readdir(path.join(work,'news-source-history'));assert.deepEqual(history,[hashBytes(bytes)+'.json']);assert.deepEqual(await readFile(path.join(work,'news-source-history',history[0])),bytes);
    assert.equal(hashBytes(await readFile(movie)),movieHash);assert.equal(providerCalls,pendingSource?1:0,'pending source state may only perform the controlled text re-review');assert.equal(mediaCalls,0);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
