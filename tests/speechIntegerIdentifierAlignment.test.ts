import test from 'node:test';
import assert from 'node:assert/strict';
import {alignLessonSpeech,compactSpeech,correctLessonTranscript} from '../server/lessonSpec';
import {lessonModelVersionSpans} from '../server/lessonModelVersions';
import type {AudioAnalysis,LessonChapter} from '../src/types';

const chapter=(identifier:string):LessonChapter=>({id:'id',title:'核验型号',role:'concept',goal:'保留完整型号和限定条件',prerequisites:[],referenceIds:[],claims:[],narration:`通报提到${identifier}支架，原因仍需核查，不能提前下结论。`,reason:'Integer identifier notation regression.',visual:{kind:'concept',takeaway:'等待核查',items:[{label:'型号',detail:'完整编号',cue:identifier},{label:'边界',detail:'原因待查',cue:'原因仍需核查'}]}});
function audio(text:string,chunk=1):AudioAnalysis{
  const chars=[...text],words=[];
  for(let i=0;i<chars.length;i+=chunk)words.push({text:chars.slice(i,i+chunk).join(''),start:i*.13,end:Math.min(chars.length,i+chunk)*.13});
  return {status:'ready',modelId:'controlled-no-provider',sourceHash:'immutable-waveform',duration:chars.length*.13,transcript:text,sentences:[{id:'s',text,start:0,end:chars.length*.13,complete:true,words}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
}

test('equivalent heard integer identifiers align across real word ownership boundaries without rewriting ASR',()=>{
  // P23 same-wave ASR twice wrote v八百 for the intended V800. This test is
  // a controlled notation projection, not a claim of human audio audition.
  for(const [expected,heard] of [['V800','v八百'],['H100','h一百'],['X400','X四百'],['V80','v八十'],['V80','v八零']] as const)for(const chunk of [1,2,4]){
    const value=chapter(expected),raw=audio(value.narration.replace(expected,heard),chunk),before=structuredClone(raw),script=structuredClone(value);
    const result=alignLessonSpeech(value,correctLessonTranscript(value,raw));
    assert.equal(result.similarity,1);assert.equal(result.cues[0].text,expected);
    assert.ok(result.cues[0].end>result.cues[0].start);assert.deepEqual(raw,before);assert.deepEqual(value,script);
    assert.equal(raw.sourceHash,'immutable-waveform');assert.equal(raw.sentences[0].complete,true);
  }
});

test('wrong identifier value, letter, repetition, omitted words and units remain rejected',()=>{
  const value=chapter('V800');
  for(const heard of ['v七百','v八十','v八百一','八百','b八百','v八百v八百']){
    const raw=audio(value.narration.replace('V800',heard)),before=structuredClone(raw);
    assert.throws(()=>alignLessonSpeech(value,correctLessonTranscript(value,raw)),/数字|型号|匹配|额外|台词|未匹配/);assert.deepEqual(raw,before);
  }
  for(const changed of [value.narration.replace('支架','支'),value.narration.replace('不能','能')])assert.throws(()=>alignLessonSpeech(value,audio(changed)),/匹配|台词|未匹配/);
  const measured=chapter('V800');measured.narration+='数量是三百台。';
  assert.throws(()=>alignLessonSpeech(measured,audio(measured.narration.replace('三百台','三百家'))),/单位|数字|匹配/);
  for(const [expected,heard] of [['V900','v八百百'],['V10000','v一万万'],['V010','v十'],['V010','v10'],['H000','h零']] as const){
    const value=chapter(expected);assert.throws(()=>alignLessonSpeech(value,audio(value.narration.replace(expected,heard))),/型号|数字|匹配/);
  }
  const zero=chapter('V010');assert.equal(alignLessonSpeech(zero,audio(zero.narration)).similarity,1);
});

test('ordinary prose and model name recognition retain their original boundaries',()=>{
  for(const text of ['AI一旦','HTML三思','V二者','AI千万不能','AI十足可信','三思之后','一百种原因'])assert.equal(compactSpeech(text),text.toLowerCase());
  assert.deepEqual(lessonModelVersionSpans('V800和X400'),[],'notation projection does not expand one-letter model NER');
  const value=chapter('V800'),raw=audio(value.narration.replace('V800','v八百'));
  raw.transcript=raw.transcript.replace('八百','七百');
  assert.throws(()=>alignLessonSpeech(value,raw),/匹配|数字|原词|转写|台词/,'disagreement between transcript and actual word stream remains rejected');
});

test('unit-form identifier spelling requires a complete cardinal rather than permissive arithmetic parsing',()=>{
  for(const [expected,heard]of [['V10000','v一万'],['V10001','v一万零一'],['H1001','h一千零一'],['V100000000','v一亿'],['V100010000','v一亿零一万'],['V1000000000000','v一万亿'],['V210','v两百一十']] as const){
    const value=chapter(expected),raw=audio(value.narration.replace(expected,heard)),before=structuredClone(raw);
    assert.equal(alignLessonSpeech(value,correctLessonTranscript(value,raw)).similarity,1);assert.deepEqual(raw,before);
  }
  for(const [expected,heard]of [['V100000000','v一亿万'],['V900','v九百零零'],['V1001','v一千一'],['V10000','v一万万'],['V900','v八百百'],['V10','v零十']] as const){
    const value=chapter(expected),raw=audio(value.narration.replace(expected,heard)),before=structuredClone(raw);
    assert.deepEqual(correctLessonTranscript(value,raw),raw,'an ambiguous original spelling is not rewritten');assert.throws(()=>alignLessonSpeech(value,raw),/型号|数字|匹配/);assert.deepEqual(raw,before);
  }
});
