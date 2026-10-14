import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { creditFetch } from './creditUsage';
import { fetchWithTextRecovery, type TransportDiagnostic } from './providerTransport';

const execution = new AsyncLocalStorage<{ signal: AbortSignal; transport: TransportDiagnostic[] }>();
const failureTransport = new WeakMap<object, TransportDiagnostic[]>();

export class JobCancelledError extends Error {
  constructor() { super('用户已停止运行。'); this.name = 'JobCancelledError'; }
}

export const currentJobSignal = () => execution.getStore()?.signal;
// Queue coordinators and external stop/persistence handlers must not inherit
// the signal of the request/release task that dispatched them. A child job
// installs its own context through runWithJobSignal; the caller is restored
// immediately after this callback, including when it returns a promise.
export function withoutJobSignal<T>(action: () => T): T { return execution.exit(action); }
export const getJobTransportDiagnostics = (): TransportDiagnostic[] => execution.getStore()?.transport.map(diagnostic => structuredClone(diagnostic)) ?? [];
// Queue catches run outside AsyncLocalStorage. WeakMap metadata survives error
// propagation without adding raw request data to JSON or user-visible errors.
export const jobErrorDiagnostics = (error: unknown): TransportDiagnostic[] => error !== null && typeof error === 'object' ? failureTransport.get(error)?.map(diagnostic => structuredClone(diagnostic)) ?? [] : [];

export function throwIfJobCancelled(signal = currentJobSignal()) {
  if (signal?.aborted) throw new JobCancelledError();
}

export function onJobAbort(callback: () => void, signal = currentJobSignal()): () => void {
  if (!signal) return () => {};
  if (signal.aborted) { callback(); return () => {}; }
  signal.addEventListener('abort', callback, { once: true });
  return () => signal.removeEventListener('abort', callback);
}

export async function runWithJobSignal<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  return execution.run({ signal, transport: [] }, async () => {
    throwIfJobCancelled();
    try {
      const result = await action();
      throwIfJobCancelled();
      return result;
    } catch (error) {
      if (error !== null && typeof error === 'object') failureTransport.set(error, getJobTransportDiagnostics());
      throwIfJobCancelled(); throw error;
    }
  });
}

// Each outgoing request keeps its own timeout and also observes the user's stop.
export const jobFetch: typeof fetch = async (input, init) => {
  const signal = currentJobSignal();
  throwIfJobCancelled(signal);
  const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const combined = signal && inherited ? AbortSignal.any([signal, inherited]) : signal || inherited;
  try {
    const response = await fetchWithTextRecovery(creditFetch, input, { ...init, ...(combined ? { signal: combined } : {}) }, diagnostic => {
      const transport = execution.getStore()?.transport;
      if (transport) { transport.push(diagnostic); if (transport.length > 64) transport.shift(); }
    });
    if (signal?.aborted) await response.body?.cancel();
    throwIfJobCancelled(signal);
    return response;
  } catch (error) { throwIfJobCancelled(signal); throw error; }
};

export const spawnForJob: typeof spawn = ((command: string, argsOrOptions?: readonly string[] | SpawnOptions, options?: SpawnOptions): ChildProcess => {
  const signal = currentJobSignal();
  throwIfJobCancelled(signal);
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  const settings = (Array.isArray(argsOrOptions) ? options : argsOrOptions) as SpawnOptions | undefined;
  // Give CLI renderers a process group so their FFmpeg workers stop with them.
  const grouped = Boolean(signal) && process.platform !== 'win32';
  // Services may start with an absolute Node path and a minimal PATH. CLI
  // wrappers still invoke `node` via env/sh; use the same runtime as this
  // service instead of failing much later after paid narration completed.
  const env = { ...process.env, ...settings?.env };
  env.PATH = [path.dirname(process.execPath), env.PATH].filter(Boolean).join(path.delimiter);
  const child = spawn(command, args, { ...settings, env, ...(grouped ? { detached: true } : {}) });
  const unbind = onJobAbort(() => {
    if (grouped && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* It may already have exited. */ }
    }
    child.kill('SIGKILL');
  }, signal);
  child.once('close', unbind);
  child.once('error', unbind);
  return child;
}) as typeof spawn;

export function jobDelay(ms: number): Promise<void> {
  const signal = currentJobSignal();
  throwIfJobCancelled(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unbind(); resolve(); }, ms);
    const unbind = onJobAbort(() => { clearTimeout(timer); reject(new JobCancelledError()); }, signal);
  });
}
