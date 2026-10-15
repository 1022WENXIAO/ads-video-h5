import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {AudioAnalysis,LessonChapter} from '../src/types';
import {correctCommonNarrationSpelling} from '../server/lessonCommonSpelling';
import {alignLessonSpeech,correctLessonTranscript} from '../server/lessonSpec';

function chapter(narration='热搜采样时间不能当作故障开始时间。'):LessonChapter{
  return{id:'c1',title:'受控正字',role:'hook',goal:'核对同音字形',prerequisites:[],narration,reason:'离线语音测试',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'时间不能混用',items:[{label:'时间',detail:'保留原字',cue:'热搜采样时间'},{label:'边界',detail:'保留原字',cue:'故障开始时间'}]}};
}
function analysis(text:string,parts=[...text]):AudioAnalysis{
  let cursor=0;const words=parts.map(text=>{const start=cursor;cursor+=[...text].length*.1;return{text,start,end:cursor};});
  return{status:'ready',modelId:'controlled',duration:cursor,sourceHash:'a'.repeat(64),createdAt:'',timing:'model-estimated',transcript:text,warnings:[],pauses:[],captionBreaks:[2,5],sentences:[{id:'s1',text,start:0,end:cursor,complete:true,words}]};
}
function unchangedMetadata(raw:AudioAnalysis,updated:AudioAnalysis){
  assert.deepEqual({...raw,transcript:undefined,sentences:undefined,warnings:undefined},{...updated,transcript:undefined,sentences:undefined,warnings:undefined});
  assert.equal(updated.sentences.length,raw.sentences.length);
  for(const [i,sentence]of raw.sentences.entries()){
    const next=updated.sentences[i];assert.deepEqual({...sentence,text:undefined,words:undefined},{...next,text:undefined,words:undefined});assert.equal(next.words.length,sentence.words.length);
    for(const [j,word]of sentence.words.entries()){assert.deepEqual({...word,text:undefined},{...next.words[j],text:undefined});assert.equal([...word.text].length,[...next.words[j].text].length);}
  }
}
for(const [script,heard]of [['当作','当做'],['当做','当作']])test(`finite ${heard}→${script} spelling retains existing words, times, source hash and caption indices`,()=>{
  const value=chapter('热搜采样时间不能'+script+'故障开始时间。'),raw=analysis('热搜采样时间不能'+heard+'故障开始时间'),before=structuredClone(raw),updated=correctCommonNarrationSpelling(value,raw);
  assert.notEqual(updated,raw);assert.equal(updated.transcript,'热搜采样时间不能'+script+'故障开始时间');assert.match(updated.warnings.at(-1)!,new RegExp(heard+'→'+script));unchangedMetadata(raw,updated);assert.deepEqual(raw,before);assert.equal(alignLessonSpeech(value,correctLessonTranscript(value,raw)).similarity,1);
});
test('the finite word may span ASR word boundaries after extended Han characters without shifting owners or times',()=>{
  const value=chapter('𬸚𬸦消息不能当作故障开始时间。');value.visual.items[0].cue='𬸚𬸦消息';
  const raw=analysis('𬸚𬸦消息不能当做故障开始时间',['𬸚𬸦','消息','不能','当','做','故障','开始','时间']),before=structuredClone(raw),updated=correctCommonNarrationSpelling(value,raw);
  assert.equal(updated.sentences[0].words[4].text,'作');assert.equal(updated.sentences[0].words[3].text,'当');unchangedMetadata(raw,updated);assert.deepEqual(raw,before);assert.equal(alignLessonSpeech(value,updated).similarity,1);
});
for(const [label,script,heard]of [
  ['missing syllable','热搜采样时间不能当作故障开始时间。','热搜采样时间不能当故障开始时间'],
  ['missing negation','热搜采样时间不能当作故障开始时间。','热搜采样时间能当做故障开始时间'],
  ['opposite modality','热搜采样时间不能当作故障开始时间。','热搜采样时间可以当做故障开始时间'],
  ['wrong number','三次热搜采样时间不能当作故障开始时间。','二次热搜采样时间不能当做故障开始时间'],
  ['wrong clock','八点十一分的热搜采样时间不能当作故障开始时间。','八点十分的热搜采样时间不能当做故障开始时间'],
  ['unrelated same-phone word','热搜采样时间不能当作故障开始时间。新消息已公布。','热搜采样时间不能当做故障开始时间心消息已公布'],
] as const)test('common spelling does not permit '+label,()=>{
  const value=chapter(script),raw=analysis(heard),before=structuredClone(raw);assert.throws(()=>alignLessonSpeech(value,correctLessonTranscript(value,raw)),/匹配|数字|时钟/);assert.deepEqual(raw,before);
});
for(const [label,script,heard]of [
  ['both written forms in script','热搜采样时间不能当作故障开始时间，也不能当做原始依据。','热搜采样时间不能当做故障开始时间也不能当做原始依据'],
  ['two intended occurrences','热搜采样时间不能当作故障开始时间，也不能当作原始依据。','热搜采样时间不能当做故障开始时间也不能当作原始依据'],
  ['two heard occurrences','热搜采样时间不能当作故障开始时间。','热搜采样时间不能当做故障开始时间也不能当做原始依据'],
  ['missing left context','当作故障开始时间。','当做故障开始时间'],
  ['missing right context','热搜采样时间不能当作。','热搜采样时间不能当做'],
  ['different actual context','热搜采样时间不能当作故障开始时间。','热搜采样时间不能当做网络开始时间'],
] as const)test('ambiguous or absent complete-word context remains unmodified: '+label,()=>{
  const value=chapter(script),raw=analysis(heard),before=structuredClone(raw);assert.equal(correctCommonNarrationSpelling(value,raw),raw);assert.deepEqual(raw,before);
});
test('transcript and word streams must independently agree; preserve original separators when they do',()=>{
  const value=chapter(),raw=analysis('热搜采样时间不能当做故障开始时间'),before=structuredClone(raw);
  const transcriptMismatch={...raw,transcript:raw.transcript.replace('当做','当作')};assert.equal(correctCommonNarrationSpelling(value,transcriptMismatch),transcriptMismatch);
  const wordsMismatch=structuredClone(raw);wordsMismatch.sentences[0].words[9].text='作';assert.equal(correctCommonNarrationSpelling(value,wordsMismatch),wordsMismatch);
  const extraTranscript={...raw,transcript:'额外原话'+raw.transcript};assert.equal(correctCommonNarrationSpelling(value,extraTranscript),extraTranscript);
  const separated={...raw,transcript:'\n'+raw.transcript+'\n'};const updated=correctCommonNarrationSpelling(value,separated);assert.equal(updated.transcript,'\n热搜采样时间不能当作故障开始时间\n');unchangedMetadata(separated,updated);assert.deepEqual(raw,before);
});
test('the archived actual four first/recheck ASR grids pass original narration and animation cues with one spelling correction each',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/narration-common-spelling-actual.json',import.meta.url),'utf8')) as {chapter:LessonChapter;records:Array<{stage:string;analysis:AudioAnalysis}>};
  assert.equal(fixture.records.length,4);assert.equal(new Set(fixture.records.map(r=>r.analysis.sourceHash)).size,2);
  for(const record of fixture.records){
    const before=structuredClone(record.analysis);assert.throws(()=>alignLessonSpeech(fixture.chapter,record.analysis),/未完整匹配汉字「作」/);
    const updated=correctCommonNarrationSpelling(fixture.chapter,record.analysis);unchangedMetadata(record.analysis,updated);
    const oldWords=record.analysis.sentences.flatMap(s=>s.words),words=updated.sentences.flatMap(s=>s.words);assert.equal(words.filter((w,i)=>w.text!==oldWords[i].text).length,1);
    const actual=alignLessonSpeech(fixture.chapter,correctLessonTranscript(fixture.chapter,record.analysis));assert.equal(actual.similarity,1);assert.equal(actual.cues.length,fixture.chapter.visual.items.length);assert.equal(actual.cues.every(c=>c.start>=0&&c.end<=record.analysis.duration),true);assert.deepEqual(record.analysis,before);assert.equal(updated.warnings.length,record.analysis.warnings.length+1);
  }
});
