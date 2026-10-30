import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {withModelSnapshot,snapshotModels} from '../server/modelContext';
import {requestSceneVisual,validateSceneVisual,SceneVisualProtocolError} from '../server/sceneVisualProtocol';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import {inspectScene} from '../server/sceneUnderstanding';
import {runFFmpeg} from '../server/core';
import {hashBytes} from '../server/narrativeScenes';
import type {SelectedScene} from '../src/types';
const primary={id:'vision-primary',kind:'understanding' as const,name:'Controlled vision',provider:'ark',modelId:'controlled-vision',enabled:true,baseUrl:'https://example.invalid/v3',apiKey:'fake-private-vision-key'};
const fallback={...primary,id:'vision-alternative',modelId:'controlled-alternative'};
const models={text:null,image:null,audio:null,understanding:primary,understandingFallbacks:[fallback]};
const valid={observations:'三张实际帧上部有文字，下部可用。',safeZone:'bottom'};
const response=(value:unknown)=>Response.json({choices:[{message:{content:JSON.stringify(value)}}]});
const content=[{type:'image_url',image_url:{url:'data:image/jpeg;base64,CONTROLLED_FRAME'}},{type:'text',text:'同一实际片段，不得改写原话。'}];

test('invalid or ambiguous visual results never receive an invented default safe zone',()=>{
  for(const value of [null,[],{}, {observations:'',safeZone:'top'}, {observations:'x',safeZone:'top或bottom'},{observations:'x',safeZone:'顶部'},{observations:'x'.repeat(701),safeZone:'top'}])assert.throws(()=>validateSceneVisual(value),SceneVisualProtocolError);
  assert.deepEqual(validateSceneVisual(valid),valid);
  assert.ok(snapshotModels(models).some(m=>m.id===fallback.id),'fallback credentials participate in job redaction');
});

test('a malformed response uses only one frozen vision alternative with identical actual evidence',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});const calls:any[]=[],audit:any[]=[];
  const bad={observations:'实际图解',safeZone:'top或bottom'};
  globalThis.fetch=async(_input,init)=>{calls.push(JSON.parse(String(init?.body)));return response(calls.length===1?bad:valid)};
  const result=await withModelSnapshot(models,()=>requestSceneVisual(primary,content,async record=>{audit.push(record)}));
  assert.deepEqual(result,valid);assert.equal(calls.length,2);assert.equal(calls[0].model,primary.modelId);assert.equal(calls[1].model,fallback.modelId);
  assert.deepEqual(calls[0].messages[1],calls[1].messages[1]);assert.deepEqual(calls[0].messages[1].content,content);
  assert.match(calls[1].messages[0].content,/safeZone须恰为top或bottom/);assert.deepEqual(JSON.parse(JSON.parse(audit[0].wire).choices[0].message.content),bad);
  assert.equal(audit.length,2);assert.equal(audit[0].attempt,1);assert.equal(audit[1].attempt,2);
});

test('two invalid responses exhaust the budget; authorization, audit I/O and cancellation cannot become a pass',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let calls=0;
  globalThis.fetch=async()=>{calls++;return response({observations:'真实画面',safeZone:'unknown'})};
  await assert.rejects(withModelSnapshot(models,()=>requestSceneVisual(primary,content,async()=>{})),SceneVisualProtocolError);assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status:401})};
  await assert.rejects(withModelSnapshot(models,()=>requestSceneVisual(primary,content,async()=>{})),/HTTP 401/);assert.equal(calls,1);
  calls=0;globalThis.fetch=async()=>{calls++;return response(valid)};
  await assert.rejects(withModelSnapshot(models,()=>requestSceneVisual(primary,content,async()=>{throw new Error('disk write failed')})),/disk write failed/);assert.equal(calls,1);
  calls=0;const controller=new AbortController();
  await assert.rejects(runWithJobSignal(controller.signal,()=>withModelSnapshot(models,()=>requestSceneVisual(primary,content,async()=>{controller.abort()}))),JobCancelledError);assert.equal(calls,1);
});

test('real extracted frames survive format recovery and only a validated bound result enters the private cache',{timeout:45000},async t=>{
  const original=globalThis.fetch,dir=await mkdtemp(path.join(tmpdir(),'qingjian-visual-protocol-'));t.after(async()=>{globalThis.fetch=original;await rm(dir,{recursive:true,force:true})});
  const source=path.join(dir,'source.mp4'),cache=path.join(dir,'cache');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=320x180:d=2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const scene={id:'scene',sourceId:'source.mp4',sourceHash:hashBytes(await readFile(source)),start:0,end:2,quote:'保留程序示意与实际原话。'} as SelectedScene;
  const calls:any[]=[];globalThis.fetch=async(_input,init)=>{calls.push(JSON.parse(String(init?.body)));const r=response(calls.length===1?{observations:'实际帧',safeZone:'top或bottom'}:valid);return r};
  const inspect=()=>withModelSnapshot(models,()=>inspectScene(scene,dir,cache));
  const result=await inspect();assert.deepEqual(result,{...valid,frameTimes:[.24,1,1.76]});assert.equal(calls.length,2);assert.equal(calls[0].messages[1].content.filter((c:any)=>c.type==='image_url').length,3);assert.deepEqual(calls[0].messages[1],calls[1].messages[1]);
  assert.deepEqual(await inspect(),result);assert.equal(calls.length,2,'a restart-compatible valid cache makes no request');
  const files=await readdir(cache),saved=files.find(f=>f.endsWith('.json')&&!f.includes('.response-'))!;assert.equal(files.filter(f=>f.includes('.response-')).length,2);
  for(const file of files.filter(f=>f.endsWith('.json')))assert.equal((await stat(path.join(cache,file))).mode&0o777,0o600);
  await writeFile(path.join(cache,saved),JSON.stringify({...result,safeZone:'unknown'}));await assert.rejects(inspect(),SceneVisualProtocolError);assert.equal(calls.length,2,'invalid cache is preserved, never reused as a fabricated safe result');
});
