import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lessonModelVersions} from '../server/lessonModelVersions';
import {alignLessonSpeech,correctLessonTranscript} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../src/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p15-speech-formatting.json',import.meta.url),'utf8')) as {cases:Array<{chapter:LessonChapter;raw:AudioAnalysis}>};
const actual=fixture.cases[0],tokens=(text:string)=>lessonModelVersions(text,value=>value);
const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'controlled',sourceHash:'unchanged-controlled-waveform',duration:text.length*.1,transcript:text,sentences:[{id:'s',text,start:0,end:text.length*.1,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''});

test('actual P15 two model mentions retain their prefix, literal version and count across spaces/hyphens',()=>{
  const before=structuredClone(actual);
  assert.deepEqual(tokens(actual.chapter.narration),['deepseekv:4.1','deepseekv:4.1']);
  assert.deepEqual(tokens(actual.raw.transcript),tokens(actual.chapter.narration));
  for(const spelling of ['DeepSeek V4.1 Flash','DeepSeek-V4.1-Flash','DeepSeekV4.1Flash'])assert.deepEqual(tokens(spelling),['deepseekv:4.1']);
  assert.deepEqual(actual,before);
});

test('the actual ASR still rejects its unrelated glyph error after the version formatting false rejection is removed',()=>{
  const before=structuredClone(actual),corrected=correctLessonTranscript(actual.chapter,actual.raw);
  assert.throws(()=>alignLessonSpeech(actual.chapter,corrected),error=>error instanceof Error&&!/型号或版本数字/.test(error.message)&&/字词|匹配|原词/.test(error.message));
  assert.deepEqual(actual,before,'actual word times, transcript and hash remain evidence; no claim that the sound is correct');
});

test('controlled complete speech accepts equivalent formatting without changing raw word owners or timing',()=>{
  for(const spelling of ['DeepSeek V4.1 Flash','DeepSeek-V4.1-Flash','DeepSeekV4.1Flash']){
    const heard=actual.chapter.narration.replace('DeepSeek V4.1 Flash',spelling).replace('DeepSeek-V4.1-Flash',spelling),raw=audio(heard),before=structuredClone(raw),chapter=structuredClone(actual.chapter);
    assert.doesNotThrow(()=>alignLessonSpeech(chapter,correctLessonTranscript(chapter,raw)));
    assert.deepEqual(raw,before);assert.deepEqual(chapter,actual.chapter);
  }
});

test('wrong versions, missing occurrences and different model/product text remain blocking',()=>{
  for(const heard of [
    actual.chapter.narration.replace('V4.1','V4.2'),
    actual.chapter.narration.replace('V4.1','V'),
    actual.chapter.narration.replace('DeepSeek V4.1','Gemini V4.1'),
    actual.chapter.narration.replace('Flash','Pro'),
    actual.chapter.narration.replace('DeepSeek-V4.1-Flash','该选项'),
  ]){
    const raw=audio(heard),before=structuredClone(raw);
    assert.throws(()=>alignLessonSpeech(actual.chapter,correctLessonTranscript(actual.chapter,raw)),/版本|型号|匹配|数字|台词/);
    assert.deepEqual(raw,before);
  }
  assert.notDeepEqual(tokens('DeepSeekV4.2Flash'),tokens('DeepSeekV4.1Flash'));
  assert.notDeepEqual(tokens('DeepSeekV4.1Flash'),tokens('DeepSeekV4.1Flash DeepSeekV4.1Flash'));
  assert.notDeepEqual(tokens('GeminiV4.1Flash'),tokens('DeepSeekV4.1Flash'));
  assert.deepEqual(tokens('Fable 5.5 与 Model13.44版本'),['fable:5.5','model:13.44']);
});
