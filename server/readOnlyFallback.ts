import type {ModelConfig} from './modelRegistry';
import {frozenTextFallbacks} from './modelContext';
import {throwIfJobCancelled} from './jobExecution';
import {isTransientExecutionError,safeErrorText,executionFailure} from './executionErrors';

export class ReadOnlyCapabilityError extends Error {
  readonly code='READ_ONLY_CAPABILITY_UNAVAILABLE';
}
export interface ReadOnlyFallbackAttempt {modelId:string;registryId:string;status:'failed'|'succeeded';reason?:string}
/** Only callers performing read-only research or an uncommitted decision may
 * use this helper. Completed tools and paid media submissions are never replayed. */
export async function withReadOnlyTextFallback<T>(primary:ModelConfig,run:(model:ModelConfig)=>Promise<T>,options:{alternatives?:ModelConfig[];observe?:(attempt:ReadOnlyFallbackAttempt)=>void|Promise<void>;recoverable?:(error:unknown)=>boolean;deadline?:number}={}):Promise<T>{
  const seen=new Set<string>(),models=[primary,...(options.alternatives??frozenTextFallbacks(primary))].filter((model,index)=>{
    const key=model.baseUrl+'\0'+model.modelId;if(seen.has(key)||index>0&&(!model.enabled||model.kind!=='text'))return false;seen.add(key);return true;
  }).slice(0,3),secrets=models.map(model=>model.apiKey);
  let last:unknown;
  for(const [index,model] of models.entries()){
    throwIfJobCancelled();
    if(options.deadline&&Date.now()>=options.deadline)break;
    try{const result=await run(model);await options.observe?.({modelId:model.modelId,registryId:model.id,status:'succeeded'});return result;}
    catch(error){
      throwIfJobCancelled();last=error;
      await options.observe?.({modelId:model.modelId,registryId:model.id,status:'failed',reason:safeErrorText(error instanceof Error?error.message:error,secrets)});
      // Explicit auth, credits and stop failures remain terminal, including
      // when another nested message happens to mention a transient network.
      const terminal=(failure:ReturnType<typeof executionFailure>):boolean=>[401,403].includes(failure.status||0)||/(?:\bHTTP\s*|\bstatus(?:\s+code)?\s*[:=]?\s*)(?:401|403)\b/i.test(failure.message)||['EACCES','EPERM','ENOSPC','EROFS','EIO'].includes(failure.code||'')||['AbortError','JobCancelledError','CreditError'].includes(failure.name)||Boolean(failure.causes?.some(terminal));
      if(terminal(executionFailure(error,secrets)))throw error;
      if(index===models.length-1||!(isTransientExecutionError(error)||error instanceof ReadOnlyCapabilityError||options.recoverable?.(error)))throw error;
    }
  }
  throw last??new ReadOnlyCapabilityError('只读任务超过本次执行预算。');
}
