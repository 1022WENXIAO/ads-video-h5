import type { ResearchReference } from '../src/types';

const tracking = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|campaign_id|nb_placement|nbt)$/i;

/** Remove known click/ad tracking only. Ambiguous parameters (id, tid, page,
 * language, event, CMS category, etc.) remain part of the article identity.
 * Further alias resolution requires a canonical link in the actual HTML. */
export function canonicalNewsUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}

export function newsSourceIdentity(value: string): string {
  const url = new URL(canonicalNewsUrl(value));
  url.hostname = url.hostname.replace(/^www\./i, '');
  return url.href;
}

export function newsPublisher(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  return parts.slice(/\.(?:com|co|org)\.[a-z]{2}$/.test(host) ? -3 : -2).join('.');
}

/** Round-robin queries before taking the read budget. A long list from one
 * publisher must not crowd out another query's independent article. */
export function newsSourceCandidates(groups: ResearchReference[][], eligible: (ref: ResearchReference) => boolean = () => true, limit = 12, perPublisher = 3): ResearchReference[] {
  const seen = new Set<string>(), counts = new Map<string, number>(), result: ResearchReference[] = [];
  for (let index = 0; index < Math.min(32, Math.max(0, ...groups.map(group => group.length))); index++) {
    for (const group of groups) {
      const original = group[index];
      if (!original) continue;
      const ref = { ...original, url: canonicalNewsUrl(original.url) }, key = newsSourceIdentity(ref.url), publisher = newsPublisher(ref.url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!eligible(ref) || (counts.get(publisher) || 0) >= perPublisher) continue;
      counts.set(publisher, (counts.get(publisher) || 0) + 1);
      result.push(ref);
      if (result.length >= limit) return result;
    }
  }
  return result;
}
