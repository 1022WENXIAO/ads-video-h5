import type { HotResearchBrief, ResearchReference } from '../src/types';

export type NewsDatePolicy = 'strict' | 'flexible';

/** Missing timestamps are not an error for an otherwise sourced explainer.
 * Explicit recency requirements always win over the deployment default. */
export function newsDatePolicy(prompt: string): NewsDatePolicy {
  const subject = prompt.split(/\n(?:研究方向：|制作路径：)/)[0];
  return /今天|今日|当日|昨天|昨日|本周|这周|近一周|(?:近|过去|最近)\s*(?:\d+|[一二三四五六七八九十两]+)\s*(?:小时|天|周)|\btoday\b|\byesterday\b|\bthis week\b|\b(?:last|past)\s+\d+\s+(?:hours?|days?|weeks?)\b/i.test(subject)
    || process.env.QINGJIAN_NEWS_DATE_POLICY === 'strict' ? 'strict' : 'flexible';
}

export const missingNewsDateNotice = '原文未注明发布时间；仅能确认本次核验可读取，不能据此声称今天发生或刚刚发布。';

export function undatedRecencyClaim(value: string): boolean {
  return value.split(/[，,。；;！？!?\n]/).some(clause => {
    const match=/(?:今天|今日|刚刚|刚)[^，,。；;！？!?]{0,24}(?:宣布|发布|推出|发生|上线)|最新发布|\btoday\b.{0,30}\b(?:announced|released|launched)\b|just announced/i.exec(clause);
    return Boolean(match&&!/未证实|未证明|没有证据|不能|无法|并未|尚未|是否|不确定/.test(clause.slice(0,match.index+match[0].length)));
  });
}

export function hasUsableNewsDate(refs: ResearchReference[], policy: NewsDatePolicy = 'strict'): boolean {
  return refs.some(ref => ref.verification === 'news-page' && ref.freshness === 'fresh')
    || policy === 'flexible' && refs.some(ref => ref.verification === 'news-page' && ref.freshness === 'undated' && !ref.publishedAt);
}

export function researchDatePolicy(brief: Pick<HotResearchBrief, 'datePolicy'>): NewsDatePolicy {
  // Old checkpoints retain their original strict contract.
  return brief.datePolicy === 'flexible' ? 'flexible' : 'strict';
}
