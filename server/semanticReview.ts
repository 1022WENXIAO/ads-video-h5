import { jobDelay, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { validateSemanticReview } from './reviewResults';
import { requestReviewJson, type ReviewObserver } from './reviewAssets';
import { blocksModelOutputRecovery } from './executionErrors';
import { bindVisualRetentionSources, visualRetentionFindings, visualRetentionReviewInstruction, VisualRetentionReviewError, type VisualRetentionRequirement, type VisualRetentionAttempt, type VisualRetentionSourceContext } from './visualRetentionReview';
import { numericVisualFindings,type VisualReviewContext } from './visualReviewEvidence';

export async function requestSemanticReview(config:ModelConfig,messages:unknown[],observe?:ReviewObserver,requiresNewsPublication=false,visualContext?:VisualReviewContext & {visualRetentionRequirements?:VisualRetentionRequirement[];visualRetentionSources?:VisualRetentionSourceContext}) {
  const evidenceAttempts:Array<{score:number;discardedFindings:Array<{original:string;reason:string}>}>=[];
  const reviewMessages=[...messages];
  const retentionRequirements=visualContext?.visualRetentionRequirements||[],retentionAttempts:VisualRetentionAttempt[]=[];
  for(let attempt=0;attempt<2;attempt++) {
    let rawScore:number|null=null;
    try {
      const body=await requestReviewJson(config,{model:config.modelId,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8000,messages:reviewMessages},'semantic',attempt,observe);
      const raw=JSON.parse(body.choices?.[0]?.message?.content||'');
      if(Number.isFinite(raw?.score))rawScore=raw.score;
      const result=validateSemanticReview(raw);
      if(requiresNewsPublication&&!result.newsPublication)throw new Error('新闻报道日期抽帧审查未完成。');
      const numericFindings=numericVisualFindings(result.numericVisualChecks,visualContext);
      result.visualRetentionChecks=bindVisualRetentionSources(result.visualRetentionChecks,visualContext?.visualRetentionSources);
      const retentionFindings=visualRetentionFindings(result.visualRetentionChecks,retentionRequirements,visualContext?.frameTimes);
      if(retentionRequirements.length)retentionAttempts.push({score:result.score,checks:result.visualRetentionChecks});
      if(result.discardedFindings?.length)evidenceAttempts.push({score:result.score,discardedFindings:result.discardedFindings});
      // Correct a sole self-identical accusation only within the existing two
      // review attempts. Its raw score and needsRepair flag are never lifted to make it pass.
      if(!attempt&&result.discardedFindings?.length&&!result.findings.length&&!numericFindings.length&&!retentionFindings.length){
        reviewMessages.push({role:'user',content:'上一轮唯一拼写指控的原串与目标串逐字相同，不能证明拼写有误。原始评分'+result.score+'及原指控已保留记录，不要求提高分数。请重新依据上面同一份实际音频和抽帧给出有效判断，保留任何真正缺陷或不确定性；不要原样重复无差异指控。具体问题：'+JSON.stringify(result.discardedFindings)});
        await jobDelay(600);continue;
      }
      return {...result,findings:[...result.findings,...numericFindings,...retentionFindings],needsRepair:result.needsRepair||numericFindings.length>0||retentionFindings.length>0,...(retentionAttempts.length?{retentionAttempts}:{}),...(evidenceAttempts.length?{evidenceAttempts}: {})};
    } catch(error) {
      throwIfJobCancelled();
      if(error instanceof VisualRetentionReviewError){
        retentionAttempts.push({score:rawScore,error:error.message});
        if(attempt)throw new VisualRetentionReviewError(error.message,{cause:error,attempts:retentionAttempts});
        reviewMessages.push({role:'user',content:'上一轮视觉保留核验协议无效：'+error.message+' 原分和失败证据保留，不要求提分。仅依据相同实际帧逐项纠正：'+visualRetentionReviewInstruction(retentionRequirements)});
      }
      if(attempt||blocksModelOutputRecovery(error))throw error;
      await jobDelay(600);
    }
  }
  throw new Error('成片审查请求未完成');
}
