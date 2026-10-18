import type { ResearchReference } from '../src/types';
import { publicResearchUrl } from './publicResearch';

/** Reject known non-documents before they consume the small body-read budget.
 * Unknown URLs are left to the reader; this is not an allowlist of publishers. */
export function newsSourceRejection(value:string):string|undefined {
  const safe=publicResearchUrl(value);
  if(!safe)return '非公开HTTPS文章地址';
  const url=new URL(safe),host=url.hostname.toLowerCase(),path=url.pathname.toLowerCase();
  if(/\.(?:pdf|mp4|mp3|jpg|png|zip)$/i.test(path))return '当前新闻正文读取器不支持该文件，请查同一公告的HTML报道';
  if(/^(?:(?:www|cn|image|images)\.)?(?:bing|baidu)\.com$/.test(host)||/^(?:m|www)\.weibo\.(?:cn|com)$/.test(host))return '搜索或社交动态页，请查发布者文章';
  if(path==='/'||/^\/(?:chn|cn|en|english|search|xxgksearch)(?:\/|\.html)?$/.test(path)||/^\/(?:news|press|releases)\/$/.test(path)||/\/web_app\/column\//.test(path))return '首页、栏目或检索页，请查具体文章';
}

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
      let ref:ResearchReference;
      try { ref={...original,url:canonicalNewsUrl(original.url)}; } catch { continue; }
      const key = newsSourceIdentity(ref.url), publisher = newsPublisher(ref.url);
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
