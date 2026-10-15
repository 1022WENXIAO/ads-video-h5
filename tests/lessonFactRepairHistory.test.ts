import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {emptyLessonFactRepairHistory,restoreLessonFactRepairHistory,rememberLessonFactReview,lessonFactRepairHistoryContext} from '../server/lessonFactRepairHistory';
import {withModelSnapshot} from '../server/modelContext';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {validatePlan} from '../server/core';
import type {AudioAnalysis,LessonReport,MediaItem,WorkflowEvent} from '../shared/types';

const prompt='制作45秒横屏知识图解视频，解释预测误差如何评分，先给脚本';
const config={id:'controlled-text',name:'controlled text',kind:'text' as const,provider:'ark',baseUrl:'https://provider.example.invalid',modelId:'controlled-model',apiKey:'controlled-only',enabled:true};
const secondary={...config,id:'controlled-independent',kind:'understanding' as const,modelId:'controlled-independent-model'};
const finding='chapter-3：本版原句“误差变大损失越高”；依据：真实来源只支持相同条件下比较；修正：明确先核对比较条件。';
const hard={score:70,needsRepair:true,findings:[finding],suggestions:['建议增加一个例子，但这不是额外硬要求。']};
function report():LessonReport{
  return validateLesson({workflowId:'controlled-fact-history',...lessonSettings(prompt),title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',limitations:[],presentation:lessonPresentation(prompt),references:[{id:'ref-1',title:'Controlled source',url:'https://source.example.org/lesson',verification:'primary-page',excerpt:'Controlled evidence: compare error and its score under the same conditions.'}],chapters:Array.from({length:3},(_,i)=>({id:'chapter-'+(i+1),title:'误差评分'+i,role:i===0?'hook':i===1?'foundation':'recap',goal:'理解误差与评分',prerequisites:i?['chapter-'+i]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['ref-1'],claims:[{text:'相同条件下比较误差与评分',basis:'source',referenceIds:['ref-1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}))},prompt);
}
function repaired(value:LessonReport):LessonReport{
  const next=structuredClone(value);next.chapters[2].narration='误差变大损失越高。'.repeat(6)+'实际比较仍要核对条件。';return next;
}
function streamCall(name:string,args:unknown){
  const chunks=[{id:'controlled',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'controlled-call',type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:null}]},{id:'controlled',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{},finish_reason:'tool_calls'}]}];
  return new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}

test('hard review snapshots bind actual chapters and source hashes without promoting passing suggestions',()=>{
  const value=report(),before=structuredClone(value),history=rememberLessonFactReview(emptyLessonFactRepairHistory(),value,hard);
  assert.deepEqual(value,before);assert.equal(history.entries.length,1);assert.deepEqual(history.entries[0].chapters.map(c=>c.id),['chapter-3']);assert.deepEqual(history.entries[0].reviews,[hard]);assert.deepEqual(history.entries[0].sources.map(s=>({id:s.id,count:s.count})),[{id:'ref-1',count:1}]);
  assert.equal(history.entries[0].sources[0].sha256.length,64);assert.deepEqual(restoreLessonFactRepairHistory(history),history);assert.notEqual(restoreLessonFactRepairHistory(history),history);
  assert.deepEqual(rememberLessonFactReview(history,value,{score:94,needsRepair:false,findings:[],suggestions:['只补充背景']}),history);
});

