import test from 'node:test';
import assert from 'node:assert/strict';
import { alignLessonSpeech, lessonCaptionAnalysis, correctLessonTranscript, compactSpeech } from '../server/lessonSpec';
import type { AudioAnalysis, LessonChapter } from '../shared/types';

const chapter=(narration:string,cues:string[]):LessonChapter=>({id:'unicode',title:'字词与证据',role:'hook',goal:'核对字词',prerequisites:[],narration,reason:'Unicode边界控制',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'字面相同仍需正确映射',items:cues.map(cue=>({label:cue,detail:'保留实际字词时间',cue}))}});
function analysis(text:string,chunks=[...text]):AudioAnalysis{
  assert.equal(chunks.join(''),text);let at=0;
  const words=chunks.map(text=>{const start=at;at+=.2*[...text].length;return{text,start:+start.toFixed(6),end:+at.toFixed(6)};});
  return{status:'ready',modelId:'offline-controlled-no-provider',sourceHash:'unchanged-original-waveform-hash',duration:at,timing:'model-estimated',createdAt:'',transcript:text,sentences:[{id:'original-utterance',text,start:0,end:at,complete:true,words}],pauses:[],warnings:[],captionBreaks:[words.length-1]};
}
function span(raw:AudioAnalysis,phrase:string){
  const text=raw.sentences.flatMap(s=>s.words).map(w=>w.text).join(''),utf16=text.indexOf(phrase);assert.ok(utf16>=0,phrase);
  const from=[...text.slice(0,utf16)].length,to=from+[...phrase].length;
  const chars=raw.sentences.flatMap(s=>s.words).flatMap(w=>[...w.text].map((char,i,a)=>({char,start:w.start+(w.end-w.start)*i/a.length,end:w.start+(w.end-w.start)*(i+1)/a.length})));
  return{start:+chars[from].start.toFixed(3),end:+chars[to-1].end.toFixed(3)};
}
function match(value:LessonChapter,raw:AudioAnalysis,heardCues=value.visual.items.map(item=>item.cue),exact=true){
  const before=structuredClone(raw),script=structuredClone(value),result=alignLessonSpeech(value,raw);
  if(exact)assert.equal(result.similarity,1);
  else assert.ok(result.similarity>=.86,'existing gate accepts equivalent numeric spellings without requiring an identical edit-distance string');
  result.cues.forEach((cue,i)=>assert.deepEqual(cue,{text:value.visual.items[i].cue,...span(raw,heardCues[i])}));
  const captions=lessonCaptionAnalysis(value,raw);
  assert.equal(captions.transcript,raw.transcript);assert.deepEqual(captions.sentences,raw.sentences);assert.equal(captions.sourceHash,raw.sourceHash);assert.equal(captions.duration,raw.duration);assert.equal(captions.pauses,raw.pauses);
  assert.deepEqual(raw,before,'raw ASR words, ownership, hash, punctuation and times remain evidence');assert.deepEqual(value,script);
  return{result,captions};
}

test('exact BMP and supplementary Han at clause start, middle and end retain cue times and subtitle boundaries',()=>{
  for(const name of ['越卓','𠮷','𠀀','𪚥','𬸚𬸦'])for(const [text,cues]of [
    [`${name}出现在记录，研究仍需证据。`,[`${name}出现`,'研究仍需证据']],
    [`研究记录了${name}的特征，结论仍需证据。`,[`${name}的特征`,'结论仍需证据']],
    [`研究记录需要核验，观测对象是${name}。`,['研究记录',`对象是${name}`]],
  ]as const)match(chapter(text,[...cues]),analysis(text));
});

test('actual-shaped supplementary name followed by decimal no longer loses numeric owners or falsely scores75percent',()=>{
  for(const name of ['越卓','𬸚𬸦']){
    const text=`论文同日。杨源${name}一点五亿年。甲乙。丙丁。`,raw=analysis(text),value=chapter(text,['论文同日','一点五亿年']);
    const {captions}=match(value,raw);
    assert.deepEqual(captions.captionBreaks,[3,13],'both names contain two code points; clause owner indices must match');
  }
  const text='论文同日登上自然。杨源𬸚𬸦生活在约一点五亿年前，重八百二十一克，兼有鸟类特征。';
  match(chapter(text,['杨源𬸚𬸦','一点五亿年前','八百二十一克','鸟类特征']),analysis(text));
});

