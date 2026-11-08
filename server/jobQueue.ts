interface QueueEntry {
  id: string;
  sessionId: string;
  status: string;
  interaction?: 'chat' | 'explore' | 'create';
}
type Lane = 'chat' | 'work';
const laneOf = (job: QueueEntry): Lane => job.interaction === 'chat' || job.interaction === 'explore' ? 'chat' : 'work';

/** One text reply and one production job can progress independently. Jobs in
 * the same session retain FIFO order and never mutate its draft concurrently. */
export function createJobQueue<T extends QueueEntry>(options: {
  jobs: () => T[];
  execute: (job: T) => Promise<void>;
  onError: (job: T, error: unknown) => void;
}) {
  const busy = new Set<Lane>(), sessions = new Set<string>();
  function dispatch() {
    for (const lane of ['work', 'chat'] as const) {
      if (busy.has(lane)) continue;
      const jobs = options.jobs();
      const job = jobs.find((item, index) => item.status === 'queued' && laneOf(item) === lane && !sessions.has(item.sessionId)
        && !jobs.some(other => other.id !== item.id && other.sessionId === item.sessionId && ['running', 'stopping'].includes(other.status))
        && !jobs.slice(0, index).some(other => other.sessionId === item.sessionId && other.status === 'queued'));
      if (!job) continue;
      busy.add(lane); sessions.add(job.sessionId);
      void Promise.resolve().then(() => {
        // A stop may cancel a reserved job before its execution microtask.
        if (job.status === 'queued') return options.execute(job);
      }).catch(error => { job.status = 'failed'; options.onError(job, error); }).finally(() => {
        busy.delete(lane); sessions.delete(job.sessionId); dispatch();
      });
    }
  }
  return { dispatch };
}
