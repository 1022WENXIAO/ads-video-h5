import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lessonModelVersions,lessonModelVersionSpans} from '../server/lessonModelVersions';
import {alignLessonSpeech,correctLessonTranscript} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../src/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p18-model-identifier-asr.json',import.meta.url),'utf8')) as {chapter:LessonChapter;raw:AudioAnalysis;reference:{title:string}};
const tokens=(text:string)=>lessonModelVersions(text,value=>value);
const chapter=(identifier:string,extra=''):LessonChapter=>({id:'identifier',title:'型号',role:'concept',goal:'说明型号',prerequisites:[],referenceIds:[],claims:[],narration:`今天介绍${identifier}模型。${extra}它有二百四十亿总参数，适合本地推理。`,reason:'Controlled no-provider alignment test.',visual:{kind:'concept',takeaway:'本地推理',items:[{label:'推理',detail:'完整原词',cue:'本地推理'}]}});
const audio=(text:string,wordTexts=[...text]):AudioAnalysis=>({status:'ready',modelId:'controlled',sourceHash:'controlled-unchanged-waveform',duration:wordTexts.length*.1,transcript:text,sentences:[{id:'s',text,complete:true,start:0,end:wordTexts.length*.1,words:wordTexts.map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''});
const unchanged=(c:LessonChapter,raw:AudioAnalysis)=>{
  const before=structuredClone(raw),script=structuredClone(c),result=alignLessonSpeech(c,raw);
  assert.equal(result.similarity,1);assert.deepEqual(raw,before);assert.deepEqual(c,script);
  const text=c.visual.items[0].cue,flat=raw.sentences.flatMap(s=>s.words),start=raw.transcript.indexOf(text);
  if(flat.length===raw.transcript.length){assert.equal(result.cues[0].start,+flat[start].start.toFixed(3));assert.equal(result.cues[0].end,+flat[start+text.length-1].end.toFixed(3));}
};

test('actual selected source identifier has no invented model token inside a numeric suffix',()=>{
  assert.match(actual.reference.title,/LFM2\.5-24B-A2B/);
  for(const form of ['LFM2.5-24B-A2B','LFM2.5 24B A2B','LFM2.5 24BA2B','LFM2.5-24BA2B']){
    assert.deepEqual(tokens(form),['lfm:2.5:24ba2b']);
    assert.equal(lessonModelVersionSpans(form).length,1);
  }
  assert.deepEqual(tokens('LFM2.5 24B GPT5'),['lfm:2.5:24b','gpt:5'],'another model is not swallowed by a whitespace suffix');
  assert.deepEqual(tokens('Fable5.1Opus5.5'),['fable:5.1','opus:5.5'],'a real family after version digits retains its independent version');
});

test('complete same-value family identifiers pass all alignment gates across spaces and hyphens',()=>{
  for(const [formal,forms] of [
    ['LFM2.5-24B-A2B',['LFM2.5 24B A2B','LFM2.5 24BA2B','LFM2.5-24BA2B']],
    ['Qwen3.5-35B-A3B',['Qwen3.5 35B A3B','Qwen3.5 35BA3B']],
    ['Qwen3-8B-A3B',['Qwen3 8B A3B','Qwen3 8BA3B']],
    ['Terra7.2-16B-A4B',['Terra7.2 16B A4B','Terra7.2 16BA4B']],
  ] as const){
    const c=chapter(formal);
    for(const form of forms)unchanged(c,audio(c.narration.replace(formal,form)));
  }
});

test('integer versions retain independent version, capacity and routing digits',()=>{
  const c=chapter('Qwen3-8B-A3B');
  for(const wrong of ['Qwen4 8BA3B','Qwen3 9BA3B','Qwen3 8BA4B']){
    const raw=audio(c.narration.replace('Qwen3-8B-A3B',wrong)),before=structuredClone(raw);
    assert.throws(()=>alignLessonSpeech(c,raw),/型号|版本|数字|匹配/);assert.deepEqual(raw,before);
  }
});

test('baseline-supported Chinese numeric identifier values retain words and timestamps',()=>{
  const c=chapter('LFM2.5-24B-A2B');
  for(const identifier of ['LFM二点五-二十四B-A二B','LFM二点五 二十四BA二B']){
    const raw=audio(c.narration.replace('LFM2.5-24B-A2B',identifier)),before=structuredClone(raw),script=structuredClone(c);
    const result=alignLessonSpeech(c,raw);assert.ok(result.similarity>=.86);assert.deepEqual(raw,before);assert.deepEqual(c,script);
    const flat=raw.sentences[0].words,at=raw.transcript.indexOf('本地推理');assert.equal(result.cues[0].start,+flat[at].start.toFixed(3));assert.equal(result.cues[0].end,+flat[at+3].end.toFixed(3));
  }
  for(const wrong of ['LFM二点六-二十四B-A二B','LFM二点五-二十五B-A二B','LFM二点五-二十四B-A三B','LFM二点五-二十四B-A二','TFM二点五-二十四B-A二B','LFM二点五-二十四B-A二B LFM二点五-二十四B-A二B']){
    const raw=audio(c.narration.replace('LFM2.5-24B-A2B',wrong)),before=structuredClone(raw);assert.throws(()=>alignLessonSpeech(c,raw),/型号|版本|数字|匹配|台词/);assert.deepEqual(raw,before);
  }
  const zeros=chapter('Terra7.10-16B-A02B');
  assert.doesNotThrow(()=>alignLessonSpeech(zeros,audio(zeros.narration.replace('Terra7.10-16B-A02B','Terra七点一零-十六B-A零二B'))));
  for(const wrong of ['Terra七点一-十六B-A零二B','Terra七点一零-十六B-A二B'])assert.throws(()=>alignLessonSpeech(zeros,audio(zeros.narration.replace('Terra7.10-16B-A02B',wrong))),/型号|版本|数字|匹配/);
});

test('actual transcript boundaries project into split word owners without changing source words or times',()=>{
  const c=chapter('LFM2.5-24B-A2B'),heard=c.narration.replace('LFM2.5-24B-A2B','LFM2.5 24BA2B');
  const before=heard.slice(0,heard.indexOf('LFM')),after=heard.slice(heard.indexOf('24BA2B')+'24BA2B'.length);
  for(const units of [['LFM2.5','24BA2B'],['LFM','2','.','5','24','B','A','2','B']])unchanged(c,audio(heard,[...before,...units,...after]));
  const extended=chapter('LFM2.5-24B-A2B','𬸚𬸦与İ符号保持原样。');
  unchanged(extended,audio(extended.narration.replace('LFM2.5-24B-A2B','LFM2.5 24BA2B')));
});

test('wrong model, version, suffix, numeric capacity or occurrence count remains rejected',()=>{
  const c=chapter('LFM2.5-24B-A2B');
  for(const wrong of ['TFM2.5 24BA2B','LFM2.6 24BA2B','LFM 24BA2B','LFM2.5 25BA2B','LFM2.5 24BA3B','LFM2.5 24BA2','LFM2.5 24B BA2','LFM2.5 24BA2B LFM2.5 24BA2B']){
    const raw=audio(c.narration.replace('LFM2.5-24B-A2B',wrong)),before=structuredClone(raw);
    assert.throws(()=>alignLessonSpeech(c,raw),/型号|版本|数字|匹配|台词/);assert.deepEqual(raw,before);
  }
});

test('model separators do not authorize changed independent decimals, quantities or clocks',()=>{
  const c=chapter('LFM2.5-24B-A2B','温度为零点七，下午一点四十四分发布。'),same=c.narration.replace('LFM2.5-24B-A2B','LFM2.5 24BA2B');
  unchanged(c,audio(same));
  for(const heard of [same.replace('零点七','零点八'),same.replace('二百四十亿','二百五十亿'),same.replace('四十四分','四十三分'),same.replace('四十四分','四十四'),same.replace('24BA2B','将24BA2B')]){
    const raw=audio(heard),before=structuredClone(raw);assert.throws(()=>alignLessonSpeech(c,raw),/型号|版本|小数|数字|时钟|单位|匹配|台词/);assert.deepEqual(raw,before);
  }
});

test('transcript and words cannot disagree about a literal model or its occurrences',()=>{
  const c=chapter('LFM2.5-24B-A2B'),heard=c.narration.replace('LFM2.5-24B-A2B','LFM2.5 24BA2B');
  for(const change of [
    (raw:AudioAnalysis)=>{raw.transcript=raw.transcript.replace('LFM','TFM');},
    (raw:AudioAnalysis)=>{raw.transcript=raw.transcript.replace('2.5','2.6');},
    (raw:AudioAnalysis)=>{raw.sentences[0].words.find(w=>w.text==='5')!.text='6';},
    (raw:AudioAnalysis)=>{raw.transcript+=' LFM2.5 24BA2B';},
  ]){const raw=audio(heard);change(raw);const before=structuredClone(raw);assert.throws(()=>alignLessonSpeech(c,raw));assert.deepEqual(raw,before);}
});

test('a suffix identifier does not remove existing measured date boundaries from other model mentions',()=>{
  const c=chapter('LFM2.5-24B-A2B','官方列Fable 5.1，二十二日有Opus 5.5。');
  const heard=c.narration.replace('LFM2.5-24B-A2B','LFM2.5 24BA2B').replace('Fable 5.1，二十二日','Fable五点一二十二日').replace('Opus 5.5','Opus五点五');
  const raw=audio(heard),at=raw.sentences[0].words.findIndex((word,index,words)=>word.text==='二'&&words[index-1]?.text==='一'&&words[index-2]?.text==='点');
  assert.ok(at>0);for(const word of raw.sentences[0].words.slice(at)){word.start+=.45;word.end+=.45;}raw.duration+=.45;raw.sentences[0].end+=.45;
  unchanged(c,raw);
  const wrong=structuredClone(raw);wrong.sentences[0].words.find((word,index,words)=>word.text==='一'&&words[index-1]?.text==='点')!.text='四';wrong.transcript=wrong.sentences[0].text=wrong.sentences[0].words.map(word=>word.text).join('');
  assert.throws(()=>alignLessonSpeech(c,wrong),/型号|数字|匹配/);
});

test('actual P18 rejected take retains its extra identifier word and missing clock unit',()=>{
  const raw=structuredClone(actual.raw),before=structuredClone(raw),c=structuredClone(actual.chapter),script=structuredClone(c);
  assert.equal(raw.sourceHash,'ddc864107b96e25bca284ad125901545a849e2e0d12047007a3e6823a0f408ed');
  assert.match(raw.transcript,/十四点五十七观察/);assert.match(raw.transcript,/至二十四ba二b/);
  assert.throws(()=>alignLessonSpeech(c,correctLessonTranscript(c,raw)),/时钟.*完整单位/);
  assert.deepEqual(raw,before);assert.deepEqual(c,script);
});
