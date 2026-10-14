import type { NewsPublicationFrameObservation, NewsPublicationProof } from '../src/types';

/** The model supplies only a reading of an actual sampled movie frame. All
 * source, layout and media hashes are supplied and verified by the server. */
export function newsPublicationFrameEvidence(observation:NewsPublicationFrameObservation|undefined,expected:Pick<NewsPublicationProof,'label'|'chapterId'>,sampledTimes:number[],chapter:{start:number;end:number}):NewsPublicationProof['frameEvidence']|undefined{
  const compact=(text:string)=>text.replace(/\s+/g,'').replace(/[:：]/g,':').replace(/（/g,'(').replace(/）/g,')');
  const labels=[expected.label,expected.label+' · 画面示意'].map(compact);
  if(!observation?.visible||observation.chapterId!==expected.chapterId||!labels.includes(compact(observation.quote))||!Number.isFinite(observation.frameTime)||observation.frameTime<chapter.start||observation.frameTime>=chapter.end||!sampledTimes.some(time=>Math.abs(time-observation.frameTime)<.001))return;
  return {chapterId:observation.chapterId,quote:observation.quote,frameTime:observation.frameTime,sampledTimes:sampledTimes.filter(time=>time>=chapter.start&&time<chapter.end)};
}
