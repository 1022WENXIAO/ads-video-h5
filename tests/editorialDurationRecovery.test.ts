import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { EditPlan, MediaItem, SelectedScene, WorkflowEvent } from '../src/types';
import { runEditorialWorkflow, selectScenes } from '../server/editorialWorkflow';
import { editFrameZoom, editSentenceBudgetHint } from '../server/editProposal';
import { applyTimelineRequest } from '../server/timeline';
import { renderPlan, runFFmpeg, validatePlan } from '../server/core';
import { inspectEvaluationStreamDuration } from '../server/evaluationMediaGate';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

const fixture=JSON.parse(await readFile(new URL('./fixtures/fine-cut-duration-incident.json',import.meta.url),'utf8'));
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'fake-editorial-key'};
type Mode='duration'|'same-selection'|'new-group'|'fragment-first'|'fade'|'auth'|'ordinary'|'original-frame'|'original-frame-manual';
const subset=()=>[1,2,3].map(index=>structuredClone(fixture.overlongSelection.scenes[index]));
const sceneKey=(scene:SelectedScene)=>JSON.stringify([scene.sourceId,scene.sourceHash,scene.start,scene.end,scene.sentenceIds,scene.quote]);

// Recorded production ASR/source ranges are real. Model decisions and review
// grades below are fault-injection controls, not creative acceptance scores.
function harness(mode:Mode){
  const media=structuredClone(fixture.media) as MediaItem[],events:WorkflowEvent[]=[],inspected:string[]=[],audited:number[]=[];
  const counts={transcriptions:0,selections:0,writes:0,renders:0,reviews:0,manualArranges:0};
  let activeSelection=mode==='fade'||mode==='auth'||mode==='ordinary'||mode.startsWith('original-frame')?subset():structuredClone(fixture.overlongSelection.scenes);
  const fetch:typeof globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),allowed=payload.tools.map((tool:any)=>tool.function.name);
    let name:string,args:any;
    if(allowed.includes('select_scenes')){
      name='select_scenes';counts.selections++;
      if(counts.selections>1){
        assert.match(JSON.stringify(payload.messages),/25\.94|不符合用户要求|已拒/);
        assert.match(JSON.stringify(payload.messages),/实际源时间.*完整句/);
        activeSelection=mode==='same-selection'?fixture.overlongSelection.scenes.map((entry:any)=>({...entry,reason:'只换理由，没有改变已经失败的原句组合'})):mode==='new-group'?[
          {...fixture.overlongSelection.scenes[0],sentenceIds:['source-a:sentence:0','source-a:sentence:1'],reason:'合并完整观察与示意说明，保留源原话'},
          fixture.overlongSelection.scenes[3],
        ]:mode==='fragment-first'&&counts.selections===2?[
          fixture.overlongSelection.scenes[0],{...fixture.overlongSelection.scenes[3],sentenceIds:['source-b:sentence:4'],reason:'故障注入：不能把标complete的残句当完整原话'},
        ]:subset();
      }
      args={scenes:activeSelection};
    }else if(allowed.includes('arrange_timeline')){
      name='arrange_timeline';counts.manualArranges++;args={format:'16:9',zoom:1.1,fade:0};
      assert.match(JSON.stringify(payload.messages),/转场类型或时长无效/);
    }else{
      assert.deepEqual(allowed,['write_narrative']);name='write_narrative';counts.writes++;
      args=counts.writes===1&&mode!=='fade'&&mode!=='auth'&&mode!=='ordinary'&&!mode.startsWith('original-frame')?fixture.originalNarrative:{premise:'观察、比较与证据边界',audience:'科普观众',arc:'用完整原话组织证据与限制',style:'保留原视频和原声',beats:activeSelection.map((entry:any,index:number)=>({sceneId:'scene-'+(index+1),intent:entry.reason,graphic:'none',label:''}))};
    }
    return new Response(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+name+counts.selections+counts.writes+counts.manualArranges,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  const run=()=>runEditorialWorkflow({prompt:mode.startsWith('original-frame')?'把两段横屏精剪成20秒，普通话原声保留，画面原比例完整放，加同步字幕。':mode==='ordinary'?'把两段视频精剪成20秒横屏成片，保留完整原话和原声，加同步字幕。':fixture.prompt,config,sources:media,previous:mode==='fade'||mode==='original-frame-manual'?{format:'16:9',summary:'故障注入：旧参数fade过长',targetSeconds:0,clips:[{sourceId:'source-a',start:0,end:4.84,transition:{kind:'fade',duration:1}}]}:null,export:true,
    transcribe:async id=>{counts.transcriptions++;return structuredClone(media.find(source=>source.id===id)!.analysis!);},
    verifySelection:async selected=>{audited.push(selected.length);if(selected.some(scene=>scene.sourceId==='source-b'&&scene.sentenceIds.length<3&&scene.sentenceIds.some(id=>/:sentence:[234]$/.test(id))))throw new Error('选句未通过独立完整性审查：该残句句首依赖前序尾字，必须保留已验证的连续原话组。');},
    inspect:async scene=>{inspected.push(sceneKey(scene));return {observations:'Controlled visual cache result; no real image-model call',safeZone:'bottom',frameTimes:[scene.start,(scene.start+scene.end)/2,scene.end]};},
    decorate:mode==='auth'?()=>{throw new Error('HTTP 401 unauthorized');}:undefined,
    persist:async()=>{},
    render:async plan=>{
      counts.renders++;
      if(!process.env.QINGJIAN_FINECUT_REAL_MEDIA_DIR)return {id:'control-movie',file:'control-only.mp4'};
      const out=process.env.QINGJIAN_FINECUT_PROOF_OUT!;assert.ok(out,'real local proof requires a private output directory');
      const mediaDir=path.join(out,'media'),exports=path.join(out,'exports');await mkdir(mediaDir,{recursive:true});await mkdir(exports,{recursive:true});
      for(const [index,source] of media.entries()){
        const actual=path.join(process.env.QINGJIAN_FINECUT_REAL_MEDIA_DIR!,`controlled-semantic-v3-production-${index+1}.mp4`);
        assert.equal(createHash('sha256').update(await readFile(actual)).digest('hex'),source.analysis!.sourceHash);
        try{await symlink(actual,path.join(mediaDir,source.id));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      }
      return renderPlan(plan,media,mediaDir,exports);
    },
    review:async(file,plan)=>{
      counts.reviews++;
      if(process.env.QINGJIAN_FINECUT_REAL_MEDIA_DIR){
        const stream=await inspectEvaluationStreamDuration(file,plan.targetSeconds);assert.equal(stream.passed,true,stream.detail);
        await runFFmpeg(['-v','error','-i',file,'-f','null','-']);
        await writeFile(path.join(process.env.QINGJIAN_FINECUT_PROOF_OUT!,'technical-proof.json'),JSON.stringify({scope:'Real recorded source MP4s, injected planning decisions, real FFmpeg and mandatory packet/decode checks. Semantic review is a control stub, not creative/production acceptance.',file,seconds:plan.targetSeconds,stream,sentenceGroups:plan.clips.map(clip=>({sourceId:clip.sourceId,sentenceIds:clip.sentenceIds})),sourceHashes:media.map(source=>source.analysis!.sourceHash)},null,2),{mode:0o600});
      }
      return {status:'passed',score:88,checks:[{name:'Controlled review transition',passed:true,detail:'Control-only grade; real quality is not claimed'}],limitations:[],createdAt:''};
    },progress:async next=>{events.splice(0,events.length,...structuredClone(next));},
  });
  return {media,events,counts,inspected,audited,fetch,run};
}

test('recorded 25.94s production selection recovers through whole-group reselection without duplicate source analysis',async()=>{
  const h=harness('duration'),original=globalThis.fetch,before=structuredClone(h.media);globalThis.fetch=h.fetch;
  try{
    const result=await h.run();
    assert.equal(result.review!.status,'passed');assert.ok(Math.abs(result.plan.targetSeconds-20)<=2);
    assert.equal(h.counts.transcriptions,2);assert.equal(h.counts.selections,2);assert.equal(h.counts.writes,2);assert.equal(h.counts.renders,1);assert.equal(h.counts.reviews,1);
    assert.equal(h.inspected.length,4);assert.equal(new Set(h.inspected).size,4);assert.deepEqual(h.audited,[4]);
    assert.deepEqual(h.media,before,'source ASR, timestamps and complete flags stay immutable');
    assert.ok(result.plan.clips.every(clip=>clip.zoom===1),'the explicit full-frame request wins over default added zoom');
    const failed=h.events.filter(event=>event.tool==='arrange_timeline'&&event.status==='failed');assert.equal(failed.length,1);assert.match(failed[0].detail!,/25\.94秒不符合用户要求20秒/);
    assert.equal(h.events.filter(event=>event.tool==='arrange_timeline'&&event.status==='succeeded').length,1);
    const compound=result.plan.clips.find(clip=>clip.sourceId===fixture.compoundGroup.sourceId&&clip.sentenceIds?.includes('source-b:sentence:4'))!;
    assert.deepEqual(compound.sentenceIds,fixture.compoundGroup.sentenceIds);assert.doesNotThrow(()=>validatePlan(result.plan,h.media));
  }finally{globalThis.fetch=original;}
});

test('changing only reasons cannot repeat a known failed selection or rerun automatic compilation',async()=>{
  const h=harness('same-selection'),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{await assert.rejects(h.run(),/同一|该完整选句组合|未完成/);assert.equal(h.counts.transcriptions,2);assert.equal(h.inspected.length,4);assert.deepEqual(h.audited,[4]);assert.equal(h.counts.renders,0);assert.equal(h.events.filter(event=>event.tool==='arrange_timeline').length,1);assert.ok(h.counts.selections<=8);}
  finally{globalThis.fetch=original;}
});

test('new merged source groups are independently checked and inspected while unchanged groups retain their prior cache',async()=>{
  const h=harness('new-group'),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{const result=await h.run();assert.ok(Math.abs(result.plan.targetSeconds-20)<=2);assert.deepEqual(h.audited,[4,1]);assert.equal(h.inspected.length,5);assert.equal(new Set(h.inspected).size,5);assert.equal(h.counts.transcriptions,2);}
  finally{globalThis.fetch=original;}
});

test('an ASR complete flag cannot skip independent rejection of a newly proposed fragment during duration recovery',async()=>{
  const h=harness('fragment-first'),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{const result=await h.run();assert.equal(result.review!.status,'passed');assert.deepEqual(h.audited,[4,1]);assert.equal(h.inspected.length,4);assert.equal(h.counts.transcriptions,2);assert.equal(h.counts.selections,3);assert.ok(h.events.some(event=>event.tool==='select_scenes'&&event.status==='failed'&&/独立完整性/.test(event.detail||'')));}
  finally{globalThis.fetch=original;}
});

test('invalid automatic fade yields to one real parameter decision instead of repeating the same automatic defaults',async()=>{
  const h=harness('fade'),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{const result=await h.run();assert.equal(result.review!.status,'passed');assert.equal(h.counts.manualArranges,1);assert.equal(h.counts.selections,1);assert.equal(h.counts.writes,1);assert.equal(h.counts.transcriptions,2);assert.equal(h.inspected.length,3);const arrangements=h.events.filter(event=>event.tool==='arrange_timeline');assert.equal(arrangements.length,2);assert.equal((arrangements[0].input as any).fade,1);assert.equal((arrangements[1].input as any).fade,0);assert.equal((arrangements[1].input as any).zoom,1.1);assert.ok(result.plan.clips.every(clip=>clip.zoom===1),'manual model arguments cannot override explicit no-crop framing');}
  finally{globalThis.fetch=original;}
});

test('ordinary arrangements retain the added-zoom default while explicit Chinese and English no-crop requests disable it',async()=>{
  const h=harness('ordinary'),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{const result=await h.run();assert.ok(result.plan.clips.every(clip=>clip.zoom===1.045));for(const prompt of ['画面完整别裁。','不裁切','不要裁剪画面，保留原声','keep the entire frame','do not crop'])assert.equal(editFrameZoom(1.1,prompt),1,prompt);assert.equal(editFrameZoom(1.045,'正常精剪并适当突出主体'),1.045);}
  finally{globalThis.fetch=original;}
});

test('actual original-ratio full-frame wording disables zoom for automatic and manual model arrangements',async()=>{
  for(const mode of ['original-frame','original-frame-manual'] as const){
    const h=harness(mode),fetch=globalThis.fetch;globalThis.fetch=h.fetch;
    try{const result=await h.run();assert.equal(result.review!.status,'passed');assert.ok(result.plan.clips.every(clip=>clip.zoom===1));assert.equal(h.counts.manualArranges,mode==='original-frame-manual'?1:0);assert.equal(result.plan.format,'16:9');assert.equal(result.plan.audio!.originalVolume,1);assert.ok(result.plan.captions!.length>0);}
    finally{globalThis.fetch=fetch;}
  }
  for(const prompt of ['画面原比例完整放。','按原比例完整展示','保持原比例完整地呈现'])assert.equal(editFrameZoom(1.1,prompt),1,prompt);
  for(const prompt of ['画面保持原比例，适当放大主体','不用原比例完整放，可以放大','不要按原比例完整展示'])assert.equal(editFrameZoom(1.1,prompt),1.1,prompt);
});

test('an explicit preserve-selection request does not silently reselect complete speech to satisfy an incompatible duration',async()=>{
  const media=structuredClone(fixture.media) as MediaItem[],scenes=selectScenes(subset(),media).map(scene=>({...scene,visual:{observations:'Recorded control visual',safeZone:'bottom' as const,frameTimes:[scene.start]}}));
  const script={premise:'已有原话',audience:'科普观众',arc:'保留原有选句',style:'原声',beats:scenes.map(scene=>({sceneId:scene.id,intent:scene.reason,graphic:'none' as const,label:''}))};
  const previous:EditPlan={format:'16:9',summary:'已有分镜',targetSeconds:0,fineCut:true,clips:scenes.map(scene=>({sceneId:scene.id,sourceId:scene.sourceId,start:scene.start,end:scene.end,sentenceIds:scene.sentenceIds})),editorial:{scenes,script}};
  await assert.rejects(runEditorialWorkflow({prompt:'保留当前分镜，只修改字幕，成片10秒横屏。',config,sources:media,previous,preserveSelection:true,export:true,transcribe:async()=>{throw new Error('must not repeat ASR');},inspect:async()=>{throw new Error('must not repeat inspection');},persist:async()=>{},render:async()=>{throw new Error('must not render an invalid duration');},review:async()=>{throw new Error('must not review an unrendered movie');},progress:async()=>{}}),/不符合用户要求10秒/);
});

test('authentication failures remain terminal rather than causing editorial reselection',async()=>{
  const h=harness('auth'),original=globalThis.fetch;globalThis.fetch=h.fetch;
  try{await assert.rejects(h.run(),/401/);assert.equal(h.counts.selections,1);assert.equal(h.counts.renders,0);assert.equal(h.events.filter(event=>event.tool==='arrange_timeline').length,1);}
  finally{globalThis.fetch=original;}
});

test('timing suggestions keep independently verified compound groups indivisible despite bad ASR complete flags',()=>{
  const media=structuredClone(fixture.media) as MediaItem[],groups=selectScenes(fixture.overlongSelection.scenes,media);
  const base:EditPlan={format:'16:9',summary:'Recorded overlong selection',targetSeconds:0,fineCut:true,clips:groups.map(group=>({sourceId:group.sourceId,start:group.start,end:group.end,sentenceIds:group.sentenceIds}))};
  let checked=0;
  const hint=editSentenceBudgetHint(base,fixture.prompt,media,plan=>{checked++;for(const clip of plan.clips)if(clip.sourceId==='source-b'&&clip.sentenceIds?.some(id=>/:sentence:[234]$/.test(id)))assert.deepEqual(clip.sentenceIds,fixture.compoundGroup.sentenceIds);return applyTimelineRequest(validatePlan(plan,media),fixture.prompt,media);},groups);
  assert.ok(checked>0);assert.match(hint,/实际源时间/);assert.match(hint,/source-b:sentence:2\+source-b:sentence:3\+source-b:sentence:4/);
});
