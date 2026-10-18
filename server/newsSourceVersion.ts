import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {LessonReport} from '../src/types';
import type {ResearchResult} from './researchTypes';
import {readPublicPage,type PublicReader} from './publicResearch';
import {verifyNewsPages} from './hotSources';
import {validateHotBrief} from './hotResearch';
import {throwIfJobCancelled} from './jobExecution';

const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Keep this independent of the scene renderer: only actual news source
// parsing/verification changes invalidate news checkpoints, never knowledge.
const parserHash=hash(['./newsPage.ts','./hotSources.ts','./newsDatePolicy.ts'].map(file=>readFileSync(new URL(file,import.meta.url),'utf8')).join('\n'));
export const newsSourceParserHash=()=>parserHash;

export async function preserveNewsSourceCheckpoint(work:string):Promise<{file:string;hash:string}>{
  const bytes=await readFile(path.join(work,'checkpoint.json')),digest=hash(bytes),directory=path.join(work,'news-source-history'),file=path.join(directory,digest+'.json');
  await mkdir(directory,{recursive:true,mode:0o700});
  try{await writeFile(file,bytes,{flag:'wx',mode:0o600});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(!(await readFile(file)).equals(bytes))throw new Error('新闻来源检查点历史SHA不一致，保留原文件并停止。',{cause:error});}
  return{file,hash:digest};
}

/** Re-read selected evidence, not discovery/search or media. A parser stamp
 * cannot be upgraded by copying old metadata. Keep the request cutoff fixed. */
export async function revalidateNewsSources(previous:ResearchResult,report:LessonReport|undefined,requestedAt:number,read:PublicReader=readPublicPage):Promise<{research:ResearchResult;valid:boolean;findings:string[]}>{
  if(!previous.current||!Number.isFinite(requestedAt))throw new Error('新闻来源重核缺少已选主题或原指令时间。');
  const used=new Set([...previous.current.topics.flatMap(topic=>topic.facts.flatMap(fact=>fact.evidence.map(e=>e.referenceId))),...(report?.chapters||[]).flatMap(chapter=>[...chapter.referenceIds,...chapter.claims.flatMap(claim=>claim.referenceIds)])]);
  const available=[...previous.references,...(report?.references||[])],selected=[] as ResearchResult['references'];
  for(const id of used){
    const matches=available.filter(ref=>ref.id===id),identities=new Set(matches.map(ref=>ref.url));
    if(!matches.length||identities.size!==1)return{research:previous,valid:false,findings:[`已选来源${id}缺失或歧义，不能沿用旧日期。`]};
    selected.push(matches[0]);
  }
  if(!selected.length||selected.length>12)return{research:previous,valid:false,findings:['已选新闻核心来源数量无效或超过既有12页读取预算，不能沿用旧日期。']};
  const failures=new Map<string,unknown>();
  const verified=await verifyNewsPages(selected,previous.current.windowHours,async url=>{
    try{return await read(url);}catch(error){failures.set(url,error);throw error;}
  },requestedAt);
  throwIfJobCancelled();
  // Incomplete network/OS reads are not evidence that the story is false and
  // must not silently trigger paid discovery or a new synthesized waveform.
  for(const page of verified.pages)if(page.status==='failed'&&failures.has(page.url)){
    throw new Error('新闻来源重核未完成：'+(page.reason||'读取失败')+'；保留旧版本标记和已有音频，不能据此重录。',{cause:failures.get(page.url)});
  }
  const now=Date.now(),current={...previous.current,asOf:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString(),failures:verified.failures},next:ResearchResult={...previous,references:verified.references,current,summary:`已按原指令截止${new Date(requestedAt).toISOString()}重新读取已选新闻正文与日期；未刷新热榜、未搜索新事件。\n`+JSON.stringify(verified.references),queries:[...previous.queries,{provider:'source-pages',action:'parser-revalidation',cutoffUtc:new Date(requestedAt).toISOString(),urls:selected.map(ref=>ref.url)}]};
  const findings:string[]=[];
  try{
    if(!current.topics.length)throw new Error('没有已选新闻主题。');
    validateHotBrief(current.topics,verified.references,current.signals,current.datePolicy);
    for(const id of used)if(!verified.references.some(ref=>ref.id===id))throw new Error(`已选来源${id}未能重新取得正文。`);
  }catch(error){findings.push(error instanceof Error?error.message:String(error));}
  return{research:next,valid:!findings.length,findings};
}
