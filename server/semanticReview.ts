import { jobDelay, throwIfJobCancelled } from './jobExecution';
import type { ModelConfig } from './modelRegistry';
import { validateSemanticReview } from './reviewResults';
import { requestReviewJson, type ReviewObserver } from './reviewAssets';
import { blocksModelOutputRecovery } from './executionErrors';

export async function requestSemanticReview(config:ModelConfig,messages:unknown[],observe?:ReviewObserver) {
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const body=await requestReviewJson(config,{model:config.modelId,thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8000,messages},'semantic',attempt,observe);
      return validateSemanticReview(JSON.parse(body.choices?.[0]?.message?.content||''));
    } catch(error) {
      throwIfJobCancelled();
      if(attempt||blocksModelOutputRecovery(error))throw error;
      await jobDelay(600);
    }
  }
  throw new Error('成片审查请求未完成');
}
