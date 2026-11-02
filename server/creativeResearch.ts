import type { ResearchResult } from './researchTypes';
import { publicResearchUrl,readPublicPage,type PublicReader } from './publicResearch';
import { lessonResearchSummary,primaryLessonUrl,primaryPageText,verifyLessonResearch } from './lessonResearch';
import { mapLimited } from './taskPool';
import { throwIfJobCancelled } from './jobExecution';
import { researchGaps } from './narrativeResearch';
import type { ModelConfig } from './modelRegistry';
import type { createToolTrace } from './toolTrace';

// Academic loss-history videos retain their stricter scholarly source gate.
// A short product/tutorial is supported by its actual publisher pages instead
// of a machine-learning paper whitelist. Reading a page does not establish
// its authority: the independent claim review must still decide that.
export async function verifyCreativeResearch(raw:ResearchResult,prompt:string,read:PublicReader=readPublicPage):Promise<ResearchResult>{
  if(/损失函数|loss function/i.test(prompt))return verifyLessonResearch(raw,prompt);
  const references=raw.references.filter(r=>publicResearchUrl(r.url)).slice(0,12).map(r=>({...r}));
  const reads=await mapLimited(references,4,async ref=>{
    try{
      ref.verification='search-cited';
      const page=await read(ref.url);throwIfJobCancelled();
      const parsed=primaryPageText(page.text);
      if(!parsed)throw new Error('页面无法读取有效正文或是访问检查。');
      const url=publicResearchUrl(page.url);if(!url)throw new Error('资料跳转地址无效。');
      const authoritative=Boolean(primaryLessonUrl(url)||/\.(?:gov|gov\.[a-z]{2})$/.test(new URL(url).hostname));
      Object.assign(ref,{url,title:parsed.title,excerpt:parsed.excerpt,verification:authoritative?'primary-page':'public-page',retrievedAt:new Date().toISOString()});
      return {url,status:'completed',verification:ref.verification};
    }catch(error){throwIfJobCancelled();return {url:ref.url,status:'failed',reason:error instanceof Error?error.message:String(error)};}
  });
  const verified=references.filter(r=>['primary-page','public-page'].includes(r.verification));
  if(!verified.length)throw new Error('创作研究缺少实际可读的来源正文；请定向查证发布者的公开说明或可靠教材，不能用标题和模型记忆代替事实。');
  // Keep search citations explicitly labelled, preserving stable source IDs.
  // All unsupported facts must fail the same independent script review.
  return {...raw,references,summary:lessonResearchSummary(raw.summary,references),queries:[...raw.queries,...reads.map(r=>({provider:'page-read',...r}))]};
}

export async function researchCreativeTopic(config:ModelConfig,topic:string,questions:string[],prompt:string,options:{search?:typeof researchGaps;read?:PublicReader;trace?:ReturnType<typeof createToolTrace>}={}){
  const search=options.search||researchGaps,academic=/损失函数|loss function/i.test(prompt);
  const verify=(raw:ResearchResult)=>verifyCreativeResearch(raw,prompt,options.read);
  const run=async()=>verify(await search(config,topic,questions,academic?'lesson':'short'));
  try{return await run();}
  catch(error){
    throwIfJobCancelled();const detail=error instanceof Error?error.message:String(error);
    if(!/缺少.*(?:来源|正文)|无法读取有效正文/.test(detail))throw error;
    const alternative=async()=>verify(await search(config,topic,[...questions.slice(0,4),'上一策略未取得有效正文：'+detail+'。改查同一主题的官方说明、公开教材或发布者页面；避开只有摘要、访问检查和不可读PDF的页面。保留原始主题与版本。'],academic?'lesson':'short'));
    return options.trace?options.trace.run('research_alternative','调整检索范围并重读来源',{topic,reason:detail,strategy:'same-subject-readable-publisher'},alternative):alternative();
  }
}
