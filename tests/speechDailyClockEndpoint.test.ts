import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alignLessonSpeech,correctLessonTranscript} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p30-daily-clock-endpoint.json',import.meta.url),'utf8')) as {narration:string;analysis:AudioAnalysis};
function chapter(narration:string,cue='全市所有道路禁鸣'):LessonChapter {
  return{id:'daily-clock',title:'核验每日范围',role:'foundation',goal:'保留每日时间范围',reason:'受控程序核验',prerequisites:[],referenceIds:[],claims:[],narration,visual:{kind:'concept',takeaway:'保留原时间范围',items:[{label:'范围',detail:'受控核验',cue}]}};
}
function audio(text:string):AudioAnalysis {
  const words=[...text].map((text,i)=>({text,start:i*.2,end:(i+1)*.2}));
  return{status:'ready',modelId:'controlled-no-provider',sourceHash:'controlled-unchanged-wave',duration:words.at(-1)!.end,timing:'model-estimated',createdAt:'',transcript:text,sentences:[{id:'controlled',text,start:0,end:words.at(-1)!.end,complete:true,words}],pauses:[],warnings:[]};
}
function check(value:LessonChapter,raw:AudioAnalysis,passes:boolean){
  const before=structuredClone(raw),script=structuredClone(value),working=correctLessonTranscript(value,raw);
  const invoke=()=>alignLessonSpeech(value,working);
  const result=passes?invoke():assert.throws(invoke,/时钟|日期|数字|单位|匹配|额外字词/);
  assert.deepEqual(raw,before,'raw word owners/text/times/completeness/transcript/hash are immutable');
  assert.deepEqual(value,script,'expected narration/visual/cues are immutable');
  return result;
}

test('actual P30 daily zero-to-24 endpoint aligns its unchanged 22-word ASR and exact cue time',()=>{
  const value=chapter(actual.narration,'二十四时'),raw=structuredClone(actual.analysis);
  assert.equal(raw.sentences[0].words.length,22);
  const result=check(value,raw,true) as ReturnType<typeof alignLessonSpeech>;
  assert.equal(result.similarity,1);
  assert.deepEqual(result.cues,[{text:'二十四时',start:7.02,end:7.74}]);
});

test('explicit daily zero-start ranges accept exact 24时 and zero-minute/second endpoints without converting to zero',()=>{
  for(const range of ['每天零至二十四时','每日零至24时','每天零时至二十四时','每天从零时到24时','每日自0时至24时','每天0:00至24:00','每天00:00:00至24:00:00','每日零时零分零秒至24时0分0秒','每天零至24:00','每日零到24:00:00']){
    const narration=`十一月一日起，${range}，全市所有道路禁鸣。`;
    check(chapter(narration),audio(narration),true);
  }
  const value=chapter('十一月一日起，每天零至二十四时，全市所有道路禁鸣。');
  check(value,audio(value.narration.replace('二十四时','24时')),true);
  for(const heard of ['零时','23时','24小时','24:00'])check(value,audio(value.narration.replace('二十四时',heard)),false);
});

test('invalid end values remain invalid even when script and both ASR text channels agree',()=>{
  for(const endpoint of ['二十五时','25:00','24:01','24:00:01','24:01:00','二十四时一分','二十四时零分一秒','二十四点零分']){
    const narration=`十一月一日起，每天零至${endpoint}，全市所有道路禁鸣。`;
    check(chapter(narration),audio(narration),false);
  }
});

test('24 remains invalid outside an explicit daily zero-start endpoint and in AM/PM periods',()=>{
  for(const phrase of ['截至二十四时','事发时间为24:00','每天二十四时','每天一时至二十四时','每天0:01至24:00','工作时间零至24时','每天零至下午二十四时','每天零至夜间24:00','每天上午零时至24时']){
    const narration=`十一月一日起，${phrase}，全市所有道路禁鸣。`;
    check(chapter(narration),audio(narration),false);
  }
  const duration='每日持续二十四小时监测，全市所有道路禁鸣。';
  check(chapter(duration),audio(duration),true);
});

test('changed start/end, missing date and inconsistent transcript/word clocks still reject',()=>{
  const value=chapter(actual.narration,'二十四时');
  for(const heard of [actual.narration.replace('零至','一至'),actual.narration.replace('二十四时','二十三时'),actual.narration.replace('一日','一'),actual.narration.replace('二十四时','二十四小时')])check(value,audio(heard),false);
  for(const channel of ['transcript','words'] as const){
    const raw=audio(actual.narration);
    if(channel==='transcript')raw.transcript=raw.transcript.replace('二十四时','二十三时');
    else{const at=raw.sentences[0].words.findIndex((w,i,all)=>w.text==='四'&&all[i+1]?.text==='时');raw.sentences[0].words[at].text='三';raw.sentences[0].text=raw.sentences[0].words.map(w=>w.text).join('');}
    check(value,raw,false);
  }
  const raw=structuredClone(actual.analysis);raw.transcript=raw.transcript.replace('一日','一');raw.sentences[0].words=raw.sentences[0].words.filter(w=>w.text!=='日');raw.sentences[0].text=raw.transcript;
  check(value,raw,false);
});
