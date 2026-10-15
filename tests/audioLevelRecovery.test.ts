import test from 'node:test';
import assert from 'node:assert/strict';
import { audioLevelOnlyRepair } from '../server/visualRecovery';
import type { EditPlan, RenderReview } from '../shared/types';

function fixture():{plan:EditPlan;review:RenderReview}{
  const plan={clips:[{sceneId:'chapter-1'}],audio:{normalize:true},lesson:{factReview:{needsRepair:false,score:85,findings:[]}}} as EditPlan;
  const checks=['画幅与音轨','教学事实与来源','完整句子','字幕原话','人声响度','段落音色一致性','成片语义审查','分段人声响度一致性','段落衔接音量跳变','段内音量稳定性','声音峰值与削波'].map(name=>({name,passed:name!=='段内音量稳定性',detail:name==='段内音量稳定性'?'有声窗P90−P10：chapter-1=8.1 LU，限值8 LU。':'实际检查已通过'}));
  const review={status:'needs-review',score:85,checks,semantic:{score:85,findings:[],suggestions:[]},audio:{segments:[{id:'chapter-1',integratedLufs:-16.19,truePeakDb:-2.12,voicedSpreadLu:8.1}],segmentSpreadLu:0,jumps:[],voice:{consistency:{status:'passed',detail:'实际审听声线一致，无明显失真。'},segments:[{id:'chapter-1',status:'passed',detail:'声音清楚，未发现削波。'}]}}} as RenderReview;
  return {plan,review};
}

test('actual P11 shape: only measured 8.1 LU failure with passed semantics and listening routes to existing audio render',()=>{
  const {plan,review}=fixture(),before=structuredClone({plan,review});
  assert.equal(audioLevelOnlyRepair(review,plan),true);
  assert.deepEqual({plan,review},before);
});

test('explicitly disabled or absent normalization and unverified facts do not authorize audio recovery',()=>{
  const {plan,review}=fixture();
  assert.equal(audioLevelOnlyRepair(review),false);
  for(const changed of [{...plan,audio:{...plan.audio,normalize:false}},{...plan,audio:undefined},{...plan,lesson:undefined},{...plan,lesson:{...plan.lesson!,factReview:undefined}},{...plan,lesson:{...plan.lesson!,factReview:{...plan.lesson!.factReview!,needsRepair:true}}}])assert.equal(audioLevelOnlyRepair(review,changed),false);
});

test('facts, missing words, subtitles, visuals or a separate failed check cannot be misclassified as level-only',()=>{
  for(const name of ['教学事实与来源','完整句子','字幕原话','成片语义审查','画幅与音轨','未知检查']){
    const {plan,review}=fixture();review.checks.push({name,passed:false,detail:'真实缺陷'});
    assert.equal(audioLevelOnlyRepair(review,plan),false,name);
  }
  const {plan,review}=fixture();review.semantic!.findings=['chapter-1旁白漏掉关键字'];
  assert.equal(audioLevelOnlyRepair(review,plan),false);
});

test('uncertain or failed listening, low semantics, absent voice and user voice rejection require their original recovery',()=>{
  for(const status of ['uncertain','failed'] as const){const {plan,review}=fixture();review.audio!.voice!.consistency.status=status;assert.equal(audioLevelOnlyRepair(review,plan),false);}
  for(const change of [
    (r:RenderReview)=>{r.semantic!.score=79;},
    (r:RenderReview)=>{r.audio!.voice=undefined;},
    (r:RenderReview)=>{r.audio!.voice!.segments[0].status='uncertain';},
    (r:RenderReview)=>{r.audio!.userReportedMismatch=true;},
    (r:RenderReview)=>{r.audio!.voice!.segments=[];},
  ]){const {plan,review}=fixture();change(review);assert.equal(audioLevelOnlyRepair(review,plan),false);}
});

test('missing audio measurements, nonfinite values, duplicated segments and audible clipping are never treated as gain issues',()=>{
  for(const change of [
    (r:RenderReview)=>{r.audio!.segments[0].integratedLufs=null;},
    (r:RenderReview)=>{r.audio!.segments[0].voicedSpreadLu=NaN;},
    (r:RenderReview)=>{r.audio!.segments[0].truePeakDb=0;},
    (r:RenderReview)=>{r.audio!.segments.push({...r.audio!.segments[0]});},
    (r:RenderReview)=>{r.audio!.voice!.consistency.detail='存在可闻削波，原声已有失真。';},
    (r:RenderReview)=>{r.checks.find(c=>c.name==='段内音量稳定性')!.detail='音轨缺失，未测得有效人声';},
  ]){const {plan,review}=fixture();change(review);assert.equal(audioLevelOnlyRepair(review,plan),false);}
});

test('incomplete, duplicated level checks and already passed reviews cannot trigger the one reserved repair',()=>{
  const {plan,review}=fixture();review.checks=review.checks.filter(c=>c.name!=='声音峰值与削波');assert.equal(audioLevelOnlyRepair(review,plan),false);
  const duplicate=fixture();duplicate.review.checks.push({...duplicate.review.checks.find(c=>c.name==='声音峰值与削波')!});assert.equal(audioLevelOnlyRepair(duplicate.review,duplicate.plan),false);
  const passed=fixture();passed.review.status='passed';assert.equal(audioLevelOnlyRepair(passed.review,passed.plan),false);
});
