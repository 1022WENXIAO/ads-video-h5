import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { transcribeWindow, validateTranscript } from '../server/audioUnderstanding';
import { runFFmpeg } from '../server/core';
import { runWithJobSignal } from '../server/jobExecution';

const config={id:'understanding-fixture',name:'controlled field diagnostics',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
const worker=()=>({sentences:[{complete:false,words:[{start:.1,end:.3,text:'原'},{start:.3,end:.6,text:'话'},{start:.6,end:1,text:'清楚'}]}]});
const stored=()=>({sentences:[{start:.1,end:1,text:'原话清楚',...worker().sentences[0]}]});
const response=(value:unknown)=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
async function waveform(){const dir=await mkdtemp(path.join(tmpdir(),'qingjian-asr-fields-')),file=path.join(dir,'unchanged.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=4.86','-ar','16000','-ac','1',file]);return{dir,file,hash:()=>readFile(file).then(bytes=>createHash('sha256').update(bytes).digest('hex'))};}

test('field diagnostics retain exact JSON paths, types and all original shape limits without inferring content',()=>{
  const cases:Array<{raw:any;path:string;condition:RegExp}>=[];
  for(const [field,value]of [['complete',undefined],['complete','true'],['text',''],['words',null],['words',[]],['words',Array.from({length:501},()=>({text:'原',start:.1,end:.2}))]]as const){const raw=stored();(raw.sentences[0]as any)[field]=value;cases.push({raw,path:'sentences[0].'+field,condition:field==='complete'?/boolean/:field==='words'?/1–500/:/非空string/});}
  for(const value of [undefined,null,'',31 as any,'字'.repeat(31)]){const raw=stored();(raw.sentences[0].words[2]as any).text=value;cases.push({raw,path:'sentences[0].words[2].text',condition:/非空string且长度≤30/});}
  cases.push({raw:{sentences:[null]},path:'sentences[0]',condition:/object/},{raw:{sentences:null},path:'sentences',condition:/array/},{raw:{sentences:Array.from({length:201},()=>stored().sentences[0])},path:'sentences.length',condition:/≤200/});
  for(const {raw,path,condition}of cases){const before=structuredClone(raw);assert.throws(()=>validateTranscript(raw,4.86),error=>{assert.ok(error instanceof Error);assert.ok(error.message.startsWith('音频理解'));assert.ok(error.message.includes(path),error.message);assert.match(error.message,condition);assert.match(error.message,/实际/);return true;});assert.deepEqual(raw,before);}
  assert.equal(validateTranscript(stored(),4.86)[0].complete,false);
  const multiple=stored();delete (multiple.sentences[0]as any).complete;delete (multiple.sentences[0].words[2]as any).text;
  assert.throws(()=>validateTranscript(multiple,4.86),/sentences\[0\]\.complete[\s\S]*sentences\[0\]\.words\[2\]\.text/);
});

test('time diagnostics identify the precise range field and preserve decimal parsing, order and0.08edge tolerance',()=>{
  const one={sentences:[{text:'原',complete:true,start:-.08,end:1.08,words:[{text:'原',start:-.08,end:1.08}]}]};
  assert.deepEqual(validateTranscript(one,1)[0].words,[{text:'原',start:0,end:1}]);
  for(const [field,value]of [['start',-.081],['end',1.081],['start',null],['end','1+2']]as const){const raw=structuredClone(one);(raw.sentences[0]as any)[field]=value;assert.throws(()=>validateTranscript(raw,1),new RegExp('音频理解时间码.*sentences\\[0\\]\\.'+field));}
  const strings={sentences:[{text:'原',complete:true,start:'0.10',end:'1.0',words:[{text:'原',start:'0.10',end:'1.0'}]}]};assert.equal(validateTranscript(strings,1)[0].words[0].start,.1);
  const overlap=stored();overlap.sentences[0].words[2].start=.4;assert.throws(()=>validateTranscript(overlap,4.86),/sentences\[0\]\.words\[2\]\.start必须≥0\.520/);
});

test('missing complete and word.text reach the next same-audio transcription system retryReason and only valid output passes',async t=>{
  const w=await waveform(),originalFetch=globalThis.fetch,requests:any[]=[];t.after(()=>{globalThis.fetch=originalFetch;return rm(w.dir,{recursive:true,force:true});});
  const before=await w.hash(),missing=worker();delete (missing.sentences[0]as any).complete;delete (missing.sentences[0].words[2]as any).text;
  globalThis.fetch=async(_input,init)=>{const body=JSON.parse(String(init?.body));requests.push(body);return response(requests.length===1?missing:worker());};
  const result=await transcribeWindow(w.file,0,4.86,config,w.dir);
  assert.equal(requests.length,2);assert.equal(requests[0].max_tokens,10000);assert.equal(requests[1].max_tokens,10000);
  assert.match(requests[1].messages[0].content,/上次具体校验错误：[\s\S]*sentences\[0\]\.complete必须为boolean[\s\S]*实际undefined[\s\S]*sentences\[0\]\.words\[2\]\.text必须为非空string/);
  assert.equal(requests[0].messages[1].content[0].input_audio.data,requests[1].messages[1].content[0].input_audio.data);
  assert.deepEqual(result[0].words,worker().sentences[0].words);assert.equal(result[0].complete,false);assert.equal(await w.hash(),before);
  const failure=JSON.parse(await readFile(path.join(w.dir,'failure-0-4.86-0.json'),'utf8'));assert.match(failure.error,/sentences\[0\]\.complete/);assert.match(failure.error,/words\[2\]\.text/);
});

test('repeated missing fields and wrong bounds fail after the unchanged two calls without invented fields or audio subdivision',async t=>{
  const w=await waveform(),originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;return rm(w.dir,{recursive:true,force:true});});
  for(const kind of ['missing','bounds']as const){
    let calls=0;const raw=worker();if(kind==='missing')delete (raw.sentences[0].words[2]as any).text;else raw.sentences[0].words[2].end=5.2;
    globalThis.fetch=async()=>{calls++;return response(raw);};
    await assert.rejects(transcribeWindow(w.file,0,4.86,config,w.dir),kind==='missing'?/sentences\[0\]\.words\[2\]\.text/:/sentences\[0\]\.end必须≤4\.940/);assert.equal(calls,2,kind);
    assert.equal((await readdir(w.dir)).filter(name=>name.endsWith('.wav')).length,1,'only original waveform survives; no failed word inference or recursive split');
  }
});

test('HTTP authorization, exhausted transport and cancellation keep existing retry strategies separate from schema feedback',async t=>{
  const w=await waveform(),originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;return rm(w.dir,{recursive:true,force:true});});
  for(const status of [401,403,503]){let calls=0;globalThis.fetch=async()=>{calls++;return new Response('',{status,headers:{'retry-after':'0'}});};await assert.rejects(transcribeWindow(w.file,0,4.86,config,w.dir),new RegExp('HTTP '+status));assert.equal(calls,status===503?3:1,'no schema retry or recursive split for HTTP failures');}
  let calls=0;const controller=new AbortController();globalThis.fetch=async()=>{calls++;controller.abort();return response(worker());};
  await assert.rejects(runWithJobSignal(controller.signal,()=>transcribeWindow(w.file,0,4.86,config,w.dir)),{name:'JobCancelledError'});assert.equal(calls,1);
});
