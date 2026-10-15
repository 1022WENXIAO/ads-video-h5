import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {correctSourceModelSpelling} from '../server/lessonModelSpelling';
import {alignLessonSpeech,correctLessonTranscript,lessonCaptionAnalysis} from '../server/lessonSpec';
import {captionsFromTranscript} from '../server/timeline';
import type {AudioAnalysis,LessonChapter,ResearchReference,EditPlan,MediaItem} from '../src/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p15-model-caption.json',import.meta.url),'utf8')) as {chapter:LessonChapter;raw:AudioAnalysis;captioned:AudioAnalysis;references:ResearchReference[];initial:{chapter:LessonChapter;raw:AudioAnalysis;recheck:AudioAnalysis;references:ResearchReference[]}};
const wordShape=(analysis:AudioAnalysis)=>analysis.sentences.map(s=>({start:s.start,end:s.end,complete:s.complete,words:s.words.map(w=>({start:w.start,end:w.end}))}));
const mutate=(value:AudioAnalysis,from:string,to:string):AudioAnalysis=>{
  const next=structuredClone(value);next.transcript=next.transcript.replace(from,to);
  for(const s of next.sentences){s.text=s.text.replace(from,to);for(const w of s.words)w.text=w.text.replace(from,to);}
  return next;
};

test('actual initial two DeepSeek model versions gain only same-value numeric typography; unrelated ASR faults remain evidence',()=>{
  const value=actual.initial;
  for(const raw of [value.raw,value.recheck]){
    const before=structuredClone(raw),corrected=correctSourceModelSpelling(value.chapter,raw,value.references);
    assert.equal((corrected.transcript.match(/V4\.1/g)||[]).length,2);assert.doesNotMatch(corrected.transcript,/v四点一/i);
    assert.deepEqual(wordShape(corrected),wordShape(raw));assert.equal(corrected.sourceHash,raw.sourceHash);assert.deepEqual(corrected.captionBreaks,raw.captionBreaks);assert.deepEqual(raw,before);
    const captions=captionsFromTranscript({clips:[{sourceId:'initial',start:0,end:raw.duration}],lesson:{chapters:[value.chapter]}} as EditPlan,[{id:'initial',analysis:corrected} as MediaItem]);
    assert.equal((captions.map(c=>c.text).join('').match(/V4\.1/g)||[]).length,2);
    if(raw.transcript.includes('阿什'))assert.ok(corrected.transcript.includes('阿什'));
    if(raw.transcript.includes('状态业')){assert.ok(corrected.transcript.includes('状态业'));assert.throws(()=>alignLessonSpeech(value.chapter,corrected),error=>error instanceof Error&&!/型号或版本/.test(error.message));}
  }
});

test('actual P15 same-waveform wordgrid gains sourced V4.1 typography and real caption projection without new words or time',()=>{
  for(const raw of [actual.raw,actual.captioned]){
    const before=structuredClone(raw),chapter=structuredClone(actual.chapter),corrected=correctSourceModelSpelling(chapter,raw,actual.references);
    assert.notEqual(corrected,raw);assert.match(corrected.transcript,/V4\.1[fF]lash/);assert.doesNotMatch(corrected.transcript,/v四点一/);
    assert.deepEqual(wordShape(corrected),wordShape(raw));assert.equal(corrected.sourceHash,raw.sourceHash);assert.equal(corrected.duration,raw.duration);assert.deepEqual(corrected.captionBreaks,raw.captionBreaks);
    assert.equal(corrected.sentences.flatMap(s=>s.words).length,62);assert.ok(corrected.warnings.some(w=>w.includes('V4.1')&&w.includes('ref-1')));
    assert.doesNotThrow(()=>alignLessonSpeech(chapter,corrected));
    const projected=lessonCaptionAnalysis(chapter,corrected),plan={clips:[{sourceId:'captured-speech',start:0,end:raw.duration}],lesson:{chapters:[chapter]}} as EditPlan;
    const captions=captionsFromTranscript(plan,[{id:'captured-speech',analysis:projected} as MediaItem]);
    assert.ok(captions.some(c=>/V4\.1[fF]lash接口/.test(c.text)));assert.equal(captions.some(c=>c.text.includes('v四点一')),false);
    assert.deepEqual(raw,before);assert.deepEqual(chapter,actual.chapter);
  }
  const before=structuredClone(actual.raw),integrated=correctLessonTranscript(actual.chapter,actual.raw,actual.references);
  assert.match(integrated.transcript,/V4\.1Flash/);assert.deepEqual(wordShape(integrated),wordShape(actual.raw));assert.deepEqual(actual.raw,before);
});

