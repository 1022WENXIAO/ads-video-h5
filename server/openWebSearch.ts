import { jobFetch } from './jobExecution';
import { publicResearchUrl,publicArticleUrl } from './publicResearch';
import type { ResearchResult } from './researchTypes';

const supported = new Set(['bing','baidu','csdn','duckduckgo','exa','brave','juejin','startpage','sogou','hackernews']);
export function usableSearchArticle(value:string):boolean{
  const url=publicResearchUrl(value);if(!url)return false;
  const u=new URL(url);
  return !['image.baidu.com','images.baidu.com','www.bing.com','bing.com','www.baidu.com','baidu.com'].includes(u.hostname);
}
export function openWebBase(value = process.env.QINGJIAN_OPEN_WEBSEARCH_URL): string | undefined {
  if (!value) return;
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('open-webSearch 地址必须是本机回环服务根地址。');
  return u.origin;
}
export function openWebEngines(value = process.env.QINGJIAN_OPEN_WEBSEARCH_ENGINES || 'bing,baidu'): string[] {
  const engines = [...new Set(value.split(',').map(e => e.trim()).filter(Boolean))];
  if (!engines.length || engines.length > 3 || engines.some(e => !supported.has(e))) throw new Error('open-webSearch 请配置 1–3 个受支持的引擎。');
  return engines;
}
export function decodeOpenWebSearch(body: any, query: string, now = new Date().toISOString()): ResearchResult {
  if (body?.status !== 'ok' || !Array.isArray(body.data?.results)) throw new Error(`open-webSearch 搜索失败（${String(body?.error?.code || 'invalid_response').replace(/[^\w.-]/g, '').slice(0,60)}）。`);
  const seen = new Set<string>();
  const references: ResearchResult['references'] = [];
  for (const row of body.data.results.slice(0, 16)) {
    const url = typeof row?.url === 'string' && publicArticleUrl(row.url);
    if (!url || !usableSearchArticle(url) || seen.has(url) || typeof row.title !== 'string' || !row.title.trim()) continue;
    seen.add(url);
    references.push({ id: `ref-${references.length+1}`, title: row.title.slice(0,180), url, retrievedAt: now, verification: 'search-cited', excerpt: `搜索摘要（不是网页正文）：${String(row.description || '').slice(0,1800)}` });
  }
  if (!references.length) throw new Error('open-webSearch 没有返回可用的公开结果。');
  const failures = (body.data.partialFailures || []).slice(0,3).map((f:any) => ({ engine: String(f.engine).slice(0,40), code: String(f.code).slice(0,60) }));
  return { summary: 'open-webSearch 实际检索结果；排名不是热度，摘要待核查原文。\n'+JSON.stringify(references), references, queries: [{ provider: 'open-websearch', query, engines: body.data.engines, partialFailures: failures }] };
}
export async function searchOpenWeb(query: string, base = openWebBase()!, engines = openWebEngines()): Promise<ResearchResult> {
  if (!base || query.length > 1800) throw new Error('open-webSearch 服务未配置或查询过长。');
  const response = await jobFetch(openWebBase(base)!+'/search', { method:'POST', headers:{'Content-Type':'application/json'}, redirect:'error', signal:AbortSignal.timeout(15000), body:JSON.stringify({query,limit:10,engines,searchMode:'request'}) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`open-webSearch 搜索 HTTP ${response.status}。`); }
  return decodeOpenWebSearch(await response.json(), query);
}
