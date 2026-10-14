import { randomUUID } from 'node:crypto';
import type { Job, JobAttempt, JobFailure } from '../shared/types';
import { executionFailure, isTransientExecutionError, safeErrorText } from './executionErrors';

function attemptTrace(job: Job, attempt: JobAttempt) {
  const restored = (job.workflow ?? []).filter(event => Date.parse(event.at) < Date.parse(attempt.startedAt));
  return {
    workflow: structuredClone((job.workflow ?? []).filter(event => !(Date.parse(event.at) < Date.parse(attempt.startedAt)))),
    restoredCallCount: restored.length,
    restoredCallIds: restored.flatMap(event => event.callId ? [event.callId] : []),
  };
}

// Completed attempts are snapshots. A new execution never rewrites an older
// attempt's model, trace, result or release identity.
export function beginJobAttempt(job: Job, revision: string | null, timestamp: string): JobAttempt {
  const previous = job.attempts?.at(-1);
  if (previous?.status === 'running') interruptJobAttempt(job, timestamp);
  if (!job.attempts?.length && job.workflow?.length) job.legacyWorkflow ??= structuredClone(job.workflow);
  const attempt: JobAttempt = {
    id: randomUUID(), number: (previous?.number ?? 0) + 1,
    reason: previous?.status === 'interrupted' ? 'restart' : previous ? 'retry' : 'initial',
    kind: job.kind, status: 'running', startedAt: timestamp, revision,
    ...(job.artifactId ? { inheritedArtifactId: job.artifactId } : {}),
  };
  (job.attempts ??= []).push(attempt);
  job.attemptId = attempt.id;
  job.workflow = [];
  job.failure = undefined;
  job.textModel = undefined;
  return attempt;
}

export function finishJobAttempt(job: Job, timestamp: string, transport: NonNullable<JobAttempt['transport']> = [], failure?: JobFailure): JobAttempt | undefined {
  const attempt = job.attempts?.find(a => a.id === job.attemptId);
  if (!attempt || attempt.status !== 'running') return attempt;
  if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) throw new Error('不能把尚未结束的任务记录为完成。');
  Object.assign(attempt, {
    status: job.status, finishedAt: timestamp, stage: job.stage,
    textModel: structuredClone(job.textModel), artifactId: job.artifactId,
    artifactOrigin: job.artifactId ? job.artifactId !== attempt.inheritedArtifactId ? 'generated' : job.status === 'succeeded' && job.kind === 'review' ? 'reviewed' : 'retained' : undefined,
    error: job.error, failure: structuredClone(failure),
    ...attemptTrace(job, attempt), transport: structuredClone(transport),
  });
  return attempt;
}

export function interruptJobAttempt(job: Job, timestamp: string): void {
  const attempt = job.attempts?.find(a => a.id === job.attemptId);
  if (!attempt || attempt.status !== 'running') return;
  Object.assign(attempt, {
    status: 'interrupted', finishedAt: timestamp, stage: job.stage,
    textModel: structuredClone(job.textModel), artifactId: job.artifactId,
    ...attemptTrace(job, attempt), error: '服务重启中断了本次执行。',
  });
}

// History polling carries attempt summaries. Large tool I/O is fetched only
// when the owner opens an individual attempt.
export function publicJob(job: Job): Job {
  const { legacyWorkflow: _legacy, ...visible } = job;
  return { ...visible, ...(job.attempts ? { attempts: job.attempts.map(({ workflow: _workflow, transport: _transport, ...summary }) => summary) } : {}) };
}

export function jobFailureMessage(error: unknown, stage: string | undefined, secrets: string[] = []): string {
  const failure = executionFailure(error, secrets), where = safeErrorText(stage || '处理步骤', secrets);
  if (/CreditError/.test(failure.name)) return failure.message;
  if (failure.status === 401 || failure.status === 403 || /\b(?:401|403)\b/.test(failure.message)) return `服务授权验证失败，任务停在「${where}」。请联系管理员检查服务配置。`;
  if (isTransientExecutionError(error) || failure.retryExhausted) return `服务连接暂时中断，自动恢复后仍未成功。任务停在「${where}」，可以重试；已生成的作品会保留。`;
  const message = failure.message.replace(/TEXT_TRANSPORT_FINAL/g, '').trim();
  if (/API Key|模型尚未配置|会话或消息|素材|剪辑方案|Pi Agent|对话回复|图片描述|口播文案|BGM|Pixabay|音频|语义分句|字幕|分句|特效|工作流未完成|研究|教学视频|形象|动画|旁白|校验|预算|来源|审查/.test(message)) return message;
  return `任务在「${where}」未能完成，请重试。若再次失败，请联系管理员查看本次任务记录。`;
}
