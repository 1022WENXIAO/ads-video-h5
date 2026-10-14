import { blocksModelOutputRecovery, canRetryWorkflowError, retryBudgetExhausted, safeErrorText } from './executionErrors';
import { throwIfJobCancelled } from './jobExecution';

// Recognition and semantic postprocessing operate on an existing waveform.
// Their failures must never be interpreted as evidence to synthesize a retake.
export class NarrationAnalysisError extends Error {
  constructor(message: string, cause: unknown) { super(message, { cause }); this.name = 'NarrationAnalysisError'; }
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
