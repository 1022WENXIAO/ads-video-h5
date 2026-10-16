import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {EditPlan,MediaItem,RenderReview,SelectedScene} from '../shared/types';
import {visualRetentionSelectionNeeded,visualRetentionUnverifiedPlanningWitnesses} from '../server/visualRetentionReview';
import {editorialRepairCandidates,type EditorialRepairSelection} from '../server/editorialRepairCandidates';
import {runEditorialWorkflow,selectScenes,splitSceneSelections} from '../server/editorialWorkflow';
import {sourceWitnessHasCompleteSpeech,visualRetentionSourceRecovery,SourceAsrRecoveryError} from '../server/sourceAsrRecovery';
import {validatePlan} from '../server/core';
import {applyTimelineRequest} from '../server/timeline';
import {editProposalNarrativeFeedback} from '../server/editProposal';
import {ARK_BASE_URL,TEXT_MODEL_PRESETS} from '../shared/textModels';
import {JobCancelledError} from '../server/jobExecution';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p36-unverified-retention-planning.json',import.meta.url),'utf8'));
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-planning-key'};
function actual(){
  // These metadata fields only complete the local SDK harness. Original source
  // hashes, sentence completeness, word texts/times and review remain actual.
  const sources=structuredClone(fixture.sources).map((s:MediaItem)=>({...s,ownerId:'controlled-owner',mimeType:'video/mp4',url:'',createdAt:'',analysis:{...s.analysis!,modelId:'actual-projection',createdAt:''}})) as MediaItem[];
  return {sources,plan:structuredClone(fixture.plan) as EditPlan,review:{...structuredClone(fixture.review),limitations:[]} as RenderReview,prompt:fixture.prompt as string};
}
function validator(x:ReturnType<typeof actual>){return(selections:EditorialRepairSelection[])=>{
  const selected=selectScenes(splitSceneSelections(selections,x.sources),x.sources);
  const base:EditPlan={format:x.plan.format,summary:'Original whole-sentence feasibility only',targetSeconds:0,fineCut:true,audio:x.plan.audio,clips:selected.map(s=>({sceneId:s.id,sourceId:s.sourceId,start:s.start,end:s.end,sentenceIds:s.sentenceIds,purpose:s.purpose,zoom:1,transition:{kind:'cut',duration:0}}))};
  try{const p=applyTimelineRequest(validatePlan(base,x.sources),x.prompt+' 同步字幕',x.sources);return editProposalNarrativeFeedback(p,x.sources).length?undefined:p;}
  catch(error){if(error instanceof Error&&/^(?:原句合计|分镜需至少|同一分镜只能|口播精剪|片段时间超出素材|成片最长|剪辑方案时长)/.test(error.message))return;throw error;}
};}
const oldSelection=(x:ReturnType<typeof actual>):EditorialRepairSelection[]=>x.plan.clips.map(c=>({sourceId:c.sourceId,sentenceIds:c.sentenceIds!,reason:'保留实际完整原话与原有方法对照画面',purpose:c.purpose||'argument'}));
function inclusionSelection(x:ReturnType<typeof actual>,includeObserved=true):EditorialRepairSelection[]{return x.sources.flatMap((source,index)=>(index===1&&includeObserved?[0,2,3]:[0,3]).map(i=>({sourceId:source.id,sentenceIds:[source.analysis!.sentences[i].id],reason:'完整保留实际观察顺序、比较条件及证据边界，并包含已绑定源见证',purpose:(index===0&&i===0?'hook':i===3?'conclusion':'comparison') as SelectedScene['purpose']})));}

