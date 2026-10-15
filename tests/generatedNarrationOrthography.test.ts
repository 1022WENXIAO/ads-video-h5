import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pinyin} from 'pinyin-pro';
import {correctGeneratedNarrationOrthography} from '../server/generatedNarrationOrthography';
import {alignLessonSpeech} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter,LessonReport} from '../shared/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p22-generated-narration-orthography.json',import.meta.url),'utf8'));
const chapter=(narration:string,id='chapter-1'):LessonChapter=>({id,narration,referenceIds:['english-source'],claims:[{text:'Controlled public-source selection',referenceIds:['english-source'],basis:'source'}],visual:{items:[]}} as unknown as LessonChapter);
const report=(value:LessonChapter):LessonReport=>({chapters:[value],references:[{id:'english-source',title:'Coffee preparation basics',excerpt:'Use the grind as a starting point and adjust to taste.',verification:'public-page',url:'https://example.org/controlled-public-source'}],factReview:{score:92,needsRepair:false,findings:[]}} as unknown as LessonReport);
function analysis(text:string,words=[...text]):AudioAnalysis{
  let at=0;
  return {status:'ready',modelId:'controlled-asr',sourceHash:'actual-bytes-unchanged',duration:30,transcript:text,sentences:[{id:'s1',text,start:0,end:words.length*.2,complete:true,words:words.map(text=>{const start=at;at+=.2;return {text,start,end:at};})}],pauses:[{start:10,end:10.1}],warnings:['Original ASR retained'],captionBreaks:[0,words.length-1],captionBoundarySource:'model',timing:'model-estimated',createdAt:''};
}
function correct(value:LessonChapter,raw:AudioAnalysis,current=report(value)){
  const before=structuredClone({current,value,raw}),result=correctGeneratedNarrationOrthography(current,value,raw);
  assert.deepEqual({current,value,raw},before,'report, chapter and raw ASR must remain unchanged');
  return result;
}
function assertIdentity(raw:AudioAnalysis,corrected:AudioAnalysis){
  assert.equal(corrected.sourceHash,raw.sourceHash);assert.equal(corrected.duration,raw.duration);
  assert.equal(corrected.pauses,raw.pauses);assert.equal(corrected.captionBreaks,raw.captionBreaks);assert.equal(corrected.captionBoundarySource,raw.captionBoundarySource);
  assert.deepEqual(corrected.sentences.map(s=>({...s,text:'',words:s.words.map(w=>({...w,text:''}))})),raw.sentences.map(s=>({...s,text:'',words:s.words.map(w=>({...w,text:''}))})));
  assert.deepEqual(pinyin(corrected.transcript,{type:'array',toneType:'num',toneSandhi:false,surname:'off',nonZh:'spaced'}),pinyin(raw.transcript,{type:'array',toneType:'num',toneSandhi:false,surname:'off',nonZh:'spaced'}));
}

test('actual retained 脆/萃 and 首/手 ASR projections receive only unique same-tone generated spelling changes',()=>{
  assert.equal(actual.records.length,3);
  for(const record of actual.records){
    const value=chapter(record.narration,record.chapterId),raw=record.raw as AudioAnalysis,result=correct(value,raw);
    assert.notEqual(result,raw);assertIdentity(raw,result);
    assert.equal(result.transcript,raw.transcript.replace(record.from,record.to));
    assert.match(result.warnings.at(-1)!,/ASR生成旁白同音正字/);
    assert.doesNotThrow(()=>alignLessonSpeech(value,result));
  }
});

test('unrelated single-reading Han homophones use the same generic rule without Chinese source vocabulary',()=>{
  for(const [canonical,heard] of [['核验程序公开完成','核验城序公开完成'],['保存会议记录结果','保存会议记鹿结果']]){
    const value=chapter(canonical),raw=analysis(heard),result=correct(value,raw);
    assert.equal(result.transcript,canonical);assertIdentity(raw,result);
    assert.equal(result.warnings.length,raw.warnings.length+1);
  }
});

test('word owners, sentence separators, completeness, caption fences and unrelated fields survive correction',()=>{
  const value=chapter('容易萃过头，新手手冲先找中细颗粒。'),raw=analysis('容易脆过头\n新手首冲先找中细颗粒');
  raw.sentences=[analysis('容易脆过头',['容易','脆过','头']).sentences[0],{...analysis('新手首冲先找中细颗粒',['新手首冲','先找','中细颗粒']).sentences[0],id:'s2',complete:false}];
  const result=correct(value,raw);assert.equal(result.transcript,'容易萃过头\n新手手冲先找中细颗粒');
  assertIdentity(raw,result);assert.equal(result.sentences[0].words[0],raw.sentences[0].words[0]);
  assert.equal(result.sentences[1].complete,false,'orthography never invents sentence completion');
});

test('missing, rejected, uncertain, low-score or stale chapter fact authorization cannot normalize uploaded-like ASR',()=>{
  const value=chapter('容易萃过头'),raw=analysis('容易脆过头'),valid=report(value);
  for(const current of [
    {...valid,factReview:undefined},
    {...valid,factReview:{score:99,needsRepair:true,findings:[]}},
    {...valid,factReview:{score:99,needsRepair:false,findings:['来源仍有矛盾']}},
    {...valid,factReview:{score:79,needsRepair:false,findings:[]}},
    {...valid,factReview:{score:101,needsRepair:false,findings:[]}},
    {...valid,factReview:{score:NaN,needsRepair:false,findings:[]}},
    {...valid,chapters:[]},
    {...valid,chapters:[value,value]},
    {...valid,chapters:[{...value,narration:'另一份当前稿'}]},
  ])assert.equal(correct(value,raw,current as LessonReport),raw);
});

