import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

/** A wall-clock deadline, not a poll-count budget. Abort in-flight health
 * requests and pauses as well, so slow startup cannot hold a worker forever. */
export async function waitForOwnedFixtureReady(check: (signal: AbortSignal) => Promise<boolean>, timeoutMs = 15000, pollMs = 50): Promise<boolean> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, timeoutMs); });
  const polling = (async () => {
    try {
      while (!controller.signal.aborted) {
        if (await check(controller.signal) && !controller.signal.aborted) return true;
        await delay(pollMs, undefined, { signal: controller.signal });
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
    return false;
  })();
  try { return await Promise.race([polling, deadline]); }
  finally { if (timer) clearTimeout(timer); controller.abort(); }
}

/** Only pass the ChildProcess returned by this test's own spawn, never a PID. */
export async function terminateOwnedChild(child: ChildProcess, graceMs = 500, killWaitMs = 2000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const onExit = () => resolveExit();
  // Install before signalling: a quick exit must not be missed between kill()
  // and once('exit'), and child.killed only means a signal was sent.
  child.once('exit', onExit);
  async function within(milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (await within(graceMs)) return;
    child.kill('SIGKILL');
    if (!await within(killWaitMs)) throw new Error('Owned test child did not exit after bounded TERM/KILL teardown.');
  } finally { child.removeListener('exit', onExit); }
}

export async function closeOwnedServer(server: Server, timeoutMs = 2000): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned test provider did not close within its teardown deadline.')), timeoutMs);
    server.close(error => {
      clearTimeout(timer);
      if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    });
  });
}

/** Provider cleanup also runs when child termination fails. Preserve the
 * disposable directory on failure rather than deleting a live child's files. */
export async function disposeOwnedFixture(child: ChildProcess | undefined, provider: Server, directory: string): Promise<void> {
  try { if (child) await terminateOwnedChild(child); }
  finally { await closeOwnedServer(provider); }
  await rm(directory, { recursive: true, force: true });
}
