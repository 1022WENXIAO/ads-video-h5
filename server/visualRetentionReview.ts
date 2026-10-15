import { createHash } from 'node:crypto';
import type { EditPlan, RenderReview, VisualRetentionCheck } from '../shared/types';
export type { VisualRetentionCheck } from '../shared/types';
export interface VisualRetentionRequirement { id:string; quote:string }
export interface VisualRetentionAttempt { score:number|null; checks?:VisualRetentionCheck[]; error?:string }
export interface VisualRetentionSourceContext {
  frames:Array<{sourceId:string;sourceTime:number;sourceHash:string}>;
  selectedRanges:Array<{sourceId:string;start:number;end:number}>;
}
export class VisualRetentionReviewError extends Error {
  readonly attempts?:VisualRetentionAttempt[];
  constructor(message:string,options?:{cause?:unknown;attempts?:VisualRetentionAttempt[]}){super(message,options);this.name='VisualRetentionReviewError';this.attempts=options?.attempts;}
}

/** Narrow positive visual-retention clauses, preserving quoted punctuation and
 * exact request text. This is not an all-purpose intent/obligation classifier. */
export function extractVisualRetentionRequirements(prompt:string):VisualRetentionRequirement[]{
  const clauses:string[]=[];let start=0,closing='';
  const quotes:Record<string,string>={'“':'”','「':'」','『':'』','"':'"'};
  for(let i=0;i<prompt.length;i++){
    const char=prompt[i];if(closing){if(char===closing)closing='';continue;}
    if(quotes[char]){closing=quotes[char];continue;}
    if(/[，,。！？!?；;\n]/.test(char)){clauses.push(prompt.slice(start,i).trim());start=i+1;}
  }
  clauses.push(prompt.slice(start).trim());
  const found:VisualRetentionRequirement[]=[];
  for(const quote of clauses){
    if(!/画面|标签|标注|图解|图形|视觉|(?:已有|原有).{0,20}表达|\b(?:visual|footage|image|frame|label|annotation|on[- ]screen)\b/i.test(quote))continue;
    let outside='',end='';for(const char of quote){if(end){outside+=' '.repeat(char.length);if(char===end)end='';}else if(quotes[char]){end=quotes[char];outside+=' ';}else outside+=char;}
    const verbs=[...outside.matchAll(/保留|留着|留住|\b(?:keep|retain|preserve)\b/gi)];
    const positive=verbs.some(match=>!/(?:不(?:要|用|必|需要|想)?|无需|别|禁止|勿)(?:(?:完整|全部|一直|继续|再)\s*)*\s*$|(?:不要|别|无需|不必)把[^并且但却而]{0,80}$|(?:不要|无需|别|不必)在[^并且但却而]{0,40}$|\b(?:do\s+not|don't|never|no\s+need\s+to)\s*(?:(?:fully|completely|always)\s*)?$/i.test(outside.slice(0,match.index)));
    if(!positive)continue;
    if(quote.length>600||found.length>=24)throw new VisualRetentionReviewError('明确视觉保留要求超过有界核验范围，不能静默丢弃。');
    found.push({id:'visual-retention-'+createHash('sha256').update(`${found.length}:${quote}`).digest('hex').slice(0,16),quote});
  }
  return found;
}
export function parseVisualRetentionChecks(value:unknown):VisualRetentionCheck[]|undefined{
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length>24)throw new VisualRetentionReviewError('视觉保留核验必须为最多24项的数组。');
  return value.map(item=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw new VisualRetentionReviewError('视觉保留核验项格式无效。');
    const v=item as Record<string,unknown>;
    if(typeof v.id!=='string'||!v.id.trim()||v.id.length>100||typeof v.quote!=='string'||!v.quote.trim()||v.quote.length>600||!['met','unmet','unverified'].includes(String(v.status))||!Array.isArray(v.frameTimes)||v.frameTimes.length>32||v.frameTimes.some(t=>typeof t!=='number'||!Number.isFinite(t)||t<0)||new Set(v.frameTimes).size!==v.frameTimes.length||typeof v.detail!=='string'||!v.detail.trim()||v.detail.length>600)throw new VisualRetentionReviewError('视觉保留核验缺少有效id、原句、状态、实际抽帧秒数或观察说明。');
    const source=v.sourceEvidence as Record<string,unknown>|undefined;
    if(source!==undefined&&(!source||typeof source!=='object'||Array.isArray(source)||typeof source.sourceId!=='string'||!source.sourceId||source.sourceId.length>120||typeof source.time!=='number'||!Number.isFinite(source.time)||source.time<0))throw new VisualRetentionReviewError('视觉保留原素材观察格式无效。');
    return {id:v.id,quote:v.quote,status:v.status as VisualRetentionCheck['status'],frameTimes:v.frameTimes as number[],detail:v.detail,...(source?{sourceEvidence:{sourceId:source.sourceId as string,time:source.time as number}}:{})};
  });
}
export function bindVisualRetentionSources(checks:VisualRetentionCheck[]|undefined,context?:VisualRetentionSourceContext):VisualRetentionCheck[]|undefined{
  return checks?.map(check=>{
    const {sourceOmitted:_untrusted,sourceEvidence,...base}=check;
    if(!sourceEvidence)return base;
    const frame=context?.frames.find(f=>f.sourceId===sourceEvidence.sourceId&&f.sourceTime===sourceEvidence.time);
    if(!frame||!/^[a-f0-9]{64}$/.test(frame.sourceHash))throw new VisualRetentionReviewError('视觉保留原素材证据未绑定本次实际源抽帧。');
    const ranges=context!.selectedRanges.filter(r=>r.sourceId===frame.sourceId);
    if(!ranges.length||ranges.some(r=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.end<=r.start))throw new VisualRetentionReviewError('视觉保留原素材证据未绑定实际选片范围。');
    const omitted=check.status==='unmet'&&ranges.every(r=>frame.sourceTime<r.start||frame.sourceTime>=r.end);
    return {...base,sourceEvidence:{sourceId:frame.sourceId,time:frame.sourceTime,sourceHash:frame.sourceHash},...(omitted?{sourceOmitted:true as const}:{})};
  });
}
export function visualRetentionFindings(checks:VisualRetentionCheck[]|undefined,requirements:VisualRetentionRequirement[]=[],actualFrameTimes:number[]=[]):string[]{
  if(!requirements.length){if(checks?.length)throw new VisualRetentionReviewError('视觉保留核验没有绑定原始请求要求。');return [];}
  if(!checks||checks.length!==requirements.length)throw new VisualRetentionReviewError('视觉保留核验缺项，必须逐项返回全部原始要求。');
  const ids=new Set<string>(),findings:string[]=[];
  for(const check of checks){
    const required=requirements.find(r=>r.id===check.id);
    if(!required||required.quote!==check.quote||ids.has(check.id))throw new VisualRetentionReviewError('视觉保留核验id或原句不符、未知或重复。');
    ids.add(check.id);
    if(check.frameTimes.some(time=>!actualFrameTimes.includes(time))||check.status!=='unverified'&&!check.frameTimes.length)throw new VisualRetentionReviewError('视觉保留核验必须绑定本次实际抽帧，满足或确定未满足不能没有画面证据。');
    if(check.status!=='met')findings.push(`用户明确视觉保留要求${check.status==='unmet'?'未满足':'未验证'}「${check.quote}」：${check.detail}${check.sourceOmitted?'；实际原素材见证位于选片之外，须重新选择包含该原有画面的真实片段，不能只改叙事理由。':check.status==='unmet'?'；必须修复该明确要求，不能只改叙事理由。':'；保留真实未验证状态，不能假定满足或伪造缺失。'}`);
  }
  return findings;
}
export function visualRetentionReviewInstruction(requirements:VisualRetentionRequirement[]):string{
  if(!requirements.length)return '';
  return '\n以下是从原始请求保留的明确视觉保留要求，必须逐项核对全部并返回visualRetentionChecks:[{id,quote,status:"met"|"unmet"|"unverified",frameTimes:[本次成片实际抽帧秒数],detail:"实际可见证据或具体缺失/不确定原因",sourceEvidence?:{sourceId:"实际原素材ID",time:实际原素材抽帧秒数}}]。id与quote逐字使用下列值，每项恰一次。只保留主题大意或原声句子不等于保留用户点名的原有画面表达。met与unmet均须至少一张本次真实成片帧，不能把原素材帧当成片已保留。原素材帧明确显示所要求内容时，用sourceEvidence定位；不自报哈希或sourceOmitted。若内容已选入却被挡住，指出画面问题，不捏造成源片段未选入。未看到且证据不足返回unverified，确认未保留返回unmet。任一unmet/unverified都不能通过，即使评分80以上；原分保留，不能提分冲抵遗漏。这是模型对实际帧的观察，不是机器像素识别证明。要求：'+JSON.stringify(requirements);
}
/** Only a bound explicit omission authorizes source reselection. Uncertainty
 * remains a review failure, not a claim that material is absent. */
export function visualRetentionSelectionNeeded(review:RenderReview,prompt:string,plan:EditPlan):boolean{
  if(review.status==='passed')return false;
  try{
    const requirements=extractVisualRetentionRequirements(prompt),checks=parseVisualRetentionChecks(review.semantic?.visualRetentionChecks);
    if(!requirements.length||!checks||checks.length!==requirements.length||new Set(checks.map(c=>c.id)).size!==checks.length)return false;
    if(checks.some(check=>!requirements.some(r=>r.id===check.id&&r.quote===check.quote)||check.status!=='unverified'&&!check.frameTimes.length))return false;
    return checks.some((check,i)=>{
      const trusted=review.semantic!.visualRetentionChecks![i],source=trusted.sourceEvidence;
      if(check.status!=='unmet'||trusted.sourceOmitted!==true||!source||!source.sourceHash)return false;
      const ranges=plan.clips.filter(c=>c.sourceId===source.sourceId);
      return Boolean(plan.editorial?.scenes.some(s=>s.sourceId===source.sourceId&&s.sourceHash===source.sourceHash))&&ranges.length>0&&ranges.every(c=>source.time<c.start||source.time>=c.end);
    });
  }catch{return false;}
}
