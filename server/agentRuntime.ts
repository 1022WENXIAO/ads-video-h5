import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AgentCapabilities } from '../shared/agentCapabilities';
import { throwIfJobCancelled } from './jobExecution';
export interface AgentRuntime {
  settings: AgentCapabilities;
  instructions: string;
  tools: AgentTool[];
  dispose?: () => Promise<void>;
}
const context = new AsyncLocalStorage<AgentRuntime>();
export const currentAgentRuntime = () => context.getStore();
export const withAgentRuntime = <T>(runtime: AgentRuntime, action: () => Promise<T>) =>
  context.run(runtime, async () => {
    try {
      return await action();
    } finally {
      await runtime.dispose?.();
    }
  });
const limits = new WeakMap<AgentRuntime, ReturnType<typeof limitParallelTools>>();
export function runtimeParallelLimit(runtime: AgentRuntime) {
  if (!limits.has(runtime)) limits.set(runtime, limitParallelTools(runtime.settings.maxParallel));
  return limits.get(runtime)!;
}
export function limitParallelTools(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(action: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      throwIfJobCancelled();
      return await action();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
