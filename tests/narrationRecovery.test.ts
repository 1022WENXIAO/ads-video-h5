import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AudioAnalysis, LessonChapter, MediaItem } from '../src/types';
import { alignLessonSpeech, correctLessonTranscript } from '../server/lessonSpec';
import { AudioTranscriptOutputError, createAudioUnderstanding, transcribe } from '../server/audioUnderstanding';
import { withModelSnapshot } from '../server/modelContext';
import { runFFmpeg } from '../server/core';
import { NarrationAnalysisError, recognizeExistingNarration } from '../server/narrationAnalysisRecovery';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';
import { TextTransportError } from '../server/executionErrors';

test('recorded news word timings match 双11/双十一 without rewriting heard numbers or accepting missing final speech', async () => {
  const fixture=JSON.parse(await readFile(new URL('./fixtures/news-speech-asr.json',import.meta.url),'utf8')) as {samples:Array<{narration:string;analysis:AudioAnalysis}>};
  for(const {narration,analysis:raw} of fixture.samples) {
    const chapter={id:'ch1',narration,visual:{items:[{cue:'双11'},{cue:'京东十二日晚八点'}]}} as LessonChapter,before=structuredClone(raw);
    const corrected=correctLessonTranscript(chapter,raw),aligned=alignLessonSpeech(chapter,corrected);
    assert.equal(aligned.similarity,1);assert.deepEqual(raw,before);
    assert.equal(corrected.sentences[0].words[0].start,raw.sentences[0].words[0].start);
    assert.equal(corrected.sentences.at(-1)!.words.at(-1)!.end,raw.sentences.at(-1)!.words.at(-1)!.end);
    const words=raw.sentences.flatMap(s=>s.words),first=words.findIndex(w=>w.text==='双');
    assert.equal(aligned.cues[0].start,words[first].start);assert.equal(aligned.cues[0].end,words[first+2].end);
    const changed=structuredClone(raw),changedWords=changed.sentences.flatMap(s=>s.words);
    changedWords[first+2].text='二';for(const sentence of changed.sentences)sentence.text=sentence.words.map(w=>w.text).join('');changed.transcript=changed.sentences.map(s=>s.text).join('\n');
    assert.throws(()=>alignLessonSpeech(chapter,correctLessonTranscript(chapter,changed)),/数字|匹配|台词/,'双十二不能被双十一替代');
    const missing=structuredClone(raw);missing.sentences.at(-1)!.words.pop();for(const sentence of missing.sentences){sentence.text=sentence.words.map(w=>w.text).join('');sentence.end=sentence.words.at(-1)!.end;}missing.transcript=missing.sentences.map(s=>s.text).join('\n');
    assert.throws(()=>alignLessonSpeech(chapter,correctLessonTranscript(chapter,missing)),/末尾台词匹配/);
  }
});

test('recognition-only retries are bounded and never turn authorization, cancellation or exhausted transport into another call', async () => {
  let attempts=0;
  assert.equal(await recognizeExistingNarration(async attempt=>{attempts++;if(!attempt)throw new Error('音频理解第1块失败：The operation was aborted due to timeout，已保存成功块');return 'same-waveform';}),'same-waveform');
  assert.equal(attempts,2);
  for(const error of [new Error('音频理解请求失败（HTTP 403）'),new JobCancelledError(),new TextTransportError(3,new Error('Connection error')),new Error('章节ch1末尾台词匹配不完整')]) {
    attempts=0;await assert.rejects(recognizeExistingNarration(async()=>{attempts++;throw error;}),NarrationAnalysisError);assert.equal(attempts,1);
  }
  attempts=0;await assert.rejects(recognizeExistingNarration(async()=>{attempts++;throw new Error('音频理解结果被截断，请重试。');}),NarrationAnalysisError);assert.equal(attempts,2);
  const controller=new AbortController();controller.abort();attempts=0;
  await assert.rejects(runWithJobSignal(controller.signal,()=>recognizeExistingNarration(async()=>{attempts++;return null;})),JobCancelledError);assert.equal(attempts,0);
});

test('a truncated ASR response records actual output usage separately from the unchanged 10000-token recognition budget', async t=>{
  const original=globalThis.fetch;let requests=0;const content='{"sentences":[';
  globalThis.fetch=async(_input,init)=>{requests++;assert.equal(JSON.parse(String(init?.body)).max_tokens,10000);return Response.json({usage:{completion_tokens:10000},choices:[{finish_reason:'length',message:{content}}]});};
  t.after(()=>{globalThis.fetch=original;});
  const config={id:'understanding-fixture',name:'unit fixture',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
  await assert.rejects(transcribe(Buffer.from('mock audio payload; not a real provider acceptance'),8.16,config,false),error=>{
    assert(error instanceof AudioTranscriptOutputError);assert.deepEqual(error.diagnostic,{durationSeconds:8.16,maxTokens:10000,completionTokens:10000,outputCharacters:content.length,finishReason:'length'});return true;
  });assert.equal(requests,1);
});

test('only generated narration can preserve validated original ASR after invalid segmentation, keeping words, flags and strict-upload separation', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-narration-postprocess-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'speech.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','2',file]);
  const original=globalThis.fetch;let recognition=0,segmentation=0;
  const raw=[{complete:false,words:[{text:'先观察',start:.1,end:.7}]},{complete:true,words:[{text:'再比较',start:.8,end:1.2},{text:'留证据',start:1.3,end:1.8}]}];
  globalThis.fetch=async(_input,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.model,'doubao-seed-2-1-lite-260915','a postprocessing error must not submit new speech generation');
    let content:unknown;
    if(body.messages[1]?.content?.[0]?.type==='input_audio'){recognition++;content={sentences:raw};}
    else if(body.messages[0].content.includes('口播分句审查者')){segmentation++;content={groups:[{first:0,last:0,complete:true}]};}
    else content={breaks:[2]};
    return Response.json({choices:[{message:{content:JSON.stringify(content)}}]});
  };
  t.after(()=>{globalThis.fetch=original;});
  const config={id:'understanding-fixture',name:'unit fixture',kind:'understanding' as const,modelId:'doubao-seed-2-1-lite-260915',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
  const media:MediaItem={id:'same-narration',name:'教学旁白-原词保留',kind:'audio',origin:'generated',mimeType:'audio/wav',duration:2,url:'',createdAt:''};
  const manager=createAudioUnderstanding(directory),hash=()=>readFile(file).then(bytes=>createHash('sha256').update(bytes).digest('hex')),before=await hash();
  await withModelSnapshot({text:null,audio:null,image:null,understanding:config},async()=>{
    const value=await manager.analyze(media,file,undefined,{purpose:'generated-narration'});
    assert.deepEqual(value.sentences.flatMap(s=>s.words),raw.flatMap(s=>s.words));assert.deepEqual(value.sentences.map(s=>s.complete),[false,true]);
    assert.match(value.warnings.join('\n'),/保留原始ASR分组与完整性标记/);assert.equal(recognition,1);assert.equal(segmentation,3);assert.equal(await hash(),before);
    await assert.rejects(manager.analyze(media,file),/分句遗漏/,'ordinary uploaded editing cannot reuse a narration-only segmentation recovery');
    assert.equal(recognition,1,'the successful original ASR block is preserved');assert.equal(segmentation,6);
  });
});
