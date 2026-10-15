import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {EditPlan,MediaItem} from '../shared/types';
import {reviewFrameSampling} from '../server/reviewFrameSampling';
import {captionsFromTranscript,timelineOffsets} from '../server/timeline';
import {reviewFrameCaptionContext,reviewFrameMessages} from '../server/renderReview';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p29-review-sampling-windows.json',import.meta.url),'utf8'));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function samplePlan(){
  const plan={format:'9:16',targetSeconds:30.02,summary:'controlled sampling contract only',
    clips:fixture.durations.map((duration:number,i:number)=>({sceneId:`ch${i+1}`,sourceId:`media-${i+1}`,start:0,end:duration,transition:{kind:i?'fade':'cut',duration:i?fixture.transition:0}})),
    lesson:{workflowId:'controlled-workflow',pacing:{leadSeconds:fixture.lead},voice:{anchorHash:hash('controlled-reference')},chapters:[]},
    captions:fixture.captions.map((c:any)=>({...c,style:'subtitle',animation:'none'}))} as EditPlan;
  const offsets=timelineOffsets(plan),media:MediaItem[]=[];
  for(const [index,clip] of plan.clips.entries()){
    const chapterCaptions=plan.captions!.filter(c=>c.start>=offsets[index]&&c.end<=offsets[index]+clip.end),narration=chapterCaptions.map(c=>c.text).join('');
    const cues=structuredClone(fixture.cues[index]),audioHash=hash('audio-'+index),htmlHash=hash('html-'+index);
    const chapter={id:clip.sceneId!,narration,mediaId:clip.sourceId,duration:clip.end,audioHash,htmlHash,speechMatch:1,cues,visual:{items:cues.map((c:any)=>({cue:c.text}))}};
    plan.lesson!.chapters.push(chapter as any);
    const words=chapterCaptions.map(c=>({text:c.text,start:+(c.start-offsets[index]).toFixed(3),end:+(c.end-offsets[index]).toFixed(3)}));
    media.push({id:clip.sourceId,kind:'video',duration:clip.end,generation:{workflowId:plan.lesson!.workflowId,beatId:chapter.id,mode:'generated',lineHash:hash(narration),audioHash,htmlHash,referenceHash:plan.lesson!.voice!.anchorHash},
      analysis:{status:'ready',sourceHash:hash('video-'+index),sentences:[{id:'sentence',start:words[0].start,end:words.at(-1)!.end,text:narration,complete:true,words}],captionBreaks:words.map((_,i)=>i)}} as MediaItem);
  }
  assert.deepEqual(captionsFromTranscript(plan,media),plan.captions,'controlled caption events really derive from the selected source word times');
  return {plan,media};
}
function legacyTimes(plan:EditPlan){
  const offsets=timelineOffsets(plan),values=[.02,.2,.5,.8,.98].map(r=>+(plan.targetSeconds*r).toFixed(3));
  for(const [i,clip] of plan.clips.entries()){
    const duration=clip.end-clip.start,last=Math.max(0,...plan.lesson!.chapters[i].cues!.map(c=>c.end));
    values.push(offsets[i]+Math.min(2.5,duration*.2),offsets[i]+Math.min(duration-.2,Math.max(duration*.7,last+1)));
  }
  return values;
}
const hits=(times:number[],start:number,end:number)=>times.some(t=>t>=start&&t<=end);

