import {JobCancelledError} from './jobExecution';
import {NarrationVerificationError} from './narrationAnalysisRecovery';
import type {PoolFailure} from './taskPool';

// Only a measured, per-chapter timing failure may request the same bounded
// script repair as exhausted local word/pause verification. Never classify a
// provider error by its prose (which may itself contain quoted speech).
export class NarrationTimingRepairError extends Error {
  constructor(readonly chapterIds:readonly string[],message:string){super(message);this.name='NarrationTimingRepairError';}
}
type ChapterRepairError=NarrationVerificationError|NarrationTimingRepairError;
export class NarrationBatchVerificationError extends Error {
  readonly errors:readonly ChapterRepairError[];
  readonly chapterIds:readonly string[];
  constructor(failures:ReadonlyArray<{chapterIds:readonly string[];error:ChapterRepairError}>){
    const ids=[...new Set(failures.flatMap(f=>f.chapterIds))];
    const details=failures.map(f=>`${f.chapterIds.join('、')}：${f.error instanceof NarrationVerificationError?'已完成同一台词的有限复听和重录，下一步须定向改写拗口表达。':''}${f.error.message.slice(0,900)}`).join('\n');
    super(`修稿章节：${ids.join('、')}\n${details}\n这些章节已耗尽本轮有限核验或超出安全时长。一次定向调整全部所列章节的拗口表达与信息密度，保留其他已核验旁白、真实事实数值和限定条件。非必须口播的难读型号可用来源支持的通俗描述，图解保留正式名称；明确要求逐字保留的内容继续保留。不把错误识别结果改成台词，不只缩短其他章节却原样重复失败表达。`,{cause:failures[0]?.error});
    this.name='NarrationBatchVerificationError';this.errors=failures.map(f=>f.error);this.chapterIds=ids;
  }
}
function cancelled(error:unknown,seen=new Set<unknown>()):boolean {
  if(!error||typeof error!=='object'||seen.has(error))return false;seen.add(error);
  if(error instanceof JobCancelledError||error instanceof Error&&error.name==='AbortError')return true;
  return 'cause'in error&&cancelled(error.cause,seen);
}
export function selectNarrationBatchFailure(failures:ReadonlyArray<PoolFailure>,chapterIds:readonly string[]):unknown {
  const ordered=[...failures].sort((a,b)=>a.index-b.index),repairs:{chapterIds:readonly string[];error:ChapterRepairError}[]=[],critical:PoolFailure[]=[];
  for(const failure of ordered){
    const {error,index}=failure,id=chapterIds[index];
    if(id&&error instanceof NarrationVerificationError&&error.chapterId===id)repairs.push({chapterIds:[id],error});
    else if(id&&error instanceof NarrationTimingRepairError&&error.chapterIds.length===1&&error.chapterIds[0]===id)repairs.push({chapterIds:[id],error});
    else critical.push(failure);
  }
  // Draining preserves completed caches. Cancellation and every unknown or
  // technical failure still stop execution with their original object/cause.
  const stop=critical.find(f=>cancelled(f.error))||critical[0];
  if(stop)return stop.error;
  return repairs.length?new NarrationBatchVerificationError(repairs):ordered[0]?.error;
}
