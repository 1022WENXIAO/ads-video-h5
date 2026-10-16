import {createHash} from 'node:crypto';
import type {LessonReport,ResearchReference} from '../shared/types';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type PublishedField={chapterId:string;channel:string;text:string};
type Precision={kind:'clock'|'date'|'quantity';value:string;unit:string;start:number;end:number;zone?:string;offset?:number;role?:string;relation?:string};
export interface LessonPrecisionBaseline {version:1;id:string;fields:PublishedField[]}
export interface LessonPrecisionWitness {
  assertionId:string;referenceId:string;sourceHash:string;
  publishedQuote:string;sourceQuote:string;actorQuote:string;roleQuote:string;valueQuote:string;
}
const numeral='[零〇一二两三四五六七八九十百千万\\d]+';
function number(text:string):number|undefined{
  if(/^\d+(?:\.\d+)?$/.test(text))return Number(text);
  const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(text.includes('点')){const [a,b]=text.split('点');const left=number(a);return left!==undefined&&b&&[...b].every(c=>c in digits)?Number(left+'.'+[...b].map(c=>digits[c]).join('')):undefined;}
  if([...text].every(c=>c in digits))return Number([...text].map(c=>digits[c]).join(''));
  let total=0,part=0,digit=0;for(const char of text){if(char in digits)digit=digits[char];else if(char==='万'){total+=(part+digit)*10000;part=0;digit=0;}else {const scale=({十:10,百:100,千:1000} as Record<string,number>)[char];if(!scale)return;part+=(digit||1)*scale;digit=0;}}return total+part+digit;
}
function fields(report:LessonReport):PublishedField[]{
  return [...(report.chapters[0]?[{chapterId:report.chapters[0].id,channel:'report.title',text:report.title}]:[]),...report.chapters.flatMap(ch=>[
    {chapterId:ch.id,channel:'title',text:ch.title},{chapterId:ch.id,channel:'narration',text:ch.narration},
    {chapterId:ch.id,channel:'visual.takeaway',text:ch.visual.takeaway},
    ...ch.visual.items.flatMap((item,i)=>['label','detail'].map(key=>({chapterId:ch.id,channel:`visual.items.${i}.${key}`,text:item[key as 'label'|'detail']}))),
    ...(ch.visual.barChart&&!ch.visual.barChart.illustrative?ch.visual.barChart.bars.map((bar,i)=>({chapterId:ch.id,channel:`visual.barChart.bars.${i}`,text:`${bar.label} ${bar.value}${ch.visual.barChart!.unit}`})):[]),
  ])];
}
/** A server checkpoint of published channels, never internal claims or reviewer prose. */
export function createLessonPrecisionBaseline(report:LessonReport):LessonPrecisionBaseline{
  const payload={version:1 as const,fields:fields(report)};return {...payload,id:hash(payload)};
}
export function restoreLessonPrecisionBaseline(raw:unknown):LessonPrecisionBaseline|undefined{
  if(raw===undefined)return;
  const value=raw as LessonPrecisionBaseline;
  if(value?.version!==1||!Array.isArray(value.fields)||value.fields.length>200||value.fields.some(f=>typeof f.chapterId!=='string'||typeof f.channel!=='string'||typeof f.text!=='string'||f.text.length>20000)||value.id!==hash({version:1,fields:value.fields}))throw new Error('发表精确量基线完整性校验失败。');
  return structuredClone(value);
}
function zoneAt(text:string,start:number,end:number):{zone?:string;offset?:number}{
  // Zone belongs to this clock, not a neighbouring clock in parentheses.
  const left=text.slice(Math.max(0,start-18),start),right=text.slice(end,end+24);
  const zonePattern=/(?:UTC|GMT)(?:\s*([+-])\s*(\d{1,2})(?::(\d{2}))?)?|日本标准时间|日本標準時|JST|北京时间|BJT/gi;
  const before=[...left.matchAll(zonePattern)].filter(m=>/^[\s:：]*$/.test(left.slice(m.index!+m[0].length))).at(-1);
  const after=[...right.matchAll(zonePattern)].find(m=>/^[\s时分秒点()（）]*$/.test(right.slice(0,m.index)));
  const match=before||after;
  if(match){const label=match[0].replace(/\s/g,'').toUpperCase();const offset=/JST|日本/.test(label)?540:/BJT|北京/.test(label)?480:match[1]?(match[1]==='-'?-1:1)*(Number(match[2])*60+Number(match[3]||0)):0;if(Math.abs(offset)>14*60||Number(match[3]||0)>59)return{};return{zone:label,offset};}
  const local=/([\p{Script=Han}A-Za-z]{2,20})(?:当地时间|当地)|当地时间|local time/iu.exec(left.slice(-24)+right.slice(0,18));
  return local?{zone:local[0]}:{};
}
function quantityRelation(text:string,start:number,end:number){
  const before=text.slice(Math.max(0,start-24),start),after=text.slice(end,end+24);
  const rangeNumber=`${numeral}(?:[点.]${numeral})?`;
  if(new RegExp(`${rangeNumber}(?:千米|公里|厘米|毫米|米|千克|公斤|克|元|秒|小时|个)?\\s*(?:到|至|[—–～~\\-])\\s*$`).test(before)||new RegExp(`^\\s*(?:到|至|[—–～~\\-])\\s*${rangeNumber}`).test(after)||/(?:[−-]|负)\s*$/.test(before))return 'unsupported-range';
  const match=/(至少|不低于|不少于|大于|超过|最多|至多|不超过|小于|不足|约|大约|近|[≥≤><])\s*$/.exec(before)?.[1];
  return match?({至少:'gte',不低于:'gte',不少于:'gte',大于:'gt',超过:'gt',最多:'lte',至多:'lte',不超过:'lte',小于:'lt',不足:'lt',约:'approx',大约:'approx',近:'near','≥':'gte','≤':'lte','>':'gt','<':'lt'} as Record<string,string>)[match]:'exact';
}
function precisions(text:string):Precision[]{
  const out:Precision[]=[];
  const add=(kind:Precision['kind'],m:RegExpMatchArray,value:string,unit:string)=>{const start=m.index!,end=start+m[0].length;if(out.some(p=>start<p.end&&end>p.start))return;out.push({kind,value,unit,start,end,...(kind==='clock'?zoneAt(text,start,end):{})});};
  for(const m of text.matchAll(/(?<![\d.])([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?![\d.])/g))add('clock',m,String(Number(m[1])*3600+Number(m[2])*60+Number(m[3]||0)),'second-of-day');
  for(const m of text.matchAll(new RegExp(`(${numeral})(?:点|时)(${numeral})(?:分)?(?:(${numeral})秒)?`,'g'))){const tail=text.slice(m.index!+m[0].length),head=text.slice(Math.max(0,m.index!-16),m.index);if(/^(?:级|倍|元|米|克|个|份|批|版|模型|版本|％|%)/.test(tail)||/[A-Za-z0-9]$/.test(head)||/(?:版本|型号)\s*$/.test(head))continue;const h=number(m[1]),min=number(m[2]),s=number(m[3]||'0');if(h!==undefined&&h<=23&&min!==undefined&&min<60&&s!==undefined&&s<60)add('clock',m,String(h*3600+min*60+s),'second-of-day');}
  for(const m of text.matchAll(/(?<!\d)([0-2]\d)([0-5]\d)(?=\s*(?:GMT|UTC|JST|BJT)(?![A-Za-z]))/g)){if(Number(m[1])<24)add('clock',m,String(Number(m[1])*3600+Number(m[2])*60),'second-of-day');}
  for(const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g))add('date',m,`${Number(m[1])}-${Number(m[2])}-${Number(m[3])}`,'date');
  for(const m of text.matchAll(new RegExp(`(?:(${numeral})年)?(${numeral})月(${numeral})日`,'g'))){const values=m.slice(1).map(v=>v?number(v):undefined);if(values[1]!==undefined&&values[2]!==undefined)add('date',m,values.map(v=>v??'').join('-'),'date');}
  const units='千米|公里|厘米|毫米|米|千克|公斤|毫克|克|万元|亿元|元|小时|分钟|秒|毫升|升|摄氏度|度|级|台|份|批|人|个|倍|%|％';
  for(const m of text.matchAll(new RegExp(`(${numeral}(?:[点.]${numeral})?)\\s*(${units})`,'g'))){const value=number(m[1]);if(value!==undefined){add('quantity',m,String(value),m[2]);const p=out.find(p=>p.start===m.index&&p.kind==='quantity');if(p){p.relation=quantityRelation(text,p.start,p.end);if(m[2]==='级'){const prefix=text.slice(Math.max(0,m.index!-8),m.index);p.role=/震度|烈度/.test(prefix)?'intensity':/震级|magnitude/i.test(prefix)||/^地震/.test(text.slice(p.end))?'magnitude':undefined;}}}}
  return out.sort((a,b)=>a.start-b.start);
}
const signature=(p:Precision)=>`${p.kind}:${p.value}:${p.unit}:${p.zone||''}:${p.role||''}:${p.relation||''}`;
function assertions(report:LessonReport,baseline:LessonPrecisionBaseline|undefined){
  if(!baseline)return[];
  const old=restoreLessonPrecisionBaseline(baseline)!;
  const prior=new Map<string,Set<string>>();for(const field of old.fields){const set=prior.get(field.chapterId)||new Set<string>();for(const p of precisions(field.text))set.add(signature(p));prior.set(field.chapterId,set);}
  return fields(report).flatMap(field=>{
    const chapter=report.chapters.find(ch=>ch.id===field.chapterId)!;
    // Built-in classroom calculations retain the existing formula/fact review;
    // they cannot honestly supply an external source quotation. This exception
    // never covers a clock/date, a news report, or a source/synthesis claim.
    const calculationOnly=!report.hotResearch&&chapter.claims.length>0&&chapter.claims.every(claim=>claim.basis==='calculation'&&claim.referenceIds.length===0&&typeof claim.explanation==='string'&&claim.explanation.trim().length>0);
    return precisions(field.text).filter(p=>!(p.kind==='quantity'&&calculationOnly)&&!prior.get(field.chapterId)?.has(signature(p))).map(p=>({...field,precision:p,id:hash({baseline:old.id,...field,precision:p})}));
  });
}
export function lessonPrecisionSourceHash(ref:ResearchReference){return hash({id:ref.id,url:ref.url,title:ref.title,excerpt:ref.excerpt,verification:ref.verification,publishedAt:ref.publishedAt,freshness:ref.freshness});}
export function lessonPrecisionReviewContext(report:LessonReport,baseline?:LessonPrecisionBaseline){
  const added=assertions(report,baseline);if(!added.length)return undefined;
  return {
    contract:'这是相对首次已发表稿在返修中新增或改变的精确量。旧claims、旧审查、suggestions和修复要求均不是证据。不得把审查建议升级为必讲事实；非必要精度不能核验时删除，保留保守表述。仅实际已读正文可作绑定。不得猜测跨语言主体或地点时区。新时刻必须在发表原句本身明确UTC/GMT/固定偏移/JST/日本标准时间/北京时间；单独“当地时间”不能确定归属。同值不同事件、日期、单位、震级与震度不可混用。数量的至少/最多/超过/约等紧邻关系必须保留，新增区间不由此窄绑定路径猜测。逐字actorQuote与roleQuote只证明文字绑定，不证明跨语言事件等价；存在其他来源冲突仍须findings。',
    assertions:added.slice(0,64).map(a=>({id:a.id,chapterId:a.chapterId,channel:a.channel,publishedQuote:a.text,value:a.text.slice(a.precision.start,a.precision.end),kind:a.precision.kind,unit:a.precision.unit})),
    sources:report.references.map(ref=>({referenceId:ref.id,sourceHash:lessonPrecisionSourceHash(ref),verification:ref.verification,freshness:ref.freshness,precisionPassages:precisions(ref.excerpt).slice(0,8).map(p=>({start:Math.max(0,p.start-100),quote:ref.excerpt.slice(Math.max(0,p.start-100),Math.min(ref.excerpt.length,p.end+160))}))})),
    response:'同次JSON可附precisionWitnesses:[{assertionId,referenceId,sourceHash,publishedQuote,sourceQuote,actorQuote,roleQuote,valueQuote}]。precisionPassages只是有界原文定位片段，完整原文仍在report.references；sourceQuote必须是该reference正文中唯一连续完整原句（最多700字），不能截掉否定或不确定限定。publishedQuote必须逐字等于对应assertion；actorQuote（至少2字）与roleQuote（至少2字）须在发表原句、当前绑定claim及sourceQuote都逐字出现，valueQuote是sourceQuote中含对应值及明确时区的连续原文。不能绑定则返回空数组并要求删除该非必要精度；不新增检索或调用。',
  };
}
function unique(text:string,quote:unknown,min=1,max=700):quote is string{return typeof quote==='string'&&quote.trim().length>=min&&quote.length<=max&&text.indexOf(quote)>=0&&text.indexOf(quote)===text.lastIndexOf(quote);}
function completePassage(text:string,quote:string){const start=text.indexOf(quote),before=text.slice(0,start).trimEnd(),after=text.slice(start+quote.length).trimStart();return(!before||/[。！？.!?\n]$/.test(before))&&(!after||/^[。！？.!?\n]/.test(after)||/[。！？.!?]$/.test(quote));}
const quantityUnit:Record<string,[string,number]>={'米':['length',1],'厘米':['length',.01],'毫米':['length',.001],'公里':['length',1000],'千米':['length',1000],'克':['mass',1],'千克':['mass',1000],'公斤':['mass',1000],'毫克':['mass',.001],'元':['money',1],'万元':['money',10000],'亿元':['money',100000000],'秒':['duration',1],'分钟':['duration',60],'小时':['duration',3600],'毫升':['volume',1],'升':['volume',1000],'％':['percent',1],'%':['percent',1]};
function valueEquivalent(a:Precision,b:Precision){
  if(a.kind!==b.kind)return false;
  if(a.kind==='clock')return a.offset!==undefined&&b.offset!==undefined&&Number(a.value)-a.offset*60===Number(b.value)-b.offset*60;
  if(a.kind==='quantity'){if(a.role!==b.role||a.relation!==b.relation||a.relation==='unsupported-range')return false;const x=quantityUnit[a.unit]||[a.unit,1],y=quantityUnit[b.unit]||[b.unit,1];return x[0]===y[0]&&Math.abs(Number(a.value)*x[1]-Number(b.value)*y[1])<1e-9;}
  return a.value===b.value&&a.unit===b.unit;
}
/** Derived hard findings; raw reviewer score, response, and source bytes remain untouched. */
export function lessonPrecisionEvidenceFindings(report:LessonReport,baseline:LessonPrecisionBaseline|undefined,rawWitnesses:unknown):string[]{
  const added=assertions(report,baseline);if(!added.length)return[];
  const witnesses=Array.isArray(rawWitnesses)&&rawWitnesses.length<=128?rawWitnesses:[];
  const failures:string[]=[];
  for(const a of added.slice(0,64)){
    const bound=witnesses.filter(w=>w&&w.assertionId===a.id);let valid=false;
    if(bound.length===1){const w=bound[0] as LessonPrecisionWitness,ch=report.chapters.find(c=>c.id===a.chapterId)!,refs=report.references.filter(r=>r.id===w.referenceId),ref=refs[0];
      if(refs.length===1&&ch.referenceIds.includes(ref.id)&&ch.claims.some(c=>c.referenceIds.includes(ref.id)&&c.text.includes(w.actorQuote)&&c.text.includes(w.roleQuote))&&ref.verification!=='search-cited'&&!['stale','future'].includes(ref.freshness||'')&&w.sourceHash===lessonPrecisionSourceHash(ref)&&w.publishedQuote===a.text&&unique(ref.excerpt,w.sourceQuote)&&completePassage(ref.excerpt,w.sourceQuote)&&unique(w.sourceQuote,w.valueQuote)&&unique(a.text,w.actorQuote,2,80)&&unique(w.sourceQuote,w.actorQuote,2,80)&&unique(a.text,w.roleQuote,2,80)&&unique(w.sourceQuote,w.roleQuote,2,80)&&w.actorQuote!==w.roleQuote&&!/未核实|未经核实|传言|网传|据传|并非|不是|否认|not confirmed|unverified|rumou?r/i.test(w.sourceQuote)){
        const sourceValues=precisions(w.sourceQuote).filter(p=>p.start>=w.sourceQuote.indexOf(w.valueQuote)&&p.end<=w.sourceQuote.indexOf(w.valueQuote)+w.valueQuote.length);
        // Exactly one matching semantic slot: no picking a convenient value from a list.
        const publishedDates=precisions(a.text).filter(p=>p.kind==='date'),sourceDates=precisions(w.sourceQuote).filter(p=>p.kind==='date');
        const datesAgree=(!publishedDates.length&&!sourceDates.length)||(publishedDates.length===1&&sourceDates.length===1&&valueEquivalent(publishedDates[0],sourceDates[0]));
        // Offset conversion that crosses midnight needs a complete date proof,
        // which this narrow path deliberately does not infer.
        valid=sourceValues.length===1&&valueEquivalent(a.precision,sourceValues[0])&&(a.precision.kind==='clock'?datesAgree:!publishedDates.length||!sourceDates.length||datesAgree);
      }
    }
    if(!valid)failures.push(`${a.chapterId}：新增发表精确量绑定核验未通过（precision-evidence），${a.channel}原句「${a.text.slice(0,260)}」，新增「${a.text.slice(a.precision.start,a.precision.end)}」；旧审核建议不能作来源，省略不必要精确量或明确当前正文所支持的主体、事件与时区/单位后再审。`);
  }
  if(added.length>64)failures.push(`${added[64].chapterId}：新增发表精确量超过有界核验范围（precision-evidence）；保守删减新增精度后再审。`);
  return [...new Set(failures)];
}