test('actual P36 unverified tail permits planning inclusion without changing any verdict, words or hashes',()=>{
  const x=actual(),before=structuredClone(x),witnesses=visualRetentionUnverifiedPlanningWitnesses(x.review,x.prompt,x.plan,x.sources)!;
  assert.equal(visualRetentionSelectionNeeded(x.review,x.prompt,x.plan),false,'no manufactured confirmed omission');
  assert.deepEqual(witnesses.map(w=>w.purpose),['preserve-met','resolve-unverified','preserve-observed','preserve-observed']);
  assert.ok(Math.abs(witnesses[2].time-9.995)<1e-9);assert.ok(Math.abs(witnesses[3].time-12.481)<1e-9);assert.deepEqual(witnesses.slice(2).map(w=>w.outputTime),[14.865,16.351]);
  assert.equal(sourceWitnessHasCompleteSpeech(x.sources[0].analysis!,16.337),true);
  assert.deepEqual(visualRetentionSourceRecovery(x.review,x.prompt,x.plan,x.sources),[],'the actual complete tail needs no ASR');
  const result=editorialRepairCandidates({...x,validate:validator(x)})!;assert.ok(result.candidates.length>0&&result.candidates.length<=3);assert.match(result.detail,/不认定原片缺失/);
  for(const c of result.candidates){const p=validator(x)(c.selections)!;assert.ok(p.targetSeconds>=18&&p.targetSeconds<=22);for(const w of witnesses)assert.ok(p.clips.some(c=>c.sourceId===w.sourceId&&w.time>=c.start&&w.time<c.end));}
  const four=validator(x)(inclusionSelection(x,false))!;assert.ok(four.targetSeconds>=18&&four.targetSeconds<=22,'four complete actual sentences fit the unchanged20s band');
  assert.ok(!four.clips.some(c=>c.sourceId===x.sources[1].id&&witnesses[2].time>=c.start&&witnesses[2].time<c.end),'four sentences alone omit an already-observed compound part, so are not a full planning candidate');
  const five=validator(x)(inclusionSelection(x))!;assert.ok(five.targetSeconds>=18&&five.targetSeconds<=22,'separate whole-sentence entries retain the compound observations within the original duration band');
  for(const w of witnesses)assert.ok(five.clips.some(c=>c.sourceId===w.sourceId&&w.time>=c.start&&w.time<c.end));
  assert.ok(result.candidates.some(c=>c.selections.filter(s=>s.sourceId===x.sources[1].id).some(s=>s.sentenceIds.includes(x.sources[1].analysis!.sentences[2].id))&&c.selections.some(s=>s.sentenceIds.includes(x.sources[1].analysis!.sentences[3].id))));
  assert.deepEqual(x,before);assert.equal(x.review.score,89);assert.equal(x.review.semantic!.visualRetentionChecks![1].status,'unverified');assert.equal(x.review.semantic!.visualRetentionChecks![1].sourceOmitted,undefined);
});

for(const mode of ['no-witness','wrong-source','wrong-hash','wrong-owner','duplicate-source','inside','nan','source-end','bad-duration','bad-range','stale-scene','missing-requirement','duplicate-check','wrong-quote','invented-omitted','met-unbound','met-outside','met-stale-omitted','no-audio','passed','outside-output-time','nan-output-time','crossfade-overlap','observed-hash','observed-scene','observed-missing-source'] as const)test('unknown planning fails closed: '+mode,()=>{
  const x=actual(),check=x.review.semantic!.visualRetentionChecks![1],met=x.review.semantic!.visualRetentionChecks![0];
  if(mode==='no-witness')delete check.sourceEvidence;
  if(mode==='wrong-source')check.sourceEvidence!.sourceId='another-owner-source';
  if(mode==='wrong-hash')check.sourceEvidence!.sourceHash='f'.repeat(64);
  if(mode==='wrong-owner')x.sources[0].ownerId='another-owner';
  if(mode==='duplicate-source')x.sources.push(structuredClone(x.sources[0]));
  if(mode==='inside')check.sourceEvidence!.time=1;
  if(mode==='nan')check.sourceEvidence!.time=NaN;
  if(mode==='source-end')check.sourceEvidence!.time=x.sources[0].duration!;
  if(mode==='bad-duration')x.sources[0].analysis!.duration=NaN;
  if(mode==='bad-range')x.plan.clips[0].end=NaN;
  if(mode==='stale-scene')x.plan.editorial!.scenes.filter(s=>s.sourceId===x.sources[0].id).forEach(s=>s.sourceHash='f'.repeat(64));
  if(mode==='missing-requirement')x.review.semantic!.visualRetentionChecks!.pop();
  if(mode==='duplicate-check')x.review.semantic!.visualRetentionChecks!.push(structuredClone(check));
  if(mode==='wrong-quote')check.quote+='not the user request';
  if(mode==='invented-omitted')check.sourceOmitted=true;
  if(mode==='met-unbound')delete met.sourceEvidence;
  if(mode==='met-outside')met.sourceEvidence!.time=16;
  if(mode==='met-stale-omitted')met.sourceOmitted=true;
  if(mode==='no-audio')x.sources[0].hasAudio=false;
  if(mode==='passed')x.review.status='passed';
  if(mode==='outside-output-time')check.frameTimes=[99];
  if(mode==='nan-output-time')check.frameTimes=[NaN];
  if(mode==='crossfade-overlap')x.plan.clips[4].transition={kind:'fade',duration:2};
  if(mode==='observed-hash')x.sources[1].analysis!.sourceHash='f'.repeat(64);
  if(mode==='observed-scene')x.plan.clips[3].sceneId='not-the-reviewed-scene';
  if(mode==='observed-missing-source')x.sources.pop();
  assert.equal(visualRetentionUnverifiedPlanningWitnesses(x.review,x.prompt,x.plan,x.sources),undefined);
  let validated=0;assert.equal(editorialRepairCandidates({...x,validate:()=>{validated++;return x.plan;}}),undefined);assert.equal(validated,0);
});

