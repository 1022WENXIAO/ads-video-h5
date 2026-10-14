import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runFFmpeg} from '../server/core';
import {reviewRender} from '../server/renderReview';
import {planHash} from '../server/renderTimeline';
import {withModelSnapshot} from '../server/modelContext';
import {newsFreshAtReview,newsFreshAtOriginalRequest} from '../server/reviewResults';
import type {EditPlan,LessonReport,RenderReview} from '../src/types';

test('actual movie re-review keeps the original publication cutoff across midnight; a new request rejects the now-old article',{timeout:30000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-review-cutoff-')),file=path.join(directory,'controlled.mp4');
  const requestedAt=Date.parse('2026-10-14T15:59:50Z'),reviewedAt=requestedAt+20000,publishedAt=new Date(requestedAt-24*3600000+1000).toISOString();
  // This tiny local color/tone file exercises the actual review function's
  // source-time check. It is not a news video or a production acceptance result.
  const lesson={workflowId:'cutoff-contract-fixture',title:'Controlled cutoff check',requestedSeconds:.5,explicitDuration:true,format:'16:9',chapters:[],references:[{id:'r1',title:'Controlled real-body metadata',url:'https://example.invalid/report',verification:'news-page',freshness:'fresh',publishedAt,excerpt:'Controlled publication cutoff fixture.'}],hotResearch:{asOf:new Date(requestedAt).toISOString(),windowHours:24,signals:[],topics:[],failures:[]},limitations:['Controlled technical fixture; not video acceptance.'],factReview:{score:90,needsRepair:false,findings:[]}} as unknown as LessonReport;
  const plan={lesson,format:'16:9',targetSeconds:.5,summary:'Cutoff fixture only',clips:[{sourceId:'controlled',start:0,end:.5,purpose:'argument'}],captions:[]} as EditPlan;
  let calls=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async()=>{calls++;throw new Error('No paid/model request may run in this cutoff regression');};
  let reviewClock=reviewedAt;t.mock.method(Date,'now',()=>reviewClock);
  try{
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=1280x720:r=30:d=0.5','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=0.5','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-t','0.5',file]);
    await writeFile(file.replace('.mp4','.render.json'),JSON.stringify({planHash:planHash(plan),captions:0,overlays:0,bgm:false,narration:false}));
    assert.equal(newsFreshAtReview(lesson,requestedAt),true);assert.equal(newsFreshAtReview(lesson,reviewedAt),false,'the source crosses the 24h boundary while the film is being made');
    const review=(cutoff:number)=>withModelSnapshot({text:null,image:null,audio:null,understanding:null},()=>reviewRender(file,plan,[],'制作最近24小时新闻视频，不要字幕',undefined,cutoff));
    const originalReview=await review(requestedAt),newRequestReview=await review(reviewedAt);
    const freshness=(result:RenderReview)=>result.checks.find(check=>check.name==='热点来源与时效')!;
    assert.equal(freshness(originalReview).passed,true,'an existing film is evaluated at its fixed original request cutoff');
    assert.equal(freshness(newRequestReview).passed,false,'a new instruction cannot use the old cutoff to make an expired publication look fresh');
    // Research can legitimately start more than five minutes after a queued
    // instruction. Its real sampling time is compared with the review clock,
    // while the article's publication window stays fixed to the instruction.
    reviewClock=requestedAt+10*60000+20000;lesson.hotResearch!.asOf=new Date(requestedAt+10*60000).toISOString();
    assert.equal(newsFreshAtOriginalRequest(lesson,requestedAt,reviewClock),true);
    const delayedQuery=await review(requestedAt);assert.equal(freshness(delayedQuery).passed,true,'a valid query ten minutes after instruction is not an invented future observation');
    lesson.hotResearch!.asOf=new Date(reviewClock+300001).toISOString();
    const futureQuery=await review(requestedAt);assert.equal(freshness(futureQuery).passed,false,'a query later than the actual review clock plus tolerance is rejected');
    assert.equal(calls,0);assert.equal(originalReview.status,'needs-review','a passing source-date subcheck alone cannot imply full media acceptance');
  }finally{await rm(directory,{recursive:true,force:true});}
});
