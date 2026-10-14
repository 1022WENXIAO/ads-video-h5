import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { lessonSpeechEntities, lessonSpeechLexicon, correctLessonTranscript, alignLessonSpeech, lessonCaptionAnalysis } from '../server/lessonSpec';
import type { AudioAnalysis, LessonChapter } from '../src/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/news-company-caption-asr.json',import.meta.url),'utf8')) as {cases:Array<{id:string;mismatch:{heard:string;expected:string};chapter:LessonChapter;recognition:{transcript:string;duration:number;words:Array<{text:string;start:number;end:number}>}}>};
const asAnalysis=(record:typeof fixture.cases[number]):AudioAnalysis=>({status:'ready',modelId:'controlled-regression',sourceHash:'same-audio',duration:record.recognition.duration,transcript:record.recognition.transcript,sentences:[{id:'captured-words',start:record.recognition.words[0].start,end:record.recognition.words.at(-1)!.end,text:record.recognition.words.map(w=>w.text).join(''),complete:true,words:structuredClone(record.recognition.words)}],pauses:[],timing:'model-estimated',warnings:[],createdAt:''});
function controlledRecheck(record:typeof fixture.cases[number],raw:AudioAnalysis):AudioAnalysis{
  // This is an independently supplied ASR stub, not a production correction.
  // The production corrector above must leave the captured error unchanged.
  const value=structuredClone(raw);value.transcript=value.transcript.replaceAll(record.mismatch.heard,record.mismatch.expected);
  const words=value.sentences[0].words;
  const chars=words.flatMap((word,owner)=>[...word.text].map((text,index,all)=>({text,owner,index,start:word.start+(word.end-word.start)*index/all.length,end:word.start+(word.end-word.start)*(index+1)/all.length})));
  const heard=chars.map(c=>c.text).join(''),at=heard.indexOf(record.mismatch.heard);assert.ok(at>=0);
  assert.equal(record.mismatch.heard.length,record.mismatch.expected.length);
  for(let i=0;i<record.mismatch.expected.length;i++)chars[at+i].text=record.mismatch.expected[i];
  value.sentences[0].words=words.map((word,owner)=>({...word,text:chars.filter(c=>c.owner===owner).map(c=>c.text).join('')}));
  value.sentences[0].text=value.sentences[0].words.map(w=>w.text).join('');return value;
}

for(const record of fixture.cases)test(`captured ${record.id} ${record.mismatch.heard} never passes a high-similarity company-name mismatch`,()=>{
  const raw=asAnalysis(record),before=structuredClone(raw),chapter=record.chapter,scriptBefore=structuredClone(chapter),corrected=correctLessonTranscript(chapter,raw);
  assert.deepEqual(raw,before);assert.equal(corrected.transcript,raw.transcript);assert.ok(corrected.transcript.includes(record.mismatch.heard));
  assert.ok(lessonSpeechEntities(chapter).includes(record.mismatch.expected));assert.ok(lessonSpeechLexicon(chapter,'生成今天的热点 AI 新闻视频').includes(record.mismatch.expected));assert.ok(lessonSpeechLexicon(chapter,'生成今天的热点 AI 新闻视频').length<=160);
  assert.throws(()=>alignLessonSpeech(chapter,corrected),/公司专名.*匹配.*独立复听/);
  const recheck=controlledRecheck(record,raw),recheckBefore=structuredClone(recheck),heard=correctLessonTranscript(chapter,recheck);
  assert.doesNotThrow(()=>alignLessonSpeech(chapter,heard));assert.deepEqual(recheck,recheckBefore);assert.equal(heard.sourceHash,raw.sourceHash);
  assert.deepEqual(heard.sentences[0].words.map(w=>[w.start,w.end]),raw.sentences[0].words.map(w=>[w.start,w.end]),'independent same-audio recheck retains its actual word timing');
  const captioned=lessonCaptionAnalysis(chapter,heard);assert.ok(captioned.transcript.includes(record.mismatch.expected));assert.equal(captioned.sourceHash,raw.sourceHash);assert.deepEqual(chapter,scriptBefore,'the script is not rewritten to follow a bad ASR');
});

