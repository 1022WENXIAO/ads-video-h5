import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {EditPlan,MediaItem} from '../shared/types';
import {reviewFrameCaptionContext,reviewFrameMessages,reviewJsonOutputExample,reviewRender} from '../server/renderReview';
import {runFFmpeg} from '../server/core';
import {planHash} from '../server/renderTimeline';
import {withModelSnapshot} from '../server/modelContext';
import {extractVisualRetentionRequirements} from '../server/visualRetentionReview';

const actual=JSON.parse(await readFile(new URL('./fixtures/p24-caption-review-frame-context.json',import.meta.url),'utf8'));
const plan=actual.plan as EditPlan;

test('actual P24 15.06 sample is a planned caption gap between the correct two events, not evidence of a freeze',()=>{
  const before=structuredClone(actual),context=reviewFrameCaptionContext(plan,15.06);
  assert.equal(context.frameTime,15.06);assert.equal(context.basis,'plan-reference-not-pixel-or-audio-proof');
  assert.deepEqual(context.clips.map(c=>c.chapterId),['ch2']);assert.equal(context.clips[0].clipIndex,1);
  assert.equal(context.captions.status,'planned-gap');assert.deepEqual(context.captions.active,[]);
  assert.equal(context.captions.previous!.text,actual.expected.previousText);assert.equal(context.captions.previous!.end,15.05);
  assert.equal(context.captions.next!.text,actual.expected.nextText);assert.equal(context.captions.next!.start,15.08);
  assert.deepEqual(context.captions.gap,{start:15.05,end:15.08});assert.deepEqual(actual,before);
  assert.equal(actual.provenance.rawReviewScore,65,'adding a plan reference never changes the retained review');
});

test('actual 14 and 16 second samples reference their own active phrases rather than a nearby sampled caption',()=>{
  const early=reviewFrameCaptionContext(plan,14),late=reviewFrameCaptionContext(plan,16);
  assert.equal(early.captions.status,'active');assert.deepEqual(early.captions.active.map(c=>c.text),['和二十九岁的一男一女']);
  assert.equal(late.captions.status,'active');assert.deepEqual(late.captions.active.map(c=>c.text),['金链约六十克值七点九万港元']);
  assert.equal(early.captions.previous!.text,'核心变化是他警方以盗窃等罪拘捕三十七');
  assert.equal(early.captions.next!.start,15.08);assert.equal(late.captions.previous!.end,15.05);
  assert.equal(early.captions.gap,null);assert.equal(late.captions.gap,null);
});

test('caption ends are exclusive, starts inclusive, and a crossfade names both declared chapters',()=>{
  assert.equal(reviewFrameCaptionContext(plan,15.05).captions.status,'planned-gap');
  assert.equal(reviewFrameCaptionContext(plan,15.08).captions.active[0].start,15.08);
  const mixed=reviewFrameCaptionContext(plan,10.2);assert.equal(mixed.mixedChapterTransition,true);
  assert.deepEqual(mixed.clips.map(c=>c.chapterId),['ch1','ch2']);
  assert.deepEqual(reviewFrameCaptionContext(plan,10.31).clips.map(c=>c.chapterId),['ch2']);
  const outside=reviewFrameCaptionContext(plan,30.13);assert.deepEqual(outside.clips,[]);assert.equal(outside.captions.status,'unverified');assert.equal(outside.captions.gap,null);
  assert.throws(()=>reviewFrameCaptionContext(plan,NaN),/抽帧时间/);assert.throws(()=>reviewFrameCaptionContext(plan,-1),/抽帧时间/);
});

test('ordinary clip plans and missing or ambiguous lesson chapters do not invent a chapter identity',()=>{
  const clipPlan={format:'16:9',targetSeconds:2,summary:'source clip',clips:[{sourceId:'uploaded-video',sceneId:'scene-a',start:5,end:7}],captions:[{start:.1,end:1.5,text:'原声字幕',style:'subtitle'}]} as EditPlan;
  const context=reviewFrameCaptionContext(clipPlan,.5);assert.equal(context.clips[0].sourceId,'uploaded-video');
  assert.equal(context.clips[0].sceneId,'scene-a');assert.equal(context.clips[0].chapterId,null);assert.equal(context.captions.active[0].text,'原声字幕');
  const missing={...plan,lesson:{...plan.lesson!,chapters:[]}};assert.equal(reviewFrameCaptionContext(missing,14).clips[0].chapterId,null);
  const duplicate={...plan,lesson:{...plan.lesson!,chapters:[...plan.lesson!.chapters,plan.lesson!.chapters[1]]}};
  assert.equal(reviewFrameCaptionContext(duplicate,14).clips[0].chapterId,null);
});

