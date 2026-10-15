import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AudioAnalysis, MediaItem, TranscriptSentence } from '../shared/types';
import { createAudioUnderstanding } from '../server/audioUnderstanding';
import { completeSourceCapacity, durationSourceRecovery, sourceAsrRecoveryReasons } from '../server/sourceAsrRecovery';
import { withModelSnapshot } from '../server/modelContext';
import { runFFmpeg } from '../server/core';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';
import { blocksModelOutputRecovery, executionFailure } from '../server/executionErrors';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p21-source-asr-inconsistency.json',import.meta.url),'utf8'));
const config={id:'source-recheck-test',name:'Controlled source recheck',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const sources=()=>fixture.sources.map((source:any)=>({id:source.id,name:'public controlled source',kind:'audio',mimeType:'audio/wav',duration:source.analysis.duration,url:'',createdAt:'',analysis:structuredClone(source.analysis)})) as MediaItem[];
const sentence=(text:string,start:number,end:number,complete=true):TranscriptSentence=>{
  const chars=[...text],step=(end-start)/chars.length;
  return{id:'control-'+start,text,start,end,complete,words:chars.map((text,index)=>({text,start:+(start+index*step).toFixed(3),end:+(start+(index+1)*step).toFixed(3)}))};
};
const fresh=()=>[sentence('先记录观察到的现象',.1,3),sentence('这个示意不是真实现场',3.5,7)];
const snapshot=<T>(action:()=>Promise<T>)=>withModelSnapshot({text:null,audio:null,image:null,understanding:config},action);

test('actual P21 raw negation split and unfinished tail are diagnosed without changing any word/time/complete',()=>{
  const media=sources(),before=structuredClone(media);
  assert.equal(sourceAsrRecoveryReasons(media[0].analysis!)[0].kind,'negation-boundary');
  assert.equal(sourceAsrRecoveryReasons(media[1].analysis!)[0].kind,'duration-incomplete-tail');
  assert.ok(completeSourceCapacity(media)<18);
  const shortage=durationSourceRecovery(media,'两段都用到，剪成20秒');assert.equal(shortage?.minimum,18);assert.equal(shortage?.candidates[0].sourceId,media[1].id);
  assert.deepEqual(media,before);
  assert.match(fixture.sources[0].primary[0].text,/不是$/);assert.match(fixture.sources[0].primary[1].text,/^是真实/);
  for(const [index,source]of fixture.sources.entries())assert.deepEqual(source.primary.flatMap((s:any)=>s.words),media[index].analysis!.sentences.flatMap(s=>s.words));
});

test('a complete negation is ordinary speech; a genuine unfinished tail does not invalidate sufficient other complete content',()=>{
  const media=sources();media[0].analysis!.sentences=[sentence('这个画面不是实拍现场',0,10),sentence('先记录观察再讨论解释',10.5,15.5)];
  media[1].analysis!.sentences=[sentence('比较前保持条件一致',0,7),sentence('暂时没有把握的',16,17.25,false)];
  assert.deepEqual(sourceAsrRecoveryReasons(media[0].analysis!),[]);assert.equal(sourceAsrRecoveryReasons(media[1].analysis!)[0].kind,'duration-incomplete-tail');
  assert.equal(durationSourceRecovery(media,'20秒横屏'),undefined);
  const short=sources();assert.equal(durationSourceRecovery(short,'刚才30秒，改为二十秒')?.minimum,18);assert.equal(durationSourceRecovery(short,'只说主题，没有目标时长'),undefined);
  short[0].analysis!.sentences[1].complete=true;assert.equal(sourceAsrRecoveryReasons(short[0].analysis!).some(reason=>reason.kind==='negation-boundary'),false,'a complete negative answer followed by a contrast is not a broken residual');
});

async function setup(t:test.TestContext,index=0){
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-source-recheck-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const media=sources()[index],file=path.join(directory,'controlled.wav');
  await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t',String(media.duration),file]);
  media.analysis!.sourceHash=hash(await readFile(file));media.analysis!.modelId=config.modelId;
  const dir=path.join(directory,'audio-understanding',media.id);await mkdir(dir,{recursive:true});
  const key=`2:${config.modelId}:${media.analysis!.sourceHash}`;
  await writeFile(path.join(dir,'analysis.json'),JSON.stringify({cacheKey:key+':segmentation-4',analysis:media.analysis}),{mode:0o600});
  await writeFile(path.join(dir,'chunk-0.json'),JSON.stringify({cacheKey:key,start:0,end:media.duration,sentences:fixture.sources[index].primary}),{mode:0o600});
  const originalAnalysis=await readFile(path.join(dir,'analysis.json')),originalChunk=await readFile(path.join(dir,'chunk-0.json'));
  const reason=sourceAsrRecoveryReasons(media.analysis!)[0];
  return{directory,media,file,dir,reason,originalAnalysis,originalChunk};
}
function worker(primary:TranscriptSentence[],counter:{recognition:number;grouping:number;captions:number}):typeof fetch {
  return async(input,init)=>{
    assert.equal(new URL(String(input)).origin,'https://example.invalid');const body=JSON.parse(String(init?.body));let content:unknown;
    if(body.messages[1]?.content?.[0]?.type==='input_audio'){
      counter.recognition++;assert.match(body.messages[0].content,/标题线索：""/);assert.doesNotMatch(body.messages[0].content,/有限复听|原识别句界|真实现场/,'no old heard quote, fixture script or proposed correction is passed to independent ASR');content={sentences:primary};
    }else if(body.messages[0].content.includes('口播分句审查者')){
      counter.grouping++;const payload=JSON.parse(body.messages[1].content);content={groups:payload.primaryUtterances.map((s:any)=>({first:s.first,last:s.last,complete:s.complete}))};
    }else{counter.captions++;const words=JSON.parse(body.messages[1].content);content={breaks:words.filter((_:unknown,index:number)=>(index+1)%5===0||index===words.length-1).map((word:any)=>word.i)};}
    return Response.json({choices:[{message:{content:JSON.stringify(content)}}]});
  };
}

test('one independent same-wave recognition commits separately and restart reuses it without changing the original bytes',async t=>{
  const h=await setup(t),before=structuredClone(h.media),counter={recognition:0,grouping:0,captions:0},original=globalThis.fetch;
  globalThis.fetch=worker(fresh(),counter);t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{
    const result=await createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason);
    assert.equal(result.sourceHash,h.media.analysis!.sourceHash);assert.equal(counter.recognition,1);assert.equal(counter.grouping,1);assert.equal(counter.captions,1);
    assert.deepEqual(await readFile(path.join(h.dir,'analysis.json')),h.originalAnalysis);assert.deepEqual(await readFile(path.join(h.dir,'chunk-0.json')),h.originalChunk);assert.deepEqual(h.media,before);
    assert.deepEqual(await createAudioUnderstanding(h.directory).analyze(h.media,h.file),result);assert.deepEqual(await createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),result);assert.equal(counter.recognition,1);
    const evidence=path.join(h.dir,'source-rechecks',(await readdir(path.join(h.dir,'source-rechecks')))[0]);
    assert.deepEqual(await readFile(path.join(evidence,'original-cache.json')),h.originalAnalysis);assert.deepEqual(await readFile(path.join(evidence,'original-chunk-0.json')),h.originalChunk);
    assert.equal(hash(await readFile(h.file)),h.media.analysis!.sourceHash);
  });
});

