import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {EditPlan,MediaItem,RenderReview,WorkflowEvent} from '../shared/types';
import {runEditorialWorkflow,selectScenes} from '../server/editorialWorkflow';
import {extractVisualRetentionRequirements,parseVisualRetentionChecks,visualRetentionFindings,visualRetentionOmittedPlanningWitnesses,visualRetentionUnverifiedPlanningWitnesses,VisualRetentionReviewError} from '../server/visualRetentionReview';
import {editorialRepairCandidates} from '../server/editorialRepairCandidates';
import {timelineOffsets} from '../server/timeline';
import {ARK_BASE_URL,TEXT_MODEL_PRESETS} from '../shared/textModels';

// Controlled protocol/SDK observations, not a real movie acceptance record.
const prompt='剪成8秒横屏，保留重复观察和未知部分限制的现有画面，所选句子保留完整原话原声，不新增配音。';
const requirement=extractVisualRetentionRequirements(prompt)[0];
function source(id:string):MediaItem{
  const sentences=[0,1].map(i=>({id:id+'-'+i,start:i*5,end:i*5+4,text:'这是完整的原话。',complete:true,words:[{text:'这是完整的原话',start:i*5,end:i*5+4}]}));
  return {id,ownerId:'controlled-owner',name:id+'.mp4',kind:'video',mimeType:'video/mp4',url:'',duration:9,hasAudio:true,createdAt:'',analysis:{status:'ready',modelId:'control',sourceHash:createHash('sha256').update(id).digest('hex'),duration:9,transcript:'这是完整的原话。',sentences,pauses:[],warnings:[],timing:'model-estimated',createdAt:''}};
}
const selections=(a:number,b:number)=>[{sourceId:'a',sentenceIds:['a-'+a],reason:'完整原话和程序示意',purpose:'hook' as const},{sourceId:'b',sentenceIds:['b-'+b],reason:'完整原话和证据边界',purpose:'comparison' as const}];
function planFor(sources:MediaItem[],a=1,b=0):EditPlan{
  const scenes=selectScenes(selections(a,b),sources);
  return {format:'16:9',summary:'controlled',targetSeconds:8,fineCut:true,clips:scenes.map(s=>({sceneId:s.id,sourceId:s.sourceId,sentenceIds:s.sentenceIds,start:s.start,end:s.end,transition:{kind:'cut',duration:0}})),editorial:{scenes,script:{premise:'control',audience:'control',arc:'control',style:'control',beats:[]}}};
}
function reviewFor(sources:MediaItem[]):RenderReview{
  return {status:'needs-review',score:72,checks:[],limitations:[],createdAt:'',semantic:{score:72,findings:['同一原句只保留了一部分画面'],visualRetentionChecks:[{...requirement,status:'unmet',frameTimes:[5],preserveFrameTimes:[1],detail:'A的已有观察出现，B的限制画面缺失',sourceEvidence:{sourceId:'b',time:6,sourceHash:sources[1].analysis!.sourceHash},sourceOmitted:true}]}};
}

test('compound omission binds both the existing output observation and the missing source frame without changing the failed review',()=>{
  const sources=[source('a'),source('b')],plan=planFor(sources),review=reviewFor(sources),before=structuredClone({sources,plan,review});
  const checks=parseVisualRetentionChecks(review.semantic!.visualRetentionChecks)!;
  assert.equal(visualRetentionFindings(checks,[requirement],[1,5]).length,1);
  assert.deepEqual(visualRetentionOmittedPlanningWitnesses(review,prompt,plan,sources),[
    {sourceId:'b',sourceHash:sources[1].analysis!.sourceHash,time:6,purpose:'confirmed-omission'},
    {sourceId:'a',sourceHash:sources[0].analysis!.sourceHash,time:6,purpose:'preserve-observed',outputTime:1},
  ]);
  let validations=0;
  const candidates=editorialRepairCandidates({sources,plan,review,prompt,validate:rows=>{
    validations++;
    const selected=selectScenes(rows,sources);
    return {...plan,targetSeconds:8,clips:selected.map(s=>({sourceId:s.sourceId,start:s.start,end:s.end}))};
  }})!;
  assert.ok(validations>0&&candidates.candidates.length>0);
  for(const option of candidates.candidates){
    assert.ok(option.selections.some(s=>s.sourceId==='a'&&s.sentenceIds.includes('a-1')));
    assert.ok(option.selections.some(s=>s.sourceId==='b'&&s.sentenceIds.includes('b-1')));
  }
  assert.deepEqual({sources,plan,review},before);
});

