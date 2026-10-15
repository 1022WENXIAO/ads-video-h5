import type { AudioAnalysis, MediaItem } from '../shared/types';
import { lessonSettings } from './lessonSpec';

export interface SourceAsrRecoveryReason {
  kind:'negation-boundary'|'duration-incomplete-tail';
  sentenceIds:string[];
  sourceHash:string;
  detail:string;
}
export class SourceAsrRecoveryError extends Error {
  readonly code='SOURCE_ASR_RECOVERY_EXHAUSTED';
  readonly retryable=false;
}
const compact=(text:string)=>text.replace(/[\s，。！？、；：,.!?;:]/g,'');

/** A diagnostic, never a replacement for heard words or a completeness flag. */
export function sourceAsrRecoveryReasons(analysis:AudioAnalysis):SourceAsrRecoveryReason[] {
  if(analysis.status!=='ready')return [];
  const reasons:SourceAsrRecoveryReason[]=[];
  for(let index=0;index+1<analysis.sentences.length;index++){
    const before=analysis.sentences[index],after=analysis.sentences[index+1];
    const tail=/(不是|并非|不等于|不代表)$/.exec(compact(before.text))?.[1];
    const duplicated=tail==='不是'||tail==='并非'?/^是/.test(compact(after.text)):tail==='不等于'?/^等于/.test(compact(after.text)):tail==='不代表'?/^代表/.test(compact(after.text)):false;
    if(duplicated&&!before.complete&&after.complete&&after.start-before.end<=.35)reasons.push({kind:'negation-boundary',sentenceIds:[before.id,after.id],sourceHash:analysis.sourceHash,detail:'否定谓词停在前一残句末，后一完整句以重复谓词开始；原识别句界与否定范围存在冲突，必须独立听取同一音频，不能移动或补写原词。'});
  }
  const last=analysis.sentences.at(-1);
  const dangling=last&&/(?:把.{1,18}(?:说成|当成|视为)|不是|不代表|意味着)$/.test(compact(last.text));
  if(last&&(!last.complete||dangling)&&analysis.duration-last.end<=.35)reasons.push({kind:'duration-incomplete-tail',sentenceIds:[last.id],sourceHash:analysis.sourceHash,detail:'源音频末尾存在未完成原句或缺少宾语的依存尾部；不能用推测的词尾、填充画面或修改complete来满足时长。'});
  return reasons;
}

/** Upper bound, including all padding allowed by the existing fine-cut policy.
 * Semantic rejection can only reduce this capacity, never increase it. */
export function completeSourceCapacity(sources:MediaItem[]):number {
  let seconds=0;
  for(const source of sources){
    const analysis=source.analysis;if(analysis?.status!=='ready')continue;
    const unsafe=new Set(sourceAsrRecoveryReasons(analysis).flatMap(reason=>reason.sentenceIds));
    const ranges=analysis.sentences.filter(sentence=>sentence.complete&&!unsafe.has(sentence.id)).map(sentence=>{
      const prior=analysis.sentences.filter(other=>other.end<=sentence.start&&other!==sentence).at(-1)?.end||0;
      const following=analysis.sentences.find(other=>other.start>=sentence.end&&other!==sentence)?.start??analysis.duration;
      return{start:Math.max(prior,0,sentence.start-.1),end:Math.min(following,analysis.duration,sentence.end+.35)};
    }).sort((a,b)=>a.start-b.start);
    let end=-Infinity;for(const range of ranges){seconds+=Math.max(0,range.end-Math.max(end,range.start));end=Math.max(end,range.end);}
  }
  return +seconds.toFixed(3);
}
export function durationSourceRecovery(sources:MediaItem[],prompt:string):{minimum:number;capacity:number;candidates:Array<{sourceId:string;reason:SourceAsrRecoveryReason}>}|undefined {
  let settings:ReturnType<typeof lessonSettings>;try{settings=lessonSettings(prompt);}catch{return;}
  const target=settings.requestedSeconds;if(!settings.explicitDuration||target>60)return;
  const minimum=target-Math.max(2,target*.1),capacity=completeSourceCapacity(sources);
  if(capacity>=minimum)return;
  const candidates=sources.flatMap(source=>source.analysis?sourceAsrRecoveryReasons(source.analysis).filter(reason=>reason.kind==='duration-incomplete-tail').map(reason=>({sourceId:source.id,reason})):[]);
  return{minimum,capacity,candidates};
}
