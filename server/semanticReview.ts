import { jobDelay, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { validateSemanticReview } from './reviewResults';
import { requestReviewJson, type ReviewObserver } from './reviewAssets';
import { blocksModelOutputRecovery } from './executionErrors';

export async function requestSemanticReview(config:ModelConfig,messages:unknown[],observe?:ReviewObserver,requiresNewsPublication=false) {
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const body=await requestReviewJson(config,{model:config.modelId,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8000,messages},'semantic',attempt,observe);
      const result=validateSemanticReview(JSON.parse(body.choices?.[0]?.message?.content||''));
      if(requiresNewsPublication&&!result.newsPublication)throw new Error('新闻报道日期抽帧审查未完成。');
      return result;
    } catch(error) {
      throwIfJobCancelled();
      if(attempt||blocksModelOutputRecovery(error))throw error;
      await jobDelay(600);
    }
  }
  throw new Error('成片审查请求未完成');
}