test('two literal Han anchors on each side never cross punctuation, sentence boundaries or missing speech',()=>{
  for(const [canonical,heard] of [
    ['萃过头','脆过头'],['容易萃过','容易脆过'],['容易，萃过头','容易脆过头'],
    ['新手手，冲先','新手首冲先'],['新手手冲先','新手冲先'],['新手手冲先','新手手手冲先'],
    ['容易萃过头','容易过脆头'],
  ]){const raw=analysis(heard);assert.equal(correct(chapter(canonical),raw),raw,heard);}
  const split=analysis('容易脆过头');split.sentences=[analysis('容易').sentences[0],{...analysis('脆过头').sentences[0],id:'s2'}];
  assert.equal(correct(chapter('容易萃过头'),split),split);
});

test('different tones, polyphonic changed glyphs and context-induced polyphone changes are never repaired',()=>{
  for(const [canonical,heard] of [
    ['容易萃过头','容易催过头'],['新手手冲先','新手收冲先'],
    ['流程型经此处','流程行经此处'],['请重新检查流程','请重心检查流程'],
  ]){const raw=analysis(heard);assert.equal(correct(chapter(canonical),raw),raw,heard);}
});

test('negation, modality, dates, clocks, numeral prose, units and model spellings are protected',()=>{
  for(const [canonical,heard] of [
    ['结论不可外推','结论布可外推'],['结论仍须验证','结论仍需验证'],
    ['记录十四日发布','记录时四日发布'],['记录八点十一分','记录八点时一分'],
    ['统一观察口径','同一观察口径'],['使用十毫升样本','使用十豪升样本'],
    ['电阻采用欧姆测量','电阻采用欧母测量'],['亮度采用尼特计量','亮度采用尼忑计量'],
    ['使用伦琴单位记录','使用伦芹单位记录'],['核验阿什模型结果','核验阿石模型结果'],
    ['核验Fable五点一版','核验Fable五点衣版'],
  ]){const raw=analysis(heard);assert.equal(correct(chapter(canonical),raw),raw,heard);}
});

test('每/各/numeral quantity classifiers in either field stay protected while ordinary container spelling remains eligible',()=>{
  for(const [canonical,heard] of [
    ['这是每袋样品的标签','这是每代样品的标签'],
    ['这是每杯样品的标签','这是每悲样品的标签'],
    ['这是各袋样品的标签','这是各代样品的标签'],
    ['这是各杯样品的标签','这是各悲样品的标签'],
    ['这是两袋样品的标签','这是两代样品的标签'],
    ['这是两杯样品的标签','这是两悲样品的标签'],
    ['这是每代样品的标签','这是每袋样品的标签'],
    ['这是每悲样品的标签','这是每杯样品的标签'],
  ]){const raw=analysis(heard);assert.equal(correct(chapter(canonical),raw),raw,heard);}
  for(const [canonical,heard] of [['收藏布袋柔软','收藏布代柔软'],['陶瓷酒杯漂亮','陶瓷酒悲漂亮'],['容易萃过头','容易脆过头']]){
    const raw=analysis(heard),result=correct(chapter(canonical),raw);
    assert.equal(result.transcript,canonical);assertIdentity(raw,result);
  }
});

test('repeated or competing canonical and heard anchor contexts remain ambiguous',()=>{
  for(const [canonical,heard] of [
    ['容易萃过头，容易萃过头','容易脆过头容易脆过头'],
    ['容易萃过头，容易脆过头','容易脆过头'],
    ['容易萃过头','容易脆过头容易萃过头'],
  ]){const raw=analysis(heard);assert.equal(correct(chapter(canonical),raw),raw,heard);}
});

test('inconsistent transcript, sentence and word fields cannot be reconciled into a correction',()=>{
  const value=chapter('容易萃过头');
  for(const raw of [
    {...analysis('容易脆过头'),transcript:'容易萃过头'},
    {...analysis('容易脆过头'),transcript:'额外原话容易脆过头'},
    {...analysis('容易脆过头'),sentences:[{...analysis('容易脆过头').sentences[0],text:'容易萃过头'}]},
  ])assert.equal(correct(value,raw),raw);
});

test('wrong numbers, missing date units and model values still fail full strict speech validation',()=>{
  const value=chapter('泡久了容易萃过头，核对58批，十月十五日和Fable5.1仍需验证。');
  for(const heard of [
    value.narration.replace('萃','脆').replace('58批','59批'),
    value.narration.replace('萃','脆').replace('十五日','十五'),
    value.narration.replace('萃','脆').replace('5.1','5.2'),
  ]){
    const raw=analysis(heard),result=correct(value,raw);assertIdentity(raw,result);
    assert.equal(result.transcript,heard.replace('脆','萃'));
    assert.throws(()=>alignLessonSpeech(value,result),/数字|年份|日期|型号|版本|单位|台词|缺|匹配|原词/);
  }
});

test('bounded evidence refuses more than eight changes rather than hiding unrecorded edits',()=>{
  const prefixes=['春风','夏雪','秋雨','冬霜','晨光','暮色','清露','薄雾','星河'];
  const canonical=prefixes.map(prefix=>prefix+'程序公开').join('，'),raw=analysis(canonical.replaceAll('程序','城序'));
  assert.equal(correct(chapter(canonical),raw),raw);
});