test('actual compound observations need independently cut complete sentences, not a forced intervening pause',()=>{
  const x=actual(),before=structuredClone(x.sources),separate=inclusionSelection(x);
  const grouped=x.sources.map(source=>({sourceId:source.id,sentenceIds:separate.filter(s=>s.sourceId===source.id).flatMap(s=>s.sentenceIds),reason:'相同完整原句，只比较合法分镜组织',purpose:'comparison' as const}));
  assert.equal(validator(x)(grouped),undefined,'merging source2 adjacent sentences2/3 retains their1.16s gap and exceeds the unchanged duration band');
  const independent=validator(x)(separate)!;assert.ok(independent.targetSeconds>=18&&independent.targetSeconds<=22);
  const words=(s:EditorialRepairSelection[])=>selectScenes(splitSceneSelections(s,x.sources),x.sources).map(c=>c.quote).join('');assert.equal(words(separate),words(grouped),'splitting complete sentences neither cuts nor adds any spoken word');
  const candidates=editorialRepairCandidates({...x,validate:validator(x)})!;assert.ok(candidates.candidates.some(c=>c.selections.some(s=>s.sourceId===x.sources[1].id&&s.sentenceIds.length===1&&s.sentenceIds[0]===x.sources[1].analysis!.sentences[2].id)));
  assert.deepEqual(x.sources,before);
});

test('planning variants keep the original search and validation bounds and disclose incomplete search',()=>{
  const x=actual();
  for(const source of x.sources){source.duration=source.analysis!.duration=40;source.analysis!.sentences=Array.from({length:9},(_,i)=>({id:source.id+':control:'+i,start:i*2,end:i*2+1.5,text:'受控完整原句',complete:true,words:[{text:'受控完整原句',start:i*2,end:i*2+1.5}]}));}
  const before=structuredClone(x.sources);let calls=0;
  const result=editorialRepairCandidates({...x,validate:()=>{calls++;return {...x.plan,targetSeconds:20,clips:x.sources.map(s=>({sourceId:s.id,start:0,end:40}))};}})!;
  assert.equal(result.search.limited,true);assert.ok(result.search.visited<=5000&&result.search.validated<=240&&calls<=240);assert.ok(result.candidates.length<=3);assert.match(result.detail,/未穷尽/);assert.deepEqual(x.sources,before);
});

test('each unknown needs its own bound witness, including an exact end-exclusive cut point',()=>{
  const x=actual();x.review.semantic!.visualRetentionChecks![0].status='unverified';
  assert.equal(visualRetentionUnverifiedPlanningWitnesses(x.review,x.prompt,x.plan,x.sources),undefined,'one valid tail cannot authorize another inside unknown');
  x.review.semantic!.visualRetentionChecks![0].status='met';
  x.review.semantic!.visualRetentionChecks![1].sourceEvidence!.time=9.46;
  assert.equal(visualRetentionUnverifiedPlanningWitnesses(x.review,x.prompt,x.plan,x.sources)?.[1].time,9.46,'clip end is not included; this is planning only');
});

