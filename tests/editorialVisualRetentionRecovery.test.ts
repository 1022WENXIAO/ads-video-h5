import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { EditPlan, MediaItem, NarrativeScript, RenderReview, SelectedScene, WorkflowEvent } from '../src/types';
import { runEditorialWorkflow, selectScenes } from '../server/editorialWorkflow';
import { extractVisualRetentionRequirements } from '../server/visualRetentionReview';
import { TextTransportError } from '../server/executionErrors';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

// Controlled SDK decisions, cached ASR and review observations exercise routing
// only. These fake media paths/grades do not prove a real rendered movie passed.
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'fake-retention-key'};
const prompt='剪成8秒横屏，完整画面不要裁切，保留画面里重复观察的标签，保留完整原话和原声，不新增配音。';
const requirement=extractVisualRetentionRequirements(prompt)[0];
function source(id:string,texts:string[]):MediaItem{
  const sentences=texts.map((text,index)=>({id:id+'-'+index,start:index*5,end:index*5+4,text,complete:true,words:[{text,start:index*5,end:index*5+4}]}));
  return {id,name:id+'.mp4',kind:'video',mimeType:'video/mp4',url:'',duration:sentences.at(-1)!.end,createdAt:'',analysis:{status:'ready',modelId:'cached-control',sourceHash:createHash('sha256').update('controlled-source-'+id).digest('hex'),duration:sentences.at(-1)!.end,transcript:texts.join(''),sentences,pauses:[],warnings:[],timing:'model-estimated',createdAt:''}};
}
type Mode='omitted'|'unverified'|'generic-unmet'|'layout'|'same-selection'|'second-unmet'|'review-error'|'missing-checks'|'duplicate-checks'|'wrong-clause'|'empty-frame';
function harness(mode:Mode,options:{preserveSelection?:boolean;reuse?:boolean;error?:Error;onReview?:()=>void}={}){
  const media=[source('source-a',['先记录看到的现象。','重复观察才能核验解释。']),source('source-b',['条件相同才方便比较。'])];
  const before=structuredClone(media),events:WorkflowEvent[]=[],counts={select:0,write:0,transcribe:0,verify:0,inspect:0,render:0,review:0},renderPlans:EditPlan[]=[],persisted:EditPlan[]=[];
  const input=(later:boolean)=>[{sourceId:'source-a',sentenceIds:[later?'source-a-1':'source-a-0'],reason:'保留完整原话和实际示意画面',purpose:'hook' as const},{sourceId:'source-b',sentenceIds:['source-b-0'],reason:'对照相同条件，保留完整原话',purpose:'comparison' as const}];
  let selected=input(false);
  const script=(scenes:SelectedScene[]):NarrativeScript=>({premise:'观察、核验与比较',audience:'普通观众',arc:'用完整原话解释方法与证据边界',style:'保留程序示意和原声',beats:scenes.map(scene=>({sceneId:scene.id,intent:scene.reason,graphic:'none',label:''}))});
  const priorScenes=selectScenes(selected,media).map(scene=>({...scene,visual:{observations:'Cached source frame analysis',safeZone:'bottom' as const,frameTimes:[scene.start]}}));
  const previous:EditPlan={format:'16:9',summary:'已审查选段',targetSeconds:8,fineCut:true,clips:priorScenes.map(scene=>({sceneId:scene.id,sourceId:scene.sourceId,start:scene.start,end:scene.end,sentenceIds:scene.sentenceIds,zoom:1,transition:{kind:'cut',duration:0}})),editorial:{scenes:priorScenes,script:script(priorScenes)}};
  const fetch:typeof globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((tool:any)=>tool.function.name);
    let name:string,args:unknown;
    if(allowed.includes('select_scenes')){
      counts.select++;name='select_scenes';
      if(counts.select>1){
        assert.match(JSON.stringify(payload.messages),/重复观察/);
        if(mode==='same-selection'&&counts.select===2)selected=input(false).map(entry=>({...entry,reason:'仅更换理由，物理选段完全相同'}));
        else selected=input(true);
      }
      args={scenes:selected};
    }else{
      assert.deepEqual(allowed,['write_narrative']);name='write_narrative';counts.write++;
      const nextScript=script(selectScenes(selected,media));
      if(counts.write>1){nextScript.arc='只重述原选段的理由，没有改变原话或源范围';nextScript.premise='更清楚地解释观察与比较';}
      if(mode==='layout'&&counts.write>1)nextScript.beats[0]={...nextScript.beats[0],graphic:'underline',label:'重复观察'};
      args=nextScript;
    }
    return new Response(`data: ${JSON.stringify({id:'control',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'retention-'+name+'-'+counts.select+'-'+counts.write,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  function review(plan:EditPlan):RenderReview{
    const met=(mode==='layout'?counts.render===2:plan.clips.some(clip=>clip.sourceId==='source-a'&&clip.sentenceIds?.includes('source-a-1')))&&mode!=='second-unmet';
    const status=mode==='unverified'?'unverified':met?'met':'unmet';
    const omitted=!['layout','generic-unmet','unverified'].includes(mode);
    return {status:met?'passed':'needs-review',score:met?88:97,checks:[{name:'用户明确视觉保留要求',passed:met,detail:met?'Controlled frame includes requested label':'Controlled observation of an unmet or unverified clause'}],limitations:[],createdAt:'',semantic:{score:97,findings:met?[]:['用户点名的重复观察画面未满足或未验证'],visualRetentionChecks:[{...requirement,status,frameTimes:status==='unverified'?[]:[.5],detail:status==='unverified'?'抽帧不足以判断':'实际抽帧中未包含用户点名的标签',...(status!=='unverified'?{sourceEvidence:{sourceId:'source-a',time:omitted?6:1,sourceHash:media[0].analysis!.sourceHash},...(omitted?{sourceOmitted:true as const}:{})}:{})}]}};
  }
  const run=()=>runEditorialWorkflow({prompt,config,sources:media,previous:options.preserveSelection||options.reuse?previous:null,...options,export:true,
    transcribe:async id=>{counts.transcribe++;return structuredClone(media.find(item=>item.id===id)!.analysis!);},
    verifySelection:async scenes=>{counts.verify+=scenes.length;},
    inspect:async scene=>{counts.inspect++;return {observations:'Controlled actual frame analysis',safeZone:'bottom',frameTimes:[scene.start]};},
    persist:async plan=>{persisted.push(structuredClone(plan));},
    render:async plan=>{counts.render++;renderPlans.push(structuredClone(plan));return {id:'controlled-'+counts.render,file:'control-only-'+counts.render+'.mp4'};},
    review:async(_file,plan)=>{
      counts.review++;options.onReview?.();if(options.error)throw options.error;const checked=review(plan);
      if(mode==='missing-checks')delete checked.semantic!.visualRetentionChecks;
      if(mode==='duplicate-checks')checked.semantic!.visualRetentionChecks!.push(structuredClone(checked.semantic!.visualRetentionChecks![0]));
      if(mode==='wrong-clause')checked.semantic!.visualRetentionChecks![0].quote+='非用户原句';
      if(mode==='empty-frame')checked.semantic!.visualRetentionChecks![0].frameTimes=[];
      return checked;
    },
    progress:async next=>{events.splice(0,events.length,...structuredClone(next));},
  });
  return {run,fetch,counts,events,media,before,renderPlans,persisted};
}
async function execute(mode:Mode,options:Parameters<typeof harness>[1]={}){
  const h=harness(mode,options),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{return {h,result:await h.run()};}finally{globalThis.fetch=original;}
}

test('a bound omitted source expression reselects whole sentences and reuses completed ASR and unchanged frame analysis',async()=>{
  const {h,result}=await execute('omitted');
  assert.equal(result.review!.status,'passed',JSON.stringify({counts:h.counts,limits:result.review!.limitations,events:h.events.map(event=>({tool:event.tool,status:event.status,detail:event.detail}))}));assert.equal(h.counts.render,2);assert.equal(h.counts.review,2);assert.equal(h.counts.select,2);assert.equal(h.counts.write,2);
  assert.equal(h.counts.transcribe,2);assert.equal(h.counts.verify,3);assert.equal(h.counts.inspect,3);
  assert.deepEqual(h.media,h.before,'source words, complete flags, times and hashes remain unchanged');
  assert.equal(h.renderPlans[0].clips[0].start,0);assert.ok(h.renderPlans[1].clips[0].start<=5&&h.renderPlans[1].clips[0].start>4);assert.equal(h.renderPlans[1].clips[1].start,0);
  assert.ok(h.renderPlans.every(plan=>plan.clips.every(clip=>clip.zoom===1)));
  const reviews=h.events.filter(event=>event.tool==='review_edit');assert.equal(reviews.length,2);assert.match(JSON.stringify(reviews[0].output),/97/,'the original score is retained in actual trace');
});

test('valid unverified retention preserves the original high score and movie without narrative or media replay',async()=>{
  const {h,result}=await execute('unverified');
  assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,97);assert.equal(result.rendered!.id,'controlled-1');
  assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);assert.equal(h.counts.select,1);assert.equal(h.counts.write,1);assert.match(result.review!.limitations.join(' '),/未验证/);
});

for(const mode of ['missing-checks','duplicate-checks','wrong-clause','empty-frame'] as const)test('unbound retention evidence cannot authorize new selection or same-media replay: '+mode,async()=>{
  const {h,result}=await execute(mode);assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,97);assert.equal(h.counts.select,1);assert.equal(h.counts.write,1);assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);assert.match(result.review!.limitations.join(' '),/未验证/);
});

test('an already selected source expression can receive an actual drawing repair without reselection',async()=>{
  const {h,result}=await execute('layout');assert.equal(result.review!.status,'passed');assert.equal(h.counts.select,1);assert.equal(h.counts.write,2);assert.equal(h.counts.render,2);assert.equal(h.counts.review,2);assert.equal(h.counts.verify,2);assert.equal(h.counts.inspect,2);
  assert.deepEqual(h.renderPlans[0].clips,h.renderPlans[1].clips);assert.equal(h.renderPlans[0].motions!.length,0);assert.equal(h.renderPlans[1].motions![0].label,'重复观察');assert.deepEqual(h.renderPlans[0].audio,h.renderPlans[1].audio);
});

test('narrative-only repair cannot rerender identical actual media inputs or obtain a second changed model grade',async()=>{
  const {h,result}=await execute('generic-unmet');assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,97);assert.equal(result.rendered!.id,'controlled-1');assert.equal(h.counts.select,1);assert.equal(h.counts.write,2);assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);
  assert.ok(h.events.some(event=>event.tool==='render_edit'&&event.status==='failed'&&/实际渲染参数.*完全相同/.test(event.detail||'')));assert.match(result.review!.limitations.join(' '),/保留/);
});

for(const key of ['preserveSelection','reuse'] as const)test(`bound retention omission cannot silently change an explicit ${key} selection`,async()=>{
  const {h,result}=await execute('omitted',{[key]:true});
  assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,97);assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);assert.equal(h.counts.select,0);assert.equal(h.counts.write,0);assert.equal(h.counts.transcribe,0);assert.equal(h.counts.inspect,0);assert.match(result.review!.limitations.join(' '),/固定选段/);
});

test('rewording the same omitted source selection cannot spend the remaining render slot',async()=>{
  const {h,result}=await execute('same-selection');assert.equal(result.review!.status,'passed');assert.equal(h.counts.select,3);assert.equal(h.counts.render,2);assert.equal(h.counts.verify,3);assert.equal(h.counts.inspect,3);
  assert.equal(h.events.filter(event=>event.tool==='select_scenes'&&event.status==='failed').length,1);assert.ok(h.events.some(event=>event.tool==='select_scenes'&&/仅改理由或叙事/.test(event.detail||'')));
});

test('a second independently reviewed omission remains needs-review at the original two-render cap',async()=>{
  const {h,result}=await execute('second-unmet');assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,97);assert.equal(h.counts.render,2);assert.equal(h.counts.review,2);assert.equal(h.counts.select,2);assert.equal(h.counts.write,2);
});

for(const error of [new Error('HTTP 401 unauthorized'),new TextTransportError(3,new Error('connection reset; request outcome unknown'))])test('review failure does not authorize retention reselection or blind media replay: '+error.name,async()=>{
  const h=harness('review-error',{error}),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{await assert.rejects(h.run(),/401|TRANSPORT|暂时不可用|connection reset/);assert.equal(h.counts.select,1);assert.equal(h.counts.write,1);assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);}
  finally{globalThis.fetch=original;}
});

test('cancellation during review stays cancellation and cannot authorize reselection or another media submission',async()=>{
  const controller=new AbortController(),h=harness('review-error',{onReview:()=>controller.abort(),error:new Error('request outcome unknown')}),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{await assert.rejects(runWithJobSignal(controller.signal,h.run),JobCancelledError);assert.equal(h.counts.select,1);assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);}
  finally{globalThis.fetch=original;}
});
