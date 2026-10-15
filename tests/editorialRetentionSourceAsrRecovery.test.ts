import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { AudioAnalysis, EditPlan, MediaItem, RenderReview, TranscriptSentence, WorkflowEvent } from '../shared/types';
import { runEditorialWorkflow, selectScenes } from '../server/editorialWorkflow';
import { completeSourceCapacity, durationSourceRecovery, sourceWitnessHasCompleteSpeech, visualRetentionSourceRecovery } from '../server/sourceAsrRecovery';
import { extractVisualRetentionRequirements } from '../server/visualRetentionReview';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';
import { JobCancelledError } from '../server/jobExecution';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p22-retention-incomplete-tail.json',import.meta.url),'utf8'));
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-retention-recheck'};
const media=():MediaItem[]=>fixture.sources.map((source:any)=>({id:source.id,ownerId:'controlled-owner',name:source.id,kind:'video',mimeType:'video/mp4',url:'',createdAt:'',duration:source.duration,hasAudio:true,analysis:{status:'ready',modelId:'controlled-actual-projection',sourceHash:source.sourceHash,duration:source.duration,transcript:source.transcript,sentences:structuredClone(source.sentences),pauses:[],warnings:[],timing:'model-estimated',createdAt:''}}));
const first=(sources:MediaItem[])=>[
  {sourceId:'source-a',sentenceIds:sources[0].analysis!.sentences.slice(0,2).map(s=>s.id),reason:'保留观察过程与程序示意完整原话',purpose:'hook' as const},
  ...[0,3].map(index=>({sourceId:'source-b',sentenceIds:[sources[1].analysis!.sentences[index].id],reason:'用完整原话保留比较条件及未知限制',purpose:'comparison' as const})),
];
const script=(scenes:ReturnType<typeof selectScenes>)=>({premise:'观察与证据比较',audience:'普通观众',arc:'保留完整原声和证据界限',style:'程序示意',beats:scenes.map(scene=>({sceneId:scene.id,intent:scene.reason,graphic:'none' as const,label:''}))});
function previous(sources:MediaItem[]):EditPlan{
  const scenes=selectScenes(first(sources),sources).map(scene=>({...scene,visual:{observations:'Controlled cached frames',safeZone:'bottom' as const,frameTimes:[scene.start]}}));
  return{format:'16:9',summary:'Controlled original plan',fineCut:true,targetSeconds:20,clips:scenes.map(scene=>({sourceId:scene.sourceId,sceneId:scene.id,start:scene.start,end:scene.end,sentenceIds:scene.sentenceIds,zoom:1})),editorial:{scenes,script:script(scenes)}};
}
const failure=():RenderReview=>({status:'needs-review',score:72,checks:[{name:'用户明确视觉保留要求',passed:false,detail:'Actual P22 omitted source witness projection'}],limitations:[],createdAt:'',semantic:{score:72,findings:['重复观察画面缺失'],visualRetentionChecks:structuredClone(fixture.checks)}});

test('actual P22 adequate complete capacity does not suppress a bound required frame inside the false tail',()=>{
  const sources=media(),before=structuredClone(sources),plan=previous(sources),review=failure();
  assert.ok(completeSourceCapacity(sources)>20);assert.equal(durationSourceRecovery(sources,fixture.prompt),undefined);
  assert.deepEqual(extractVisualRetentionRequirements(fixture.prompt).map(r=>r.id),fixture.checks.map((c:any)=>c.id));
  const candidates=visualRetentionSourceRecovery(review,fixture.prompt,plan,sources);
  assert.equal(candidates.length,1);assert.equal(candidates[0].sourceId,'source-a');assert.equal(candidates[0].time,16.337);assert.equal(candidates[0].reason.kind,'duration-incomplete-tail');
  assert.deepEqual(candidates[0].reason.sentenceIds,['source-a:sentence:2']);assert.match(candidates[0].reason.detail,/16\.337.*未完成末句/);
  assert.equal(sourceWitnessHasCompleteSpeech(sources[0].analysis!,16.337),false);assert.deepEqual(sources,before);
});

