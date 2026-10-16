import type {LessonReport,LessonBarChart,ResearchReference} from '../shared/types';
import {lessonPrecisionSourceHash} from './lessonEvidenceConcordance';

type Evidence=NonNullable<LessonBarChart['bars'][number]['evidence']>;
export interface LessonBarBinding {chapterId:string;barIndex:number;referenceId:string;sourceHash:string;sourceQuote:string;operation:NonNullable<Evidence['operation']>}
const compact=(s:string)=>s.replace(/\s/g,'');
const one=(s:string,part:string)=>Boolean(part)&&s.indexOf(part)>=0&&s.indexOf(part)===s.lastIndexOf(part);
const unitTable:Record<string,[string,number]>={年:['year',1],year:['year',1],years:['year',1],天:['day',1],day:['day',1],days:['day',1],小时:['second',3600],分钟:['second',60],秒:['second',1],s:['second',1],ms:['second',.001],毫秒:['second',.001],米:['length',1],m:['length',1],公里:['length',1000],千米:['length',1000],km:['length',1000],厘米:['length',.01],cm:['length',.01],毫米:['length',.001],mm:['length',.001],元:['money',1],万元:['money',10000],亿元:['money',1e8],克:['mass',1],千克:['mass',1000],公斤:['mass',1000],毫克:['mass',.001],毫升:['volume',.001],升:['volume',1],'%':['percent',1],'％':['percent',1]};
const units=Object.keys(unitTable).sort((a,b)=>b.length-a.length).join('|')+'|人|个|台|份|批|分|次|件|册|辆';
const numeral='[零〇一二两三四五六七八九十百千万亿\\d]+(?:[点.][零〇一二两三四五六七八九\\d]+)?';
function number(s:string):number|undefined{
  if(/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)){
    const n=Number(s),canonical=s.includes('.')?s.replace(/0+$/,'').replace(/\.$/,''):s,places=canonical.split('.')[1]?.length||0;
    return Number.isFinite(n)&&n<=Number.MAX_SAFE_INTEGER&&places<=100&&n.toFixed(places)===canonical?n:undefined;
  }
  const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(s.includes('点')){const [a,b]=s.split('点'),n=number(a);return n!==undefined&&b&&[...b].every(c=>c in digits)?number(n+'.'+[...b].map(c=>digits[c]).join('')):undefined;}
  if(s.length===1&&s in digits)return digits[s];
  let total=0,part=0,digit=0;for(const c of s){if(c in digits)digit=digits[c];else if(c==='亿'){total=(total+part+digit)*1e8;part=0;digit=0;}else if(c==='万'){total+=(part+digit)*10000;part=0;digit=0;}else{const scale=({十:10,百:100,千:1000}as Record<string,number>)[c];if(!scale)return;part+=(digit||1)*scale;digit=0;}}
  const n=total+part+digit;
  // Never turn malformed/ambiguous source wording into an exact quantity.
  return Number.isSafeInteger(n)&&s.replace(/两/g,'二').replace(/〇/g,'零')===han(n)?n:undefined;
}
function han(n:number):string{
  if(n===0)return '零';if(n>=1e12)return '';
  const digits='零一二三四五六七八九';
  if(n>=1e8){const rest=n%1e8;return han(Math.floor(n/1e8))+'亿'+(rest?(rest<1e7?'零':'')+han(rest):'');}
  if(n>=10000){const rest=n%10000;return han(Math.floor(n/10000))+'万'+(rest?(rest<1000?'零':'')+han(rest):'');}
  let text='',zero=false;for(const [scale,unit]of [[1000,'千'],[100,'百'],[10,'十'],[1,'']]as const){const digit=Math.floor(n/scale)%10;if(digit){if(zero)text+='零';text+=digits[digit]+unit;zero=false;}else if(text&&n%scale)zero=true;}return text.replace(/^一十/,'十');
}
function normalized(value:number,unit:string){unit=unit.toLowerCase();const [dimension,factor]=unitTable[unit]||[unit,1];return {dimension,factor,sourceValue:value,value:value*factor};}
function valueOf(e:Evidence,chartUnit:string):{value:number;converted:boolean}|undefined{
  const operation=e.operation||'identity',text=compact(e.valueQuote);
  if(operation==='identity'){
    const m=new RegExp(`^(${numeral})(${units})$`,'i').exec(text);if(!m)return;
    const n=number(m[1]);if(n===undefined)return;const a=normalized(n,m[2]),b=normalized(1,chartUnit);return a.dimension===b.dimension?{value:a.factor===b.factor?n:a.value/b.value,converted:a.factor!==b.factor}:undefined;
  }
  const m=new RegExp(`^(${numeral})(${units})?(?:至|到|[—–-])(${numeral})(${units})$`,'i').exec(text);if(!m)return;
  const lo=number(m[1]),hi=number(m[3]);if(lo===undefined||hi===undefined)return;
  const a=normalized(lo,m[2]||m[4]),b=normalized(hi,m[4]),target=normalized(1,chartUnit);
  if(a.dimension!==b.dimension||a.dimension!==target.dimension)return;
  const av=a.factor===b.factor?a.sourceValue:a.value,bv=a.factor===b.factor?b.sourceValue:b.value;
  const chosen=operation==='range-min'?(av<=bv?a:b):(av>=bv?a:b);
  return {value:chosen.factor===target.factor?chosen.sourceValue:chosen.value/target.value,converted:chosen.factor!==target.factor};
}
function isClause(ref:ResearchReference,quote:string){
  if(!one(ref.excerpt,quote)||quote.length>700)return false;
  const start=ref.excerpt.indexOf(quote),end=start+quote.length;
  // Clauses may start after a comma, but a quote cannot begin/end mid-word.
  if(start&&!/[\s，,；;：:。.!?！？]/.test(ref.excerpt[start-1])||end<ref.excerpt.length&&!/[\s，,；;。.!?！？]/.test(ref.excerpt[end]))return false;
  const prior=ref.excerpt.slice(Math.max(0,start-100),start).split(/[。.!?！？;；\n]/).at(-1)||'';
  const following=ref.excerpt.slice(end,end+100).split(/[。.!?！？;；\n]/)[0];
  return !/并非|不是|并不|不等于|没有|未曾|否认|辟谣|虚假|不实|(?:消息|说法|数据|传闻)(?:有误|错误)|(?:为|是)错误|未经证实|未核实|网传|据传|疑似|可能|not\s+(?:confirmed|true)|unverified|rumou?r/i.test(prior+quote+following);
}
function validateEvidence(report:LessonReport,chapter:LessonReport['chapters'][number],chart:LessonBarChart,index:number):LessonBarBinding|undefined{
  const bar=chart.bars[index],e=bar.evidence;
  if(!e||typeof e!=='object'||Array.isArray(e))return;
  for(const [key,max]of [['referenceId',100],['sourceQuote',700],['entityQuote',80],['metricQuote',80],['valueQuote',100]]as const){if(typeof e[key]!=='string'||!e[key].trim()||e[key].length>max)return;}
  if(e.metricQuote.trim().length<2||e.sourceHash!==undefined&&!/^[a-f0-9]{64}$/.test(e.sourceHash)||e.operation!==undefined&&!['identity','range-min','range-max'].includes(e.operation))return;
  const refs=report.references.filter(r=>r.id===e.referenceId),ref=refs[0];if(refs.length!==1||!chapter.referenceIds.includes(e.referenceId)||ref.verification==='search-cited'||['future','stale'].includes(ref.freshness||''))return;
  const hash=lessonPrecisionSourceHash(ref);if(e.sourceHash!==undefined&&e.sourceHash!==hash||!isClause(ref,e.sourceQuote))return;
  if(!one(e.sourceQuote,e.entityQuote)||!one(e.sourceQuote,e.metricQuote)||!one(e.sourceQuote,e.valueQuote)||!chart.panels.every(p=>compact(p.title).includes(compact(e.metricQuote))))return;
  const operation=e.operation||'identity',owner=compact(e.entityQuote),label=compact(bar.label);
  if(operation==='identity'?label!==owner:!label.startsWith(owner)||!(operation==='range-min'?/(?:最低|最小|下限|min)$/i:/(?:最高|最大|上限|max)$/i).test(label.slice(owner.length)))return;
  // A quoted multi-owner comparison is ambiguous, even when a number matches.
  const owners=new Set(chart.bars.map(b=>b.evidence?.entityQuote||b.label));
  if([...owners].some(other=>other!==e.entityQuote&&e.sourceQuote.includes(other)))return;
  const entityAt=e.sourceQuote.indexOf(e.entityQuote),metricAt=e.sourceQuote.indexOf(e.metricQuote),valueAt=e.sourceQuote.indexOf(e.valueQuote);
  if(entityAt+e.entityQuote.length>metricAt||metricAt+e.metricQuote.length>valueAt)return;
  if(/[，,；;。.!?！？\d]/.test(e.metricQuote)||/表示|声称|介绍|转述|据称/.test(e.metricQuote))return;
  const ownerBridge=compact(e.sourceQuote.slice(entityAt+e.entityQuote.length,metricAt)),valueBridge=compact(e.sourceQuote.slice(metricAt+e.metricQuote.length,valueAt));
  if(!/^(?:的|为|是|：|:|被判|被判处|测得)?$/.test(ownerBridge)||!/^(?:为|是|：|:)?(?:人民币)?$/.test(valueBridge))return;
  if(/^[A-Za-z0-9_-]+$/.test(e.entityQuote)&&(/[A-Za-z0-9_-]/.test(e.sourceQuote[entityAt-1]||'')||/[A-Za-z0-9_-]/.test(e.sourceQuote[entityAt+e.entityQuote.length]||'')))return;
  const before=e.sourceQuote.slice(Math.max(metricAt,valueAt-16),valueAt);
  if(/至少|最多|不超过|不少于|不低于|超过|不足|至多|约|大约|近|[<>≥≤≈−-]|负/.test(before))return;
  const dimension=normalized(1,chart.unit).dimension;
  const quantities=[...e.sourceQuote.matchAll(new RegExp(`(${numeral})\\s*(${units})`,'gi'))].filter(m=>normalized(1,m[2]).dimension===dimension);
  if(operation==='identity'){
    if(quantities.length!==1||quantities[0].index!==valueAt||compact(quantities[0][0])!==compact(e.valueQuote))return;
    if(new RegExp(`${numeral}(?:${units})?\\s*(?:至|到|[—–-])\\s*$`).test(e.sourceQuote.slice(0,valueAt))||/^\s*(?:至|到|[—–-])/.test(e.sourceQuote.slice(valueAt+e.valueQuote.length)))return;
  }else if(quantities.some(m=>m.index!<valueAt||m.index!+m[0].length>valueAt+e.valueQuote.length))return;
  const value=valueOf(e,chart.unit);
  // Permit only floating-point representation error in unit conversion. A
  // fixed absolute epsilon would incorrectly turn a small positive value into
  // zero, changing the quantitative assertion even with matching source text.
  if(value===undefined||(!value.converted?value.value!==bar.value:Math.abs(value.value-bar.value)>4*Number.EPSILON*Math.max(Math.abs(value.value),Math.abs(bar.value))))return;
  // The claim ties this chapter to the owner/reference; only the continuous
  // source relation above establishes the measurement and value.
  if(!chapter.claims.some(c=>c.referenceIds.includes(ref.id)&&c.text.includes(e.entityQuote)))return;
  return {chapterId:chapter.id,barIndex:index,referenceId:ref.id,sourceHash:hash,sourceQuote:e.sourceQuote,operation};
}
export function lessonBarChartGrounding(report:LessonReport):{findings:string[];bindings:LessonBarBinding[]}{
  const findings:string[]=[],bindings:LessonBarBinding[]=[];
  for(const chapter of report.chapters){
    const chart=chapter.visual.barChart;if(!chart)continue;
    const classroom=!report.hotResearch&&chapter.claims.length>0&&chapter.claims.every(c=>c.basis==='calculation'&&c.referenceIds.length===0&&typeof c.explanation==='string'&&c.explanation.trim());
    if(classroom)continue;
    for(let i=0;i<chart.bars.length;i++){
      const binding=validateEvidence(report,chapter,chart,i);if(binding)bindings.push(binding);
      else findings.push(`${chapter.id}：来源柱图「${chart.bars[i].label} ${chart.bars[i].value}${chart.unit}」缺少同主体、测量角色、数值与单位的原文证据。illustrative或代理位置说明不能把未量化类别变成数值；提供本章真实referenceId及唯一连续sourceQuote/entityQuote/metricQuote/valueQuote，sourceHash可省略由服务器绑定，已给hash必须一致。无法量化时保留原旁白、claims和信息点原文，将visual改为comparison、移除barChart及bar-chart illustration，以普通文字卡说明未知或质性结果；不得编值或改为illustrative=true。仍须经过原事实/成片审查。`);
    }
  }
  return {findings,bindings};
}
export function bindLessonBarChartEvidence(report:LessonReport):LessonReport{
  const checked=lessonBarChartGrounding(report);if(checked.findings.length)throw new Error(checked.findings.join('\n'));
  const next=structuredClone(report);for(const binding of checked.bindings)next.chapters.find(c=>c.id===binding.chapterId)!.visual.barChart!.bars[binding.barIndex].evidence!.sourceHash=binding.sourceHash;return next;
}
