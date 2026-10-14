import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { terminateOwnedChild, disposeOwnedFixture, closeOwnedServer, waitForOwnedFixtureReady } from './fixtures/ownedProcess';
import { waitForBackground } from './backgroundWait';

test('owned child teardown kills a real ignored-TERM process at a bounded deadline', { timeout: 5000 }, async t => {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>process.send('ignored'));process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore','ignore','ignore','ipc'] });
  t.after(() => terminateOwnedChild(child));
  await once(child, 'message');
  const messages: unknown[] = []; child.on('message', message => messages.push(message));
  const started = Date.now(); await terminateOwnedChild(child, 80, 2000);
  assert(messages.includes('ignored'), 'the actual child consumed TERM and remained alive');
  assert.equal(child.signalCode, 'SIGKILL'); assert(Date.now() - started < 3000);
  assert.equal(child.listenerCount('exit'), 0, 'teardown removes its listener');
  await terminateOwnedChild(child);
});

test('owned child teardown observes fast TERM exits and accepts an already-exited child', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore','ignore','ignore','ipc'] });
  await once(child, 'message'); await terminateOwnedChild(child, 1000);
  assert.equal(child.signalCode, 'SIGTERM'); await terminateOwnedChild(child);
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await once(exited, 'exit'); await terminateOwnedChild(exited);
  assert.equal(exited.exitCode, 0);
});

test('a child already terminated by signal has null exitCode and must not wait for a second exit event', { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore','ignore','ignore','ipc'] });
  await once(child, 'message');
  const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  assert.equal(child.exitCode, null); assert.equal(child.signalCode, 'SIGTERM');
  await waitForBackground(terminateOwnedChild(child), 500);
});

test('a termination error still closes only the owned provider and preserves failure evidence', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qingjian-owned-teardown-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const provider = createServer((_request, response) => response.end('fixture'));
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const child = spawn(process.execPath, ['-e', "process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore','ignore','ignore','ipc'] });
  await once(child, 'message'); const kill = child.kill.bind(child);
  t.after(() => { child.kill = kill; return terminateOwnedChild(child); });
  child.kill = () => { throw new Error('controlled teardown failure'); };
  await assert.rejects(disposeOwnedFixture(child, provider, directory), /controlled teardown failure/);
  assert.equal(provider.listening, false); await access(directory);
  child.kill = kill; await disposeOwnedFixture(child, provider, directory);
  await assert.rejects(access(directory), { code: 'ENOENT' });
});

test('owned provider close has a deadline instead of keeping a test worker alive indefinitely', { timeout: 5000 }, async () => {
  const provider = createServer(), close = provider.close.bind(provider);
  provider.close = () => provider;
  await assert.rejects(closeOwnedServer(provider, 20), /teardown deadline/);
  provider.close = close; await closeOwnedServer(provider);
});

test('startup uses its actual time deadline rather than stopping at 120 health polls', { timeout: 5000 }, async () => {
  let checks = 0;
  assert.equal(await waitForOwnedFixtureReady(async () => ++checks === 125, 2000, 0), true);
  assert.equal(checks, 125);
});

test('the startup deadline aborts an in-flight health request and clears its referenced timers', { timeout: 5000 }, async () => {
  let aborted = false;
  const started = Date.now();
  const ready = await waitForOwnedFixtureReady(signal => new Promise<boolean>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(false); }, { once: true })), 30, 0);
  assert.equal(ready, false); assert.equal(aborted, true); assert(Date.now() - started < 500);
  await assert.rejects(waitForOwnedFixtureReady(async () => { throw new Error('spawn failed'); }, 2000, 0), /spawn failed/);
});
