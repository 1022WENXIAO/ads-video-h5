import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bindVisualRetentionSources,extractVisualRetentionRequirements,parseVisualRetentionChecks,visualRetentionFindings,visualRetentionReviewInstruction,visualRetentionSelectionNeeded,VisualRetentionReviewError} from '../server/visualRetentionReview';
import {requestSemanticReview} from '../server/semanticReview';
import {validateSemanticReview} from '../server/reviewResults';
import type {ModelConfig} from '../server/modelRegistry';
import type {EditPlan,RenderReview,VisualRetentionCheck} from '../shared/types';
const actual=JSON.parse(await readFile(new URL('./fixtures/p20-visual-retention.json',import.meta.url),'utf8'));
const requirements=extractVisualRetentionRequirements(actual.request);
const sourceContext={frames:[{sourceId:actual.sourceId,sourceTime:actual.actualSourceWitnessTime,sourceHash:actual.sourceSha256}],selectedRanges:actual.source1SelectedRanges.map(([start,end]:number[])=>({sourceId:actual.sourceId,start,end}))};
const context={frameTimes:actual.frameTimes as number[],chapters:[],visualRetentionRequirements:requirements,visualRetentionSources:sourceContext};
const actualPlan={clips:sourceContext.selectedRanges,editorial:{scenes:[{sourceId:actual.sourceId,sourceHash:actual.sourceSha256}]}} as EditPlan;
const good={score:99,needsRepair:false,findings:[],suggestions:[]};
const config={id:'fixture',kind:'understanding',provider:'test',modelId:'fixture',baseUrl:'https://example.invalid/v1',apiKey:'fixture',enabled:true} as ModelConfig;
const response=(value:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{headers:{'Content-Type':'application/json'}});
const checks=():VisualRetentionCheck[]=>requirements.map((r,i)=>({...r,status:i?'unmet':'met',frameTimes:i?[.5,8.1]:[.5],...(i?{sourceEvidence:{sourceId:actual.sourceId,time:actual.actualSourceWitnessTime}}:{}),detail:i?'所选源1仅到12.17秒，实际成片未呈现被要求保留的已有画面表达。':'实际帧中原程序示意和非真实现场标注清楚可见。'}));
const review=(observations:VisualRetentionCheck[]):RenderReview=>({status:'needs-review',score:99,checks:[],semantic:{score:99,findings:[],visualRetentionChecks:observations},limitations:[],createdAt:''});

test('narrow extraction preserves exact quoted clauses and distinguishes positive visual retention from speech and negation',()=>{
  assert.equal(requirements.length,2);
  assert.equal(requirements[0].quote,'保留画面里“程序示意、不是真实现场”的标注');
  assert.equal(requirements[1].quote,'也留着重复观察和证据边界相关的已有画面表达');
  assert.deepEqual(extractVisualRetentionRequirements(actual.request),requirements);
  assert.deepEqual(extractVisualRetentionRequirements('新闻标题是“保留画面证据”，原材料引用“keep the visual label”。'),[]);
  assert.deepEqual(extractVisualRetentionRequirements('普通话原声保留，不要保留原画面标签，无需继续保留画面标注，不要一直保留原画面标签，别再保留旧图解，无需完整保留原画面标签，不要把原画面标签保留下来。不要新增配音或图片。'),[]);
  assert.deepEqual(extractVisualRetentionRequirements("don't keep the visual label; do not retain the old footage; no need to preserve this annotation"),[]);
  assert.equal(extractVisualRetentionRequirements('Keep the visual label "program demo, not live"; retain the original on-screen annotation.').length,2);
  assert.equal(extractVisualRetentionRequirements('标签不重要，但请保留这段画面标注。').length,1,'unrelated earlier negation must not erase a later positive clause');
  assert.deepEqual(extractVisualRetentionRequirements('不要在成片里保留原有画面标签。'),[]);
  assert.equal(extractVisualRetentionRequirements('不要裁切并保留原有画面标签。').length,1);
  assert.equal(extractVisualRetentionRequirements('无需重录但保留画面标注。').length,1);
});

