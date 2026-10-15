import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { EditPlan, MediaItem, RenderReview, SelectedScene, WorkflowEvent } from '../shared/types';
import { editorialRepairCandidates, type EditorialRepairSelection } from '../server/editorialRepairCandidates';
import { runEditorialWorkflow, selectScenes, splitSceneSelections } from '../server/editorialWorkflow';
import { validatePlan } from '../server/core';
import { applyTimelineRequest } from '../server/timeline';
import { editProposalNarrativeFeedback } from '../server/editProposal';
import { extractVisualRetentionRequirements } from '../server/visualRetentionReview';
import { JobCancelledError } from '../server/jobExecution';
import { TextTransportError } from '../server/executionErrors';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p27-editorial-retention-candidates.json',import.meta.url),'utf8'));
function actual(){return {sources:structuredClone(fixture.media) as MediaItem[],plan:structuredClone(fixture.firstPlan) as EditPlan,review:structuredClone(fixture.reviewProjection) as RenderReview,prompt:fixture.prompt as string};}
function validator(sources:MediaItem[],prompt:string,prior:EditPlan){return(selections:EditorialRepairSelection[])=>{
  const scenes=selectScenes(splitSceneSelections(selections,sources),sources);
  const base:EditPlan={format:prior.format,summary:'Only original whole-sentence feasibility',targetSeconds:0,fineCut:true,audio:prior.audio,clips:scenes.map(s=>({sceneId:s.id,sourceId:s.sourceId,start:s.start,end:s.end,sentenceIds:s.sentenceIds,purpose:s.purpose,zoom:1,transition:{kind:'cut',duration:0}}))};
  try{const plan=applyTimelineRequest(validatePlan(base,sources),prompt+' 同步字幕',sources);return editProposalNarrativeFeedback(plan,sources).length?undefined:plan;}
  catch(error){if(error instanceof Error&&/^(?:原句合计|分镜需至少|同一分镜只能|口播精剪|片段时间超出素材|成片最长|剪辑方案时长)/.test(error.message))return;throw error;}
};}
function candidates(x=actual()){return editorialRepairCandidates({...x,validate:validator(x.sources,x.prompt,x.plan)});}

test('actual P27 offers an 18.11s whole-sentence choice avoiding the cited opening caption, without correcting ASR or declaring acceptance',()=>{
  const x=actual(),before=structuredClone(x),result=candidates(x)!;
  assert.ok(result.candidates.length>0&&result.candidates.length<=3);
  const option=result.candidates.find(c=>c.seconds===18.11);assert.ok(option,JSON.stringify(result));
  assert.equal(option.avoidsCaptionConcern,true);assert.ok(!option.selections.flatMap(s=>s.sentenceIds).includes(fixture.expectedAvoidedSentenceId));
  const plan=validator(x.sources,x.prompt,x.plan)(option.selections)!;
  for(const w of fixture.actualVisualWitnesses)assert.ok(plan.clips.some(c=>c.sourceId===w.sourceId&&w.sourceTime>=c.start&&w.sourceTime<c.end));
  assert.ok(plan.targetSeconds>=18&&plan.targetSeconds<=22);
  assert.match(result.detail,/不证明意义完整/);assert.match(result.detail,/不能自动选定、补词或改变需求/);
  assert.equal(x.sources[0].analysis!.sentences[0].words[0].text,'察一','retain the actual multi-character word owner, without prepending 观');
  assert.deepEqual(x,before,'original ASR word owners/times, complete flags, hashes, review scores and plan remain immutable');
  assert.equal(result.search.limited,false);assert.ok(result.search.validated<=240&&result.search.visited<=5000);
});

for(const mode of ['unverified','passed','missing','duplicate','wrong-clause','wrong-hash','wrong-source','selected-time','outside-source','no-audio'] as const)test('unbound or uncertain retention cannot authorize candidate search: '+mode,()=>{
  const x=actual(),check=x.review.semantic!.visualRetentionChecks![1];
  if(mode==='unverified')check.status='unverified';
  if(mode==='passed')x.review.status='passed';
  if(mode==='missing')delete x.review.semantic!.visualRetentionChecks;
  if(mode==='duplicate')x.review.semantic!.visualRetentionChecks!.push(structuredClone(check));
  if(mode==='wrong-clause')check.quote+='not the request';
  if(mode==='wrong-hash')check.sourceEvidence!.sourceHash='0'.repeat(64);
  if(mode==='wrong-source')check.sourceEvidence!.sourceId='another-owner-source';
  if(mode==='selected-time')check.sourceEvidence!.time=1;
  if(mode==='outside-source')check.sourceEvidence!.time=100;
  if(mode==='no-audio')x.sources[0].hasAudio=false;
  let validated=0;assert.equal(editorialRepairCandidates({...x,validate:()=>{validated++;return x.plan;}}),undefined);assert.equal(validated,0);
});

