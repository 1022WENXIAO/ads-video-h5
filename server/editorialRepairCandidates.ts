import type { EditPlan, MediaItem, RenderReview, SelectedScene } from '../shared/types';
import { extractVisualRetentionRequirements, parseVisualRetentionChecks, visualRetentionSelectionNeeded, visualRetentionUnverifiedPlanningWitnesses } from './visualRetentionReview';
import { timelineOffsets } from './timeline';

export interface EditorialRepairSelection {
  sourceId:string;
  sentenceIds:string[];
  reason:string;
  purpose:SelectedScene['purpose'];
}
export interface EditorialRepairCandidate {
  seconds:number;
  selections:EditorialRepairSelection[];
  avoidsCaptionConcern:boolean;
  retainedSentences:number;
}
export interface EditorialRepairCandidates {
  detail:string;
  candidates:EditorialRepairCandidate[];
  search:{visited:number;validated:number;limited:boolean};
}
const compact=(s:string)=>s.replace(/[\s，。！？、；：,.!?;:]/g,'');
const key=(sourceId:string,sentenceId:string)=>JSON.stringify([sourceId,sentenceId]);
const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

/** A cited visible caption defect is an optional avoidance preference. It does
 * not establish what the source audio said and never supplies missing words. */
function captionConcerns(review:RenderReview,plan:EditPlan,sources:readonly MediaItem[]){
  const concerns=new Set<string>(),scenes=new Set<string>(),offsets=timelineOffsets(plan);
  for(const finding of review.semantic?.findings||[]){
    if(!/字幕.{0,120}(?:缺少|缺字|漏字|错字|截断|不完整)/.test(finding))continue;
    const quotes=[...finding.matchAll(/[“「"]([^”」"]{1,100})[”」"]/g)].map(m=>m[1]);
    for(const [i,clip] of plan.clips.entries()){
      const scene=plan.editorial?.scenes.find(s=>s.id===clip.sceneId);
      if(!scene||!new RegExp('(?:^|[\\s。；;])'+escape(scene.id)+'\\s*[:：]').test(finding))continue;
      const source=sources.find(s=>s.id===clip.sourceId);
      if(!source?.analysis||source.analysis.sourceHash!==scene.sourceHash)continue;
      const offset=offsets[i];
      for(const quote of quotes){
        const captions=plan.captions?.filter(c=>c.text===quote&&c.start>=offset-.03&&c.end<=offset+clip.end-clip.start+.03)||[];
        if(captions.length!==1)continue;
        const matches=source.analysis.sentences.filter(s=>clip.sentenceIds?.includes(s.id)&&compact(s.text).includes(compact(quote)));
        if(matches.length===1){concerns.add(key(source.id,matches[0].id));scenes.add(scene.id);}
      }
    }
  }
  return {sentences:concerns,scenes};
}

/** Bounded suggestions only. The caller supplies the existing selection,
 * timeline and narrative validators; no rendering or model call occurs here. */
export function editorialRepairCandidates(options:{
  review:RenderReview;prompt:string;plan:EditPlan;sources:readonly MediaItem[];
  validate:(selections:EditorialRepairSelection[])=>EditPlan|undefined;
}):EditorialRepairCandidates|undefined{
  const {review,prompt,plan,sources}=options;
  const planning=visualRetentionUnverifiedPlanningWitnesses(review,prompt,plan,sources);
  if(!planning&&!visualRetentionSelectionNeeded(review,prompt,plan))return;
  const requirements=extractVisualRetentionRequirements(prompt),checks=parseVisualRetentionChecks(review.semantic?.visualRetentionChecks)!;
  const used=new Set(plan.clips.map(c=>c.sourceId));
  let invalidWitness=false;
  const witnesses=planning||checks.flatMap((check,index)=>{
    const trusted=review.semantic!.visualRetentionChecks![index],w=trusted.sourceEvidence;
    if(check.status!=='unmet'||trusted.sourceOmitted!==true||!w||!requirements.some(r=>r.id===check.id&&r.quote===check.quote))return [];
    const matches=sources.filter(s=>s.id===w.sourceId),source=matches[0],analysis=source?.analysis;
    if(matches.length!==1||source.kind!=='video'||source.hasAudio===false||analysis?.status!=='ready'||!/^[a-f0-9]{64}$/.test(w.sourceHash||'')||analysis.sourceHash!==w.sourceHash||!Number.isFinite(w.time)||w.time<0||w.time>=analysis.duration){invalidWitness=true;return [];}
    return [{sourceId:w.sourceId,time:w.time,sourceHash:w.sourceHash}];
  });
  if(invalidWitness||!witnesses.length)return;
  if(sources.length>5||new Set(sources.map(s=>s.id)).size!==sources.length||[...used].some(id=>!sources.some(s=>s.id===id))){
    return {detail:'来源身份或数量超出候选提示范围，未穷举，不能据此断言无解。',candidates:[],search:{visited:0,validated:0,limited:true}};
  }
  const pool=sources.filter(s=>used.has(s.id)).flatMap(source=>source.analysis?.status==='ready'?source.analysis.sentences.filter(s=>s.complete).map(sentence=>({source,sentence})):[]);
  if(pool.length>18||new Set(pool.map(row=>key(row.source.id,row.sentence.id))).size!==pool.length){
    return {detail:'完整原句数量或身份超出候选提示范围，未穷举，不能据此断言无解。',candidates:[],search:{visited:0,validated:0,limited:true}};
  }
  const concern=captionConcerns(review,plan,sources),avoided=concern.sentences;
  // Preserve unaffected first-candidate scenes before retaining extra content
  // from the scene whose caption was explicitly disputed.
  const retained=new Set(plan.clips.filter(c=>!c.sceneId||!concern.scenes.has(c.sceneId)).flatMap(c=>(c.sentenceIds||[]).map(id=>key(c.sourceId,id))));
  const candidates:EditorialRepairCandidate[]=[];let visited=0,validated=0,limited=false;
  function search(index:number,selected:typeof pool){
    if(visited>=5000){limited=true;return;}visited++;
    if(index<pool.length){search(index+1,selected);search(index+1,[...selected,pool[index]]);return;}
    if(!selected.length||[...used].some(id=>!selected.some(row=>row.source.id===id)))return;
    // Necessary upper envelope only; real validators below still decide every
    // cut and silence margin. This avoids spending the bounded validations on
    // selections that cannot possibly cover a mandatory observation.
    if(planning&&witnesses.some(w=>{const rows=selected.filter(row=>row.source.id===w.sourceId);return !rows.length||w.time<Math.min(...rows.map(row=>row.sentence.start))-.1||w.time>=Math.max(...rows.map(row=>row.sentence.end))+.35;}))return;
    const selections=sources.filter(s=>used.has(s.id)).map(source=>({sourceId:source.id,sentenceIds:selected.filter(row=>row.source.id===source.id).map(row=>row.sentence.id),reason:'候选仅核算完整原句、原时长和已绑定画面见证；叙事意义仍须核对',purpose:plan.clips.find(c=>c.sourceId===source.id)?.purpose||'argument' as SelectedScene['purpose']}));
    const adjacent=Boolean(planning)&&selections.some(entry=>{const all=sources.find(s=>s.id===entry.sourceId)!.analysis!.sentences;return entry.sentenceIds.some((id,i)=>i>0&&all.findIndex(s=>s.id===id)===all.findIndex(s=>s.id===entry.sentenceIds[i-1])+1);});
    const variants=adjacent?[selections,selections.flatMap(entry=>entry.sentenceIds.map(id=>({...entry,sentenceIds:[id]})))]:[selections];
    for(const variant of variants){
      if(planning&&variant.reduce((count,entry)=>{const all=sources.find(s=>s.id===entry.sourceId)!.analysis!.sentences;return count+entry.sentenceIds.filter((id,i)=>!i||all.findIndex(s=>s.id===id)!==all.findIndex(s=>s.id===entry.sentenceIds[i-1])+1).length;},0)>16)continue;
      if(validated>=240){limited=true;return;}validated++;
      const checked=options.validate(structuredClone(variant));
      if(!checked||!Number.isFinite(checked.targetSeconds)||witnesses.some(w=>!checked.clips.some(c=>c.sourceId===w.sourceId&&w.time>=c.start&&w.time<c.end)))continue;
      const selectedKeys=new Set(selected.map(row=>key(row.source.id,row.sentence.id)));
      candidates.push({seconds:checked.targetSeconds,selections:variant,avoidsCaptionConcern:[...avoided].every(k=>!selectedKeys.has(k)),retainedSentences:[...retained].filter(k=>selectedKeys.has(k)).length});
    }
  }
  search(0,[]);
  // Preferences choose suggestions, never change the validator's duration band.
  candidates.sort((a,b)=>Number(b.avoidsCaptionConcern)-Number(a.avoidsCaptionConcern)||b.retainedSentences-a.retainedSentences||Math.abs(a.seconds-plan.targetSeconds)-Math.abs(b.seconds-plan.targetSeconds)||a.seconds-b.seconds);
  const picked:EditorialRepairCandidate[]=[];
  const pick=(candidate:EditorialRepairCandidate|undefined)=>{if(candidate&&picked.length<3&&!picked.some(p=>JSON.stringify(p.selections)===JSON.stringify(candidate.selections)))picked.push(candidate);};
  pick(candidates[0]);
  // Also expose a shorter valid choice; closeness to the target is a preference,
  // not grounds to hide a legal whole-sentence solution near the allowed edge.
  const best=candidates[0];
  pick(candidates.filter(c=>c.avoidsCaptionConcern===best?.avoidsCaptionConcern&&c.retainedSentences===best?.retainedSentences).sort((a,b)=>a.seconds-b.seconds)[0]);
  for(const candidate of candidates){pick(candidate);if(picked.length===3)break;}
  return {detail:(planning?'原审查仍为未验证；以下只规划包含当前选段外的真实源见证并保留已满足见证，以新成片消除不确定性，不认定原片缺失。':'')+'以下最多3项只证明当前完整原句、原时长门禁与已绑定画面见证可行；优先保留其它原句，并包含较短的合法组合，可避开明确字幕缺陷涉及的原句。不证明意义完整或全部用户画面表达通过，不能自动选定、补词或改变需求；须重新选句、独立完整性审查和新成片复核。'+(limited?'搜索触及5000节点或240次校验上界，未穷尽，不能断言无解。':candidates.length?'':'当前有界搜索未找到候选，不能据此宣称素材无解。'),candidates:picked,search:{visited,validated,limited}};
}
