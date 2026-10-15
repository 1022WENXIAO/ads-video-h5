import test from 'node:test';
import assert from 'node:assert/strict';
import {mapLimited} from '../server/taskPool';
import {NarrationAnalysisError,NarrationVerificationError} from '../server/narrationAnalysisRecovery';
import {NarrationBatchVerificationError,NarrationTimingRepairError,selectNarrationBatchFailure} from '../server/narrationBatchRecovery';
import {JobCancelledError} from '../server/jobExecution';
import {TextTransportError} from '../server/executionErrors';
import {alignLessonSpeech} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

const quality=(id:string)=>new NarrationVerificationError('speech',id,`章节${id}实际旁白中的数字与脚本不一致，脚本值(1)=[24]；识别值(1)=[25]`);
test('drained parallel failures preserve every exhausted chapter in input order and start no later work',async()=>{
  let active=0,completed=0,selected=0;const started:number[]=[],a=quality('ch1'),b=quality('ch2');
  await assert.rejects(mapLimited([0,1,2],2,async index=>{started.push(index);active++;try{await new Promise(r=>setTimeout(r,index===0?15:1));throw index===0?a:b;}finally{active--;completed++;}},failures=>{selected++;assert.equal(active,0);assert.equal(completed,2);return selectNarrationBatchFailure(failures,['ch1','ch2','ch3']);}),error=>{
    assert.ok(error instanceof NarrationBatchVerificationError);assert.deepEqual(error.chapterIds,['ch1','ch2']);assert.deepEqual(error.errors,[a,b]);assert.match(error.message,/^修稿章节：ch1、ch2/);assert.match(error.message,/脚本值.*24.*识别值.*25/);for(const id of ['ch1','ch2'])assert.match(error.message,new RegExp(id+'：已完成同一台词的有限复听和重录，下一步须定向改写'));return true;
  });
  assert.equal(selected,1);assert.deepEqual(started,[0,1]);
});
test('technical, authentication, IO, unknown and cancellation failures retain original identity in either completion order',()=>{
  const errors=[new TextTransportError(3,new Error('Connection error')),Object.assign(new Error('HTTP 401'),{status:401}),Object.assign(new Error('Permission denied'),{code:'EACCES'}),new NarrationAnalysisError('format failed',new Error('schema')),new Error('未知错误：章节ch2数字匹配'),undefined];
  for(const error of errors)for(const ordered of [[{index:0,error:quality('ch1')},{index:1,error}],[{index:1,error},{index:0,error:quality('ch1')}]] as const)assert.equal(selectNarrationBatchFailure(ordered,['ch1','ch2']),error);
  const cancel=new JobCancelledError(),auth=errors[1];assert.equal(selectNarrationBatchFailure([{index:0,error:auth},{index:1,error:cancel}],['ch1','ch2']),cancel);
  const wrapped=new NarrationAnalysisError('cancelled during analysis',cancel);assert.equal(selectNarrationBatchFailure([{index:0,error:quality('ch1')},{index:1,error:wrapped}],['ch1','ch2']),wrapped);
  const wrongChapter=quality('other');assert.equal(selectNarrationBatchFailure([{index:0,error:wrongChapter}],['ch1']),wrongChapter);
});
test('trusted measured timing can share one scoped repair but cannot hide a technical failure',()=>{
  const timing=new NarrationTimingRepairError(['ch2'],'本章重录后的变速1.5不在0.8–1.25安全范围内。'),a=quality('ch1');
  const batch=selectNarrationBatchFailure([{index:1,error:timing},{index:0,error:a}],['ch1','ch2']);assert.ok(batch instanceof NarrationBatchVerificationError);assert.deepEqual(batch.chapterIds,['ch1','ch2']);
  assert.doesNotMatch(batch.message.split('\n').find(line=>line.startsWith('ch2：'))!,/有限复听和重录/);
  const io=Object.assign(new Error('read denied'),{code:'EPERM'});assert.equal(selectNarrationBatchFailure([{index:0,error:timing},{index:1,error:io}],['ch2','ch3']),io);
});
const chapter=(narration:string):LessonChapter=>({id:'diagnostic',title:'实际核验',role:'concept',goal:'说明实际数据',prerequisites:[],referenceIds:[],claims:[],narration,reason:'Controlled no-provider fixture.',visual:{kind:'concept',takeaway:'核对事实',items:[{label:'核验',detail:'保留原词',cue:'核对事实'}]}});
const analysis=(text:string):AudioAnalysis=>({status:'ready',sourceHash:'unchanged',modelId:'controlled',duration:text.length*.1,transcript:text,createdAt:'',timing:'model-estimated',pauses:[],warnings:[],sentences:[{id:'s',text,complete:true,start:0,end:text.length*.1,words:[...text].map((text,i)=>({text,start:i*.1,end:(i+1)*.1}))}]});
test('model, number, clock and missing-tail feedback reports actual differences without changing words or gates',()=>{
  for(const [expected,heard,pattern] of [
    ['今天介绍Fable5.1模型，核对事实仍然十分重要。','今天介绍Fable5.2模型，核对事实仍然十分重要。',/脚本值.*fable:5\.1.*识别值.*fable:5\.2/],
    ['今天记录二十四项结果，核对事实仍然十分重要。','今天记录二十五项结果，核对事实仍然十分重要。',/脚本值.*24.*识别值.*25/],
    ['截至十四点五十七分，核对事实仍然十分重要。','截至十四点五十八分，核对事实仍然十分重要。',/脚本值.*十四点五十七分.*识别值.*十四点五十八分/],
    ['今天核对事实，完整观察整个网络。','今天核对事实，完整观察整个网。',/脚本末尾「.*网络」；识别末尾「.*网」/],
  ] as const){const c=chapter(expected),raw=analysis(heard),before=structuredClone(raw),script=structuredClone(c);assert.throws(()=>alignLessonSpeech(c,raw),pattern);assert.deepEqual(raw,before);assert.deepEqual(c,script);}
});