test('negation and later visual-tail reasons share the same durable claim after restart',async t=>{
  const h=await setup(t),analysis=h.media.analysis!,last=analysis.sentences.at(-1)!,tail=last.words.slice(-10),head=last.words.slice(0,-10);
  // Retain all original words/times; this control supplies two simultaneous
  // diagnostics to prove that changing the trigger never grants a second call.
  analysis.sentences.splice(-1,1,{...last,text:head.map(word=>word.text).join(''),end:head.at(-1)!.end,words:head},{...last,id:last.id+'-tail',text:tail.map(word=>word.text).join(''),start:tail[0].start,complete:false,words:tail});
  analysis.transcript=analysis.sentences.map(sentence=>sentence.text).join('\n');
  const cache=JSON.parse(h.originalAnalysis.toString());cache.analysis=analysis;
  await writeFile(path.join(h.dir,'analysis.json'),JSON.stringify(cache));const originalBytes=await readFile(path.join(h.dir,'analysis.json'));
  const reasons=sourceAsrRecoveryReasons(analysis);assert.deepEqual(reasons.map(reason=>reason.kind),['negation-boundary','duration-incomplete-tail']);
  const counter={recognition:0,grouping:0,captions:0},fetch=globalThis.fetch;globalThis.fetch=worker(fresh(),counter);t.after(()=>{globalThis.fetch=fetch;});
  await snapshot(async()=>{
    const result=await createAudioUnderstanding(h.directory).recheck(h.media,h.file,reasons[0]);
    const visualTail={...reasons[1],detail:'Actual bound visual witness inside this false tail; no expected words are sent to ASR.'};
    assert.deepEqual(await createAudioUnderstanding(h.directory).recheck(h.media,h.file,visualTail),result);
    assert.equal(counter.recognition,1);assert.equal((await readdir(path.join(h.dir,'source-rechecks'))).length,1);
    assert.deepEqual(await readFile(path.join(h.dir,'analysis.json')),originalBytes);assert.deepEqual(await readFile(path.join(h.dir,'chunk-0.json')),h.originalChunk);
  });
});