test('company gate rejects missing words, a different entity and an incorrect occurrence even if another mention is correct',()=>{
  const record=fixture.cases[0],chapter=record.chapter,valid=controlledRecheck(record,asAnalysis(record));
  const mutate=(from:string,to:string)=>{const value=structuredClone(valid);value.transcript=value.transcript.replaceAll(from,to);for(const sentence of value.sentences){sentence.text=sentence.text.replaceAll(from,to);const text=sentence.words.map(w=>w.text).join('').replaceAll(from,to);sentence.words=[{text,start:sentence.start,end:sentence.end}];}return value;};
  for(const wrong of [mutate('德才股份','万科股份'),mutate('德才股份','德才股')]){
    const before=structuredClone(wrong),corrected=correctLessonTranscript(chapter,wrong);assert.deepEqual(wrong,before);assert.throws(()=>alignLessonSpeech(chapter,corrected),/公司专名.*匹配/);assert.ok(!corrected.transcript.includes('德才股份'),'no missing name is inserted');
  }
  const duplicate={...chapter,narration:chapter.narration+'德才股份。'},partial=structuredClone(valid);partial.transcript+='德彩股份。';partial.sentences[0].words.push({text:'德彩股份',start:valid.duration-.1,end:valid.duration});assert.throws(()=>alignLessonSpeech(duplicate,partial),/公司专名.*匹配/);
  const wrongDigits=mutate('十六点五三','十七点五三');assert.throws(()=>alignLessonSpeech(chapter,correctLessonTranscript(chapter,wrongDigits)),/数字|小数|数量|匹配/);
});

test('ordinary visual labels and generic venture companies do not become literal proper-name gates',()=>{
  const chapter={id:'ordinary',narration:'双方共同成立合资公司，今天介绍市场的关注程度。',claims:[{text:'双方共同成立合资公司，采用科技工具。',referenceIds:['r1'],basis:'source'}],visual:{kind:'concept',takeaway:'市场热度',items:[{label:'市场热度',detail:'关注程度',cue:'市场的关注程度'},{label:'主营业务',detail:'原有服务',cue:'介绍'}]}} as LessonChapter;
  assert.deepEqual(lessonSpeechEntities(chapter),[]);
  for(const generic of ['合资公司','项目公司','运营公司','控股公司','科技公司','新设公司','联合研究团队','十个实验小组','技术服务平台'])assert.deepEqual(lessonSpeechEntities({...chapter,narration:'双方共同成立'+generic+'。',claims:[{text:'双方共同成立'+generic+'。',referenceIds:['r1'],basis:'source'}]}),[]);
  const noSource={...fixture.cases[0].chapter,claims:[]};assert.deepEqual(lessonSpeechEntities(noSource),[],'a label alone is not verified company evidence');
  const unspoken={...fixture.cases[0].chapter,narration:'这家公司受到市场关注。'};assert.deepEqual(lessonSpeechEntities(unspoken),[],'only names actually spoken in this chapter are required');
});

test('transcript alone cannot hide a company-name error in the actual caption words',()=>{
  const record=fixture.cases[0],raw=asAnalysis(record),correct=controlledRecheck(record,raw);raw.transcript=correct.transcript;assert.throws(()=>alignLessonSpeech(record.chapter,raw),/公司专名.*匹配/);
});


test('clear company suffixes retain source binding across ordinary corporate predicates and report prefixes',()=>{
  const base=fixture.cases[0].chapter;
  for(const text of ['公告显示德才股份与行云科技合作。','德才股份控股孙公司从事AI漫剧平台业务。','德才股份主营建筑装饰业务。']){
    const chapter={...base,narration:text.replace('公告显示',''),claims:[{text,referenceIds:['r1'],basis:'source' as const}]};assert.ok(lessonSpeechEntities(chapter).includes('德才股份'),text);
  }
});
