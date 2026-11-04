import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {editorialRepairCandidates,type EditorialRepairSelection} from '../server/editorialRepairCandidates';
import {selectScenes,splitSceneSelections} from '../server/editorialWorkflow';
import {validatePlan} from '../server/core';
import {applyTimelineRequest} from '../server/timeline';
import {editProposalNarrativeFeedback} from '../server/editProposal';
import {visualRetentionOmittedPlanningWitnesses} from '../server/visualRetentionReview';
import type {EditPlan,MediaItem} from '../shared/types';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-d4-witness-search.json',import.meta.url),'utf8'));
function validate(sources:MediaItem[],prompt:string,prior:EditPlan){return(selections:EditorialRepairSelection[])=>{
  try{
    const scenes=selectScenes(splitSceneSelections(selections,sources),sources);
    const base:EditPlan={format:prior.format,summary:'Controlled whole-sentence/source-witness feasibility only',targetSeconds:0,fineCut:true,audio:prior.audio,clips:scenes.map(s=>({sceneId:s.id,sourceId:s.sourceId,start:s.start,end:s.end,sentenceIds:s.sentenceIds,purpose:s.purpose,zoom:1,transition:{kind:'cut',duration:0}}))};
    const result=applyTimelineRequest(validatePlan(base,sources),prompt+' 同步字幕',sources);
    return editProposalNarrativeFeedback(result,sources).length?undefined:result;
  }catch(e){if(e instanceof Error&&/^(?:原句合计|分镜需至少|同一分镜只能|不能重复使用同一句|口播精剪|片段时间超出素材|成片最长|剪辑方案时长)/.test(e.message))return;throw e;}
};}

test('actual 14-sentence case finds a bounded whole-source repair that retains every old observation and the omitted source witness',()=>{
  const x=structuredClone(fixture),before=structuredClone(x);
  const result=editorialRepairCandidates({sources:x.sources,prompt:x.prompt,plan:x.firstPlan,review:x.review,validate:validate(x.sources,x.prompt,x.firstPlan)})!;
  assert.ok(result.candidates.length>0,JSON.stringify(result));
  const witnesses=visualRetentionOmittedPlanningWitnesses(x.review,x.prompt,x.firstPlan,x.sources)!;
  for(const candidate of result.candidates){
    const plan=validate(x.sources,x.prompt,x.firstPlan)(candidate.selections)!;
    assert.ok(plan.targetSeconds>=18&&plan.targetSeconds<=22);
    for(const w of witnesses)assert.ok(plan.clips.some(c=>c.sourceId===w.sourceId&&w.time>=c.start&&w.time<c.end));
  }
  const firstSource=x.sources[0],firstIds=firstSource.analysis.sentences.slice(0,2).map((s:any)=>s.id);
  assert.ok(result.candidates.some(c=>{const plan=validate(x.sources,x.prompt,x.firstPlan)(c.selections)!;return plan.clips.some(clip=>clip.sourceId===firstSource.id&&firstIds.every((id:string)=>clip.sentenceIds?.includes(id)));}),'one feasible hint restores the actually recorded preceding opening clause; it does not invent words or declare the movie acceptable');
  assert.ok(witnesses.some(w=>{const source=x.sources.find((s:any)=>s.id===w.sourceId);return !source.analysis.sentences.some((s:any)=>w.time>=s.start&&w.time<s.end);}), 'recorded observations inside a retained speech gap must remain feasible');
  assert.ok(result.search.visited<=5000&&result.search.validated<=240);assert.ok(result.candidates.length<=3);
  assert.deepEqual(x,before);assert.equal(x.review.score,85);
});
