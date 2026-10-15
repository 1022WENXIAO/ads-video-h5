import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {requestSemanticReview,SemanticReviewProtocolError,semanticReviewProtocolDiagnostics} from '../server/semanticReview';
import {VisualRetentionReviewError} from '../server/visualRetentionReview';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';
import {TextTransportError} from '../server/executionErrors';
import {providerTransportSettings} from '../server/providerTransport';
import {reviewRender} from '../server/renderReview';
import {runFFmpeg} from '../server/core';
import {planHash} from '../server/renderTimeline';
import {withModelSnapshot} from '../server/modelContext';
import type {EditPlan} from '../shared/types';

const config={id:'controlled-review',name:'Controlled review',provider:'ark',kind:'understanding' as const,modelId:'controlled-model',baseUrl:'https://example.invalid/v3',apiKey:'controlled-not-a-real-secret',enabled:true};
const good={score:76,needsRepair:true,findings:['Controlled original low verdict'],suggestions:[]};
const response=(value:unknown)=>Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
const badJson=()=>Response.json({choices:[{message:{content:'not-json PRIVATE_RESPONSE_SENTINEL Bearer never-serialize-me https://private.invalid/path'}}]});

test('two HTTP200 protocol failures retain their actual distinct stages and only a parsed finite raw score',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;const metrics:any[]=[];
  globalThis.fetch=async()=>++calls===1?badJson():response({score:93,needsRepair:'PRIVATE_SCHEMA_SENTINEL',findings:[],suggestions:[]});
  await assert.rejects(requestSemanticReview(config,[],metric=>metrics.push(metric)),error=>{
    assert.ok(error instanceof SemanticReviewProtocolError);assert.equal(error.name,'SemanticReviewProtocolError');
    assert.deepEqual(error.diagnostics.map(({attempt,stage,code,rawScore})=>({attempt,stage,code,rawScore})),[
      {attempt:1,stage:'message-json',code:'SEMANTIC_MESSAGE_JSON_INVALID',rawScore:undefined},
      {attempt:2,stage:'review-schema',code:'SEMANTIC_REVIEW_SCHEMA_INVALID',rawScore:93},
    ]);
    assert.ok(error.cause instanceof Error);assert.equal(semanticReviewProtocolDiagnostics(error),error.diagnostics);
    assert.doesNotMatch(JSON.stringify(error.diagnostics)+error.message,/PRIVATE_|Bearer|never-serialize|private\.invalid|controlled-not-a-real-secret/);
    assert.equal('rawScore' in error.diagnostics[0],false,'no invented zero when JSON never parsed');return true;
  });
  assert.equal(calls,2);assert.deepEqual(metrics.map(m=>m.status),[200,200]);assert.ok(metrics.every(m=>!m.error));
});

test('successful second protocol result retains its raw low score and original rejection with safe first-attempt diagnostics',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>++calls===1?badJson():response(good);
  const result=await requestSemanticReview(config,[]);
  assert.equal(calls,2);assert.equal(result.score,76);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,good.findings);
  assert.equal(result.protocolDiagnostics?.length,1);assert.equal(result.protocolDiagnostics?.[0].stage,'message-json');assert.equal(result.protocolDiagnostics?.[0].rawScore,undefined);
});

test('a finite parsed score is recorded even when the schema rejects its range, while nonnumeric scores remain absent',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>response({...good,score:++calls===1?101:'76'});
  await assert.rejects(requestSemanticReview(config,[]),error=>{assert.ok(error instanceof SemanticReviewProtocolError);assert.equal(error.diagnostics[0].rawScore,101);assert.equal('rawScore' in error.diagnostics[1],false);return true;});assert.equal(calls,2);
});

test('publication and numeric evidence failures are attributable without storing the model claim or response',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>{calls++;return response({...good,score:94});};
  await assert.rejects(requestSemanticReview(config,[],undefined,true),error=>{assert.ok(error instanceof SemanticReviewProtocolError);assert.deepEqual(error.diagnostics.map(d=>d.stage),['news-publication','news-publication']);assert.deepEqual(error.diagnostics.map(d=>d.rawScore),[94,94]);return true;});assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;return response({...good,numericVisualChecks:[{chapterId:'not-this-chapter',frameTime:1,claim:'top-4',expectedCount:4,observedCount:3,observedEvidence:'PRIVATE_MODEL_EVIDENCE'}]});};
  await assert.rejects(requestSemanticReview(config,[],undefined,false,{frameTimes:[1],chapters:[{id:'chapter-1',start:0,end:2}]}),error=>{assert.ok(error instanceof SemanticReviewProtocolError);assert.deepEqual(error.diagnostics.map(d=>d.stage),['numeric-evidence','numeric-evidence']);assert.match(error.message,/章节或时点/);assert.doesNotMatch(JSON.stringify(error.diagnostics),/PRIVATE_MODEL_EVIDENCE|top-4/);return true;});assert.equal(calls,2);
});

