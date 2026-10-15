import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { AudioAnalysis, MediaItem } from '../shared/types';
import { JobCancelledError, onJobAbort, throwIfJobCancelled } from './jobExecution';
import { SourceAsrRecoveryError, type SourceAsrRecoveryReason } from './sourceAsrRecovery';

interface SourceAsrAuthorizationOptions {
  ownerId: string;
  sourceId: string;
  media: readonly MediaItem[] | (() => readonly MediaItem[]);
  file: string;
  reason: SourceAsrRecoveryReason;
  recheck: (item: MediaItem, file: string, reason: SourceAsrRecoveryReason) => Promise<AudioAnalysis>;
}

const fail = (message: string): never => { throw new SourceAsrRecoveryError(message); };
const analysisIdentity = (analysis: AudioAnalysis): string => createHash('sha256').update(JSON.stringify(analysis)).digest('hex');

async function sourceHash(file: string): Promise<string> {
  throwIfJobCancelled();
  const input = createReadStream(file), hash = createHash('sha256');
  const unbind = onJobAbort(() => input.destroy(new JobCancelledError()));
  try {
    for await (const block of input) { throwIfJobCancelled(); hash.update(block); }
    throwIfJobCancelled();
    return hash.digest('hex');
  } finally { unbind(); input.destroy(); }
}

/** Authorize a candidate only. The caller must call assertCurrent and adopt it
 * without another await; the promise-return microtask can otherwise race a
 * concurrent state change. This function never mutates the media/analysis. */
export async function recheckAuthorizedSource(options: SourceAsrAuthorizationOptions): Promise<{ item: MediaItem; analysis: AudioAnalysis; assertCurrent: () => void }> {
  throwIfJobCancelled();
  const media = () => typeof options.media === 'function' ? options.media() : options.media;
  const find = (): MediaItem => {
    const matches = media().filter(item => item.id === options.sourceId);
    if (!options.ownerId || matches.length !== 1 || matches[0].ownerId !== options.ownerId) return fail('源音频不属于当前用户或素材身份存在歧义，不能复听。');
    return matches[0];
  };
  const item = find(), original = item.analysis, reason = options.reason;
  if (!['audio', 'video'].includes(item.kind) || item.hasAudio === false || original?.status !== 'ready') return fail('只有已完成识别的原声视频或音频可以独立复听。');
  if (!reason || !['negation-boundary', 'duration-incomplete-tail'].includes(reason.kind) || !/^[a-f0-9]{64}$/.test(reason.sourceHash) || reason.sourceHash !== original.sourceHash || !Array.isArray(reason.sentenceIds) || !reason.sentenceIds.length || new Set(reason.sentenceIds).size !== reason.sentenceIds.length || reason.sentenceIds.some(id => !original.sentences.some(sentence => sentence.id === id))) return fail('源音频复听原因未绑定当前原识别与实际音频。');
  const originalIdentity = analysisIdentity(original), originalKind = item.kind, originalHasAudio = item.hasAudio;
  const assertCurrent = () => {
    throwIfJobCancelled();
    const current = find();
    if (current !== item || current.kind !== originalKind || current.hasAudio !== originalHasAudio || current.analysis !== original || analysisIdentity(original) !== originalIdentity) fail('复听期间素材所有权或原识别已变化，不能覆盖当前结果。');
  };
  if (await sourceHash(options.file) !== original.sourceHash) return fail('实际源音频与原识别哈希不一致，不能复听。');
  throwIfJobCancelled(); assertCurrent();
  const analysis = await options.recheck(item, options.file, reason);
  throwIfJobCancelled(); assertCurrent();
  if (!analysis || analysis.status !== 'ready' || analysis.sourceHash !== original.sourceHash) return fail('独立复听结果没有绑定已核对的同一源音频。');
  if (await sourceHash(options.file) !== original.sourceHash) return fail('复听期间实际源音频已变化，不能采用候选结果。');
  throwIfJobCancelled(); assertCurrent();
  return { item, analysis, assertCurrent };
}