test('P29 three-cue/four-focus structure gains both missed grouped-caption windows without increasing the 24 frame cap',()=>{
  const {plan,media}=samplePlan(),before=structuredClone({plan,media}),old=legacyTimes(plan),result=reviewFrameSampling(plan,media);
  for(const window of fixture.focusWindows){
    assert.equal(hits(old,window.start,window.end),false,window.node+' was outside the original samples');
    assert.ok(hits(result.times,window.start,window.end),window.node+' now has a stable sample: '+result.times.join(','));
  }
  assert.equal(result.frameLimit,24);assert.ok(result.times.length<=24);
  assert.equal(result.coverage.length,3);assert.ok(result.coverage.every(c=>c.proofBound&&c.sampledTimes.length>=2));
  assert.ok(result.times.includes(.6));assert.ok(result.times.includes(29.42),'original global endpoints remain');
  for(const chapter of result.coverage)assert.ok(chapter.windows.filter(w=>w.kind==='cue').every(w=>w.selected));
  assert.deepEqual({plan,media},before);assert.equal(fixture.provenance.retainedScore,88,'sampling is not a score override');
});

test('raw cue lead is added once while the selected ASR captions remain in their existing output clock',()=>{
  const {plan,media}=samplePlan(),result=reviewFrameSampling(plan,media),school=result.coverage[1].windows.find(w=>w.cueIndex===1&&w.kind==='cue')!;
  assert.deepEqual([school.start,school.end],[10.58,12.53]);assert.ok(Math.abs(school.time-11.4575)<=.001);
  assert.equal(result.coverage[1].windows.find(w=>w.cueIndex===1&&w.kind==='cue-caption-late')!.time,12.205);
  const single=structuredClone(plan);single.clips=[single.clips[1]];single.clips[0].start=2;single.clips[0].end=8;single.clips[0].transition={kind:'cut',duration:0};single.targetSeconds=6;single.lesson!.chapters=[single.lesson!.chapters[1]];
  single.captions=captionsFromTranscript(single,media);
  const trimmed=reviewFrameSampling(single,media).coverage[0].windows.find(w=>w.cueIndex===1&&w.kind==='cue')!;
  assert.equal(trimmed.start,2.41);assert.equal(trimmed.end,4.36);assert.equal(trimmed.time,3.288);
});

test('transition overlaps and trimmed-away cues are not labelled stable chapter observations',()=>{
  const {plan,media}=samplePlan(),result=reviewFrameSampling(plan,media),offsets=timelineOffsets(plan);
  for(const chapter of result.coverage)for(const time of chapter.sampledTimes){
    assert.ok(time>=chapter.stableStart&&time<=chapter.stableEnd);
    assert.equal(reviewFrameCaptionContext(plan,time).mixedChapterTransition,false);
  }
  assert.equal(result.coverage[1].stableStart,6.39);assert.equal(result.coverage[1].stableEnd,18.4);
  const clipped=structuredClone(plan);clipped.clips[1].start=5.4;clipped.clips[1].end=6;clipped.targetSeconds=24;
  clipped.captions=captionsFromTranscript(clipped,media);
  const sample=reviewFrameSampling(clipped,media);
  assert.ok(sample.limitations.some(l=>l.includes('cue1在选片或转场稳定区外')));
  assert.ok(!sample.coverage[1].windows.some(w=>w.cueIndex===0));assert.equal(offsets[1],6.17);
});

test('stale, missing, or ambiguous generation and cue identities fall back without inventing verified coverage',()=>{
  for(const mutate of [
    ({media}:ReturnType<typeof samplePlan>)=>{media[1].generation!.lineHash=hash('old narration');},
    ({media}:ReturnType<typeof samplePlan>)=>{media[1].generation!.audioHash=hash('old waveform');},
    ({media}:ReturnType<typeof samplePlan>)=>{media[1].analysis=undefined;},
    ({plan}:ReturnType<typeof samplePlan>)=>{plan.lesson!.chapters.push(structuredClone(plan.lesson!.chapters[1]));},
    ({media}:ReturnType<typeof samplePlan>)=>{media.push(structuredClone(media[1]));},
    ({plan}:ReturnType<typeof samplePlan>)=>{plan.lesson!.chapters[1].cues![1].text='unbound cue';},
  ]){
    const state=samplePlan();mutate(state);const result=reviewFrameSampling(state.plan,state.media);
    assert.equal(result.coverage[1].proofBound,false);assert.deepEqual(result.coverage[1].windows,[]);
    assert.ok(result.coverage[1].sampledTimes.length);assert.ok(result.limitations.some(l=>l.includes('片段2缺少唯一且匹配当前稿')));
  }
});