test('actual P20 omission is source-bound late visual content, not missing spoken words; original scores stay intact',()=>{
  assert.equal(actual.repeatVisualStart,14.246);
  assert.ok(actual.source1SelectedRanges.every((r:number[])=>r[1]<actual.repeatVisualStart));
  assert.equal(actual.originalEvaluationScore,100);assert.equal(actual.originalReviewScore,80);assert.equal(actual.originalFirstReviewScore,72);
  const observations=bindVisualRetentionSources(checks(),sourceContext)!,before=structuredClone(observations),findings=visualRetentionFindings(observations,requirements,actual.frameTimes);
  assert.equal(findings.length,1);assert.match(findings[0],/明确视觉保留要求未满足.*重新选择.*不能只改叙事理由/);
  assert.deepEqual(observations,before);
  assert.equal(visualRetentionSelectionNeeded(review(observations),actual.request,actualPlan),true);
});

test('missing/malformed, unknown IDs, altered request quotes and unsampled frames fail closed',()=>{
  assert.equal(parseVisualRetentionChecks(undefined),undefined);
  for(const bad of [null,{},[{...checks()[0],status:'passed'}],[{...checks()[0],frameTimes:[NaN]}],[{...checks()[0],detail:''}]])assert.throws(()=>parseVisualRetentionChecks(bad),VisualRetentionReviewError);
  assert.throws(()=>visualRetentionFindings(undefined,requirements,actual.frameTimes),/缺项/);
  for(const patch of [{id:'invented'},{quote:requirements[0].quote+'补写'},{frameTimes:[.5001]},{frameTimes:[]}]){
    assert.throws(()=>visualRetentionFindings([{...checks()[0],...patch},checks()[1]],requirements,actual.frameTimes),VisualRetentionReviewError);
  }
  assert.throws(()=>visualRetentionFindings([checks()[0],checks()[0]],requirements,actual.frameTimes),/重复/);
  assert.throws(()=>visualRetentionFindings(checks(),[],actual.frameTimes),/没有绑定/);
  assert.equal(visualRetentionSelectionNeeded(review([{...checks()[0],id:'invented'},checks()[1]]),actual.request,actualPlan),false,'unbound structured fields cannot authorize reselection');
});

test('high-score unmet and unverified checks block the same existing review call without claiming pixel recognition',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;
  const frame='data:image/png;base64,'+(await readFile(new URL('./fixtures/p20-final-evidence-frame.png',import.meta.url))).toString('base64');
  globalThis.fetch=(async(_url,options)=>{calls++;const sent=JSON.parse(String(options?.body));assert.ok(JSON.stringify(sent.messages).includes(frame));assert.match(JSON.stringify(sent.messages),/visualRetentionChecks/);return response({...good,visualRetentionChecks:checks()});}) as typeof fetch;
  const result=await requestSemanticReview(config,[{role:'user',content:[{type:'text',text:visualRetentionReviewInstruction(requirements)},{type:'image_url',image_url:{url:frame}}]}],undefined,false,context);
  assert.equal(calls,1);assert.equal(result.score,99);assert.equal(result.needsRepair,true);assert.equal(result.visualRetentionChecks?.length,2);assert.equal(result.retentionAttempts?.[0].score,99);
  const uncertain=checks().map(c=>({...c,status:'unverified' as const,frameTimes:[],detail:'现有实际帧无法确认本项，不能推定缺失或满足。'}));
  assert.equal(visualRetentionFindings(uncertain,requirements,actual.frameTimes).length,2);assert.equal(visualRetentionSelectionNeeded(review(uncertain),actual.request,actualPlan),false);
});

test('correct retained evidence in the actual third clip binds its real sampled frame and preserves80',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;
  const required=extractVisualRetentionRequirements('保留画面里的证据边界标签。');
  const observations:VisualRetentionCheck[]=[{...required[0],status:'met',frameTimes:[20.05],detail:'实际帧可读证据支持的结论和未知部分保留限制。'}];
  globalThis.fetch=(async()=>{calls++;return response({...good,score:80,visualRetentionChecks:observations});}) as typeof fetch;
  const result=await requestSemanticReview(config,[],undefined,false,{frameTimes:[20.05],chapters:[],visualRetentionRequirements:required});
  assert.equal(calls,1);assert.equal(result.needsRepair,false);assert.equal(result.score,80);assert.deepEqual(result.visualRetentionChecks,observations);
});