test('incomplete true-source witness never gets a fabricated complete flag or words',()=>{
  const x=actual();x.sources[0].analysis!.sentences[2].complete=false;const before=structuredClone(x);
  assert.equal(candidates(x)!.candidates.length,0);assert.deepEqual(x,before);
});

for(const error of [new JobCancelledError(),new TextTransportError(1,new Error('unknown accepted request')),Object.assign(new Error('disk denied'),{code:'EACCES'}),new Error('HTTP 401 unauthorized')])test('pure callback failure preserves the original critical error: '+error.name,()=>{
  const x=actual();assert.throws(()=>editorialRepairCandidates({...x,validate:()=>{throw error;}}),value=>value===error);
});

test('scope and search caps return honest incomplete-search diagnostics',()=>{
  const x=actual();
  const over=Array.from({length:6},(_,i)=>({...structuredClone(x.sources[i%2]),id:'scope-'+i}));
  let calls=0;const limited=editorialRepairCandidates({...x,sources:[...x.sources,...over],validate:()=>{calls++;return x.plan;}})!;
  assert.equal(calls,0);assert.equal(limited.search.limited,true);assert.match(limited.detail,/未穷举/);
  for(const source of x.sources){source.analysis!.duration=40;source.duration=40;source.analysis!.sentences=Array.from({length:9},(_,i)=>({id:source.id+':'+i,start:i*2,end:i*2+1.5,text:'完整的独立表达。',complete:true,words:[{text:'完整的独立表达',start:i*2,end:i*2+1.5}]}));}
  const before=structuredClone(x.sources);const bounded=editorialRepairCandidates({...x,validate:selections=>{calls++;return {...x.plan,targetSeconds:20,clips:selections.map(s=>({sourceId:s.sourceId,start:0,end:40}))};}})!;
  assert.ok(calls<=240);assert.ok(bounded.search.visited<=5000&&bounded.search.validated<=240);assert.equal(bounded.search.limited,true);assert.ok(bounded.candidates.length<=3);assert.match(bounded.detail,/未穷尽/);assert.deepEqual(x.sources,before);
});

test('an uncited or differently quoted caption complaint does not invent a faulted source sentence',()=>{
  for(const finding of ['global：字幕缺少开头，请重新核验。','scene-1：字幕为“观察一个现象时”，缺少一个词。']){
    const x=actual();x.review.semantic!.findings=[finding];
    assert.ok(candidates(x)!.candidates.some(c=>c.selections.some(s=>s.sentenceIds.includes(fixture.expectedAvoidedSentenceId))));
  }
});

test('the generic search uses arbitrary source words and original validators rather than incident theme tokens',()=>{
  const x=actual(),before=structuredClone(x.sources);
  for(const source of x.sources)for(const sentence of source.analysis!.sentences){
    sentence.words=sentence.words.map(w=>({...w,text:'字'}));sentence.text=sentence.words.map(w=>w.text).join('');
  }
  x.review.semantic!.findings=[];x.plan.captions=[];
  const result=candidates(x)!;assert.ok(result.candidates.length>0);
  for(const candidate of result.candidates){const plan=validator(x.sources,x.prompt,x.plan)(candidate.selections)!;assert.ok(plan.targetSeconds>=18&&plan.targetSeconds<=22);}
  assert.notDeepEqual(x.sources,before,'test-only arbitrary-word control differs from actual recorded narration');
});