test('context reports real field/source changes and treats reviewer advice as opinions rather than evidence',()=>{
  const value=report(),history=rememberLessonFactReview(emptyLessonFactRepairHistory(),value,hard),unchanged=lessonFactRepairHistoryContext(history,value)!;
  assert.equal(unchanged.priorHardReviews[0].chapters[0].unchanged,true);assert.deepEqual(unchanged.priorHardReviews[0].chapters[0].changedPaths,[]);
  const next=repaired(value);next.chapters[2].claims[0].text+='；按现场体验口径解释';const before=structuredClone(next),context=lessonFactRepairHistoryContext(history,next)!;
  assert.deepEqual(context.priorHardReviews[0].chapters[0].changedPaths,['claims.0.text','narration']);assert.equal(context.priorHardReviews[0].chapters[0].previous.narration,value.chapters[2].narration);assert.equal(context.priorHardReviews[0].chapters[0].current?.narration,next.chapters[2].narration);
  assert.equal(context.priorHardReviews[0].sourceBindings[0].changed,false,'a fabricated source claim does not alter the actual source evidence');assert.match(context.policy,/旧review里的修复建议同样可能错误/);assert.deepEqual(next,before);
  next.references[0].excerpt+=' New actual source evidence.';assert.equal(lessonFactRepairHistoryContext(history,next)!.priorHardReviews[0].sourceBindings[0].changed,true);
  next.references.push({...next.references[0],url:'https://other.example.net/conflicting'});assert.equal(lessonFactRepairHistoryContext(history,next)!.priorHardReviews[0].sourceBindings[0].current.count,2);
  next.references=[];assert.equal(lessonFactRepairHistoryContext(history,next)!.priorHardReviews[0].sourceBindings[0].current.count,0);
  const savedHistory=structuredClone(history),savedNext=structuredClone(next),isolated=lessonFactRepairHistoryContext(history,next)!;isolated.priorHardReviews[0].chapters[0].previous.narration='修改请求副本';isolated.priorHardReviews[0].chapters[0].current!.narration='修改请求副本';assert.deepEqual(history,savedHistory);assert.deepEqual(next,savedNext);
});

test('history remains bounded to six real script/source versions and keeps first/latest actual hard reviews',()=>{
  const value=report();let history=emptyLessonFactRepairHistory();
  for(let i=0;i<8;i++){const next=structuredClone(value);next.chapters[2].narration+='版本'+i;history=rememberLessonFactReview(history,next,hard);}
  assert.equal(history.entries.length,6);const last=structuredClone(value);last.chapters[2].narration+='版本7';
  for(let i=0;i<5;i++)history=rememberLessonFactReview(history,last,{...hard,findings:[finding+' 实际复核'+i]});
  assert.equal(history.entries.length,6);assert.equal(history.entries.at(-1)!.reviews.length,2);assert.deepEqual(history.entries.at(-1)!.reviews[0],hard);assert.match(history.entries.at(-1)!.reviews[1].findings[0],/实际复核4/);assert.deepEqual(restoreLessonFactRepairHistory(history),history);
});

test('unknown, truncated, duplicated and tampered history fail closed without modifying the input',()=>{
  const history=rememberLessonFactReview(emptyLessonFactRepairHistory(),report(),hard);
  for(const corrupt of [{version:2,entries:[]},{version:1,entries:[{id:'incomplete'}]},(()=>{const c=structuredClone(history);c.entries[0].chapters[0].narration+='篡改';return c;})(),(()=>{const c=structuredClone(history);c.entries.push(c.entries[0]);return c;})()]){
    const before=structuredClone(corrupt);assert.throws(()=>restoreLessonFactRepairHistory(corrupt),/事实返修历史/);assert.deepEqual(corrupt,before);
  }
});

async function seed(directory:string,value:LessonReport,history?:unknown){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const saved={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:false})),phase:'fact-review',rendererHash:lessonRendererHash(),report:value,research:{summary:'Controlled verified research',queries:[],references:value.references},renders:1,...(history===undefined?{}:{factRepairHistory:history})};
  const bytes=Buffer.from(JSON.stringify(saved,null,2)+'\n');await writeFile(path.join(work,'checkpoint.json'),bytes);return{work,bytes};
}
function options(directory:string,events:WorkflowEvent[]=[]){
  return{prompt,config,audioConfig:null,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:false,progress:async(updates:WorkflowEvent[])=>{events.splice(0,events.length,...updates);},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},analyze:async()=>{throw new Error('unexpected ASR');},render:async()=>{throw new Error('unexpected render');},review:async()=>{throw new Error('unexpected media review');}};
}

