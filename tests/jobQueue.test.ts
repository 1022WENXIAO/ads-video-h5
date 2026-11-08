import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../server/jobQueue';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function entry(id: string, interaction: 'chat' | 'explore' | 'create', sessionId = id) { return { id, interaction, sessionId, status: 'queued' }; }
function harness(jobs: ReturnType<typeof entry>[]) {
  const started: string[] = [], finish = new Map<string, () => void>();
  const queue = createJobQueue({ jobs: () => jobs, onError: (_job, error) => assert.fail(String(error)),
    async execute(job) { job.status = 'running'; started.push(job.id); await new Promise<void>(r => finish.set(job.id, r)); job.status = 'succeeded'; } });
  return { queue, started, finish: (id: string) => { assert.ok(finish.has(id)); finish.get(id)!(); } };
}

test('a blocked production job does not block text replies; each lane stays serial', async () => {
  const jobs = [entry('work1', 'create'), entry('work2', 'create'), entry('chat1', 'chat'), entry('chat2', 'explore')];
  const h = harness(jobs); h.queue.dispatch(); h.queue.dispatch(); await flush();
  assert.deepEqual(h.started, ['work1', 'chat1']);
  h.finish('chat1'); await flush(); assert.deepEqual(h.started, ['work1', 'chat1', 'chat2']);
  assert.equal(jobs[0].status, 'running'); assert.equal(jobs[1].status, 'queued');
  h.finish('work1'); await flush(); assert.equal(h.started.at(-1), 'work2');
  h.finish('work2'); h.finish('chat2'); await flush(); assert.ok(jobs.every(j => j.status === 'succeeded'));
});

test('one session retains FIFO across chat and production without blocking other sessions', async () => {
  const jobs = [entry('chat-first', 'chat', 'same'), entry('work-second', 'create', 'same'), entry('other-work', 'create')];
  const h = harness(jobs); h.queue.dispatch(); await flush();
  assert.deepEqual(h.started, ['other-work', 'chat-first']);
  h.finish('other-work'); await flush(); assert.equal(jobs[1].status, 'queued');
  h.finish('chat-first'); await flush(); assert.equal(h.started.at(-1), 'work-second');
  h.finish('work-second'); await flush();
});

test('stopping work in a session prevents a text job from racing its cleanup', async () => {
  const running = { ...entry('running', 'create', 'same'), status: 'stopping' };
  const jobs = [running, entry('chat', 'chat', 'same')], h = harness(jobs);
  h.queue.dispatch(); await flush(); assert.deepEqual(h.started, []);
  running.status = 'cancelled'; h.queue.dispatch(); await flush(); assert.deepEqual(h.started, ['chat']);
  h.finish('chat'); await flush();
});

test('a job cancelled after reservation never starts and the next job can run', async () => {
  const jobs = [entry('cancelled', 'chat'), entry('next', 'chat')], h = harness(jobs);
  h.queue.dispatch(); jobs[0].status = 'cancelled'; await flush();
  assert.deepEqual(h.started, ['next']); h.finish('next'); await flush();
});

test('an unexpected executor failure releases the lane without retrying a poisoned job', async () => {
  const jobs = [entry('bad', 'chat'), entry('good', 'chat')], failures: string[] = [];
  const queue = createJobQueue({ jobs: () => jobs, onError: job => { failures.push(job.id); }, async execute(job) {
    if (job.id === 'bad') throw new Error('broken executor'); job.status = 'succeeded';
  } });
  queue.dispatch(); await flush(); assert.deepEqual(failures, ['bad']);
  assert.deepEqual(jobs.map(j => j.status), ['failed', 'succeeded']);
});

test('deep exploration has a separate lane while other conversations progress and same-session FIFO is retained', async () => {
  const jobs = [
    { ...entry('deep', 'chat', 'same'), researchMode: 'deep' },
    entry('same-followup', 'chat', 'same'), entry('chat-a', 'chat'), entry('chat-b', 'chat'), entry('work', 'create'),
  ];
  const started: string[] = [], releases = new Map<string, () => void>();
  const queue = createJobQueue({ concurrency: { work: 1, chat: 2, research: 2 }, jobs: () => jobs,
    onError: (_job, error) => assert.fail(String(error)),
    async execute(job) { job.status = 'running'; started.push(job.id); await new Promise<void>(r => releases.set(job.id, r)); job.status = 'succeeded'; } });
  queue.dispatch(); await flush();
  assert.deepEqual(new Set(started), new Set(['work', 'chat-a', 'chat-b', 'deep']));
  releases.get('chat-a')!(); releases.get('chat-b')!(); await flush();
  assert.equal(jobs[1].status, 'queued', 'a later message in the research session cannot race its predecessor');
  assert.equal(jobs[0].status, 'running');
  releases.get('deep')!(); await flush(); assert.equal(started.at(-1), 'same-followup');
  releases.get('same-followup')!(); releases.get('work')!(); await flush();
  assert.ok(jobs.every(j => j.status === 'succeeded'));
});
