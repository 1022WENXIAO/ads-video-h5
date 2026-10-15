import test from 'node:test';
import assert from 'node:assert/strict';
import {alignLessonSpeech,correctLessonTranscript,lessonCaptionAnalysis} from '../server/lessonSpec';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

function chapter(clock:string):LessonChapter{
  return{id:'clock',title:'核对事件时间',role:'hook',goal:'区分时间和数值',prerequisites:[],narration:`这条报道记录，事发时间是十月十二日${clock}，商人回应情况，核验结论仍以证据为准。`,reason:'受控台词核验',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'核对事件时间',items:[{label:'报道',detail:'核验来源',cue:'这条报道'},{label:'结论',detail:'以证据为准',cue:'核验结论'}]}};
}
function audio(text:string,splitAt?:number):AudioAnalysis{
  const words=[...text].map((text,i)=>({text,start:i*.25,end:(i+1)*.25})),duration=words.at(-1)!.end;
  const sentence=(from:number,to:number,id:string)=>({id,text:words.slice(from,to).map(w=>w.text).join(''),start:words[from].start,end:words[to-1].end,complete:true,words:words.slice(from,to)});
  return{status:'ready',modelId:'controlled-asr',sourceHash:'same-original-audio',duration,transcript:text,sentences:splitAt?[sentence(0,splitAt,'date'),sentence(splitAt,words.length,'clock')]:[sentence(0,words.length,'all')],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
}
function assertMatch(value:LessonChapter,heard:string,passes:boolean,splitAt?:number){
  const raw=audio(heard,splitAt),before=structuredClone(raw),script=structuredClone(value),corrected=correctLessonTranscript(value,raw);
  let result:ReturnType<typeof alignLessonSpeech>|undefined;
  if(passes)assert.doesNotThrow(()=>{result=alignLessonSpeech(value,corrected);},heard);
  else assert.throws(()=>alignLessonSpeech(value,corrected),/时钟|小数|数字|日期|单位|匹配|末尾/,heard);
  assert.deepEqual(raw,before,'raw words, transcript, timings and source hash remain evidence');assert.deepEqual(value,script,'script and visual cues are not rewritten');
  if(passes){const captions=lessonCaptionAnalysis(value,corrected);assert.deepEqual(captions.sentences,corrected.sentences);assert.equal(captions.transcript,corrected.transcript);}
  return{raw,corrected,result};
}

test('the actual 十三点四十四分 / 13点44分 decimal false rejection is removed across equivalent clock notation',()=>{
  for(const expected of ['十三点四十四分','13点44分','13时44分','13:44'])for(const heard of ['十三点四十四分','13点44分','13时44分','13:44'])assertMatch(chapter(expected),chapter(heard).narration,true);
  const value=chapter('十三点四十四分');assertMatch(value,value.narration.replace('十月十二日十三点四十四分','10月12日13点44分'),true);
  for(const heard of ['13 点 44 分','13 : 44','下午 1 点 44 分'])assertMatch(value,chapter(heard).narration,true);
});

test('AM/PM and minute/second fields preserve explicit clock meaning and bounds',()=>{
  for(const [expected,heard]of [['13点44分','下午一点四十四分'],['13:44','中午一点四十四分'],['01:44','凌晨一点四十四分'],['01:44','夜间一点四十四分'],['02:44','晚间两点四十四分'],['19:44','晚上七点四十四分'],['00:44','晚上十二点四十四分'],['09:44','上午九点四十四分'],['00:44','凌晨十二点四十四分'],['13时44分05秒','下午一点四十四分五秒'],['13:44:05','十三点四十四分零五秒']])assertMatch(chapter(expected),chapter(heard).narration,true);
  for(const heard of ['上午一点四十四分','下午两点四十四分','13点14分','十三点四十五分','14:44','十三点四十四分六秒','25点44分','13点60分','13:44:61','上午十三点四十四分','凌晨十三点四十四分','中午九点四十四分'])assertMatch(chapter('13点44分'),chapter(heard).narration,false);
  assertMatch(chapter('13:44:05'),chapter('13:44').narration,false);assertMatch(chapter('13:44:05'),chapter('13:44:06').narration,false);
});

test('independent date clauses and clock tokens align without filling date units or accepting wrong entities',()=>{
  const value=chapter('十三点四十四分'),heard=value.narration.replace('十二日十三','十二日，十三'),at=heard.indexOf('十三点');
  assertMatch(value,heard,true,at);
  for(const text of [value.narration.replace('十二日十三','十二十三'),value.narration.replace('十月十二日','十月十三日'),value.narration.replace('商人','伤人'),value.narration.replace('四十四分','四十四')])assertMatch(value,text,false);
  const inconsistent=audio(value.narration);inconsistent.transcript=inconsistent.transcript.replace('四十四分','十四分');const before=structuredClone(inconsistent);assert.throws(()=>alignLessonSpeech(value,inconsistent),/时钟/);assert.deepEqual(inconsistent,before);
  const mixed={...value,narration:'这条报道记录，Gemini五点一，二十二日发布消息，十三点四十四分核对来源，核验结论仍以证据为准。'};
  const raw=audio(mixed.narration),words=raw.sentences[0].words.filter(w=>!/[，。]/.test(w.text));raw.sentences[0].words=words;
  const dateAt=words.findIndex((w,i)=>w.text==='二'&&words[i+1]?.text==='十');for(let i=dateAt;i<words.length;i++){words[i].start+=.5;words[i].end+=.5;}raw.duration+=.5;
  const beforeMixed=structuredClone(raw);assert.doesNotThrow(()=>alignLessonSpeech(mixed,raw));assert.deepEqual(raw,beforeMixed);
});

test('real decimals, scores, prices, ratios and model versions remain outside the clock normalization',()=>{
  const base=chapter('十三点四十四分');
  for(const [expected,heard,passes]of [
    ['数值是13.44','数值是十三点四四',true],['得分为13.44分','得分为十三点四四分',true],['价格13.44元','价格十三点四四元',true],['分数为13.44分之一','分数为十三点四四分之一',true],['长度13.44分米','长度十三点四四分米',true],['比例为13:44','比例为13点44分',false],
    ['数值是13.44','数值是13点44分',false],['得分为13.44分','得分为13:44',false],['价格13.44元','价格13点44分',false],['Model13.44版本','Model十三点四四版本',true],['Model13.44版本','Model13点44分版本',false],
  ] as const){const value={...base,narration:`这条报道记录，${expected}，核验结论仍以证据为准。`};assertMatch(value,value.narration.replace(expected,heard),passes);}
  assertMatch(base,base.narration.replace('十三点四十四分','13.44'),false);
  const value={...base,narration:'这条报道记录，模型特点需要核对，核验结论仍以证据为准。'};assertMatch(value,value.narration.replace('特点','特'),false);
});

test('full and minute clock cues retain original labels and their actual word timing spans',()=>{
  const value=chapter('十三点四十四分');value.visual.items[0].cue='十三点四十四分';value.visual.items[1].cue='四十四分';
  const heard=chapter('下午1点44分').narration,{raw,result}=assertMatch(value,heard,true);
  const start=heard.indexOf('下午1点44分'),minute=heard.indexOf('44分'),words=raw.sentences[0].words;
  assert.deepEqual(result!.cues.map(c=>c.text),['十三点四十四分','四十四分']);assert.equal(result!.cues[0].start,words[start].start);assert.equal(result!.cues[0].end,words[minute+2].end);assert.equal(result!.cues[1].start,words[minute].start);assert.equal(result!.cues[1].end,words[minute+2].end);
});

test('partial clock cues inherit the chapter afternoon context and exact source spans',()=>{
  for(const cue of ['下午一点','一点四十四分','下午'])for(const time of ['下午一点四十四分','13点44分']){
    const value=chapter('下午一点四十四分');value.visual.items[0].cue=cue;
    const heard=chapter(time).narration,{raw,result}=assertMatch(value,heard,true),words=raw.sentences[0].words;
    const start=time==='下午一点四十四分'?heard.indexOf(cue):heard.indexOf('13点44分');
    const end=time==='下午一点四十四分'?start+cue.length:heard.indexOf('13点44分')+(cue==='一点四十四分'?6:3);
    assert.equal(result!.cues[0].text,cue);assert.equal(result!.cues[0].start,words[start].start);assert.equal(result!.cues[0].end,words[end-1].end);
  }
});

test('actual ASR newline inside 四十四 preserves clock structure without crossing punctuation or filling units',()=>{
  const value=chapter('十三点四十四分'),raw=audio(value.narration),words=raw.sentences[0].words,at=value.narration.indexOf('四十四分')+1;
  raw.transcript=value.narration.slice(0,at)+'\n'+value.narration.slice(at);
  raw.sentences=[{...raw.sentences[0],id:'first',text:value.narration.slice(0,at),end:words[at-1].end,words:words.slice(0,at)},{...raw.sentences[0],id:'second',text:value.narration.slice(at),start:words[at].start,words:words.slice(at)}];
  const before=structuredClone(raw);assert.doesNotThrow(()=>alignLessonSpeech(value,raw));assert.deepEqual(raw,before);
  for(const time of ['十三点四\n十四分','1\n3点4\n4分','13:4\n4'])assertMatch(value,chapter(time).narration,true);
  for(const time of ['十三点四\n十五分','1\n4点4\n4分','十三点四\n十四','十三点四，十四分','十三点四。十四分','十三点四；十四分'])assertMatch(value,chapter(time).narration,false);
});
