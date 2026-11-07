import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {EditPlan,MediaItem} from '../shared/types';
import {editorialRepairCandidates} from '../server/editorialRepairCandidates';
import {selectScenes,splitSceneSelections} from '../server/editorialWorkflow';
import {validatePlan} from '../server/core';
import {applyTimelineRequest} from '../server/timeline';
import {editFrameZoom,editProposalNarrativeFeedback} from '../server/editProposal';
import {visualRetentionOmittedPlanningWitnesses} from '../server/visualRetentionReview';

const recorded=JSON.parse(await readFile(new URL('./fixtures/qa-381-editorial-padding.json',import.meta.url),'utf8'));

test('recorded 20s retention repair can reduce added silence padding while retaining every original sentence and bound observation',()=>{
  const input=structuredClone(recorded),before=structuredClone(input);
  const witnesses=visualRetentionOmittedPlanningWitnesses(input.review,input.prompt,input.plan,input.sources)!;
  const validate=(selections:any)=>{
    const selected=selectScenes(splitSceneSelections(selections,input.sources),input.sources);
    const base:EditPlan={format:input.plan.format,summary:'Controlled feasibility only, not movie acceptance',targetSeconds:0,fineCut:true,audio:input.plan.audio,clips:selected.map(scene=>({sceneId:scene.id,sourceId:scene.sourceId,start:scene.start,end:scene.end,sentenceIds:scene.sentenceIds,purpose:scene.purpose,zoom:editFrameZoom(input.plan.clips[0]?.zoom||1,input.prompt),transition:{kind:'cut',duration:0}}))};
    try{const result=applyTimelineRequest(validatePlan(base,input.sources),input.prompt+' 同步字幕',input.sources,{sourceWitnesses:witnesses});return editProposalNarrativeFeedback(result,input.sources).length?undefined:result;}
    catch(error){if(error instanceof Error&&/^剪辑方案时长/.test(error.message))return;throw error;}
  };
  const candidates=editorialRepairCandidates({...input,validate})!;
  assert.ok(candidates.candidates.length>0);assert.equal(candidates.search.limited,false);
  const plan=validate(candidates.candidates[0].selections)!;assert.ok(plan.targetSeconds>=18&&plan.targetSeconds<=22);
  for(const clip of plan.clips){
    const source=input.sources.find((s:MediaItem)=>s.id===clip.sourceId);
    const selected=source.analysis.sentences.filter((s:any)=>clip.sentenceIds!.includes(s.id));
    assert.ok(clip.start<=selected[0].start&&clip.end>=selected.at(-1).end);
    assert.ok(selected.flatMap((s:any)=>s.words).every((w:any)=>w.start>=clip.start&&w.end<=clip.end));
  }
  for(const witness of witnesses){
    assert.ok(plan.clips.some(clip=>clip.sourceId===witness.sourceId&&witness.time>=clip.start&&witness.time<clip.end));
  }
  assert.deepEqual(input,before);assert.equal(input.review.score,84);assert.equal(input.review.status,'needs-review');
});

function controlled(seconds:number,fade=false){
  const sources=structuredClone(recorded.sources) as MediaItem[];
  for(const source of sources){
    source.duration=20;const sentence=source.analysis!.sentences[0];
    Object.assign(sentence,{start:1,end:1+seconds,words:[{text:sentence.text,start:1,end:1+seconds}]});
    source.analysis!.sentences=[sentence];source.analysis!.duration=20;source.analysis!.pauses=[];
  }
  const plan:EditPlan={format:'16:9',summary:'Controlled padding budget',targetSeconds:0,fineCut:true,clips:sources.map((s,i)=>({sourceId:s.id,start:1,end:1+seconds,sentenceIds:[s.analysis!.sentences[0].id],transition:{kind:fade&&i?'fade':'cut',duration:fade&&i?0.05:0}}))};
  return{sources,plan};
}

test('padding optimization shares remaining quiet margins and never truncates speech or changes crossfade safety to fit',()=>{
  const short=controlled(10.87),before=structuredClone(short);
  const result=applyTimelineRequest(short.plan,'剪成20秒横屏',short.sources);
  assert.ok(result.targetSeconds<=22);assert.deepEqual(short,before);
  for(const clip of result.clips){assert.ok(clip.start<1);assert.ok(clip.end>11.87);}
  const long=controlled(11.2);assert.throws(()=>applyTimelineRequest(long.plan,'剪成20秒横屏',long.sources),/剪辑方案时长/);
  const fading=controlled(10.87,true);assert.throws(()=>applyTimelineRequest(fading.plan,'剪成20秒横屏',fading.sources),/剪辑方案时长/);
});

test('source witnesses must retain their actual hash and cannot authorize cuts into unselected speech',()=>{
  const input=controlled(10.87),source=input.sources[0];
  assert.throws(()=>applyTimelineRequest(input.plan,'剪成20秒横屏',input.sources,{sourceWitnesses:[{sourceId:source.id,sourceHash:'0'.repeat(64),time:1}]}),/源哈希/);
  const next={...source.analysis!.sentences[0],id:'unselected-speech',start:11.92,end:12.3,text:'未选择的另一句',words:[{text:'未选择的另一句',start:11.92,end:12.3}]};
  source.analysis!.sentences.push(next);
  assert.throws(()=>applyTimelineRequest(input.plan,'剪成20秒横屏',input.sources,{sourceWitnesses:[{sourceId:source.id,sourceHash:source.analysis!.sourceHash,time:12.1}]}),/未选中的半句/);
});
