import { isEvaluationOwner } from './evaluationIsolation';

// Only the server's evaluator supplies this deadline. Queue time and earlier
// messages consume the same case budget; ordinary jobs keep their own limit.
export function taskTimeoutMs(ownerId: string | undefined, evaluationDeadline: number | undefined, now = Date.now(), configured = process.env.QINGJIAN_TASK_TIMEOUT_MS): number {
  if (!isEvaluationOwner(ownerId) || evaluationDeadline === undefined) return Number(configured) || 1800000;
  if (!Number.isSafeInteger(evaluationDeadline)) throw new Error('评测执行时限无效。');
  return Math.max(1, evaluationDeadline - now);
}
