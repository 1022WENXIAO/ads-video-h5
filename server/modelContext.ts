import { AsyncLocalStorage } from 'node:async_hooks';
import type { ModelConfig } from './modelRegistry';
import type { ModelKind } from '../src/types';

export type ModelSnapshot = Record<ModelKind, ModelConfig | null> & { textFallbacks?: ModelConfig[] };
const context = new AsyncLocalStorage<ModelSnapshot>();
export function withModelSnapshot<T>(models: ModelSnapshot, action: () => Promise<T>): Promise<T> { return context.run(models, action); }
export const snapshotModels = (models: ModelSnapshot): ModelConfig[] => [models.text,models.image,models.audio,models.understanding,...(models.textFallbacks||[])].filter((model):model is ModelConfig=>Boolean(model));
export function frozenTextFallbacks(primary:ModelConfig):ModelConfig[]{
  return (context.getStore()?.textFallbacks||[]).filter(model=>model.id!==primary.id&&model.enabled&&model.kind==='text'&&model.baseUrl.replace(/\/$/,'')===primary.baseUrl.replace(/\/$/,''));
}
export function frozenModel(kind: ModelKind, preferredId?: string | null): ModelConfig | null | undefined {
  const snapshot = context.getStore();
  if (!snapshot) return undefined;
  const model = snapshot[kind];
  return preferredId && model?.id !== preferredId ? null : model;
}
