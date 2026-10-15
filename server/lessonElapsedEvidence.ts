import type {LessonReport,ResearchReference} from '../shared/types';

type Range={lo:number;hi:number};
type Day={value:number;label:string;year?:number};
type Clock=Range&{start:number;end:number;raw:string;day:Day};
type Duration=Range&{start:number;end:number;raw:string;subject:string};
type Conflict={referenceId:string;day:Day;subject:string;range:Range;quote:string;historical:boolean};
const numeral='[0-9零〇一二两三四五六七八九十百]';
const trusted=new Set(['news-page','primary-page','primary-record','primary-paper','public-page']);
const daySeconds=86400;
const number=(text:string):number=>{
  text=text.replace(/〇/g,'零').replace(/两/g,'二');
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text);
  const digits='零一二三四五六七八九';
  if(!/[十百]/.test(text))return [...text].every(c=>digits.includes(c))?Number([...text].map(c=>digits.indexOf(c)).join('')):NaN;
  let total=0,pending=0;
  for(const char of text){if(digits.includes(char))pending=digits.indexOf(char);else if(char==='十'||char==='百'){total+=(pending||1)*(char==='十'?10:100);pending=0;}else return NaN;}
  return total+pending;
};
const clauseStart=(text:string,at:number)=>{
  const prefix=text.slice(0,at),matches=[...prefix.matchAll(/[，,。；;！？!?\n]|但是|然而|不过|而是|但|却/g)];
  return matches.length?matches.at(-1)!.index!+matches.at(-1)![0].length:0;
};
const sentenceAround=(text:string,at:number)=>{
  const separators=/[。；;！？!?\n]|但是|然而|不过|而是|但|却/g,parts=[...text.matchAll(separators)];
  const before=parts.filter(m=>m.index!<at).at(-1),after=parts.find(m=>m.index!>=at);
  return text.slice(before?before.index!+before[0].length:0,after?.index??text.length);
};
const denied=(prefix:string)=>/(?:并非|并不是|不是|没有|尚未|未曾|不曾|未|不)(?:已经|已|曾|真的)?\s*$/.test(prefix)
  ||/(?:不能|无法|没有|未能|尚未|未)(?:证明|证实|确认|认定|表明|断言|说明|称|说)[^，,。；;！？!?]{0,28}$/.test(prefix);
const subject=(prefix:string)=>prefix.replace(/^.*(?:称|表示|报道|信息[：:])/,'').replace(/^(?:据|本次|此次|这次|该次|该|本轮|这场|本场|同一|相关)/,'').replace(/(?:已经|已|确实|确|仍然|仍|总共|累计|一共|持续|时长|于|在|自|从|北京时间|上午|早上|下午|晚上|凌晨|\s)+$/g,'').trim();
const sameSubject=(a:string,b:string)=>!a||!b||a===b;

