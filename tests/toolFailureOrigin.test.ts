import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowEvent } from '../src/types';
import { createToolTrace, executionDiagnostics } from '../server/toolTrace';
import { executionOrigin } from '../server/executionErrors';
import { JobCancelledError } from '../server/jobExecution';

const event=(tool:string,callId:string,input:unknown,status:WorkflowEvent['status'],at:string,durationMs=0,detail=''):WorkflowEvent=>({tool,callId,stage:callId,input,status,at,durationMs,detail});
const failure=()=>event('synthesize_chapter','failed-ch1',{chapterId:'ch1'},'failed','2026-10-14T22:04:42.313Z',329,'模型服务请求失败（HTTP 429，UPSTREAM_ERROR）。');

test('actual P9 ch1 rejection is not marked recovered by concurrently successful ch2 or by a later different chapter',()=>{
  const events=[failure(),event('synthesize_chapter','parallel-ch2',{chapterId:'ch2'},'succeeded','2026-10-14T22:04:42.315Z',28629),event('synthesize_chapter','later-ch3',{chapterId:'ch3'},'succeeded','2026-10-14T22:05:13.250Z',25000)];
  const before=JSON.stringify(events),diagnostics=executionDiagnostics(events);
  assert.equal(diagnostics.recoveredFailures,0);assert.equal(diagnostics.failures[0].recovery.status,'unresolved');assert.equal(diagnostics.failures[0].kind,'provider-unavailable');assert.equal(JSON.stringify(events),before);
  events.push(event('synthesize_chapter','real-retry-ch1',{chapterId:'ch1',audioHash:'new-take'},'succeeded','2026-10-14T22:05:40.000Z',22000));
  assert.equal(executionDiagnostics(events).failures[0].recovery.callId,'real-retry-ch1');
});

test('stable scene/source/item identities and actual start time constrain recovery while global write-to-revise still works',()=>{
  for(const key of ['chapterId','sceneId','sourceId','itemId','beatId','mediaId','clipId']){
    const failed=event('render_one','failure',{[key]:'one'},'failed','2026-10-14T22:00:00Z',500,'HTTP 503');
    for(const input of [{[key]:'two'},{}])assert.equal(executionDiagnostics([failed,event('render_one','other',input,'succeeded','2026-10-14T22:00:01Z')]).recoveredFailures,0,key);
    assert.equal(executionDiagnostics([failed,event('render_one','parallel-same',{[key]:'one'},'succeeded','2026-10-14T22:00:00.100Z')]).recoveredFailures,0,key+' cannot treat an earlier in-flight duplicate as retry');
    assert.equal(executionDiagnostics([failed,event('render_one','retry',{[key]:'one'},'succeeded','2026-10-14T22:00:00.500Z')]).recoveredFailures,1,key);
  }
  const global=event('write_lesson_script','write',{},'failed','2026-10-14T22:00:00Z',5,'预算超限');
  assert.equal(executionDiagnostics([global,event('revise_lesson_script','revise',{},'succeeded','2026-10-14T22:00:01Z')]).recoveredFailures,1);
  const nested=event('render_one','nested',{chapter:{id:'ch1'}},'failed','',0,'HTTP 503');
  assert.equal(executionDiagnostics([nested,event('render_one','same',{chapterId:'ch1'},'succeeded','')]).recoveredFailures,1);
  assert.equal(executionDiagnostics([nested,event('render_one','other',{chapterId:'ch2'},'succeeded','')]).recoveredFailures,0);
});

test('chapter review feedback is not repaired by another chapter repair or passing review',()=>{
  const failed={...event('review_chapter','review-1',{chapterId:'ch1'},'succeeded','2026-10-14T22:00:00Z',100),output:{status:'needs-review',score:78}};
  const events=[failed,event('repair_visual','repair-2',{chapterId:'ch2'},'succeeded','2026-10-14T22:00:01Z'),{...event('review_chapter','review-2',{chapterId:'ch2'},'succeeded','2026-10-14T22:00:02Z'),output:{status:'passed'}}];
  const feedback=executionDiagnostics(events).qualityFeedback[0];assert.equal(feedback.status,'unresolved');assert.equal(feedback.repairTool,undefined);
  events.push(event('repair_visual','repair-1',{chapterId:'ch1'},'succeeded','2026-10-14T22:00:03Z'));
  events.push({...event('review_chapter','review-1-again',{chapterId:'ch1'},'succeeded','2026-10-14T22:00:04Z'),output:{status:'passed'}});
  const recovered=executionDiagnostics(events).qualityFeedback[0];assert.equal(recovered.status,'repaired');assert.equal(recovered.repairCallId,'repair-1');
});

test('nested tool failure records the deepest origin across wrappers without changing the original frozen error or serializing input',async()=>{
  const trace=createToolTrace(async()=>{},['private-test-secret']),original=Object.freeze(new Error('HTTP 429 private-test-secret'));
  const keys=Object.getOwnPropertyNames(original),serialized=JSON.stringify(original);
  let wrapped:Error|undefined;
  await assert.rejects(trace.run('synthesize_narration','生成全片旁白',{token:'private-test-secret'},async()=>{
    try{return await trace.run('synthesize_chapter','合成旁白 · 第一章',{chapterId:'ch1'},async()=>{throw original;},'innermost');}
    catch(cause){wrapped=new Error('章节合成失败',{cause});throw wrapped;}
  },'outer'),error=>error===wrapped);
  const expected={tool:'synthesize_chapter',stage:'合成旁白 · 第一章',callId:'innermost'};
  assert.deepEqual(executionOrigin(original),expected);assert.deepEqual(executionOrigin(wrapped),expected);
  assert.deepEqual(Object.getOwnPropertyNames(original),keys);assert.equal(JSON.stringify(original),serialized);assert.equal(wrapped!.cause,original);
  assert.doesNotMatch(JSON.stringify(trace.events),/private-test-secret/);
  assert.deepEqual(Object.keys(executionOrigin(original)!).sort(),['callId','stage','tool']);
});

test('cancellation keeps the exact error object and deepest stage and cannot become provider recovery',async()=>{
  const error=Object.freeze(new JobCancelledError()),before=Object.getOwnPropertyNames(error),trace=createToolTrace(async()=>{});
  await assert.rejects(trace.run('draw_lesson_scenes','绘制全片',{},()=>trace.run('render_html','绘制与渲染 · 第一章',{chapterId:'ch1'},async()=>{throw error;},'cancel-inner'),'cancel-outer'),caught=>caught===error);
  assert.deepEqual(executionOrigin(error),{tool:'render_html',stage:'绘制与渲染 · 第一章',callId:'cancel-inner'});assert.deepEqual(Object.getOwnPropertyNames(error),before);
  await trace.run('render_html','绘制与渲染 · 第二章',{chapterId:'ch2'},async()=>({ok:true}));
  const diagnostics=executionDiagnostics(trace.events);assert.equal(diagnostics.recoveredFailures,0);assert.ok(diagnostics.failures.every(failure=>failure.kind==='interrupted'));
});