test('missing, ambiguous, unrelated, selected and untrusted witnesses never authorize tail recovery',()=>{
  for(const mode of ['hash','source','duplicate-source','selected','complete','non-tail','no-omitted','unverified','passed','quote','missing-check','duplicate-check','empty-frames','nan-time','beyond-source','scene-hash','no-audio'] as const){
    const sources=media(),plan=previous(sources),review=failure(),check=review.semantic!.visualRetentionChecks![1];
    if(mode==='hash')check.sourceEvidence!.sourceHash='f'.repeat(64);
    if(mode==='source')check.sourceEvidence!.sourceId='another-source';
    if(mode==='duplicate-source')sources.push(structuredClone(sources[0]));
    if(mode==='selected')plan.clips[0].end=16.67;
    if(mode==='complete')sources[0].analysis!.sentences.at(-1)!.complete=true;
    if(mode==='non-tail')check.sourceEvidence!.time=3;
    if(mode==='no-omitted')delete check.sourceOmitted;
    if(mode==='unverified'){check.status='unverified';check.frameTimes=[];}
    if(mode==='passed')review.status='passed';
    if(mode==='quote')check.quote='不是用户实际要求';
    if(mode==='missing-check')review.semantic!.visualRetentionChecks!.pop();
    if(mode==='duplicate-check')review.semantic!.visualRetentionChecks![0]=structuredClone(check);
    if(mode==='empty-frames')check.frameTimes=[];
    if(mode==='nan-time')check.sourceEvidence!.time=NaN;
    if(mode==='beyond-source')check.sourceEvidence!.time=16.67;
    if(mode==='scene-hash')plan.editorial!.scenes[0].sourceHash='f'.repeat(64);
    if(mode==='no-audio')sources[0].hasAudio=false;
    assert.deepEqual(visualRetentionSourceRecovery(review,fixture.prompt,plan,sources),[],mode);
  }
});

