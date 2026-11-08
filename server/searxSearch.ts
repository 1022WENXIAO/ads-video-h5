import {jobFetch} from './jobExecution';
import {openWebBase,decodeOpenWebSearch} from './openWebSearch';
/** SearXNG stays a separate local service; no upstream source is vendored. */
export async function searchSearx(query:string,configured=process.env.QINGJIAN_SEARXNG_URL){
  if(!configured)throw Error('SearXNG 尚未配置。');const base=openWebBase(configured)!;
  const url=new URL('/search',base);url.searchParams.set('q',query.slice(0,1800));url.searchParams.set('format','json');url.searchParams.set('language','zh-CN');url.searchParams.set('safesearch','1');
  const response=await jobFetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok){await response.body?.cancel();throw Error('SearXNG 搜索 HTTP '+response.status);}
  const body=await response.json();if(!Array.isArray(body?.results))throw Error('SearXNG 未返回 JSON 搜索结果。');
  const result=decodeOpenWebSearch({status:'ok',data:{results:body.results.slice(0,16).map((r:any)=>({url:r?.url,title:r?.title,description:r?.content})),engines:[],partialFailures:[]}},query);
  return{...result,summary:'SearXNG 实际搜索摘要，正文仍需独立读取。\n'+JSON.stringify(result.references),queries:[{provider:'searxng',query,unresponsiveEngines:body.unresponsive_engines||[]}]};
}