test('unchanged bad negation cannot be repaired by merging or relabeling the same words, and failed/unknown claims cannot replay',async t=>{
  const h=await setup(t),counter={recognition:0,grouping:0,captions:0},original=globalThis.fetch;
  const same=fixture.sources[0].primary.map((s:any,i:number)=>({...s,id:'fresh-'+i}));globalThis.fetch=worker(same,counter);t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{
    await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/没有消除|否定句界冲突/);assert.equal(counter.recognition,1);
    await assert.rejects(createAudioUnderstanding(h.directory).analyze(h.media,h.file),/有限独立复听已失败/);
    await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/有限独立复听已失败/);assert.equal(counter.recognition,1);
    const evidence=path.join(h.dir,'source-rechecks',(await readdir(path.join(h.dir,'source-rechecks')))[0]);await rm(path.join(evidence,'failed.json'));
    await assert.rejects(createAudioUnderstanding(h.directory).analyze(h.media,h.file),/结果尚未确认/);assert.equal(counter.recognition,1);
    await writeFile(path.join(evidence,'started.json'),'not valid JSON');await assert.rejects(createAudioUnderstanding(h.directory).analyze(h.media,h.file),SyntaxError);assert.equal(counter.recognition,1);
    assert.deepEqual(await readFile(path.join(h.dir,'analysis.json')),h.originalAnalysis);
  });
});

test('new actual ASR can retain a genuine false tail; only eligible complete content may subsequently be selected',async t=>{
  const h=await setup(t,1),counter={recognition:0,grouping:0,captions:0},original=globalThis.fetch,primary=[...fresh(),sentence('暂时没有把握的',16,17.25,false)];
  globalThis.fetch=worker(primary,counter);t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{const result=await createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason);assert.equal(result.sentences.at(-1)!.complete,false);assert.equal(counter.recognition,1);assert.equal(sourceAsrRecoveryReasons(result)[0].kind,'duration-incomplete-tail');});
});

test('HTTP authorization, actual file changes and OS read errors never become a new recognition loop',async t=>{
  const h=await setup(t),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response('unauthorized',{status:401});};t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/HTTP 401/);assert.equal(calls,1);await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/已失败/);assert.equal(calls,1);});
  await writeFile(h.file,'different actual bytes');await snapshot(()=>assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/哈希不一致/));assert.equal(calls,1);
  const io=await setup(t);await rm(path.join(io.dir,'analysis.json'));await mkdir(path.join(io.dir,'analysis.json'));await snapshot(()=>assert.rejects(createAudioUnderstanding(io.directory).recheck(io.media,io.file,io.reason),(error:NodeJS.ErrnoException)=>error.code==='EISDIR'));assert.equal(calls,1);
});

test('cancellation during recognition is immediate and the started claim blocks a later replay',async t=>{
  const h=await setup(t),controller=new AbortController(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;controller.abort();throw new JobCancelledError();};t.after(()=>{globalThis.fetch=original;});
  await snapshot(()=>assert.rejects(runWithJobSignal(controller.signal,()=>createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason)),JobCancelledError));assert.equal(calls,1);
  await snapshot(()=>assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/已失败|尚未确认/));assert.equal(calls,1);
});

