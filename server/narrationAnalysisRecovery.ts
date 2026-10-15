import { blocksModelOutputRecovery, canRetryWorkflowError, retryBudgetExhausted, safeErrorText } from './executionErrors';
import { throwIfJobCancelled } from './jobExecution';

// Recognition and semantic postprocessing operate on an existing waveform.
// Their failures must never be interpreted as evidence to synthesize a retake.
export class NarrationAnalysisError extends Error {
  constructor(message: string, cause: unknown) { super(message, { cause }); this.name = 'NarrationAnalysisError'; }
}

// This is produced only at the trusted local script/word alignment boundary,
// or after measured pause inspection. Provider and file errors are not evidence
// that a paid waveform should be replaced, even if their text mentions clocks.
export class NarrationVerificationError extends Error {
  readonly errors?: NarrationVerificationError[];
  constructor(readonly kind:'speech'|'pause',readonly chapterId:string,message:string,options:{cause?:unknown;firstError?:NarrationVerificationError}={}) {
    super(message,options.cause===undefined?undefined:{cause:options.cause});this.name='NarrationVerificationError';
    if(options.firstError)this.errors=[options.firstError];
  }
}
export function verifyNarrationSpeech<T>(chapterId:string,run:()=>T):T {
  try{return run();}catch(error){
    if(!(error instanceof Error)||Object.getPrototypeOf(error)!==Error.prototype||error.name!=='Error'||['cause','code','status','retryable','retryExhausted'].some(key=>key in error))throw error;
    const prefix='章节'+chapterId,message=error.message,detail=message.startsWith(prefix)?message.slice(prefix.length):'';
    const known=/^(?:日期数字或年月日单位与脚本不同|实际时钟的小时、分钟、秒或完整单位与脚本不同|已核验公司专名「.+」匹配不完整或不同|实际转写含无法辨认的占位|末尾台词匹配不完整或出现额外尾词|实际旁白与脚本匹配\d|实际读出的年份与脚本不同|实际型号或版本数字与脚本不同|实际读出的小数数字|实际读出的残差、误差、伽马或阈值数字与脚本不同|金额、百分比、数量数字或单位与脚本不一致|关键数学术语「.+」不完整或匹配次数不同|实际读出的数学符号|出现未计划的重复字|出现连续未匹配的额外字词|存在连续未匹配台词|实际旁白中的数字与脚本不一致|实际字词未完整匹配汉字)/.test(detail)||/^动画原词「.+」未能与实际旁白对齐。$/.test(message);
    if(!known)throw error;
    throw new NarrationVerificationError('speech',chapterId,message,{cause:error});
  }
}
export function canRetryNarrationAnalysis(error: unknown): boolean {
  if (retryBudgetExhausted(error)) return false;
  if (canRetryWorkflowError(error)) return true;
  if (blocksModelOutputRecovery(error)) return false;
  return error instanceof SyntaxError || /^(?:音频理解.*(?:被截断|时间码|字词|格式)|分句|语义分句|字幕语义分行)/.test(error instanceof Error ? error.message : String(error));
}
export async function recognizeExistingNarration<T>(run: (attempt: number) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfJobCancelled();
    try { return await run(attempt); }
    catch (error) {
      throwIfJobCancelled();
      if (attempt === 0 && canRetryNarrationAnalysis(error)) continue;
      throw new NarrationAnalysisError(`同一旁白的识别或分句未完成，已保留音频，不能据此重录或改脚本：${safeErrorText(error instanceof Error ? error.message : error)}`, error);
    }
  }
  throw new Error('旁白识别恢复状态无效。');
}