test('preserved observations reject invented samples, duplicate times, wrong source hashes, mixed owners and ambiguous transitions',()=>{
  const sources=[source('a'),source('b')],review=reviewFor(sources);
  for(const times of [[NaN],[-1],[1,1]])assert.throws(()=>parseVisualRetentionChecks([{...review.semantic!.visualRetentionChecks![0],preserveFrameTimes:times}]),VisualRetentionReviewError);
  const checks=parseVisualRetentionChecks(review.semantic!.visualRetentionChecks)!;
  assert.throws(()=>visualRetentionFindings(checks,[requirement],[5]),/实际成片抽帧/);
  for(const mode of ['hash','owner','overlap','outside'] as const){
    const media=structuredClone(sources),plan=planFor(media),r=structuredClone(review);
    if(mode==='hash')plan.editorial!.scenes[0].sourceHash='0'.repeat(64);
    if(mode==='owner')media[1].ownerId='foreign-owner';
    if(mode==='outside')r.semantic!.visualRetentionChecks![0].preserveFrameTimes=[20];
    if(mode==='overlap'){
      plan.clips[1].transition={kind:'fade',duration:.5};
      const boundary=timelineOffsets(plan)[1];r.semantic!.visualRetentionChecks![0].preserveFrameTimes=[boundary+.1];
    }
    assert.equal(visualRetentionOmittedPlanningWitnesses(r,prompt,plan,media),undefined,mode);
  }
});

test('partial observations remain mandatory when the missing half is unverified rather than confirmed absent',()=>{
  const sources=[source('a'),source('b')],plan=planFor(sources),review=reviewFor(sources);
  const check=review.semantic!.visualRetentionChecks![0];check.status='unverified';check.frameTimes=[];delete check.sourceOmitted;
  const before=structuredClone(review);
  assert.deepEqual(visualRetentionUnverifiedPlanningWitnesses(review,prompt,plan,sources),[
    {sourceId:'b',sourceHash:sources[1].analysis!.sourceHash,time:6,purpose:'resolve-unverified'},
    {sourceId:'a',sourceHash:sources[0].analysis!.sourceHash,time:6,purpose:'preserve-observed',outputTime:1},
  ]);
  assert.deepEqual(review,before,'planning observations never promote unknown to missing or passed');
  check.preserveFrameTimes=[20];assert.equal(visualRetentionUnverifiedPlanningWitnesses(review,prompt,plan,sources),undefined);
});

test('SDK repair rejects swapping away the already observed half and independently reviews both retained halves within two renders',async()=>{
  const sources=[source('a'),source('b')],before=structuredClone(sources),events:WorkflowEvent[]=[],plans:EditPlan[]=[];
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-key'};
  const original=globalThis.fetch;let selects=0,renders=0,reviews=0,current=selections(1,0);
  globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((t:any)=>t.function.name);let name:string,args:unknown;
    if(allowed.includes('select_scenes')){
      name='select_scenes';selects++;
      current=selects===1?selections(1,0):selects===2?selections(0,1):selections(1,1);
      if(selects===3)assert.match(JSON.stringify(payload.messages),/丢失了已经观察到/);
      args={scenes:current};
    }else{
      assert.deepEqual(allowed,['write_narrative']);name='write_narrative';
      args={premise:'保留完整原话和已有画面',audience:'普通观众',arc:'观察与证据边界',style:'完整画面原声',beats:selectScenes(current,sources).map(s=>({sceneId:s.id,intent:s.reason,graphic:'none',label:''}))};
    }
    return new Response(`data: ${JSON.stringify({id:'control',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:name+selects,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const result=await runEditorialWorkflow({prompt,config,sources,previous:null,export:true,
      transcribe:async id=>structuredClone(sources.find(s=>s.id===id)!.analysis!),verifySelection:async()=>{},inspect:async s=>({observations:'controlled',safeZone:'bottom',frameTimes:[s.start]}),persist:async()=>{},
      render:async plan=>{renders++;plans.push(structuredClone(plan));return {id:'control-'+renders,file:'not-a-real-movie.mp4'};},
      review:async(_file,plan)=>{
        reviews++;if(reviews===1)return reviewFor(sources);
        for(const id of ['a','b'])assert.ok(plan.clips.some(c=>c.sourceId===id&&c.start<=6&&c.end>6));
        return {status:'passed',score:88,checks:[],limitations:['Controlled review only; live full acceptance still required'],createdAt:''};
      },progress:async next=>{events.splice(0,events.length,...structuredClone(next));},
    });
    assert.equal(selects,3);assert.equal(renders,2);assert.equal(reviews,2);assert.equal(result.review!.status,'passed');
    assert.equal(result.rendered!.id,'control-2');assert.equal(plans.length,2);
    assert.ok(events.some(e=>e.tool==='select_scenes'&&e.status==='failed'&&/丢失了已经观察到/.test(e.detail||'')));
    assert.deepEqual(sources,before,'original words, ranges, hashes and complete flags stay immutable');
  }finally{globalThis.fetch=original;}
});