test('caption onMatch indices are code points and cover all later numeric characters without moving original word owners',()=>{
  const text='先看𠮷鸟。𬸚𬸦二零二四年发现，约一点五亿年前生活。',raw=analysis(text),value=chapter(text,['𠮷鸟','𬸚𬸦','一点五亿年']);
  const matches:Array<{start:number;end:number;heard:string}>=[];
  const captioned=lessonCaptionAnalysis(value,raw,(start,end,heard)=>matches.push({start,end,heard}));
  assert.deepEqual(matches.map(({start,end,heard})=>[...heard].slice(start,end).join('')),['先看𠮷鸟','𬸚𬸦2024年发现','约一点五亿年前生活']);
  assert.deepEqual(matches.map(({start,end})=>[start,end]),[[0,4],[4,13],[13,22]]);
  const covered=new Set(matches.flatMap(({start,end})=>Array.from({length:end-start},(_,i)=>start+i))),heard=[...matches[0].heard];
  heard.forEach((char,i)=>{if(/[\d零〇一二两三四五六七八九十百千万亿点]/.test(char))assert.ok(covered.has(i),'numeric position '+i);});
  assert.deepEqual(captioned.captionBreaks,[3,13,23]);
  match(value,raw);
});

test('equivalent dates, decimals and clocks after supplementary Han preserve numeric gates and their actual spans',()=>{
  const text='𬸚𬸦记录于十月十二日十三点四十四分，数量是十六只，证据仍需核验。';
  const heard='𬸚𬸦记录于10月12日13点44分，数量是16只，证据仍需核验。';
  match(chapter(text,['𬸚𬸦记录于十月十二日十三点四十四分','证据仍需核验']),analysis(text));
  match(chapter(text,['𬸚𬸦','十三点四十四分','证据仍需核验']),analysis(heard),['𬸚𬸦','13点44分','证据仍需核验'],false);
  const decimal='𠮷鸟数值为一点五，数量为八百二十一克，结论仍需证据。',numeric='𠮷鸟数值为1.5，数量为八百二十一克，结论仍需证据。';
  match(chapter(decimal,['𠮷鸟','结论仍需证据']),analysis(numeric),undefined,false);
});

test('mathematical symbol normalization and cross-word supplementary characters preserve source cue times',()=>{
  const value=chapter('𬸚𬸦对应δ参数，误差为零点五，结论仍需证据。',['𬸚𬸦','δ参数','结论仍需证据']);
  const heard='𬸚𬸦对应德尔塔参数，误差为零点五，结论仍需证据。';
  match(value,analysis(heard),['𬸚𬸦','德尔塔参数','结论仍需证据']);
  const text='论文同日。杨源𬸚𬸦一点五亿年前，结论仍需证据。';
  const chunks=['论','文','同','日','。','杨源𬸚','𬸦一点','五亿年前','，','结论仍需证据','。'];
  match(chapter(text,['杨源𬸚𬸦','一点五亿年前','结论仍需证据']),analysis(text,chunks));
});

test('known alias and contextual homophone corrections after supplementary Han use the heard code-point span',()=>{
  for(const [expected,heard,from,to]of [
    ['𬸚𬸦智元公布结果，结论仍需证据。','𬸚𬸦智源公布结果，结论仍需证据。','智源','智元'],
    ['𬸚𬸦像鸟类，结论仍需证据。','𬸚𬸦象鸟类，结论仍需证据。','𬸚𬸦象鸟类','𬸚𬸦像鸟类'],
    ['𠮷鸟进入视野，结论仍需证据。','𠮷鸟近入视野，结论仍需证据。','𠮷鸟近入视','𠮷鸟进入视'],
  ]){
    const value=chapter(expected,[to,'结论仍需证据']),raw=analysis(heard),before=structuredClone(raw),corrected=correctLessonTranscript(value,raw);
    assert.equal(corrected.transcript,heard.replace(from,to));assert.equal(corrected.sourceHash,raw.sourceHash);assert.deepEqual(raw,before);
    const changed=corrected.sentences.flatMap(s=>s.words).find(w=>w.text===to)!;assert.ok(changed);assert.deepEqual({start:changed.start,end:changed.end},span(raw,from));
    assert.equal(alignLessonSpeech(value,corrected).similarity,1);assert.equal([...compactSpeech(corrected.transcript)].length,[...compactSpeech(expected)].length);
  }
});

test('supplementary-Han omissions, added words, wrong digits, dates, clocks and math symbols remain rejected without raw mutation',()=>{
  const text='研究发现𬸚𬸦，数量为十六只，记录在十月十二日十三点四十四分，结论仍需证据。',value=chapter(text,['𬸚𬸦','结论仍需证据']);
  for(const heard of [text.replace('𬸚𬸦','𬸦'),text.replace('𬸚𬸦','𬸚𬸦异兽'),text.replace('十六只','十七只'),text.replace('十二日','十三日'),text.replace('四十四分','十四分'),text.replace('十二日','十二'),text.replace('四十四分','四十四')]){
    const raw=analysis(heard),before=structuredClone(raw);assert.throws(()=>alignLessonSpeech(value,raw),/匹配|数字|日期|时钟|单位|台词|汉字/);assert.deepEqual(raw,before);
  }
  const math=chapter('𠮷鸟对应δ参数，结论仍需证据。',['𠮷鸟','δ参数']);assert.throws(()=>alignLessonSpeech(math,analysis('𠮷鸟对应γ参数，结论仍需证据。')),/匹配|数学|汉字/);
});
