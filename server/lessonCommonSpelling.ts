import {pinyin} from 'pinyin-pro';
import type {AudioAnalysis,LessonChapter} from '../src/types';

const options={type:'array',toneType:'num',toneSandhi:false,surname:'off',nonZh:'spaced'} as const;
const samePhones=(left:string,right:string)=>JSON.stringify(pinyin(left,options))===JSON.stringify(pinyin(right,options));
const count=(text:string,word:string)=>text.split(word).length-1;
const separators=/^[\p{P}\p{Z}\s]*$/u;

/** A finite written-word equivalence for fact-reviewed generated narration.
 * This is not arbitrary pinyin matching and must never edit uploaded speech.
 * Every changed glyph belongs to an existing ASR word; raw ASR stays separate.
 */
export function correctCommonNarrationSpelling(chapter:LessonChapter,analysis:AudioAnalysis):AudioAnalysis{
  if(analysis.status!=='ready'||typeof analysis.transcript!=='string'||!Array.isArray(analysis.sentences)||typeof chapter.narration!=='string')return analysis;
  const expected=chapter.narration.replace(/[\p{P}\p{Z}\s]/gu,'');
  // Do not infer which written form was intended when either occurs twice or
  // both occur in the script. Only this complete word is interchangeable.
  const target=count(expected,'当作')===1&&count(expected,'当做')===0?'当作':count(expected,'当做')===1&&count(expected,'当作')===0?'当做':undefined;
  if(!target)return analysis;
  const from=target==='当作'?'当做':'当作',position=[...expected.slice(0,expected.indexOf(target))].length,script=[...expected];
  const context=script.slice(position-2,position+4).join('');
  if(position<2||!/^\p{Script=Han}{6}$/u.test(context))return analysis;
  const heardContext=context.replace(target,from);
  if(!samePhones(heardContext,context))return analysis;
  const offsets:number[]=[];let cursor=0;
  for(const sentence of analysis.sentences){
    if(typeof sentence.text!=='string'||!sentence.text||!Array.isArray(sentence.words)||sentence.words.some(word=>typeof word.text!=='string'||!word.text||!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.end<=word.start)||sentence.text!==sentence.words.map(word=>word.text).join(''))return analysis;
    const at=analysis.transcript.indexOf(sentence.text,cursor);
    if(at<0||!separators.test(analysis.transcript.slice(cursor,at)))return analysis;
    offsets.push(at);cursor=at+sentence.text.length;
  }
  if(!separators.test(analysis.transcript.slice(cursor)))return analysis;
  const heard=analysis.sentences.map(sentence=>sentence.text).join('');
  if(count(heard,from)!==1||count(heard,target)!==0)return analysis;
  const sentenceIndex=analysis.sentences.findIndex(sentence=>sentence.text.includes(heardContext));
  if(sentenceIndex<0)return analysis;
  const sentence=analysis.sentences[sentenceIndex],at=sentence.text.indexOf(heardContext);
  if(sentence.text.indexOf(heardContext,at+1)>=0)return analysis;
  const changedPoint=[...sentence.text.slice(0,at)].length+3;
  const chars=[...sentence.text],before=chars[changedPoint];chars[changedPoint]=[...target][1];
  const after=chars.join('');
  if(before!==[...from][1]||!samePhones(sentence.text,after))return analysis;
  let wordPoint=0,changedWord=-1;
  const words=sentence.words.map((word,index)=>{
    const value=[...word.text],start=wordPoint;wordPoint+=value.length;
    if(changedPoint<start||changedPoint>=wordPoint)return word;
    value[changedPoint-start]=[...target][1];changedWord=index;return{...word,text:value.join('')};
  });
  if(changedWord<0)return analysis;
  const sentences=analysis.sentences.map((value,index)=>index===sentenceIndex?{...value,text:after,words}:value);
  const transcript=analysis.transcript.slice(0,offsets[sentenceIndex])+after+analysis.transcript.slice(offsets[sentenceIndex]+sentence.text.length);
  if(!samePhones(analysis.transcript,transcript))return analysis;
  return{...analysis,transcript,sentences,warnings:[...analysis.warnings,`ASR常用词正字（仅生成旁白；完整词与左右原字一致，原始转写另存，未补字或修改词时间、完整性与分行）：${from}→${target}；句${String(sentence.id).slice(0,80)}；词${changedWord}`]};
}