test('unmatched or overlapping plan captions cannot create a grouped-phrase priority from stale subtitle metadata',()=>{
  const {plan,media}=samplePlan();plan.captions!.find(c=>c.start===10.58)!.end=14;
  const result=reviewFrameSampling(plan,media),cue=result.coverage[1].windows.find(w=>w.cueIndex===1)!;
  assert.ok(Math.abs(cue.start-10.58)<1e-9&&Math.abs(cue.end-11.48)<1e-9);assert.equal(cue.time,11.03);
  assert.equal(result.coverage[1].windows.some(w=>w.cueIndex===1&&w.kind==='cue-caption-late'),false);
});

test('chapter fairness and explicit unobserved windows survive a crowded plan at the fixed frame limit',()=>{
  const base=samplePlan(),plan=structuredClone(base.plan),media:MediaItem[]=[];
  plan.clips=[];plan.lesson!.chapters=[];plan.captions=[];
  for(let i=0;i<10;i++){
    const ch=structuredClone(base.plan.lesson!.chapters[1]),source=structuredClone(base.media[1]);
    ch.id='chapter-'+i;source.id=ch.mediaId='source-'+i;source.generation!.beatId=ch.id;
    plan.lesson!.chapters.push(ch);media.push(source);plan.clips.push({sourceId:source.id,sceneId:ch.id,start:0,end:12.45,transition:{kind:'cut',duration:0}});
  }
  plan.targetSeconds=124.5;plan.captions=captionsFromTranscript(plan,media);
  const result=reviewFrameSampling(plan,media);
  assert.equal(result.times.length,24);assert.ok(result.coverage.every(c=>c.sampledTimes.length>=1));
  assert.ok(result.limitations.some(l=>l.includes('24帧上限限制')));
  assert.ok(result.coverage.some(c=>c.windows.some(w=>!w.selected)),'unseen obligations stay explicitly unobserved');
  assert.equal(new Set(result.times).size,result.times.length);assert.ok(result.times.every(t=>t>=0&&t<=plan.targetSeconds-.05));
});

test('output frame references use precisely the selected actual clock without replacing image evidence with coverage metadata',()=>{
  const {plan,media}=samplePlan(),sample=reviewFrameSampling(plan,media),outputs=sample.times.map(time=>({time,image:{type:'image_url',image_url:{url:'controlled-image-'+time}}}));
  const parts=reviewFrameMessages(plan,outputs);
  assert.deepEqual(parts.filter(p=>p.type==='image_url'),outputs.map(o=>o.image));
  for(const output of outputs){
    const index=parts.indexOf(output.image),context=JSON.parse(parts[index-2].text!.slice(parts[index-2].text!.indexOf('{')));
    assert.equal(context.frameTime,output.time);assert.equal(context.basis,'plan-reference-not-pixel-or-audio-proof');
  }
});

test('ordinary source plans retain the old 18-frame budget and reject invalid candidate times without new acceptance checks',()=>{
  const plan={format:'16:9',targetSeconds:10,clips:[{sourceId:'source',start:4,end:14}],summary:'ordinary clip',motions:Array.from({length:30},(_,i)=>({start:i*.3,end:i*.3+.5}))} as EditPlan;
  const result=reviewFrameSampling(plan,[]);assert.equal(result.frameLimit,18);assert.equal(result.times.length,18);assert.deepEqual(result.coverage,[]);
  assert.ok(result.limitations.some(l=>l.includes('18帧')));assert.ok(result.times.every(t=>Number.isFinite(t)&&t>=0&&t<=9.95));
  const invalid=reviewFrameSampling({...plan,targetSeconds:NaN},[]);assert.deepEqual(invalid.times,[]);assert.ok(invalid.limitations.length);
});
