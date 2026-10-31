import {createHash} from 'node:crypto';
import {lessonSpokenDateValues} from './lessonSpec';
type Chapter={id:string;narration:string};
export interface NarrationDateBaseline {version:1;chapters:Chapter[];hash:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createNarrationDateBaseline(chapters:Chapter[]):NarrationDateBaseline{
  const value={version:1 as const,chapters:chapters.map(({id,narration})=>({id,narration}))};return{...value,hash:hash(value)};
}
export function restoreNarrationDateBaseline(raw:unknown):NarrationDateBaseline|undefined{
  if(raw===undefined)return;
  const value=raw as NarrationDateBaseline;
  if(value?.version!==1||!Array.isArray(value.chapters)||!value.chapters.length||value.chapters.length>64||value.chapters.some(c=>!c||typeof c.id!=='string'||!c.id||typeof c.narration!=='string'||c.narration.length>5000)||new Set(value.chapters.map(c=>c.id)).size!==value.chapters.length||value.hash!==hash({version:1,chapters:value.chapters}))throw new Error('旁白日期修稿基线损坏，保留原件并停止。');
  return structuredClone(value);
}
const numeral='[\\d零〇一二两三四五六七八九十百千]+';
const number=(text:string,unit:string)=>lessonSpokenDateValues(text+unit)[0]?.value;
/** Compare authored calendar meaning only; never rewrite the actual script or
 * infer a missing publication date. Trading/work-day calendars are not guessed. */
export function narrationCalendarValues(text:string,requestedAt:number){
  const year=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',year:'numeric'}).format(new Date(requestedAt)));
  const expanded=text.replace(/\s/g,'').replace(new RegExp('(?:('+numeral+')年[，,、]*)?('+numeral+')月(?:的)?(?:最后[一1](?:天|日)|倒数第('+numeral+')(?:天|日))','g'),(_match,y,m,n)=>{
    const yyyy=y?number(y,'年'):year,month=number(m,'月'),ordinal=n?number(n,'日'):1;
    if(!yyyy||!month||month<1||month>12||!ordinal)throw new Error('无法核实月末日期，保留原有明确日期。');
    const leap=yyyy%4===0&&(yyyy%100!==0||yyyy%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1],day=days-ordinal+1;
    if(day<1||day>days)throw new Error('无法核实月末日期，保留原有明确日期。');
    return(y?y+'年':'')+month+'月'+day+'日';
  }).replace(/\s/g,'');
  const calendar=new RegExp('(?:'+numeral+'年[，,、]*)?'+numeral+'月(?:[，,、]*'+numeral+'[日号])?','g');
  const groups=[...expanded.matchAll(calendar)].map(m=>({at:m.index!,end:m.index!+m[0].length,values:lessonSpokenDateValues(m[0]).map(v=>({...v,unit:v.unit==='号'?'日':v.unit}))}));
  for(const match of expanded.matchAll(new RegExp('('+numeral+')年','g'))){
    const value=number(match[1],'年');if(value&&value>=1000&&!groups.some(g=>match.index!>=g.at&&match.index!<g.end))groups.push({at:match.index!,end:match.index!+match[0].length,values:[{unit:'年',value}]});
  }
  return groups.sort((a,b)=>a.at-b.at).flatMap(g=>g.values);
}
export function assertNarrationRepairDates(baseline:NarrationDateBaseline|undefined,chapters:Chapter[],requestedAt:number):void{
  if(!baseline)return;
  for(const original of baseline.chapters){
    const matches=chapters.filter(c=>c.id===original.id);if(matches.length!==1)throw new Error('旁白修稿必须保留原章节ID：'+original.id);
    const before=narrationCalendarValues(original.narration,requestedAt),after=narrationCalendarValues(matches[0].narration,requestedAt);
    if(JSON.stringify(before)!==JSON.stringify(after))throw new Error(`章节${original.id}旁白修稿改变了已明确日期：原值${JSON.stringify(before)}；提交值${JSON.stringify(after)}。本次只修读法，不能改日期或以月底、最后一天等表达绕过。可使用相同日期的日/号及等值汉字读法，缩短周边句子。`);
  }
}