function dates(text:string):Array<{at:number;end:number;day?:Day;offset?:number}>{
  const out:Array<{at:number;end:number;day?:Day;offset?:number}>=[];
  const add=(match:RegExpMatchArray,year:number|undefined,month:number,day:number,label:string)=>{
    const value=Date.UTC(year??2000,month-1,day)/1000,d=new Date(value*1000);
    if(Number.isFinite(value)&&month>=1&&month<=12&&day>=1&&day<=31&&d.getUTCMonth()===month-1&&d.getUTCDate()===day)out.push({at:match.index!,end:match.index!+match[0].length,day:{value,label,year}});
  };
  for(const m of text.matchAll(new RegExp(`(?:(\\d{4})年)?(${numeral}{1,3})月(${numeral}{1,3})[日号]`,'g')))add(m,m[1]?Number(m[1]):undefined,number(m[2]),number(m[3]),m[0]);
  for(const m of text.matchAll(/((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})/g))add(m,Number(m[1]),Number(m[2]),Number(m[3]),m[0]);
  for(const m of text.matchAll(/次日|翌日|第二天|昨天|昨日|昨晚|今天|今日|今早|今晨|当天|当日|同日/g))out.push({at:m.index!,end:m.index!+m[0].length,offset:/次日|翌日|第二天/.test(m[0])?1:/^昨/.test(m[0])?-1:0});
  return out.sort((a,b)=>a.at-b.at);
}
function dayAt(text:string,at:number,carry?:Day):Day|undefined{
  let value=carry,anchor=carry;
  for(const date of dates(text).filter(date=>date.end<=at)){
    if(date.day){value=date.day;if(value.year===undefined&&anchor?.year!==undefined){const d=new Date(value.value*1000);value={...value,value:Date.UTC(anchor.year,d.getUTCMonth(),d.getUTCDate())/1000,year:anchor.year};}anchor=value;}
    else if(date.offset!==undefined){
      if(date.offset===1){value={value:(value?.value??0)+daySeconds,label:(value?.label||'同段起点')+'次日',year:value?.year};}
      else value={value:(anchor?.value??0)+date.offset*daySeconds,label:date.offset===-1?'同段昨日':anchor?.label||'同段今日',year:anchor?.year};
    }
  }
  return value;
}
function withoutDates(text:string):string{
  for(const date of dates(text).reverse())text=text.slice(0,date.at)+text.slice(date.end);
  return text.replace(/北京时间|UTC(?:[+-]\d{1,2})?|GMT(?:[+-]\d{1,2})?|上午|早上|下午|晚上|凌晨|\s/g,'');
}
function clocks(text:string,carry?:Day):Clock[]{
  const found:Clock[]=[];
  const add=(m:RegExpMatchArray,hour:number,minute:number|undefined,second:number|undefined)=>{
    if(!Number.isFinite(hour)||hour<0||hour>23||minute!==undefined&&(!Number.isFinite(minute)||minute<0||minute>59)||second!==undefined&&(!Number.isFinite(second)||second<0||second>59))return;
    const day=dayAt(text,m.index!,carry);if(!day)return;
    const prefix=text.slice(clauseStart(text,m.index!),m.index!);
    const periods=[...prefix.matchAll(/下午|晚上|晚间|中午|凌晨|上午|早上/g)],period=periods.at(-1)?.[0];
    if(period&&/下午|晚上|晚间|中午/.test(period)&&hour<12)hour+=12;
    if(period==='凌晨'&&hour===12)hour=0;
    const lo=day.value+hour*3600+(minute||0)*60+(second||0),precision=second!==undefined?1:minute!==undefined?60:3600;
    found.push({start:m.index!,end:m.index!+m[0].length,raw:m[0],day,lo,hi:lo+precision});
  };
  for(const m of text.matchAll(/(?<!\d)(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?(?!\d)/g))add(m,Number(m[1]),Number(m[2]),m[3]===undefined?undefined:Number(m[3]));
  for(const m of text.matchAll(new RegExp(`(${numeral}{1,3})(?:点|时)(半|${numeral}{1,3}分?)?(?:(${numeral}{1,3})秒)?`,'g')))add(m,number(m[1]),m[2]?m[2]==='半'?30:number(m[2].replace(/分$/,'')):undefined,m[3]===undefined?undefined:number(m[3]));
  return found.sort((a,b)=>a.start-b.start);
}
function durations(text:string):Duration[]{
  const result:Duration[]=[];
  const pattern=new RegExp(`(?<![\\d.])((?:\\d+(?:\\.\\d+)?|${numeral}{1,5}))(?:个)?(半|多|余|\\+)?(小时|分钟|秒钟|秒)(?:(${numeral}{1,3})(分钟|秒钟|秒))?`,'g');
  for(const m of text.matchAll(pattern)){
    const before=text.slice(clauseStart(text,m.index!),m.index!),after=text.slice(m.index!+m[0].length),predicate=[...before.matchAll(/持续|历时|耗时|用时|时长|已(?:超过|超|逾|达)|超过|超|逾/g)].at(-1);
    if(!predicate||before.length-predicate.index!-predicate[0].length>14)continue;
    const prefix=before.slice(0,predicate.index!),qualifier=before.slice(predicate.index!+predicate[0].length);
    if(denied(prefix)||/约|大约|近|将近|左右|上下/.test(qualifier)||/^(?:左右|上下)/.test(after))continue;
    if(/^[”」"]?(?:的说法|这一说法)(?:不实|错误|(?:未|尚未|未经|无法|不能)(?:核实|证实|确认))/.test(after))continue;
    const unit=m[3]==='小时'?3600:m[3]==='分钟'?60:1,subunit=m[5]==='分钟'?60:1;
    const value=number(m[1])*unit+(m[4]?number(m[4])*subunit:0)+(m[2]==='半'?unit/2:0);
    if(!Number.isFinite(value)||value<0)continue;
    let lo=value,hi=value+(m[4]?subunit:m[1].includes('.')?unit/10**m[1].split('.')[1].length:unit);
    if(/不少于|不低于|至少/.test(qualifier))hi=Infinity;
    else if(/不足|不到|少于|不超过|不多于|至多|最多/.test(qualifier)){lo=0;hi=value+(/不超过|不多于|至多|最多/.test(qualifier)?1:0);}
    else if(m[2]==='多'||m[2]==='余'||m[2]==='+'||/超过|多于|至少|不低于|逾/.test(qualifier)||/超过|超|逾/.test(predicate[0]))hi=Infinity;
    else if(/恰好|正好|整整|精确/.test(qualifier))hi=value+1;
    result.push({start:m.index!,end:m.index!+m[0].length,raw:m[0],lo,hi,subject:subject(prefix)});
  }
  return result;
}
const disjoint=(a:Range,b:Range)=>a.hi<=b.lo||b.hi<=a.lo;
const sameDay=(a:Day,b:Day)=>{
  if(a.year!==undefined&&b.year!==undefined)return a.value===b.value;
  const x=new Date(a.value*1000),y=new Date(b.value*1000);return x.getUTCMonth()===y.getUTCMonth()&&x.getUTCDate()===y.getUTCDate();
};
function acknowledgedConflict(text:string,at:number):boolean{
  const sentence=sentenceAround(text,at);
  return /来源|原文|报道|媒体/.test(sentence)&&/(?:内部|起止|起点|开始|启动|时间点|时刻)[^。；;！？!?]{0,28}(?:矛盾|不一致|对不上|不相符)/.test(sentence)
    &&/(?:时长|持续时间|该数字|该时长|这(?:一|个)?时长)[^。；;！？!?]{0,12}(?:未|尚未|未经|无法|不能)[^。；;！？!?]{0,4}(?:核实|证实|确认)/.test(sentence);
}
function sourceConflicts(reference:ResearchReference):Conflict[]{
  const source=reference.excerpt.replace(/<\/(?:p|section|article|li)>/gi,'\n').replace(/<p(?:\s[^>]*)?>/gi,'\n').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ');
  const blocks=source.split(/\n+/).map(s=>s.trim()).filter(Boolean),result:Conflict[]=[];let carry:Day|undefined;
  for(const block of blocks){
    const contextual=/本次|此次|该次|当日|当天|同日/.test(block)?carry:undefined;
    const cs=clocks(block,contextual),ds=durations(block);
    const starts=cs.filter(clock=>{
      const prefix=block.slice(clauseStart(block,clock.start),clock.start),suffix=block.slice(clock.end,clock.end+18);
      const lead=prefix.replace(/(?:于|在|自|从)?(?:北京时间|UTC(?:[+-]\d{1,2})?|上午|早上|下午|晚上|凌晨)?$/,'');
      return !denied(lead)&&(/^(?:启动|开始|起|发生|出现|发现)/.test(suffix)||/(?:开始|启动|发生|发现|始于|起于)(?:于|在)?(?:北京时间)?$/.test(prefix)||/(?:从|自)(?:北京时间)?$/.test(prefix)&&/^(?:到|至|起)/.test(suffix));
    });
    const ends=cs.filter(clock=>/(?:截至|截止|直到|到|至)(?:记者)?$/.test(withoutDates(block.slice(clauseStart(block,clock.start),clock.start))));
    // Multiple starts or endpoints are different/ambiguous frames. Do not
    // choose the pair that happens to make the statement look inconsistent.
    if(starts.length===1&&ends.length===1&&starts[0].start<ends[0].start&&!/当地时间/.test(block)){
      const start=starts[0],end=ends[0],timeZones=[...new Set(block.match(/北京时间|UTC(?:[+-]\d{1,2})?|GMT(?:[+-]\d{1,2})?/g)||[])];
      const origin=subject(block.slice(clauseStart(block,start.start),start.start).replace(/(?:开始|启动|发生|发现|始于|起于)(?:于|在)?$/,''));
      const range={lo:Math.max(0,end.lo-start.hi),hi:end.hi-start.lo};
      if(timeZones.length<=1&&range.hi>0&&end.lo>=start.lo)for(const duration of ds){
        if(duration.start<end.end||duration.start-start.start>420||!sameSubject(origin,duration.subject)||!disjoint(range,duration)||acknowledgedConflict(block,duration.start))continue;
        result.push({referenceId:reference.id,day:start.day,subject:duration.subject||origin,range,quote:block.slice(Math.max(0,start.start-45),Math.min(block.length,duration.end+2)),historical:/此前|上次|上一次|上一轮|历史|去年|上月/.test(block.slice(0,duration.start))});
      }
    }
    const latest=dayAt(block,block.length,carry);if(latest)carry=latest;
  }
  return result;
}

/** A narrow arithmetic veto for a currently asserted duration from an
 * internally inconsistent, actually linked source event. It never guesses a
 * request date, changes source text, or accepts a complete factual review. */
export function lessonElapsedEvidenceFindings(report:LessonReport):string[]{
  const conflicts=new Map<string,Conflict[]>();
  for(const reference of report.references||[]){
    if(!trusted.has(reference.verification||'')||report.references.filter(r=>r.id===reference.id).length!==1)continue;
    conflicts.set(reference.id,sourceConflicts(reference));
  }
  const findings:string[]=[];
  for(const chapter of report.chapters||[]){
    const linked=new Set((chapter.claims||[]).flatMap(claim=>claim.referenceIds||[]).filter(id=>chapter.referenceIds?.includes(id)));
    if(!linked.size)continue;
    const surfaces=[['旁白',chapter.narration],['标题',chapter.title],['图解结论',chapter.visual.takeaway],...chapter.visual.items.flatMap(item=>[['图解标签',item.label],['图解文字',item.detail],...(/^(?:持续)?时长$/.test(item.label)?[['图解时长',item.label+'：'+item.detail]]:[])]),...chapter.claims.map(claim=>['事实声明',claim.text,claim.referenceIds.filter(id=>linked.has(id))])] as Array<[string,string,string[]?]>;
    for(const [kind,text,referenceIds]of surfaces)for(const duration of durations(text))for(const id of referenceIds??linked)for(const conflict of conflicts.get(id)||[]){
      const day=dayAt(text,duration.start),historic=/此前|上次|上一次|上一轮|历史|去年|上月/.test(text.slice(0,duration.start));
      if(day&&!sameDay(day,conflict.day)||historic&&!conflict.historical||!sameSubject(duration.subject,conflict.subject)||!disjoint(duration,conflict.range)||acknowledgedConflict(text,duration.start))continue;
      const bound=Math.ceil(conflict.range.hi/60);
      findings.push(`${chapter.id}：本版${kind}「${text.slice(0,220)}」仍断言与同一来源起止时间不相容的持续时长。来源${id}实际原句「${conflict.quote.slice(0,260)}」；按其明确日期/同日上下文与时间精度保守计算，上界不足${bound}分钟，不能支持「${duration.raw}」。来源本身的算术矛盾不能用无来源的统计口径或媒体归因解除；须删去错误时长，或明确来源时间点与时长矛盾且该时长未经核实，或补充真实起算依据。`);
    }
  }
  return [...new Set(findings)].slice(0,12);
}

/** Arithmetic vetoes require correcting the current assertion, not fetching
 * the same source again. Keep unrelated source gaps eligible for research. */
export function lessonSourceResearchFeedback(report:LessonReport,findings:string[]):string{
  const arithmetic=new Set(lessonElapsedEvidenceFindings(report));
  return findings.filter(finding=>!arithmetic.has(finding)).join('；');
}
