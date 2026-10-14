import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {AudioTranscriptOutputError,transcribeWindow} from '../server/audioUnderstanding';
import {runFFmpeg} from '../server/core';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';

const config={id:'fixture',name:'offline ASR fixture',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const truncated=()=>Response.json({usage:{completion_tokens:10000},choices:[{finish_reason:'length',message:{content:'{"sentences":['}}]});
const valid=(text:string)=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({sentences:[{complete:true,words:[{start:.1,end:.6,text}]}]})}}]});
function requestDuration(init?:RequestInit){
  const body=JSON.parse(String(init?.body));assert.equal(body.max_tokens,10000);assert.equal(body.messages[1].content[0].type,'input_audio');
  const match=/音频总长 ([\d.]+) 秒/.exec(body.messages[1].content[1].text);assert.ok(match);return Number(match[1]);
}
async function fixture(t:any,duration=9.22){
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-asr-truncation-')),file=path.join(directory,'source.wav');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await runFFmpeg(['-v','error','-y','-f','lavfi','-i',`sine=frequency=440:sample_rate=16000:duration=${duration}`,'-ac','1',file]);
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  return{directory,file,before:hash(await readFile(file))};
}

test('actual 9.22-second truncated ASR shape immediately splits once and keeps real word times',async t=>{
  const {directory,file,before}=await fixture(t),calls:number[]=[];
  globalThis.fetch=async(_input,init)=>{const duration=requestDuration(init);calls.push(duration);return calls.length===1?truncated():valid(calls.length===2?'先观察':'再比较');};
  const result=await transcribeWindow(file,0,9.22,config,directory);
  assert.deepEqual(calls,[9.22,4.61,4.61]);
  assert.deepEqual(result.map(s=>s.text),['先观察','再比较']);assert.deepEqual(result.flatMap(s=>s.words).map(w=>({start:w.start,end:w.end})),[{start:.1,end:.6},{start:4.71,end:5.21}]);
  assert.equal(hash(await readFile(file)),before);
  const diagnostic=JSON.parse(await readFile(path.join(directory,'failure-0-9.22-0.json'),'utf8'));
  assert.deepEqual(diagnostic.responseDiagnostic,{durationSeconds:9.22,maxTokens:10000,completionTokens:10000,outputCharacters:14,finishReason:'length'});
  assert.equal((await readdir(directory)).filter(name=>name.startsWith('failure-')).length,1);
});

test('persistent truncation keeps the existing depth limit without repeating full windows or accepting partial JSON',async t=>{
  const {directory,file}=await fixture(t,24),calls:number[]=[];
  globalThis.fetch=async(_input,init)=>{calls.push(requestDuration(init));return truncated();};
  await assert.rejects(transcribeWindow(file,0,24,config,directory),AudioTranscriptOutputError);
  assert.deepEqual(calls,[24,12,6]);
  const failures=(await readdir(directory)).filter(name=>name.startsWith('failure-'));assert.equal(failures.length,3);
  assert.deepEqual((await Promise.all(failures.map(async name=>JSON.parse(await readFile(path.join(directory,name),'utf8')).depth))).sort(),[0,1,2]);
});

test('a truncated window below six seconds fails once with its output diagnostic and unchanged source',async t=>{
  const {directory,file,before}=await fixture(t,5.99);let calls=0;
  globalThis.fetch=async()=>{calls++;return truncated();};
  await assert.rejects(transcribeWindow(file,0,5.99,config,directory),AudioTranscriptOutputError);
  assert.equal(calls,1);assert.equal(hash(await readFile(file)),before);
});

test('ordinary schema recovery still retries the same audio window before subdivision',async t=>{
  const {directory,file}=await fixture(t),calls:number[]=[];
  globalThis.fetch=async(_input,init)=>{calls.push(requestDuration(init));return calls.length===1?Response.json({choices:[{message:{content:'{"sentences":[{"complete":true}]}'}}]}):valid('原话保留');};
  assert.equal((await transcribeWindow(file,0,9.22,config,directory))[0].text,'原话保留');assert.deepEqual(calls,[9.22,9.22]);
});

for(const status of [401,429,500])test(`HTTP ${status} never becomes output-limit subdivision`,async t=>{
  const {directory,file}=await fixture(t),durations:number[]=[];
  globalThis.fetch=async(_input,init)=>{durations.push(requestDuration(init));return new Response('Controlled refusal',{status});};
  await assert.rejects(transcribeWindow(file,0,9.22,config,directory),new RegExp(`HTTP ${status}`));
  // Understanding calls retain the shared text-transport retry policy. No
  // ASR output repair or smaller-window submission may follow that policy.
  assert.deepEqual(durations,Array(status===401?1:3).fill(9.22));
  assert.equal((await readdir(directory)).filter(name=>name.startsWith('failure-')).length,1);
});

test('cancellation after truncated ASR reception cannot start a smaller recognition request',async t=>{
  const {directory,file}=await fixture(t),controller=new AbortController();let calls=0;
  globalThis.fetch=async()=>{calls++;controller.abort();return truncated();};
  await assert.rejects(runWithJobSignal(controller.signal,()=>transcribeWindow(file,0,9.22,config,directory)),JobCancelledError);assert.equal(calls,1);
});
