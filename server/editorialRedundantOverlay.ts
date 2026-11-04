import type {EditPlan,NarrativeScript,RenderReview} from '../shared/types';
import {extractVisualRetentionRequirements,parseVisualRetentionChecks} from './visualRetentionReview';

/** Narrow edit permission, not acceptance: remove only a uniquely quoted
 * generated overlay observed on real sampled frames while every original
 * visual-retention requirement is already met. A NEW movie must be reviewed. */
export function redundantOverlayRepair(review:RenderReview,prompt:string,plan:EditPlan,script:NarrativeScript):{script:NarrativeScript;removed:Array<{sceneId:string;label:string}>}|undefined{
  if(review.status!=='needs-review'||!review.semantic||!plan.motions?.length)return;
  const failed=review.checks.filter(c=>!c.passed),findings=review.semantic.findings;
  if(!failed.length||failed.some(c=>c.name!=='成片语义审查')||!findings.length||findings.length>6)return;
  const requirements=extractVisualRetentionRequirements(prompt);let checks;
  try{checks=parseVisualRetentionChecks(review.semantic.visualRetentionChecks);}catch{return;}
  if(!requirements.length||!checks||checks.length!==requirements.length||new Set(checks.map(c=>c.id)).size!==checks.length||checks.some(c=>c.status!=='met'||!c.frameTimes.length||!requirements.some(r=>r.id===c.id&&r.quote===c.quote)))return;
  const sampled=new Set(checks.flatMap(c=>c.frameTimes)),ids=new Set<string>();
  for(const finding of findings){
    if(!/重复|冗余/.test(finding)||!/新增|叠加|动效|高亮|椭圆/.test(finding)||/事实|原话|旁白|字幕|音频|错误|不准确|未核验|漏字|缺失|遮挡|挡住|裁切/.test(finding))return;
    const quotes=[...finding.matchAll(/[“「"]([^”」"]+)[”」"]/g)].map(m=>m[1]);
    const beats=script.beats.filter(b=>b.graphic!=='none'&&quotes.includes(b.label));
    if(beats.length!==1)return;
    const beat=beats[0],motions=plan.motions.filter(m=>m.sceneId===beat.sceneId&&m.kind===beat.graphic&&m.label===beat.label);
    const label=beat.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if([...prompt.matchAll(new RegExp('(?:圈出|高亮|添加|新增|加上)[^，。；,;!?！？]{0,20}'+label,'g'))].some(m=>!/(?:不要|别|不必|无需|不用)[^，。；,;!?！？]{0,6}$/.test(prompt.slice(Math.max(0,m.index!-12),m.index))))return;
    const times=[...finding.matchAll(/(\d+(?:\.\d+)?)\s*秒/g)].map(m=>Number(m[1]));
    if(motions.length!==1||!times.length||times.some(t=>!sampled.has(t)||t<motions[0].start||t>=motions[0].end))return;
    ids.add(beat.sceneId);
  }
  const next=structuredClone(script),removed=next.beats.filter(b=>ids.has(b.sceneId)).map(b=>({sceneId:b.sceneId,label:b.label}));
  for(const beat of next.beats)if(ids.has(beat.sceneId)){beat.graphic='none';beat.label='';}
  if(/至少(?:两|2)种/.test(prompt)&&new Set(next.beats.filter(b=>b.graphic!=='none').map(b=>b.graphic)).size<2)return;
  return {script:next,removed};
}
