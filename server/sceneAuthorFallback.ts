import type {ModelConfig} from './modelRegistry';
import {frozenTextFallbacks} from './modelContext';

/** The existing second authored attempt may use an independent configured
 * author. It spends the same attempt, keeps the actual layout feedback and
 * still produces a candidate for the full browser checks. */
export function sceneAuthorConfig(primary:ModelConfig,layoutFeedback:string):ModelConfig{
  return layoutFeedback.trim()?frozenTextFallbacks(primary)[0]||primary:primary;
}