test('missing protocol gets one specifically explained correction, with raw scores and caller messages retained',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;const messages:unknown[]=[{role:'user',content:'actual frames already supplied'}];
  globalThis.fetch=(async(_url,options)=>{calls++;const sent=JSON.parse(String(options?.body)).messages;if(calls===2){assert.equal(sent.length,2);assert.match(sent[1].content,/缺项.*原分.*同.*|缺项.*原分/);assert.match(sent[1].content,/visualRetentionChecks/);}return response(calls===1?good:{...good,visualRetentionChecks:checks()});}) as typeof fetch;
  const before=structuredClone(messages),result=await requestSemanticReview(config,messages,undefined,false,context);
  assert.equal(calls,2);assert.deepEqual(messages,before);assert.equal(result.needsRepair,true);assert.deepEqual(result.retentionAttempts?.map(a=>a.score),[99,99]);
});

test('persistent unknown frame cannot accept or create extra review calls and keeps both raw scores',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;
  globalThis.fetch=(async()=>{calls++;return response({...good,visualRetentionChecks:[{...checks()[0],frameTimes:[.50001]},checks()[1]]});}) as typeof fetch;
  await assert.rejects(requestSemanticReview(config,[],undefined,false,context),error=>{assert.ok(error instanceof VisualRetentionReviewError);assert.equal(error.attempts?.length,2);assert.deepEqual(error.attempts?.map(a=>a.score),[99,99]);return true;});
  assert.equal(calls,2);
});

test('requests without visual retention preserve the legacy protocol and no new mandatory field',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;
  globalThis.fetch=(async()=>{calls++;return response(good);}) as typeof fetch;
  const result=await requestSemanticReview(config,[]);assert.equal(calls,1);assert.equal(result.visualRetentionChecks,undefined);assert.equal(result.needsRepair,false);assert.equal(validateSemanticReview(good).visualRetentionChecks,undefined);
});

test('only a bound source witness outside actual selected ranges authorizes reselection, not occlusion or model self-claims',()=>{
  const bound=bindVisualRetentionSources(checks(),sourceContext)!;
  assert.equal(bound[1].sourceOmitted,true);assert.equal(bound[1].sourceEvidence?.sourceHash,actual.sourceSha256);
  assert.equal(visualRetentionSelectionNeeded(review(bound),actual.request,actualPlan),true);
  assert.equal(visualRetentionSelectionNeeded(review(checks()),actual.request,actualPlan),false,'unbound model observations alone never authorize source reselection');
  const inside={...sourceContext,frames:[{...sourceContext.frames[0],sourceTime:8.1}]};
  const occluded=bindVisualRetentionSources([checks()[0],{...checks()[1],sourceEvidence:{sourceId:actual.sourceId,time:8.1}}],inside)!;
  assert.equal(occluded[1].sourceOmitted,undefined);assert.equal(visualRetentionSelectionNeeded(review(occluded),actual.request,actualPlan),false);
  assert.equal(visualRetentionSelectionNeeded(review(bound),actual.request,{...actualPlan,clips:[...actualPlan.clips,{sourceId:actual.sourceId,start:14,end:16} as any]}),false,'old omission cannot authorize reselection after the required source range was included');
  assert.throws(()=>bindVisualRetentionSources(checks(),{...sourceContext,frames:[]}),/未绑定/);
  assert.throws(()=>visualRetentionFindings([{...bound[0],frameTimes:[14.6]},bound[1]],requirements,actual.frameTimes),/实际抽帧/,'a true source frame is not a final movie frame');
  const forged=parseVisualRetentionChecks([{...checks()[0],sourceOmitted:true},{...checks()[1],sourceEvidence:undefined,sourceOmitted:true}])!;
  assert.ok(forged.every(c=>c.sourceOmitted===undefined));
});
