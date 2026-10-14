import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job, Session } from '../src/types';
import { createJobRunner, restoreInterruptedJobs } from '../server/jobRunner';
import { currentJobSignal, jobDelay, jobFetch, JobCancelledError, runWithJobSignal, spawnForJob, throwIfJobCancelled, withoutJobSignal } from '../server/jobExecution';
import { updateReply } from '../server/replies';
import { runFFmpeg } from '../server/core';

const timestamp = '2026-10-02T11:00:00.000Z';
const job = (id: string, status: Job['status'] = 'running', sessionId = 'chat-a', ownerId = 'owner-a'): Job => ({
  id, sessionId, ownerId, status, kind: 'plan', messageId: `message-${id}`, createdAt: timestamp, updatedAt: timestamp,
});

test('stop cancels all current-chat work but preserves other chats, owners and completed work', () => {
  const runner = createJobRunner();
  const jobs = [job('active'), job('queued', 'queued'), job('other-chat', 'running', 'chat-b'), job('other-owner', 'running', 'chat-a', 'owner-b'), job('finished', 'succeeded')];
  const stopped = runner.stopSession(jobs, 'owner-a', 'chat-a', timestamp);
  assert.deepEqual(stopped.map(item => item.id), ['active', 'queued']);
  assert.equal(jobs[0].status, 'stopping');
  assert.equal(jobs[1].status, 'cancelled');
  assert.equal(jobs[1].cancelledAt, timestamp);
  assert.deepEqual(jobs.slice(2).map(item => item.status), ['running', 'running', 'succeeded']);
  assert.equal(runner.stopSession(jobs, 'owner-a', 'chat-a', timestamp).length, 1);
});

test('stop before the running controller is attached prevents work from starting', async () => {
  const runner = createJobRunner(), item = job('race');
  runner.stopSession([item], 'owner-a', 'chat-a', timestamp);
  let started = false;
  await assert.rejects(runner.run(item, async () => { started = true; }), JobCancelledError);
  assert.equal(started, false);
});

test('running cancellation waits for actual execution to exit, and leaves another run alive', async () => {
  const runner = createJobRunner(), a = job('a'), b = job('b', 'running', 'chat-b');
  let lateStep = false, exited = false;
  const first = runner.run(a, async () => {
    try { await jobDelay(10_000); lateStep = true; }
    finally { exited = true; }
  });
  const second = runner.run(b, async () => { await jobDelay(30); return 'completed'; });
  runner.stopSession([a, b], 'owner-a', 'chat-a', timestamp);
  assert.equal(a.status, 'stopping');
  await assert.rejects(first, JobCancelledError);
  assert.equal(exited, true);
  assert.equal(lateStep, false);
  assert.equal(await second, 'completed');
  assert.equal(b.stopRequestedAt, undefined);
});

test('a cancelled execution cannot publish a late reply over the stopped state', async () => {
  const runner = createJobRunner(), item = job('late');
  const session: Session = { id: 'chat-a', title: 'Test', modelId: null, createdAt: timestamp, updatedAt: timestamp, messages: [], plan: null };
  const active = runner.run(item, async () => {
    try { await jobDelay(10_000); }
    catch { assert.throws(() => updateReply(session, item, 'Incorrect late success'), JobCancelledError); }
  });
  runner.stopSession([item], 'owner-a', 'chat-a', timestamp);
  await assert.rejects(active, JobCancelledError);
  assert.equal(session.messages.length, 0);
});

test('stop aborts an actual in-flight HTTP response body and closes its backend connection', { timeout: 5000 }, async t => {
  let disconnected = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"pending":');
    const timer = setTimeout(() => response.end('false}'), 10_000);
    timers.add(timer);
    response.once('close', () => { disconnected = true; clearTimeout(timer); timers.delete(timer); });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); server.close(); });
  const address = server.address(); assert(address && typeof address !== 'string');
  const runner = createJobRunner(), item = job('http');
  let responseReady!: () => void;
  const ready = new Promise<void>(resolve => { responseReady = resolve; });
  const active = runner.run(item, async () => {
    const response = await jobFetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(4000) });
    responseReady();
    return response.json();
  });
  await ready;
  runner.stopSession([item], 'owner-a', 'chat-a', timestamp);
  await assert.rejects(active);
  const deadline = Date.now() + 1000;
  while (!disconnected && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(disconnected, true);
});

