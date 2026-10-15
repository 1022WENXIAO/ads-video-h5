import { jobDelay, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { validateSemanticReview } from './reviewResults';
import { requestReviewJson, type ReviewObserver } from './reviewAssets';
import { blocksModelOutputRecovery } from './executionErrors';
import { numericVisualFindings,type VisualReviewContext } from './visualReviewEvidence';

export async function requestSemanticReview(config:ModelConfig,messages:unknown[],observe?:ReviewObserver,requiresNewsPublication=false,visualContext?:VisualReviewContext) {
  const evidenceAttempts:Array<{score:number;discardedFindings:Array<{original:string;reason:string}>}>=[];
  const reviewMessages=[...messages];
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const body=await requestReviewJson(config,{model:config.modelId,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8000,messages:reviewMessages},'semantic',attempt,observe);
      const result=validateSemanticReview(JSON.parse(body.choices?.[0]?.message?.content||''));
      if(requiresNewsPublication&&!result.newsPublication)throw new Error('新闻报道日期抽帧审查未完成。');
      const numericFindings=numericVisualFindings(result.numericVisualChecks,visualContext);
      if(result.discardedFindings?.length)evidenceAttempts.push({score:result.score,discardedFindings:result.discardedFindings});
      // Correct a sole self-identical accusation only within the existing two
      // review attempts. Its raw score and needsRepair flag are never lifted to make it pass.
      if(!attempt&&result.discardedFindings?.length&&!result.findings.length&&!numericFindings.length){
        reviewMessages.push({role:'user',content:'上一轮唯一拼写指控的原串与目标串逐字相同，不能证明拼写有误。原始评分'+result.score+'及原指控已保留记录，不要求提高分数。请重新依据上面同一份实际音频和抽帧给出有效判断，保留任何真正缺陷或不确定性；不要原样重复无差异指控。具体问题：'+JSON.stringify(result.discardedFindings)});
        await jobDelay(600);continue;
      }
      return {...result,findings:[...result.findings,...numericFindings],needsRepair:result.needsRepair||numericFindings.length>0,...(evidenceAttempts.length?{evidenceAttempts}: {})};
    } catch(error) {
      throwIfJobCancelled();
      if(attempt||blocksModelOutputRecovery(error))throw error;
      await jobDelay(600);
    }
  }
  throw new Error('成片审查请求未完成');
}