test('retention failures keep their existing dedicated type and raw attempts while adding safe binding/check stages',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  const requirement={id:'keep-label',quote:'保留已有画面标签'},context={frameTimes:[1],chapters:[],visualRetentionRequirements:[requirement],visualRetentionSources:{frames:[{sourceId:'source',sourceTime:2,sourceHash:'a'.repeat(64)}],selectedRanges:[{sourceId:'source',start:0,end:3}]}};
  globalThis.fetch=async()=>{calls++;return response({...good,visualRetentionChecks:[{...requirement,status:'met',frameTimes:[1],detail:'Controlled observation',sourceEvidence:{sourceId:'other-source',time:2}}]});};
  await assert.rejects(requestSemanticReview(config,[],undefined,false,context),error=>{assert.ok(error instanceof VisualRetentionReviewError);assert.ok(!(error instanceof SemanticReviewProtocolError));assert.deepEqual(error.attempts?.map(a=>a.score),[76,76]);assert.deepEqual(semanticReviewProtocolDiagnostics(error)?.map(d=>d.stage),['retention-binding','retention-binding']);return true;});assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>++calls===1?badJson():response({...good,visualRetentionChecks:[{...requirement,status:'met',frameTimes:[1.1],detail:'Controlled observation'}]});
  await assert.rejects(requestSemanticReview(config,[],undefined,false,context),error=>{assert.ok(error instanceof VisualRetentionReviewError);assert.equal(error.attempts?.length,1,'generic failures do not alter the old retention-attempt contract');assert.deepEqual(semanticReviewProtocolDiagnostics(error)?.map(d=>d.stage),['message-json','retention-checks']);return true;});assert.equal(calls,2);
});

test('HTTP401, cancellation and network errors retain their prior identity and cannot inherit a previous protocol stage',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response('PRIVATE_AUTH_BODY',{status:401});};
  await assert.rejects(requestSemanticReview(config,[]),error=>{assert.ok(error instanceof Error);assert.equal(error.message,'HTTP 401');assert.ok(!(error instanceof SemanticReviewProtocolError));assert.equal(semanticReviewProtocolDiagnostics(error),undefined);return true;});assert.equal(calls,1);
  calls=0;const controller=new AbortController();globalThis.fetch=async()=>{calls++;controller.abort();throw new DOMException('Controlled abort','AbortError');};
  await assert.rejects(runWithJobSignal(controller.signal,()=>requestSemanticReview(config,[])),JobCancelledError);assert.equal(calls,1);
  calls=0;const network=new TypeError('fetch failed');globalThis.fetch=async()=>{if(++calls===1)return badJson();throw network;};
  await assert.rejects(requestSemanticReview(config,[]),error=>{assert.ok(error instanceof TextTransportError);assert.equal(error.cause,network);assert.ok(!(error instanceof SemanticReviewProtocolError));assert.equal(semanticReviewProtocolDiagnostics(error),undefined);assert.equal(error.attempts,providerTransportSettings().textMaxRetries+1);return true;});assert.equal(calls,1+providerTransportSettings().textMaxRetries+1,'one protocol response plus the unchanged lower-level text transport budget, no extra semantic request');
});

test('outer HTTP response JSON errors stay outside the local message/schema wrapper',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;const metrics:any[]=[];
  globalThis.fetch=async()=>{calls++;return new Response('not outer JSON',{status:200});};
  await assert.rejects(requestSemanticReview(config,[],metric=>metrics.push(metric)),error=>{assert.ok(error instanceof SyntaxError);assert.ok(!(error instanceof SemanticReviewProtocolError));return true;});assert.equal(calls,2);assert.deepEqual(metrics.map(m=>m.error),['SyntaxError','SyntaxError']);
});

test('actual local render-review persists safe protocol diagnostics beside unchanged score0/semanticnull and exactly two mock requests',{timeout:30000},async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-semantic-diagnostic-')),file=path.join(directory,'controlled.mp4');
  const plan={format:'16:9',targetSeconds:2,summary:'Controlled protocol diagnostics, not media acceptance',clips:[{sourceId:'controlled',start:0,end:2}],captions:[]} as EditPlan;
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>++calls===1?badJson():response({score:91,needsRepair:'PRIVATE_SCHEMA_SENTINEL',findings:[],suggestions:[]});
  try{
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=960x540:r=30:d=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-threads','1','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-t','2',file]);
    await writeFile(file.replace('.mp4','.render.json'),JSON.stringify({planHash:planHash(plan),captions:0,overlays:0,bgm:false,narration:false}));
    const review=await withModelSnapshot({text:null,image:null,audio:null,understanding:config},()=>reviewRender(file,plan,[],'检查这条技术测试片，不是成片验收'));
    assert.equal(calls,2);assert.equal(review.score,0);assert.equal(review.semantic,undefined);assert.equal(review.status,'needs-review');assert.equal(review.checks.find(c=>c.name==='成片语义审查')!.passed,false);
    const prefix='语义审查协议阶段诊断（不含模型正文）：',line=review.limitations.find(l=>l.startsWith(prefix));assert.ok(line);const diagnostics=JSON.parse(line.slice(prefix.length));
    assert.deepEqual(diagnostics.map((d:any)=>d.stage),['message-json','review-schema']);assert.equal(diagnostics[1].rawScore,91);
    assert.doesNotMatch(JSON.stringify(review),/PRIVATE_|never-serialize|private\.invalid|controlled-not-a-real-secret/);
    const persisted=JSON.parse(await readFile(file.replace('.mp4','.review.json'),'utf8'));assert.equal(persisted.score,0);assert.equal(persisted.semantic,undefined);assert.ok(persisted.limitations.includes(line));
  }finally{await rm(directory,{recursive:true,force:true});}
});