test('stop kills the real render-style subprocess before the execution promise settles', { timeout: 5000 }, async () => {
  const runner = createJobRunner(), item = job('render');
  let spawned!: (pid: number) => void;
  const ready = new Promise<number>(resolve => { spawned = resolve; });
  let closed = false;
  const active = runner.run(item, async () => {
    const child = spawnForJob(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await once(child, 'spawn'); spawned(child.pid!);
    await once(child, 'close'); closed = true;
  });
  const pid = await ready;
  runner.stopSession([item], 'owner-a', 'chat-a', timestamp);
  await assert.rejects(active, JobCancelledError);
  assert.equal(closed, true);
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});

test('a CLI wrapper can find the service Node runtime with an empty inherited PATH', { skip: process.platform === 'win32', timeout: 5000 }, async () => {
  const child = spawnForJob('/bin/sh', ['-c', 'node -e "process.stdout.write(process.execPath)"'], { env: { PATH: '', QINGJIAN_CHILD_CHECK: 'kept' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = '';
  child.stdout!.on('data', chunk => { output += chunk; });
  child.stderr!.on('data', chunk => { error += chunk; });
  const [code] = await once(child, 'close');
  assert.equal(code, 0, error);
  assert.equal(output, process.execPath);
});

test('interrupted ordinary work resumes after restart, but persisted stop requests never resume', () => {
  const jobs = [job('interrupted'), job('stopping', 'stopping'), { ...job('stopped-before-crash'), stopRequestedAt: timestamp }, job('waiting', 'queued'), job('done', 'succeeded'), job('stopped', 'cancelled')];
  restoreInterruptedJobs(jobs, timestamp);
  assert.deepEqual(jobs.map(item => item.status), ['queued', 'cancelled', 'cancelled', 'queued', 'succeeded', 'cancelled']);
  assert.equal(jobs[1].cancelledAt, timestamp);
});

test('stop interrupts FFmpeg after it actually starts producing a video', { timeout: 7000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qingjian-stop-render-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'in-progress.mp4');
  const runner = createJobRunner(), item = job('ffmpeg');
  const active = runner.run(item, () => runFFmpeg(['-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:r=10', '-t', '30', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', output]));
  void active.catch(() => undefined);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !(await stat(output).then(info => info.size > 0).catch(() => false))) await new Promise(resolve => setTimeout(resolve, 20));
  assert((await stat(output)).size > 0, 'FFmpeg must really be writing video before stopping');
  runner.stopSession([item], 'owner-a', 'chat-a', timestamp);
  await assert.rejects(active, JobCancelledError);
  const size = (await stat(output)).size;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await stat(output)).size, size, 'Video output must stop growing');
});

test('ordinary upstream timeouts still apply independently of a user stop signal', async () => {
  const server = createServer(() => {});
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const controller = new AbortController();
  try {
    await assert.rejects(runWithJobSignal(controller.signal, () => jobFetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(40) })), error => (error as Error).name === 'TimeoutError');
    assert.equal(controller.signal.aborted, false);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a detached queue installs independent child context and survives coordinator cancellation while restoring its caller', async () => {
  const coordinator = new AbortController(), runner = createJobRunner(), item = job('detached-queue');
  let childCompleted = false, cleanupPersisted = false;
  await assert.rejects(runWithJobSignal(coordinator.signal, async () => {
    assert.equal(currentJobSignal(), coordinator.signal);
    const queued = withoutJobSignal(() => {
      assert.equal(currentJobSignal(), undefined);
      return runner.run(item, async () => {
        const childSignal = currentJobSignal(); assert.ok(childSignal); assert.notEqual(childSignal, coordinator.signal);
        await jobDelay(20);
        throwIfJobCancelled(); childCompleted = true; return 'child complete';
      });
    });
    assert.equal(currentJobSignal(), coordinator.signal, 'dispatch restores the release coordinator context');
    coordinator.abort();
    withoutJobSignal(() => { throwIfJobCancelled(); cleanupPersisted = true; });
    assert.equal(currentJobSignal(), coordinator.signal);
    assert.equal(await queued, 'child complete');
    assert.equal(currentJobSignal(), coordinator.signal, 'await restores the original coordinator context');
  }), JobCancelledError);
  assert.equal(childCompleted, true); assert.equal(cleanupPersisted, true); assert.equal(currentJobSignal(), undefined);
});

test('cancelling a detached child job does not cancel its release coordinator or leak its signal into queue cleanup', async () => {
  const coordinator = new AbortController(), runner = createJobRunner(), item = job('independent-child');
  await runWithJobSignal(coordinator.signal, async () => {
    await withoutJobSignal(async () => {
      const queued = runner.run(item, async () => { assert.notEqual(currentJobSignal(), coordinator.signal); await jobDelay(10_000); });
      runner.stopSession([item], 'owner-a', 'chat-a', timestamp);
      await assert.rejects(queued, JobCancelledError);
      assert.equal(currentJobSignal(), undefined); throwIfJobCancelled();
    });
    assert.equal(currentJobSignal(), coordinator.signal); assert.equal(coordinator.signal.aborted, false);
  });
  assert.equal(currentJobSignal(), undefined);
});