// Real old word grids/complete flags above; SDK decisions and a new recognition
// response below are injected controls, not new ASR or a movie-quality claim.
function harness(mode:'recovered'|'recovered-other-tail'|'second-unmet'|'still-incomplete'|'wrong-hash'|'auth'|'cancel'|'no-callback'='recovered',preserveSelection=false){
  const sources=media(),old=structuredClone(sources),events:WorkflowEvent[]=[],plans:EditPlan[]=[],reviewInputs:RenderReview[]=[],counts={transcribe:0,recheck:0,select:0,write:0,render:0,inspect:0,verify:0};
  const critical=mode==='cancel'?new JobCancelledError():new Error('HTTP 401 unauthorized');let selected=first(sources);
  const fetch:typeof globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((tool:any)=>tool.function.name);let name:string,args:unknown;
    if(allowed.includes('select_scenes')){
      counts.select++;name='select_scenes';
      if(counts.select>1){
        assert.equal(counts.recheck,1);assert.match(JSON.stringify(payload.messages),/source-a:independent:tail/);
        selected=[{sourceId:'source-a',sentenceIds:[sources[0].analysis!.sentences.find(sentence=>sentence.id==='source-a:independent:tail')!.id],reason:'新的实际完整原话与必留重复观察画面一并选入',purpose:'hook'},...[0,1,2,3].map(index=>({sourceId:'source-b',sentenceIds:[sources[1].analysis!.sentences[index].id],reason:'保留比较条件与证据界限的完整原话',purpose:'comparison' as const}))];
      }
      args={scenes:selected};
    }else{assert.deepEqual(allowed,['write_narrative']);counts.write++;name='write_narrative';args=script(selectScenes(selected,sources));}
    return new Response(`data: ${JSON.stringify({id:'control',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'controlled-'+counts.select+'-'+counts.write,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  const run=()=>runEditorialWorkflow({prompt:fixture.prompt,config,sources,previous:preserveSelection?previous(sources):null,preserveSelection,export:true,
    transcribe:async id=>{counts.transcribe++;return sources.find(source=>source.id===id)!.analysis!;},
    recheckSource:mode==='no-callback'?undefined:async(id,reason)=>{
      counts.recheck++;assert.equal(id,'source-a');assert.equal(reason.sourceHash,old[0].analysis!.sourceHash);assert.equal(reason.kind,'duration-incomplete-tail');assert.match(reason.detail,/16\.337/);
      if(mode==='auth'||mode==='cancel')throw critical;
      const analysis=structuredClone(sources[0].analysis!);
      if(mode==='wrong-hash')analysis.sourceHash='f'.repeat(64);
      if(['recovered','recovered-other-tail','second-unmet'].includes(mode)){
        // Independent control response owns these words and its complete flag.
        const text='把观察和推测分开可以让表达更清楚也让后续核验有明确的方向';
        const sentence:TranscriptSentence={id:'source-a:independent:tail',text,start:10.47,end:16.67,complete:true,words:[...text].map((text,index,all)=>({text,start:10.47+6.2*index/all.length,end:10.47+6.2*(index+1)/all.length}))};
        analysis.sentences[2]=sentence;analysis.transcript=analysis.sentences.map(sentence=>sentence.text).join('\n');
        if(mode==='recovered-other-tail'){
          sentence.end=16.4;sentence.words.forEach((word,index,all)=>{word.start=10.47+5.93*index/all.length;word.end=10.47+5.93*(index+1)/all.length;});
          analysis.sentences.push({id:'independent-remaining-tail',text:'未完',start:16.5,end:16.67,complete:false,words:[{text:'未完',start:16.5,end:16.67}]});analysis.transcript=analysis.sentences.map(sentence=>sentence.text).join('\n');
        }
      }
      return analysis;
    },
    verifySelection:async scenes=>{counts.verify+=scenes.length;assert.ok(scenes.every(scene=>scene.sentenceIds.every(id=>sources.find(source=>source.id===scene.sourceId)!.analysis!.sentences.some(sentence=>sentence.id===id&&sentence.complete))));},
    inspect:async scene=>{counts.inspect++;return{observations:'Controlled image cache result',safeZone:'bottom',frameTimes:[scene.start]};},
    persist:async()=>{},render:async plan=>{counts.render++;plans.push(structuredClone(plan));return{id:'controlled-'+counts.render,file:'controlled-only-'+counts.render+'.mp4'};},
    review:async()=>{const review=failure();if(counts.render===2&&mode!=='second-unmet'){review.status='passed';review.score=88;review.checks.forEach(check=>check.passed=true);review.semantic!.findings=[];review.semantic!.visualRetentionChecks!.forEach(check=>{check.status='met';delete check.sourceOmitted;});}reviewInputs.push(structuredClone(review));return review;},
    progress:async next=>{events.splice(0,events.length,...structuredClone(next));},
  });
  return{run,fetch,counts,sources,old,events,plans,reviewInputs,critical};
}
async function execute<T>(h:ReturnType<typeof harness>,action:()=>Promise<T>){const fetch=globalThis.fetch;globalThis.fetch=h.fetch;try{return await action();}finally{globalThis.fetch=fetch;}}

test('bound tail omission independently rechecks once, invalidates old scene IDs and recompiles inside the original two-render cap',async()=>{
  const h=harness(),result=await execute(h,h.run);
  assert.equal(result.review!.status,'passed');assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,2);assert.equal(h.counts.transcribe,2);assert.equal(h.counts.select,2);assert.equal(h.counts.write,2);
  assert.equal(h.reviewInputs[0].score,72);assert.equal(h.reviewInputs[0].status,'needs-review');assert.ok(h.events.some(event=>event.tool==='review_edit'&&JSON.stringify(event.output).includes('72')));
  assert.deepEqual(h.sources[1],h.old[1]);assert.equal(h.old[0].analysis!.sentences[2].complete,false);assert.match(h.old[0].analysis!.sentences[2].text,/明确的方$/);
  assert.equal(h.sources[0].analysis!.sourceHash,h.old[0].analysis!.sourceHash);assert.ok(result.plan.clips.some(clip=>clip.sourceId==='source-a'&&clip.sentenceIds?.includes('source-a:independent:tail')&&clip.start<=16.337&&clip.end>16.337));
  assert.ok(h.plans.every(plan=>plan.clips.every(clip=>clip.zoom===1)));assert.ok(result.plan.targetSeconds>=18&&result.plan.targetSeconds<=22);
  assert.equal(h.counts.verify,6,'changed and new groups rechecked; the two unchanged source-b groups retain verification');assert.equal(h.counts.inspect,6);
});

for(const mode of ['still-incomplete','wrong-hash','no-callback'] as const)test('required tail cannot be filled, forced complete or replayed after bounded recovery: '+mode,async()=>{
  const h=harness(mode);await execute(h,()=>assert.rejects(h.run(),/有限|复听结果不匹配/));assert.equal(h.counts.recheck,mode==='no-callback'?0:1);assert.equal(h.counts.render,1);assert.equal(h.counts.select,1);assert.equal(h.reviewInputs[0].score,72);assert.deepEqual(h.sources,h.old);
});
for(const mode of ['auth','cancel'] as const)test('critical source recheck errors retain the original object and no further media call: '+mode,async()=>{
  const h=harness(mode);await execute(h,()=>assert.rejects(h.run(),error=>error===h.critical));assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,1);assert.equal(h.counts.select,1);assert.deepEqual(h.sources,h.old);
});
test('an explicit fixed selection does not authorize a tail recheck or replacement',async()=>{
  const h=harness('recovered',true),result=await execute(h,h.run);assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,72);assert.equal(h.counts.recheck,0);assert.equal(h.counts.select,0);assert.equal(h.counts.render,1);assert.deepEqual(h.sources,h.old);
});
test('a genuinely incomplete later tail remains false when other complete speech can carry the required witness',async()=>{
  const h=harness('recovered-other-tail'),result=await execute(h,h.run);assert.equal(result.review!.status,'passed');assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,2);assert.equal(h.sources[0].analysis!.sentences.at(-1)!.complete,false);assert.ok(!result.plan.clips.some(clip=>clip.sentenceIds?.includes('independent-remaining-tail')));
});
test('a second unmet review keeps its raw score and cannot grant a third render or another source recognition',async()=>{
  const h=harness('second-unmet'),result=await execute(h,h.run);assert.equal(result.review!.status,'needs-review');assert.equal(result.review!.score,72);assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,2);assert.equal(h.counts.select,2);assert.equal(h.reviewInputs.length,2);
});
