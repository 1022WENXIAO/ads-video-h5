// Isolated shadow regression; source media acceptance is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alignLessonSpeech,lessonCaptionAnalysis} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p22-cue-context-word-window.json',import.meta.url),'utf8'));
const chapter=(narration:string,cues=['八点十一','十三点零四']):LessonChapter=>({id:'cue-context',title:'核对实际时间原词',role:'foundation',goal:'准确定位原词',prerequisites:[],narration,reason:'格式规范不能伪造时间',referenceIds:[],claims:[],visual:{kind:'timeline',takeaway:'以实际原词定位',items:cues.map(cue=>({label:'定位',detail:'真实发音区间',cue}))}});
function audio(text:string):AudioAnalysis{
  const words=[...text].map((text,i)=>({text,start:+(i*.1).toFixed(3),end:+((i+1)*.1).toFixed(3)}));
  return {status:'ready',modelId:'controlled-word-grid',sourceHash:'unchanged-controlled-waveform',transcript:text,duration:words.length*.1,sentences:[{id:'s',text,start:0,end:words.length*.1,complete:true,words}],warnings:[],pauses:[],timing:'model-estimated',createdAt:''};
}
function aligned(value:LessonChapter,raw:AudioAnalysis){
  const before=structuredClone(raw),script=structuredClone(value),result=alignLessonSpeech(value,raw);
  assert.deepEqual(raw,before);assert.deepEqual(value,script);
  assert.deepEqual(result.cues.map(c=>c.text),value.visual.items.map(i=>i.cue));
  return result;
}
function rejected(value:LessonChapter,raw:AudioAnalysis){
  const before=structuredClone(raw);
  assert.throws(()=>alignLessonSpeech(value,raw),/原词|时钟|日期|单位|数字|版本|型号|匹配|缺|完整|台词/);
  assert.deepEqual(raw,before);
}

test('two actual052 trace word/time windows locate unique 八点十一 without including the following 到',()=>{
  // Actual words/times/hash are retained. This is a partial controlled analysis
  // projection; it does not claim complete original ASR or media acceptance.
  for(const record of fixture.records){
    const words=structuredClone(record.words),text=words.map((w:any)=>w.text).join('');
    const raw:AudioAnalysis={...audio(text),sourceHash:record.audioHash,duration:words.at(-1).end+.1,sentences:[{id:'partial-window',text,start:words[0].start,end:words.at(-1).end,complete:true,words}]};
    const result=aligned(chapter(text),raw);
    assert.equal(result.similarity,1);
    assert.equal(result.cues[0].start,words[0].start);assert.equal(result.cues[0].end,words[3].end);
    assert.equal(result.cues[1].start,words[5].start);assert.equal(result.cues[1].end,words[9].end);
    const captions=lessonCaptionAnalysis(chapter(text),raw);
    assert.deepEqual(captions.sentences,raw.sentences);assert.equal(captions.sourceHash,record.audioHash);
  }
});

test('a quantity cue ending before its actual unit uses the existing full narration numeric spelling',()=>{
  const narration='检测记录二百一十份样本，结论限定本次采样。',value=chapter(narration,['二百一十','限定本次采样']),raw=audio(narration),result=aligned(value,raw);
  const start=narration.indexOf('二百一十');
  assert.equal(result.similarity,1);assert.equal(result.cues[0].start,raw.sentences[0].words[start].start);
  assert.equal(result.cues[0].end,raw.sentences[0].words[start+3].end);
  for(const heard of [narration.replace('二百一十份','二百一十一份'),narration.replace('二百一十份','二百一十批')])rejected(value,audio(heard));
});

test('duplicate cue contexts never select one occurrence to enable new canonical matching',()=>{
  for(const narration of [
    '八点十一到十三点零四故障，八点十一份材料需要核验。',
    '八点十一到十三点零四故障，八点十一到十三点零四仍需核验。',
    '八点十一到十三点零四故障，型号Fable八点十一B仍需核验。',
  ])rejected(chapter(narration),audio(narration));
});

test('an already matching literal duplicate retains legacy first canonical lookup and cue order',()=>{
  const narration='八点十一到十三点零四结束，八点十一发生事件。',raw=audio(narration),value=chapter(narration),result=aligned(value,raw);
  const at=narration.indexOf('八点十一',1);
  assert.equal(result.cues[0].start,raw.sentences[0].words[at].start);
  assert.equal(result.cues[0].end,raw.sentences[0].words[at+3].end);
});

test('a numeric token crossing a cue boundary receives no new canonical span',()=>{
  const narration='八点十一到十三点零四故障。';
  rejected(chapter(narration,['八点十','十三点零四']),audio(narration));
});

test('wrong actual values, missing日/分/hour units, wrong quantity units and model decimals remain hard failures',()=>{
  const narration='十月十五日八点十一分到十三点零四分事件记录58批，Fable5.1仍需核验。',value=chapter(narration,['八点十一分','仍需核验']);
  aligned(value,audio(narration));
  for(const changed of [
    narration.replace('十一分','十二分'),narration.replace('八点','九点'),narration.replace('十五日','十五'),
    narration.replace('十五日','十五天'),narration.replace('十一分','十一'),narration.replace('八点','八'),
    narration.replace('58批','58份'),narration.replace('58批','59批'),narration.replace('5.1','5.2'),
    narration.replace('十三点零四分','13.04'),
  ])rejected(value,audio(changed));
});

test('missing actual 时 or ordinary Han speech is not covered by cue normalization',()=>{
  const narration='截至十时仍需核验，露天采样记录58批，Fable5.1保持待查。',value=chapter(narration,['截至十时','露天采样']);
  aligned(value,audio(narration));
  for(const changed of [narration.replace('十时','十'),narration.replace('露天','天')])rejected(value,audio(changed));
});

test('ordinary prose and existing caption fences/word timing remain unchanged',()=>{
  const narration='统一观察口径，另一方面仍需核验。',value=chapter(narration,['统一','仍需核验']),raw=audio(narration);
  raw.captionBreaks=[6,raw.sentences[0].words.length-1];raw.captionBoundarySource='matched-clauses';
  aligned(value,raw);
});
