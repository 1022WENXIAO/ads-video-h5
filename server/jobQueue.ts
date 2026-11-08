interface QueueEntry {
  id: string;
  sessionId: string;
  status: string;
  interaction?: 'chat' | 'explore' | 'create';
  researchMode?: 'auto' | 'off' | 'web' | 'deep';
}
type Lane = 'chat' | 'work' | 'research';
const laneOf = (job: QueueEntry): Lane => job.interaction === 'chat' || job.interaction === 'explore' ? job.researchMode==='deep'?'research':'chat' : 'work';

/** Chat, research and production lanes progress independently. Jobs in
 * the same session retain FIFO order and never mutate its draft concurrently. */
export function createJobQueue<T extends QueueEntry>(options: {
  jobs: () => T[];
  execute: (job: T) => Promise<void>;
  onError: (job: T, error: unknown) => void;
  concurrency?: Partial<Record<Lane,number>>;
}) {
  const busy = new Map<Lane,number>(), sessions = new Set<string>();
  const capacity=(lane:Lane)=>Math.max(1,Math.min(4,Math.floor(options.concurrency?.[lane]||1)));
  function dispatch() {
    for (const lane of ['work', 'chat', 'research'] as const) {
      while ((busy.get(lane)||0)<capacity(lane)) {
      const jobs = options.jobs();
      const job = jobs.find((item, index) => item.status === 'queued' && laneOf(item) === lane && !sessions.has(item.sessionId)
        && !jobs.some(other => other.id !== item.id && other.sessionId === item.sessionId && ['running', 'stopping'].includes(other.status))
        && !jobs.slice(0, index).some(other => other.sessionId === item.sessionId && other.status === 'queued'));
      if (!job) break;
      busy.set(lane,(busy.get(lane)||0)+1); sessions.add(job.sessionId);
      void Promise.resolve().then(() => {
        // A stop may cancel a reserved job before its execution microtask.
        if (job.status === 'queued') return options.execute(job);
      }).catch(error => { job.status = 'failed'; options.onError(job, error); }).finally(() => {
        busy.set(lane,(busy.get(lane)||1)-1); sessions.delete(job.sessionId); dispatch();
      });
      }
    }
  }
  return { dispatch };
}
