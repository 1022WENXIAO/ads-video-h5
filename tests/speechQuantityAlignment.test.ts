import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {alignLessonSpeech,correctLessonTranscript,lessonCaptionAnalysis,compactSpeech} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/quantity-format-actual-asr.json',import.meta.url),'utf8'));
function audio(text:string,chunk=1):AudioAnalysis{
  const chars=[...text],words=[];
  for(let i=0;i<chars.length;i+=chunk)words.push({text:chars.slice(i,i+chunk).join(''),start:i*.15,end:Math.min(chars.length,i+chunk)*.15});
  return {status:'ready',modelId:'controlled-projection',sourceHash:'immutable-control-hash',duration:chars.length*.15,transcript:text,sentences:[{id:'sentence',text,start:0,end:chars.length*.15,complete:true,words}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
}
function chapter(quantity:string):LessonChapter{
  return {id:'quantity',title:'核对实际检测数量',role:'foundation',goal:'只解释给定数量',prerequisites:[],narration:`这份通报记录${quantity}，检测结论限定本次范围，后续仍需核验。`,reason:'数量字形等值核验',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'数量和单位保持一致',items:[{label:'数量',detail:'通报口径',cue:quantity},{label:'范围',detail:'限定本次',cue:'检测结论限定本次范围'}]}};
}
function verify(value:LessonChapter,raw:AudioAnalysis,passes=true){
  const before=structuredClone(raw),script=structuredClone(value),working=correctLessonTranscript(value,raw);let aligned:ReturnType<typeof alignLessonSpeech>|undefined;
  if(passes)assert.doesNotThrow(()=>{aligned=alignLessonSpeech(value,working);});
  else assert.throws(()=>alignLessonSpeech(value,working),/数字|数量|单位|版本|型号|时钟|日期|匹配|末尾|未匹配|额外/);
  assert.deepEqual(raw,before,'actual transcript, word ownership/times, complete flags and source hash are not edited');assert.deepEqual(value,script,'no expected script/cue values are filled into ASR');
  if(passes){const captions=lessonCaptionAnalysis(value,working);assert.deepEqual(captions.sentences,working.sentences);assert.equal(captions.transcript,working.transcript);assert.equal(captions.sourceHash,working.sourceHash);assert.equal(captions.captionBreaks?.at(-1),working.sentences.flatMap(s=>s.words).findLastIndex(w=>compactSpeech(w.text,false).length>0));}
  return aligned;
}

test('both actual P21 same-wave ASR grids align 15品牌/58批/210份 without expected-word substitution',()=>{
  for(const record of actual.records){
    const raw:AudioAnalysis={status:'ready',modelId:'archived-public-projection',createdAt:'',warnings:[],pauses:[],timing:'model-estimated',...structuredClone(record.analysis)},aligned=verify(actual.chapter,raw)!;
    assert.equal(aligned.similarity,1);assert.equal(raw.sourceHash,'5d0b5778136a9922d312b0f1c8a8f7b94e6d3e908b1117dee87ca835947707f0');
    const words=raw.sentences.flatMap(s=>s.words),chars=words.flatMap(w=>[...compactSpeech(w.text,false)].map((char,i,all)=>({char,start:w.start+(w.end-w.start)*i/all.length,end:w.start+(w.end-w.start)*(i+1)/all.length})));
    for(const [index,heard] of [[1,'十五品牌五十八批'],[2,'二百一十份血样']] as const){
      const phrase=compactSpeech(heard,false),stream=chars.map(c=>c.char).join(''),start=stream.indexOf(phrase);assert.ok(start>=0);
      assert.equal(aligned.cues[index].text,actual.chapter.visual.items[index].cue);
      assert.equal(aligned.cues[index].start,chars[start].start);assert.equal(aligned.cues[index].end,chars[start+[...phrase].length-1].end);
    }
  }
});

test('bounded batch/copy/brand quantities share canonical cue and caption mapping across word chunk sizes',()=>{
  for(const [expected,heard] of [['58批','五十八批'],['368批次','三百六十八批次'],['210份','二百一十份'],['15品牌','十五品牌'],['2.5份','二点五份'],['58至60批','五十八至六十批']] as const)for(const chunk of [1,2,4]){
    const value=chapter(expected),raw=audio(value.narration.replace(expected,heard),chunk),aligned=verify(value,raw)!;
    assert.equal(aligned.similarity,1);assert.equal(aligned.cues[0].text,expected);assert.ok(aligned.cues[0].end>aligned.cues[0].start);
  }
});

test('wrong measured values, units and missing digits or lexical words remain rejected',()=>{
  for(const [expected,heard] of [['58批','五十九批'],['210份','二百零一份'],['15品牌','十六品牌'],['368批次','三百八批次'],['58批','五十八份'],['210份','二百一十批'],['15品牌','十五个品牌'],['58至60批','五十八至六十一批'],['2.5份','二点六份']] as const)verify(chapter(expected),audio(chapter(expected).narration.replace(expected,heard)),false);
  for(const record of actual.records){
    const raw:AudioAnalysis={status:'ready',modelId:'archived-public-projection',createdAt:'',warnings:[],pauses:[],timing:'model-estimated',...structuredClone(record.analysis)};
    raw.transcript=raw.transcript.replace('二百一十','二百二十');raw.sentences=raw.sentences.map(s=>({...s,text:s.text.replace('二百一十','二百二十'),words:s.words.map(w=>({...w}))}));
    verify(actual.chapter,raw,false);
  }
  const value=chapter('58批');verify(value,audio(value.narration.replace('后续仍需核验','后续仍需验')),false);
});

test('ordinary Han prose is not normalized as an unbounded quantity or supplied missing characters',()=>{
  const value=chapter('三份材料');value.narration='三思之后再作判断，证据边界不能省略，后续仍需核验。';value.visual.items[0].cue='三思之后';value.visual.items[1].cue='证据边界不能省略';
  assert.equal(compactSpeech('三思之后'), '三思之后');verify(value,audio(value.narration));verify(value,audio(value.narration.replace('三思','思')),false);
});

test('new quantity units do not merge a preceding model decimal across an actual clause pause',()=>{
  for(const [unit,han] of [['批','二十二批'],['份','二十二份'],['品牌','二十二品牌']] as const){
    const value=chapter('22'+unit);value.narration=`这条记录Fable5.1，22${unit}完成检测，后续仍需核验。`;value.visual.items[0].cue='Fable5.1';value.visual.items[1].cue='22'+unit;
    const raw=audio(value.narration.replace('Fable5.1，22'+unit,'Fable五点一'+han).replace(/[，。]/g,'')),words=raw.sentences[0].words,quantityStart=raw.transcript.indexOf(han);
    for(let i=quantityStart;i<words.length;i++){words[i].start+=.5;words[i].end+=.5;}raw.duration+=.5;raw.sentences[0].end+=.5;
    verify(value,raw);
    const wrong=structuredClone(raw);wrong.transcript=wrong.transcript.replace('五点一','五点二');wrong.sentences[0].text=wrong.transcript;wrong.sentences[0].words[quantityStart-1].text='二';verify(value,wrong,false);
  }
});

test('coexisting dates, clocks and full model identifiers retain their independent strict gates',()=>{
  const value=chapter('58批');value.narration='六月二十二日十三时四十四分核对LFM2.5-24B-A2B，检查58批材料，后续仍需核验。';value.visual.items[0].cue='58批';value.visual.items[1].cue='后续仍需核验';
  const heard=value.narration.replace('六月二十二日十三时四十四分','6月22日13时44分').replace('58批','五十八批');verify(value,audio(heard));
  for(const changed of [heard.replace('22日','22'),heard.replace('22日','23日'),heard.replace('44分','14分'),heard.replace('44分','44'),heard.replace('2.5','2.6'),heard.replace('24B','25B'),heard.replace('A2B','A3B'),heard.replace('五十八','五十九')])verify(value,audio(changed),false);
});

test('an already matching measured range retains its legacy meaning across a real pause inside that range',()=>{
  const value=chapter('15到20元'),heard=value.narration.replace('15到20元','十五到二十元'),raw=audio(heard),at=[...heard.slice(0,heard.indexOf('二十元'))].length;
  for(let i=at;i<raw.sentences[0].words.length;i++){raw.sentences[0].words[i].start+=.5;raw.sentences[0].words[i].end+=.5;}raw.duration+=.5;raw.sentences[0].end+=.5;
  assert.equal(verify(value,raw)!.similarity,1);
  for(const changed of ['十五到二十一元','十五到二十份','十五到二元'])verify(value,audio(value.narration.replace('15到20元',changed)),false);
  const disagreement=structuredClone(raw);disagreement.transcript=disagreement.transcript.replace('二十元','二十一元');verify(value,disagreement,false);
});
