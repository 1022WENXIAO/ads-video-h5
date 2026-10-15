import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alignLessonSpeech,correctLessonTranscript,lessonCaptionAnalysis} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../src/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p15-speech-formatting.json',import.meta.url),'utf8')) as {cases:Array<{chapter:LessonChapter;raw:AudioAnalysis}>};
const actual=fixture.cases[1];
const audio=(text:string):AudioAnalysis=>({status:'ready',modelId:'controlled',sourceHash:'unchanged-controlled-waveform',duration:text.length*.1,transcript:text,sentences:[{id:'s',text,start:0,end:text.length*.1,complete:true,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''});

test('actual P15 截至10时 cue uses the same canonical clock as the complete 十时 wordgrid',()=>{
  const before=structuredClone(actual),corrected=correctLessonTranscript(actual.chapter,actual.raw),result=alignLessonSpeech(actual.chapter,corrected);
  assert.deepEqual(actual,before);assert.equal(result.cues[0].text,'截至10时');
  const words=actual.raw.sentences.flatMap(sentence=>sentence.words);
  assert.equal(result.cues[0].start,words[0].start);assert.equal(result.cues[0].end,words[3].end);
  const captions=lessonCaptionAnalysis(actual.chapter,corrected);assert.deepEqual(captions.sentences,corrected.sentences);assert.equal(captions.sourceHash,actual.raw.sourceHash);
});

test('explicit hour notation and partial/full cues retain actual source spans across token boundaries',()=>{
  for(const expected of ['10时','十时'])for(const heard of ['10时','十时'])for(const cue of ['截至'+expected,expected]){
    const chapter=structuredClone(actual.chapter);chapter.narration=chapter.narration.replace('截至10时','截至'+expected);chapter.visual.items[0].cue=cue;
    const text=chapter.narration.replace('截至'+expected,'截至'+heard),raw=audio(text),before=structuredClone(raw),result=alignLessonSpeech(chapter,correctLessonTranscript(chapter,raw));
    const start=cue.startsWith('截至')?0:2,end=2+heard.length;
    assert.equal(result.cues[0].start,raw.sentences[0].words[start].start);assert.equal(result.cues[0].end,raw.sentences[0].words[end-1].end);assert.equal(result.cues[0].text,cue);assert.deepEqual(raw,before);
  }
});

test('hour canonicalization cannot fill missing date/minute/second units or accept wrong time values',()=>{
  const base=structuredClone(actual.chapter);base.narration='10月15日'+base.narration;
  for(const replacement of ['11时','10时11分','10.0','10','25时']){
    const raw=audio(base.narration.replace('10时',replacement)),before=structuredClone(raw);
    assert.throws(()=>alignLessonSpeech(base,correctLessonTranscript(base,raw)),/时钟|日期|数字|单位|匹配/);assert.deepEqual(raw,before);
  }
  for(const heard of [base.narration.replace('15日','15'),base.narration.replace('15日','16日')])assert.throws(()=>alignLessonSpeech(base,audio(heard)),/日期|匹配/);
  for(const [expected,heard]of [['10时11分','十时十一'],['10时11分12秒','十时十一分十二'],['10时11分','十时十二分']]){
    const chapter=structuredClone(actual.chapter);chapter.narration=chapter.narration.replace('10时',expected);chapter.visual.items[0].cue='截至'+expected;
    assert.throws(()=>alignLessonSpeech(chapter,audio(chapter.narration.replace(expected,heard))),/时钟|数字|单位|匹配/);
  }
});

test('named mathematical values followed by 时 remain strict values rather than hour-only clocks',()=>{
  for(const prefix of ['残差','误差','伽马为','γ为','阈值等于','残差设为']){
    const chapter=structuredClone(actual.chapter);chapter.narration=`${prefix}三时，计算结果要核对，结论仍以证据为准。`;chapter.visual.items=[{label:'计算',detail:'核对数值',cue:'计算结果'},{label:'结论',detail:'证据边界',cue:'以证据为准'}];
    const raw=audio(chapter.narration),before=structuredClone(raw);
    assert.doesNotThrow(()=>alignLessonSpeech(chapter,correctLessonTranscript(chapter,raw)));
    assert.throws(()=>alignLessonSpeech(chapter,audio(chapter.narration.replace('三时','四时'))),/数字/);
    assert.deepEqual(raw,before);
  }
});
