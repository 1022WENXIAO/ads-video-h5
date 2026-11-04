import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {redundantOverlayRepair} from '../server/editorialRedundantOverlay';
import {runEditorialWorkflow} from '../server/editorialWorkflow';
import {extractVisualRetentionRequirements} from '../server/visualRetentionReview';
import {TEXT_MODEL_PRESETS,ARK_BASE_URL} from '../shared/textModels';
import type {EditPlan,MediaItem,RenderReview} from '../shared/types';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-650-redundant-overlay.json',import.meta.url),'utf8'));

test('actual 92-point rejection authorizes deleting only the sampled, quoted duplicate overlay; every source retention check stays met',()=>{
  const x=structuredClone(fixture),before=structuredClone(x),repair=redundantOverlayRepair(x.review,x.prompt,x.plan,x.script)!;
  assert.ok(repair);assert.equal(repair.removed.length,1);assert.equal(repair.removed[0].label,'程序示意');
  const id=repair.removed[0].sceneId;
  assert.deepEqual(repair.script,{...x.script,beats:x.script.beats.map((b:any)=>b.sceneId===id?{...b,graphic:'none',label:''}:b)});
  assert.deepEqual(x,before);assert.equal(x.review.score,92);assert.equal(x.review.status,'needs-review');
});

test('unknown/missing retention, unbound times/labels, ambiguity, factual or mixed faults never authorize automatic removal',()=>{
  for(const mode of ['unmet','unknown','missing','quote','frame','range','duplicate','factual','mixed','passed'] as const){
    const x=structuredClone(fixture);
    if(mode==='unmet')x.review.semantic.visualRetentionChecks[0].status='unmet';
    if(mode==='unknown')x.review.semantic.visualRetentionChecks[0].status='unverified';
    if(mode==='missing')delete x.review.semantic.visualRetentionChecks;
    if(mode==='quote')x.review.semantic.findings=[x.review.semantic.findings[0].replaceAll('“程序示意”','“不存在的标签”')];
    if(mode==='frame')x.review.semantic.findings=[x.review.semantic.findings[0].replace('6.37秒','6.38秒')];
    if(mode==='range')x.plan.motions.forEach((m:any)=>{m.start=50;m.end=55;});
    if(mode==='duplicate')x.script.beats.push({...x.script.beats.find((b:any)=>b.label==='程序示意'),sceneId:'ambiguous'});
    if(mode==='factual')x.review.semantic.findings[0]+='旁白与事实不符。';
    if(mode==='mixed')x.review.checks.push({name:'字幕原话',passed:false,detail:'字幕漏字'});
    if(mode==='passed')x.review.status='passed';
    assert.equal(redundantOverlayRepair(x.review,x.prompt,x.plan,x.script),undefined,mode);
  }
});

test('an explicitly requested highlight or required two-kind graphic set cannot be silently removed',()=>{
  const x=structuredClone(fixture);
  assert.equal(redundantOverlayRepair(x.review,x.prompt+'请高亮程序示意。',x.plan,x.script),undefined);
  x.script.beats.forEach((b:any)=>{if(b.label!=='程序示意'){b.graphic='none';b.label='';}});
  assert.equal(redundantOverlayRepair(x.review,x.prompt+'至少两种绘制动效。',x.plan,x.script),undefined);
});

for(const secondPassed of [true,false])test(`controlled SDK removes reviewed duplicate without reselection or rewriting; new movie review ${secondPassed?'passes':'still fails'}`,async()=>{
  const prompt='剪成8秒横屏，保留画面里的程序示意标注，保留完整原话原声，不新增配音。',requirement=extractVisualRetentionRequirements(prompt)[0];
  const sources:MediaItem[]=['a','b'].map(id=>({id,name:id+'.mp4',kind:'video',mimeType:'video/mp4',url:'',createdAt:'',duration:4,hasAudio:true,analysis:{status:'ready',modelId:'control',sourceHash:(id==='a'?'a':'b').repeat(64),duration:4,transcript:'完整的原话。',sentences:[{id:id+'-0',start:0,end:4,text:'完整的原话。',complete:true,words:[{text:'完整的原话',start:0,end:4}]}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''}}));
  const before=structuredClone(sources),original=globalThis.fetch,config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-overlay-only'};
  let selects=0,writes=0,reviews=0;const plans:EditPlan[]=[];
  globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((t:any)=>t.function.name);let name:string,args:any;
    if(allowed.includes('select_scenes')){selects++;name='select_scenes';args={scenes:sources.map(s=>({sourceId:s.id,sentenceIds:[s.id+'-0'],reason:'完整原话和现有示意标注',purpose:'argument'}))};}
    else{writes++;name='write_narrative';args={premise:'原话与原图',audience:'普通观众',arc:'保留完整对照',style:'完整画面和原声',beats:[{sceneId:'scene-1',intent:'保留原有程序示意',graphic:'circle',label:'程序示意'},{sceneId:'scene-2',intent:'保留原话对照',graphic:'none',label:''}]};}
    return new Response(`data: ${JSON.stringify({id:'control',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:name+selects+writes,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const result=await runEditorialWorkflow({prompt,config,sources,previous:null,export:true,transcribe:async id=>structuredClone(sources.find(s=>s.id===id)!.analysis!),verifySelection:async()=>{},inspect:async()=>({observations:'Controlled actual source label observation',safeZone:'top',frameTimes:[1]}),persist:async()=>{},progress:async()=>{},
      render:async plan=>{plans.push(structuredClone(plan));return{id:'control-'+plans.length,file:'not-a-real-movie-'+plans.length+'.mp4'};},
      review:async()=>{reviews++;const pass=reviews===2&&secondPassed;return{status:pass?'passed':'needs-review',score:pass?88:reviews===1?92:80,checks:[{name:'成片语义审查',passed:pass,detail:'Controlled review only'}],limitations:['SDK routing test, not real generated-video acceptance'],createdAt:'',semantic:{score:pass?88:92,findings:pass?[]:['在成片1秒抽帧中，顶部新增的“程序示意”标签与原有标注重复，属于冗余装饰。'],visualRetentionChecks:[{...requirement,status:'met',frameTimes:[1],detail:'Controlled original source label remains visible'}]}} as RenderReview;},
    });
    assert.equal(selects,1);assert.equal(writes,1);assert.equal(plans.length,2);assert.equal(reviews,2);
    assert.deepEqual(plans[1].clips,plans[0].clips);assert.deepEqual(plans[1].captions,plans[0].captions);assert.deepEqual(plans[1].audio,plans[0].audio);
    assert.equal(plans[0].motions!.length,1);assert.equal(plans[1].motions!.length,0);
    assert.equal(result.review!.status,secondPassed?'passed':'needs-review');assert.equal(result.rendered!.id,secondPassed?'control-2':'control-1');assert.deepEqual(sources,before);
  }finally{globalThis.fetch=original;}
});