test('missing, search-only, duplicate, other-chapter or nonliteral source evidence cannot authorize formatting',()=>{
  const sources=actual.references;
  for(const refs of [[],sources.map(r=>({...r,verification:'search-cited' as const})),sources.flatMap(r=>[r,{...r}]),sources.map(r=>({...r,excerpt:r.excerpt.replaceAll('V4.1','V4.2')}))]){
    assert.equal(correctSourceModelSpelling(actual.chapter,actual.raw,refs),actual.raw);
  }
  const other=structuredClone(actual.chapter);other.referenceIds=['another-chapter-ref'];assert.equal(correctSourceModelSpelling(other,actual.raw,sources),actual.raw);
  const synthesis=structuredClone(actual.chapter);synthesis.claims=synthesis.claims.map(c=>({...c,basis:'synthesis',explanation:'Controlled unsupported source binding'}));assert.equal(correctSourceModelSpelling(synthesis,actual.raw,sources),actual.raw);
});

test('different version, missing prefix/digit, extra occurrence and product text cannot become the expected caption',()=>{
  for(const [from,to]of [['四','五'],['v',''],['一',''],['flash','pro']] as const){
    // Only change the actual model token, leaving clock numbers and all other
    // heard words alone. A wrong product remains for the full speech gate.
    const raw=structuredClone(actual.raw);raw.transcript=raw.transcript.replace('v四点一flash','v四点一flash'.replace(from,to));
    const sentence=raw.sentences.find(s=>s.text.includes('v四点一'))!;sentence.text=sentence.text.replace('v四点一flash','v四点一flash'.replace(from,to));
    const words=sentence.words,at=words.findIndex(w=>w.text==='v');
    const word=words.slice(at,at+5).find(w=>w.text===from);if(word)word.text=to;
    const before=structuredClone(raw),corrected=correctSourceModelSpelling(actual.chapter,raw,actual.references);
    if(to!=='pro')assert.equal(corrected,raw);
    assert.throws(()=>alignLessonSpeech(actual.chapter,corrected),/版本|型号|数字|字词|匹配|台词/);
    if(from==='v')assert.doesNotMatch(corrected.transcript,/V4\.1/,'the formatter must not insert a missing prefix');
    assert.deepEqual(raw,before);
  }
  const duplicate=structuredClone(actual.raw);duplicate.transcript+='v四点一';duplicate.sentences[0].text+='v四点一';duplicate.sentences[0].words.push({text:'v四点一',start:duplicate.duration-.1,end:duplicate.duration});assert.equal(correctSourceModelSpelling(actual.chapter,duplicate,actual.references),duplicate);
});

test('transcript, sentence text and word-grid disagreement is fail-closed and never silently rewritten',()=>{
  for(const change of [
    (a:AudioAnalysis)=>{a.transcript=a.transcript.replace('v四点一','v四点二');},
    (a:AudioAnalysis)=>{a.sentences[0].text=a.sentences[0].text.replace('v四点一','v四点二');},
    (a:AudioAnalysis)=>{const w=a.sentences.flatMap(s=>s.words).find(w=>w.text==='v')!;w.text='x';},
  ]){const raw=structuredClone(actual.raw);change(raw);const before=structuredClone(raw);assert.equal(correctSourceModelSpelling(actual.chapter,raw,actual.references),raw);assert.deepEqual(raw,before);}
});

test('unrelated same-sound glyphs and numerals are not normalized by source typography',()=>{
  const raw=mutate(actual.raw,'页','业'),before=structuredClone(raw),corrected=correctSourceModelSpelling(actual.chapter,raw,actual.references);
  assert.match(corrected.transcript,/状态业/);assert.match(corrected.transcript,/V4\.1/);assert.throws(()=>alignLessonSpeech(actual.chapter,corrected),/字词|匹配/);assert.deepEqual(raw,before);
  const wrong=mutate(actual.raw,'十一分','十四分');assert.throws(()=>alignLessonSpeech(actual.chapter,correctSourceModelSpelling(actual.chapter,wrong,actual.references)),/时钟|数字|单位|匹配/);
});