test('a real controlled revision clears authorization but preserves prior hard findings for primary and independent review',async()=>{
  const {runLessonWorkflow}=await import('../server/lessonWorkflow');
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-history-revise-')),value=report(),{work,bytes}=await seed(directory,value),originalFetch=globalThis.fetch,contexts:any[]=[],events:WorkflowEvent[]=[];let reviews=0,decisions=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(body.stream){decisions++;assert.equal(body.tool_choice.function.name,'revise_lesson_script');return streamCall('revise_lesson_script',{chapters:[repaired(value).chapters[2]]});}
    const request=JSON.parse(body.messages[1].content);contexts.push(request.factRepairContext);reviews++;
    if(reviews===1)return Response.json({choices:[{message:{content:JSON.stringify(hard)}}]});
    assert.match(JSON.stringify(request.factRepairContext),/真实来源只支持相同条件下比较/);assert.equal(request.factRepairContext.priorHardReviews[0].chapters[0].current.narration,repaired(value).chapters[2].narration);
    return Response.json({choices:[{message:{content:JSON.stringify({score:94,needsRepair:false,findings:[],suggestions:reviews===2?['chapter-3：可补充更多例子。']:[]})}}]});
  };
  try{
    const result=await withModelSnapshot({text:config,understanding:secondary,audio:null,image:null},()=>runLessonWorkflow(options(directory,events)));
    assert.equal(reviews,3);assert.equal(decisions,1);assert.deepEqual(contexts[1],contexts[2],'both existing reviews receive the same prior history');assert.equal(contexts[0],undefined);assert.equal(result.report.factReview!.needsRepair,false);assert.deepEqual(result.report.factReview!.findings,[],'actually fixed history is context, not a perpetual union veto');
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.factRepairHistory.entries.length,1);assert.deepEqual(saved.factRepairHistory.entries[0].reviews[0],hard);assert.equal(saved.renders,1);assert.equal(events.filter(e=>e.tool==='adjudicate_lesson_script').length,1);
    assert.deepEqual(await readFile(path.join(work,'news-source-history',hashBytes(bytes)+'.json')),bytes,'legacy bytes are preserved before the first new persistence');
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('resumed history is passed to both reviews while ordinary corrections can pass without extra resolution JSON',async()=>{
  const {runLessonWorkflow}=await import('../server/lessonWorkflow');
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-history-resume-')),value=report(),history=rememberLessonFactReview(emptyLessonFactRepairHistory(),value,hard),next=repaired(value),{work}=await seed(directory,next,history),originalFetch=globalThis.fetch,contexts:any[]=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.stream,undefined);contexts.push(JSON.parse(body.messages[1].content).factRepairContext);return Response.json({choices:[{message:{content:JSON.stringify({score:94,needsRepair:false,findings:[],suggestions:contexts.length===1?['chapter-3：可增加背景。']:[]})}}]});};
  try{
    const result=await withModelSnapshot({text:config,understanding:secondary,audio:null,image:null},()=>runLessonWorkflow(options(directory)));assert.equal(result.report.factReview!.needsRepair,false);assert.equal(contexts.length,2);assert.deepEqual(contexts[0],contexts[1]);assert.equal(contexts[0].priorHardReviews[0].chapters[0].unchanged,false);assert.match(contexts[0].priorHardReviews[0].chapters[0].current.narration,/核对条件/);
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.deepEqual(saved.factRepairHistory,history);assert.equal(saved.renders,1);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('corrupt persisted history preserves exact checkpoint bytes and refuses before any provider or draft mutation',async()=>{
  const {runLessonWorkflow}=await import('../server/lessonWorkflow');
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-history-corrupt-')),{work,bytes}=await seed(directory,report(),{version:99,entries:[]}),originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw new Error('unexpected provider');};
  try{
    await assert.rejects(withModelSnapshot({text:config,understanding:null,audio:null,image:null},()=>runLessonWorkflow(options(directory))),/事实返修历史版本/);assert.equal(calls,0);assert.deepEqual(await readFile(path.join(work,'checkpoint.json')),bytes);assert.deepEqual(await readdir(path.join(work,'news-source-history')),[hashBytes(bytes)+'.json']);assert.deepEqual(await readFile(path.join(work,'news-source-history',hashBytes(bytes)+'.json')),bytes);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('actual P15 elapsed contradiction survives empty 99-point primary and independent findings',async()=>{
  const {reviewLessonScript}=await import('../server/lessonWorkflow'),fixture=JSON.parse(await readFile(new URL('./fixtures/p15-elapsed-contradiction.json',import.meta.url),'utf8')),value=fixture.report as LessonReport,before=structuredClone(value),originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({score:99,needsRepair:false,findings:[],suggestions:[]})}}]});};
  try{
    const first=await reviewLessonScript(config,value,'controlled actual public-source projection');assert.equal(first.needsRepair,true);assert.ok(first.findings.length>0);assert.match(first.findings.join(' '),/持续时长|时间/);
    const second=await reviewLessonScript(secondary,value,'controlled actual public-source projection',undefined,first);assert.equal(second.needsRepair,true);assert.deepEqual(second.findings,first.findings);assert.equal(calls,2);assert.deepEqual(value,before);
  }finally{globalThis.fetch=originalFetch;}
});

test('old passed mathematical contradiction is revoked before trusting its movie, keeping exact bytes and two-render budget',async()=>{
  const {runLessonWorkflow}=await import('../server/lessonWorkflow'),fixture=JSON.parse(await readFile(new URL('./fixtures/p15-elapsed-contradiction.json',import.meta.url),'utf8')),directory=await mkdtemp(path.join(tmpdir(),'qingjian-fact-history-old-movie-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  // This is a plan/checkpoint hash fixture, not a real media acceptance. Its
  // movie must never be read as authority after the current source veto.
  const value=report(),verifiedPublic=fixture.report.references.find((ref:any)=>ref.id==='ref-1');value.references=[structuredClone(verifiedPublic),{...value.references[0],id:'ref-controlled'}];value.voice={mode:'preset',modelId:'controlled-audio',anchorHash:'controlled-anchor',revision:0,tempo:1};value.factReview={score:99,needsRepair:false,findings:[]};
  value.chapters[2].visual.items[1].detail='截至10时故障已持续3个多小时';value.chapters[2].claims=[{text:'本次故障已持续3个多小时',basis:'source',referenceIds:['ref-1']}];
  for(const [i,chapter] of value.chapters.entries()){chapter.mediaId='controlled-source-'+i;chapter.duration=15;chapter.audioHash='controlled-audio-'+i;chapter.htmlHash='controlled-html-'+i;chapter.speechMatch=1;chapter.cues=chapter.visual.items.map(item=>({text:item.cue,start:0,end:15}));}
  const media:MediaItem[]=value.chapters.map(chapter=>({id:chapter.mediaId!,name:chapter.title,kind:'video',mimeType:'video/mp4',duration:15,url:'',createdAt:'',generation:{workflowId:value.workflowId,beatId:chapter.id,mode:'generated',lineHash:hashBytes(chapter.narration),audioHash:chapter.audioHash!,htmlHash:chapter.htmlHash,referenceHash:value.voice!.anchorHash},analysis:{status:'ready',sourceHash:chapter.audioHash!,modelId:'controlled-analysis',duration:15,transcript:chapter.narration,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',start:0,end:15,text:chapter.narration,complete:true,words:[{text:chapter.narration,start:0,end:15}]}]} satisfies AudioAnalysis}));
  const plan=validatePlan({lesson:value,format:value.format,targetSeconds:45,summary:'Controlled legacy plan',clips:value.chapters.map(chapter=>({sceneId:chapter.id,sourceId:chapter.mediaId!,start:0,end:15,purpose:'argument'}))},media),movie=path.join(directory,'not-real-video.mp4');await writeFile(movie,'CONTROLLED HASH FIXTURE; NOT MEDIA ACCEPTANCE');const movieHash=hashBytes(await readFile(movie)),review={status:'passed',score:99,checks:[],limitations:[],createdAt:''};
  const saved={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'done',rendererHash:lessonRendererHash(),report:value,research:{summary:'Controlled linked actual public-source projection',queries:[],references:value.references},renders:2,plan,rendered:{id:'old-movie',file:movie},renderedHash:movieHash,review,best:{plan,rendered:{id:'old-movie',file:movie},hash:movieHash,review}};const bytes=Buffer.from(JSON.stringify(saved,null,2)+'\n');await writeFile(path.join(work,'checkpoint.json'),bytes);
  const originalFetch=globalThis.fetch,audioConfig={...config,kind:'audio' as const};let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected provider');};
  try{
    await assert.rejects(withModelSnapshot({text:config,understanding:secondary,audio:audioConfig,image:null},()=>runLessonWorkflow({...options(directory),audioConfig,media,export:true})),/两版渲染预算已用尽/);
    const next=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(next.report.factReview.needsRepair,true);assert.match(next.report.factReview.findings.join(' '),/持续时长/);assert.equal(next.renders,2);assert.equal(next.best,undefined);assert.equal(next.rendered,undefined);assert.equal(next.factRepairHistory.entries.length,1);assert.equal(calls,0);assert.equal(hashBytes(await readFile(movie)),movieHash);assert.deepEqual(await readFile(path.join(work,'news-source-history',hashBytes(bytes)+'.json')),bytes);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
