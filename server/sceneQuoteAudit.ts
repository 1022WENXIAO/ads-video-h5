import type { MediaItem, SelectedScene } from '../src/types';

export const sceneQuoteAuditVersion = 'sentence-audit-v3';
export interface SceneQuoteAuditEntry {
  id: string;
  selected: { sourceId: string; sourceHash: string; sentenceIds: string[]; start: number; end: number; quote: string };
  context: { previous: string; next: string };
}
export interface SceneQuoteAuditResult {
  rejected: Array<{ id: string; quote: string; evidence: { start: number; end: number; text: string }; reason: string }>;
}
export class SceneQuoteAuditProtocolError extends Error {
  constructor(readonly field: string, readonly expected: string) {
    super(`选句审查协议无效：${field}须${expected}。原始审查记录保留；未绑定的判断不能当作通过，也不能当作所选原话的已确认缺陷。请在既有调用额度内依据当前所选原话返回绑定审查，不能补词或改变原始完整性标记。`);
    this.name = 'SceneQuoteAuditProtocolError';
  }
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function invalid(field: string, expected: string): never { throw new SceneQuoteAuditProtocolError(field, expected); }

export function sceneQuoteAuditEntries(scenes: SelectedScene[], sources: MediaItem[]): SceneQuoteAuditEntry[] {
  return scenes.map(scene => {
    const source = sources.find(item => item.id === scene.sourceId);
    const all = source?.analysis?.sentences || [];
    const first = all.findIndex(sentence => sentence.id === scene.sentenceIds[0]);
    const last = all.findIndex(sentence => sentence.id === scene.sentenceIds.at(-1));
    const selected = first < 0 || last < first ? [] : all.slice(first, last + 1);
    if (source?.analysis?.sourceHash !== scene.sourceHash || !selected.length || selected.length !== scene.sentenceIds.length || selected.some((sentence, index) => sentence.id !== scene.sentenceIds[index]) || selected.map(sentence => sentence.text).join('') !== scene.quote || selected[0].start !== scene.start || selected.at(-1)!.end !== scene.end) invalid('selected', '与当前源哈希、连续句子ID、原词和时间完全一致');
    return { id: scene.id, selected: { sourceId: scene.sourceId, sourceHash: scene.sourceHash, sentenceIds: [...scene.sentenceIds], start: scene.start, end: scene.end, quote: scene.quote }, context: { previous: all[first - 1]?.text || '', next: all[last + 1]?.text || '' } };
  });
}

export function validateSceneQuoteAuditResult(raw: unknown, entries: SceneQuoteAuditEntry[]): SceneQuoteAuditResult {
  if (!object(raw) || !Array.isArray(raw.rejected) || raw.rejected.length > entries.length) invalid('rejected', '为不超过本批所选分镜数的array');
  const ids = new Set<string>();
  for (const [index, value] of raw.rejected.entries()) {
    const at = `rejected[${index}]`;
    if (!object(value) || typeof value.id !== 'string' || ids.has(value.id)) invalid(`${at}.id`, '为本批唯一的所选分镜id');
    const entry = entries.find(item => item.id === value.id);
    if (!entry) invalid(`${at}.id`, '属于本批所选分镜');
    ids.add(value.id);
    if (value.quote !== entry.selected.quote) invalid(`${at}.quote`, '逐字等于该id的selected.quote，不能引用context');
    if (!object(value.evidence)) invalid(`${at}.evidence`, '包含所选quote内的start/end/text');
    const { start, end, text } = value.evidence;
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > entry.selected.quote.length) invalid(`${at}.evidence`, '使用selected.quote内有效的字串半开区间[start,end)');
    if (typeof text !== 'string' || !text.trim() || text !== entry.selected.quote.slice(start as number, end as number)) invalid(`${at}.evidence.text`, '逐字等于selected.quote.slice(start,end)，不能使用previous/next文字');
    if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 1000) invalid(`${at}.reason`, '为1–1000字符的具体原始拒绝理由');
  }
  return raw as unknown as SceneQuoteAuditResult;
}

export function validateSceneQuoteAuditCache(raw: unknown, entries: SceneQuoteAuditEntry[]): SceneQuoteAuditResult {
  if (!object(raw) || raw.version !== sceneQuoteAuditVersion || JSON.stringify(raw.entries) !== JSON.stringify(entries)) invalid('cache.binding', '使用当前v3 schema且与本批完整源/句子/时间/quote/context绑定完全一致');
  return validateSceneQuoteAuditResult(raw.result, entries);
}