test('no caption events and malformed metadata are distinct from a verified planned gap',()=>{
  assert.equal(reviewFrameCaptionContext({...plan,captions:[]},14).captions.status,'no-caption-events');
  const malformed={...plan,captions:[...plan.captions!,{start:1,end:0,text:'bad',style:'subtitle' as const}]};
  const context=reviewFrameCaptionContext(malformed,15.06);assert.equal(context.captions.status,'unverified');assert.equal(context.captions.invalidEntries,1);assert.equal(context.captions.gap,null);
});

test('overlapping caption events remain explicit instead of silently picking one line as actual pixels',()=>{
  const captions=Array.from({length:4},(_,i)=>({start:13,end:17,text:'并存'+i,style:'subtitle' as const}));
  const context=reviewFrameCaptionContext({...plan,captions},14);
  assert.equal(context.captions.activeCount,4);assert.equal(context.captions.active.length,3);assert.equal(context.basis,'plan-reference-not-pixel-or-audio-proof');
});

test('per-output context preserves same-clock source adjacency, original time labels and image identities',()=>{
  const image=(url:string)=>({type:'image_url',image_url:{url}}),outputs=[14,15.06,16].map(time=>({time,image:image('output-'+time)}));
  const source={sourceId:'fixture-scene-2',sourceName:'controlled source',sourceHash:'a'.repeat(64),sourceTime:3.87,image:'local-source',purpose:'mapped' as const,mappedOutputTime:14,clipIndex:1};
  const tail={...source,sourceTime:9.849,purpose:'tail' as const,mappedOutputTime:undefined,clipIndex:undefined};
  const sourceImage=image('source-same-clock'),tailImage=image('source-tail');
  const parts=reviewFrameMessages(plan,outputs,[{frame:source,image:sourceImage},{frame:tail,image:tailImage}]);
  for(const output of outputs){
    const index=parts.indexOf(output.image);assert.ok(index>=2);assert.equal(parts[index-1].text,`成片时间 ${output.time} 秒`);
    const reference=JSON.parse(parts[index-2].text!.slice(parts[index-2].text!.indexOf('{')));
    assert.equal(reference.frameTime,output.time);assert.deepEqual(reference.clips.map((c:any)=>c.chapterId),['ch2']);
    assert.equal(reference.captions.status,output.time===15.06?'planned-gap':'active');
  }
  const outputIndex=parts.indexOf(outputs[0].image);assert.ok(parts[outputIndex+1].text!.startsWith('同刻原素材对照'));assert.equal(parts[outputIndex+2],sourceImage);
  assert.equal(parts.at(-1),tailImage);assert.ok(parts.at(-2)!.text!.includes('没有对应的成片同刻帧'));
  assert.equal(parts.filter(p=>p.type==='image_url').length,5);assert.equal(new Set(parts.filter(p=>p.type==='image_url')).size,5);
  assert.deepEqual(reviewFrameMessages(plan,outputs).filter(p=>p.type==='image_url'),outputs.map(o=>o.image));
});

test('the final JSON example carries only this request\'s mandatory retention and publication fields',()=>{
  const required=extractVisualRetentionRequirements('请保留原有画面标签'),before=structuredClone(required);
  const ordinary=reviewJsonOutputExample([]);assert.equal('visualRetentionChecks' in ordinary,false);assert.equal('newsPublication' in ordinary,false);
  const both=reviewJsonOutputExample(required,{chapterId:'ch1'},.602);
  assert.deepEqual(both.visualRetentionChecks?.map(({id,quote})=>({id,quote})),required);
  assert.deepEqual(both.newsPublication,{visible:false,chapterId:'ch1',quote:'',frameTime:.602});
  assert.equal(both.needsRepair,true,'the structure example is not a passing review');assert.deepEqual(required,before);
});

