import type { Job } from '../src/types';
import { JobCancelledError, runWithJobSignal } from './jobExecution';
import { isActiveJob } from '../src/jobStatus';
import { interruptJobAttempt } from './jobAttempts';
export { isActiveJob } from '../src/jobStatus';

export function restoreInterruptedJobs(jobs: Job[], timestamp: string) {
  for (const job of jobs) {
    if (job.status === 'running' || job.status === 'stopping') interruptJobAttempt(job, timestamp);
    if (job.status === 'stopping' || job.stopRequestedAt && isActiveJob(job)) {
      job.status = 'cancelled'; job.cancelledAt = timestamp; job.updatedAt = timestamp;
      job.progress = undefined; job.stage = '已停止运行';
    } else if (job.status === 'running') job.status = 'queued';
  }
}

// Controllers belong to backend jobs, never to an HTTP request or browser tab.
export function createJobRunner() {
  const running = new Map<string, AbortController>();
  return {
    async run<T>(job: Job, action: () => Promise<T>): Promise<T> {
      const controller = new AbortController();
      running.set(job.id, controller);
      if (job.stopRequestedAt || job.status === 'stopping' || job.status === 'cancelled') controller.abort(new JobCancelledError());
      try { return await runWithJobSignal(controller.signal, action); }
      finally { running.delete(job.id); }
    },
    stopSession(jobs: Job[], ownerId: string, sessionId: string, timestamp: string) {
      const stopped: Job[] = [];
      for (const job of jobs) {
        if (job.ownerId !== ownerId || job.sessionId !== sessionId || !isActiveJob(job)) continue;
        job.stopRequestedAt ||= timestamp;
        job.updatedAt = timestamp;
        job.progress = undefined;
        job.error = undefined;
        if (job.status === 'queued') {
          job.status = 'cancelled'; job.cancelledAt = timestamp; job.stage = '已停止运行';
        } else {
          job.status = 'stopping'; job.stage = '正在停止运行';
          running.get(job.id)?.abort(new JobCancelledError());
        }
        stopped.push(job);
      }
      return stopped;
    },
  };
}