const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-candidate-key'};
for(const mode of ['controlled-pass','incomplete-review'] as const)test('actual P27 SDK route exposes the hint once and retains existing two-render/best rules: '+mode,async()=>{
  const x=actual(),before=structuredClone(x.sources),original=globalThis.fetch,events:WorkflowEvent[]=[],plans:EditPlan[]=[];
  const counts={select:0,write:0,transcribe:0,inspect:0,render:0,review:0};
  let receivedReview:RenderReview|undefined,receivedCandidates:ReturnType<typeof editorialRepairCandidates>;
  let selection:EditorialRepairSelection[]=x.plan.clips.map(c=>({sourceId:c.sourceId,sentenceIds:c.sentenceIds!,reason:'保留已选完整原话和实际程序示意',purpose:c.purpose||'argument'}));
  const next=candidates(x)!.candidates.find(c=>c.seconds===18.11)!;
  globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((t:any)=>t.function.name);let name:string,args:unknown;
    if(allowed.includes('select_scenes')){
      name='select_scenes';counts.select++;
      if(counts.select===2){
        const messages=JSON.stringify(payload.messages);assert.match(messages,/repairCandidates/);assert.match(messages,/18\.11/);assert.match(messages,/不证明意义完整/);
        const texts=payload.messages.flatMap((m:any)=>typeof m.content==='string'?[m.content]:(m.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text));
        const marker='工具数据与错误：',contextText=texts.findLast((t:string)=>t.includes(marker));assert.ok(contextText);
        const context=JSON.parse(contextText.slice(contextText.lastIndexOf(marker)+marker.length).split('\n')[0]);
        receivedReview=context.review;receivedCandidates=context.repairCandidates;
        selection=structuredClone(next.selections);
      }
      args={scenes:selection};
    }else{
      assert.deepEqual(allowed,['write_narrative']);name='write_narrative';counts.write++;
      const selected=selectScenes(splitSceneSelections(selection,x.sources),x.sources);
      args={premise:'Controlled original-sentence selection',audience:'Ordinary audience',arc:'Retain recorded words; actual meaning still needs a real review',style:'Preserve source audio and full frame',beats:selected.map(s=>({sceneId:s.id,intent:s.reason,graphic:'none',label:''}))};
    }
    return new Response(`data: ${JSON.stringify({id:'control',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'candidate-'+name+'-'+counts.select+'-'+counts.write,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const result=await runEditorialWorkflow({prompt:x.prompt,config,sources:x.sources,previous:null,export:true,
      transcribe:async id=>{counts.transcribe++;return structuredClone(x.sources.find(s=>s.id===id)!.analysis!);},
      verifySelection:async()=>{},inspect:async scene=>{counts.inspect++;return {observations:'Controlled cached frame analysis, not new image review',safeZone:'bottom',frameTimes:[scene.start]};},persist:async()=>{},
      render:async plan=>{counts.render++;plans.push(structuredClone(plan));return {id:'control-'+counts.render,file:'not-a-real-movie-'+counts.render+'.mp4'};},
      review:async(_file,plan)=>{
        counts.review++;if(counts.review===1)return structuredClone(x.review);
        for(const w of fixture.actualVisualWitnesses)assert.ok(plan.clips.some(c=>c.sourceId===w.sourceId&&w.sourceTime>=c.start&&w.sourceTime<c.end));
        assert.ok(!plan.clips.some(c=>c.sentenceIds?.includes(fixture.expectedAvoidedSentenceId)));
        return mode==='controlled-pass'?{status:'passed',score:88,checks:[],limitations:['Control-only score; original sentence/range checks do not prove semantic acceptance'],createdAt:''}:{status:'needs-review',score:0,checks:[],limitations:['Controlled incomplete semantic review; original best must remain'],createdAt:''};
      },progress:async value=>{events.splice(0,events.length,...structuredClone(value));},
    });
    assert.deepEqual(counts,{select:2,write:2,transcribe:2,inspect:4,render:2,review:2});
    assert.equal(plans[1].targetSeconds,18.11);assert.deepEqual(x.sources,before,'no ASR words/time/hash or complete flag changed');
    // Existing trace strings are bounded, so inspect the actual full SDK
    // context instead of pretending a truncated audit string is valid JSON.
    const first=events.find(e=>e.tool==='review_edit')!;assert.match(JSON.stringify(first.output),/76/);
    assert.equal(receivedReview!.score,76);assert.equal(receivedReview!.status,'needs-review');assert.deepEqual(receivedReview!.semantic,x.review.semantic);assert.ok(receivedCandidates!.candidates.some(c=>c.seconds===18.11));
    assert.equal(result.review!.score,mode==='controlled-pass'?88:76);assert.equal(result.rendered!.id,mode==='controlled-pass'?'control-2':'control-1');
  }finally{globalThis.fetch=original;}
});