test('a corrupted completed record is refused instead of falling through the legacy cache recomputation',async t=>{
  const h=await setup(t),counter={recognition:0,grouping:0,captions:0},original=globalThis.fetch;globalThis.fetch=worker(fresh(),counter);t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{await createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason);const directory=path.join(h.dir,'source-rechecks',(await readdir(path.join(h.dir,'source-rechecks')))[0]);await writeFile(path.join(directory,'accepted-analysis.json'),'{}');await assert.rejects(createAudioUnderstanding(h.directory).analyze(h.media,h.file),/哈希不一致/);assert.equal(counter.recognition,1);});
});

test('invalid new schema or out-of-range times retain the existing finite ASR validation budget and never promote the old result',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const kind of ['complete','bounds']){
    const h=await setup(t);let calls=0;
    globalThis.fetch=async(input,init)=>{
      assert.equal(new URL(String(input)).origin,'https://example.invalid');const body=JSON.parse(String(init?.body));assert.equal(body.messages[1].content[0].type,'input_audio');calls++;
      return Response.json({choices:[{message:{content:JSON.stringify({sentences:[{...(kind==='bounds'?{complete:true}:{}),words:[{text:'原话',start:0,end:kind==='bounds'?100:.1}]}]})}}]});
    };
    await snapshot(async()=>{
      await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),kind==='complete'?/complete必须为boolean/:/时间码越界/);assert.equal(calls,6,'two existing schema attempts at each of the three permitted split depths; no manager-level repeat');
      await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),/已失败/);assert.equal(calls,6);assert.deepEqual(await readFile(path.join(h.dir,'analysis.json')),h.originalAnalysis);
    });
  }
});

test('concurrent requests share a permanent claim and archived-original tampering fails closed without another ASR',async t=>{
  const h=await setup(t),counter={recognition:0,grouping:0,captions:0},original=globalThis.fetch;globalThis.fetch=worker(fresh(),counter);t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{
    const manager=createAudioUnderstanding(h.directory),results=await Promise.allSettled([manager.recheck(h.media,h.file,h.reason),manager.recheck(h.media,h.file,h.reason)]);assert.ok(results.some(result=>result.status==='fulfilled'));assert.equal(counter.recognition,1);
    const directory=path.join(h.dir,'source-rechecks',(await readdir(path.join(h.dir,'source-rechecks')))[0]);await writeFile(path.join(directory,'original-chunk-0.json'),'tampered');
    await assert.rejects(createAudioUnderstanding(h.directory).analyze(h.media,h.file),/原始证据哈希不一致/);assert.equal(counter.recognition,1);
  });
});

test('an audit write failure retains the original authorization cause and the surviving started claim prevents replay',async t=>{
  const h=await setup(t),original=globalThis.fetch,authorization=Object.assign(new Error('HTTP 401 unauthorized'),{status:401});let calls=0;
  globalThis.fetch=async()=>{calls++;const directory=path.join(h.dir,'source-rechecks',(await readdir(path.join(h.dir,'source-rechecks')))[0]);await mkdir(path.join(directory,'failed.json'));throw authorization;};t.after(()=>{globalThis.fetch=original;});
  await snapshot(async()=>{
    await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),error=>{
      assert.ok(error instanceof AggregateError);assert.equal((error.cause as Error).cause,authorization,'the existing chunk wrapper retains the exact authorization object');assert.ok(error.errors.includes(error.cause));assert.ok(error.errors.some(item=>item.code==='EISDIR'));assert.equal(blocksModelOutputRecovery(error),true);assert.match(JSON.stringify(executionFailure(error)),/HTTP 401 unauthorized/);return true;
    });
    assert.equal(calls,1);await assert.rejects(createAudioUnderstanding(h.directory).recheck(h.media,h.file,h.reason),(error:NodeJS.ErrnoException)=>error.code==='EISDIR');assert.equal(calls,1);
    const directory=path.join(h.dir,'source-rechecks',(await readdir(path.join(h.dir,'source-rechecks')))[0]);assert.ok((await readFile(path.join(directory,'started.json'))).length);
  });
});