function script(selected:SelectedScene[]){return{premise:'观察、解释与公平比较的方法对照',audience:'普通观众',arc:'保留观察顺序、公平比较条件和未知限制的完整原话',style:'保持原比例原声程序示意',beats:selected.map(s=>({sceneId:s.id,intent:s.reason,graphic:'none' as const,label:''}))};}
async function harness(mode:'passed'|'still-unknown'|'lower'|'no-witness'|'fixed'|'drops-met'|'same-selection'|'false-tail'|'rechecked'|'auth'|'cancel'){
  const x=actual(),before=structuredClone(x.sources),counts={select:0,write:0,render:0,review:0,recheck:0},plans:EditPlan[]=[],reviews:RenderReview[]=[],events:any[]=[];
  if(mode==='no-witness')delete x.review.semantic!.visualRetentionChecks![1].sourceEvidence;
  if(['false-tail','rechecked','auth','cancel'].includes(mode))x.sources[0].analysis!.sentences.at(-1)!.complete=false;
  const critical=mode==='cancel'?new JobCancelledError():new Error('HTTP 401 unauthorized');
  let selection=oldSelection(x);const original=globalThis.fetch;
  globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((t:any)=>t.function.name);let name:string,args:unknown;
    if(allowed.includes('select_scenes')){
      name='select_scenes';counts.select++;
      if(counts.select>1){
        assert.ok(JSON.stringify(payload.messages).includes('原审查仍为未验证'));assert.ok(JSON.stringify(payload.messages).includes('16.337')||JSON.stringify(payload.messages).includes('repairCandidates'));
        selection=inclusionSelection(x);
        if(mode==='same-selection')selection=oldSelection(x);
        if(mode==='drops-met')selection=[selection[1],...[0,1,2,3].map(i=>({sourceId:x.sources[1].id,sentenceIds:[x.sources[1].analysis!.sentences[i].id],reason:'保留完整比较原话及未知限制的实际方法表达',purpose:'comparison' as const}))];
      }
      args={scenes:selection};
    }else{assert.deepEqual(allowed,['write_narrative']);name='write_narrative';counts.write++;args=script(selectScenes(splitSceneSelections(selection,x.sources),x.sources));}
    return new Response(`data: ${JSON.stringify({id:'control',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'control-'+counts.select+'-'+counts.write,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  const previous=mode==='fixed'?{...x.plan,editorial:{...x.plan.editorial!,script:script(selectScenes(splitSceneSelections(selection,x.sources),x.sources)),scenes:x.plan.editorial!.scenes.map(s=>({...s,visual:{observations:'Controlled cached framing only',safeZone:'bottom' as const,frameTimes:[s.start]}}))}}:null;
  try{
    const result=await runEditorialWorkflow({prompt:x.prompt,config,sources:x.sources,previous,preserveSelection:mode==='fixed',export:true,transcribe:async id=>x.sources.find(s=>s.id===id)!.analysis!,verifySelection:async()=>{},inspect:async scene=>({observations:'Controlled framing, not actual image acceptance',safeZone:'bottom',frameTimes:[scene.start]}),persist:async()=>{},recheckSource:async()=>{counts.recheck++;if(mode==='auth'||mode==='cancel')throw critical;const next=structuredClone(x.sources[0].analysis!);if(mode==='rechecked'){next.modelId='controlled-independent-recheck';next.sentences.at(-1)!.complete=true;}return next;},
      render:async p=>{counts.render++;assert.ok(counts.render<=2);plans.push(structuredClone(p));return{id:'control-'+counts.render,file:'controlled-not-a-real-movie-'+counts.render+'.mp4'};},
      review:async()=>{counts.review++;const r=structuredClone(x.review);if(counts.review===2){if(mode==='passed'){r.status='passed';r.score=91;r.checks.forEach(c=>c.passed=true);r.semantic!.score=91;r.semantic!.findings=[];r.semantic!.visualRetentionChecks!.forEach(c=>{c.status='met';});}else if(mode==='lower'){r.score=0;delete r.semantic;} }reviews.push(structuredClone(r));return r;},progress:async next=>{events.splice(0,events.length,...structuredClone(next));}});
    return{result,counts,plans,reviews,events,x,before,critical};
  }catch(error){return{error,counts,plans,reviews,events,x,before,critical};}finally{globalThis.fetch=original;}
}

for(const mode of ['passed','still-unknown','lower'] as const)test('actual timing SDK route resolves only by new inclusion plus existing review: '+mode,async()=>{
  const h=await harness(mode);assert.ok(!('error' in h),String('error' in h&&h.error));assert.deepEqual(h.counts,{select:2,write:2,render:2,review:2,recheck:0});
  for(const t of [.37,16.337])assert.ok(h.plans[1].clips.some(c=>c.sourceId===h.x.sources[0].id&&t>=c.start&&t<c.end));
  assert.equal(h.reviews[0].score,89);assert.equal(h.reviews[0].semantic!.visualRetentionChecks![1].status,'unverified');assert.equal(h.reviews[0].semantic!.visualRetentionChecks![1].sourceOmitted,undefined);
  assert.equal(h.result!.review!.status,mode==='passed'?'passed':'needs-review');assert.equal(h.result!.review!.score,mode==='passed'?91:89);assert.equal(h.result!.rendered!.id,mode==='lower'?'control-1':'control-2');
  assert.deepEqual(h.x.sources,h.before,'no re-ASR or word/time/hash edits for a complete actual tail');
});
for(const mode of ['no-witness','fixed'] as const)test('uncertainty without permission retains one original render: '+mode,async()=>{
  const h=await harness(mode);assert.ok(!('error' in h));assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);assert.equal(h.counts.recheck,0);assert.equal(h.result!.review!.score,89);assert.equal(h.result!.review!.status,'needs-review');
});
test('incomplete witness uses only existing bounded same-source recheck and still-false speech stops',async()=>{
  const h=await harness('false-tail');assert.ok('error' in h&&h.error instanceof SourceAsrRecoveryError);assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,1);assert.equal(h.x.sources[0].analysis!.sentences.at(-1)!.complete,false);
});
test('only an independent controlled recheck can make its own false-tail result eligible, without changing raw words or time',async()=>{
  const h=await harness('rechecked');assert.ok(!('error' in h));assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,2);assert.equal(h.counts.review,2);assert.equal(h.result.review!.status,'needs-review','new inclusion is not automatic semantic acceptance');
  assert.deepEqual(h.x.sources[0].analysis!.sentences.map(s=>s.words),h.before[0].analysis!.sentences.map(s=>s.words));assert.equal(h.x.sources[0].analysis!.sourceHash,h.before[0].analysis!.sourceHash);
  assert.equal(fixture.sources[0].analysis.sentences.at(-1).complete,true,'actual fixture stays unchanged; false and independently corrected flags above are explicit controls');
});
for(const mode of ['auth','cancel'] as const)test('critical recheck failure is not swallowed by best preservation or phase change: '+mode,async()=>{
  const h=await harness(mode);assert.ok('error' in h);assert.equal(h.error,h.critical);assert.equal(h.counts.recheck,1);assert.equal(h.counts.render,1);assert.equal(h.counts.review,1);
});
for(const mode of ['drops-met','same-selection'] as const)test('new selection cannot discard an already-met bound witness or repeat the old selection: '+mode,async()=>{
  const h=await harness(mode);assert.equal(h.counts.render,1);assert.equal(h.counts.recheck,0);assert.equal(h.reviews[0].score,89);
  assert.ok(h.events.some(e=>e.status==='failed'&&new RegExp(mode==='drops-met'?'选段必须覆盖已绑定的原画面见证':'画面保留状态仍未验证').test(e.detail||'')),JSON.stringify(h.events));
  if(!('error' in h)){assert.equal(h.result.review!.status,'needs-review');assert.equal(h.result.review!.score,89);assert.equal(h.result.rendered!.id,'control-1');}
});