test('one actual review request includes full conditional JSON obligations beside its actual plan and frame references',{timeout:30000},async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'qingjian-review-frame-contract-')),source=path.join(root,'media','source-1'),movie=path.join(root,'exports','movie.mp4');
  const prompt='请保留原有画面标签',required=extractVisualRetentionRequirements(prompt);
  const fixturePlan={format:'16:9',targetSeconds:2,summary:'controlled request-contract fixture; not video acceptance',clips:[{sourceId:'source-1',start:0,end:2}],captions:[],editorial:{scenes:[],script:{premise:'fixture',audience:'test',arc:'same request',style:'original',beats:[]}}} as EditPlan;
  let calls=0,captured:any;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=(async(_input,init)=>{
    calls++;captured=JSON.parse(String(init?.body));
    const times=captured.messages[1].content.flatMap((p:any)=>{const match=/^成片时间 ([\d.]+) 秒$/.exec(p.text||'');return match?[Number(match[1])]:[];});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:78,findings:[],suggestions:[],needsRepair:true,visualRetentionChecks:required.map(r=>({...r,status:'met',frameTimes:[times[0]],detail:'controlled protocol response, not actual model or media acceptance'}))})}}]}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  try{
    await Promise.all(['media','exports'].map(dir=>mkdir(path.join(root,dir))));
    // Actual local encoded audio/video exercises request assembly. The only
    // semantic response is injected; no provider or true review is performed.
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=96x54:r=30:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-c:a','aac','-t','2',movie]);
    await copyFile(movie,source);const sourceHash=createHash('sha256').update(await readFile(source)).digest('hex');
    const item={id:'source-1',ownerId:'controlled-owner',name:'controlled local source',kind:'video',duration:2,analysis:{sourceHash,status:'ready',transcript:'',sentences:[]}} as MediaItem;
    await writeFile(movie.replace('.mp4','.render.json'),JSON.stringify({planHash:planHash(fixturePlan),captions:0,overlays:0,bgm:false,narration:false}));
    const config={id:'controlled',name:'controlled',provider:'ark',kind:'understanding' as const,modelId:'controlled',baseUrl:'https://fixture.invalid/v3',apiKey:'fixture-only',enabled:true};
    const review=await withModelSnapshot({text:null,image:null,audio:null,understanding:config},()=>reviewRender(movie,fixturePlan,[item],prompt));
    assert.equal(calls,1,'no extra review call is added: '+JSON.stringify(review.limitations));assert.equal(review.semantic?.score,78);assert.equal(review.status,'needs-review');
    const parts=captured.messages[1].content,text=parts.at(-1).text,marker=text.lastIndexOf('输出JSON（'),start=text.indexOf('{',marker),end=text.indexOf('。findings',start);
    assert.ok(marker>=0&&end>start);const example=JSON.parse(text.slice(start,end));
    assert.deepEqual(example.visualRetentionChecks.map(({id,quote}:any)=>({id,quote})),required);assert.equal('newsPublication' in example,false);
    for(const check of example.visualRetentionChecks)for(const field of ['id','quote','status','frameTimes','detail'])assert.ok(field in check);
    assert.ok(text.includes('实际方案：'+JSON.stringify(fixturePlan)));assert.ok(text.includes('评分、状态及观察占位值不可照抄'));
    const outputTimes=parts.flatMap((p:any)=>/^成片时间 ([\d.]+) 秒$/.test(p.text||'')?[p.text]:[]),references=parts.filter((p:any)=>p.text?.startsWith('本张真实成片抽帧的计划参照'));
    assert.equal(outputTimes.length,5);assert.equal(references.length,outputTimes.length);assert.equal(parts.filter((p:any)=>p.type==='input_audio').length,1);
    assert.equal(parts.filter((p:any)=>p.type==='image_url').length,9,'five unchanged output times plus bounded four source frames');
    assert.equal(review.transport?.requests.length,1);assert.equal(review.transport?.requests[0].attempt,1);
  }finally{await rm(root,{recursive:true,force:true});}
});
