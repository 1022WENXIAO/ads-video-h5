import type { HotTopicSignal, ResearchReference } from '../src/types';
import { publicResearchUrl, readPublicPage, type PublicReader } from './publicResearch';
import { mapLimited } from './taskPool';
import {readNewsCanonical,readNewsDocument,readPublication} from './newsPage';
import {currentJobSignal,throwIfJobCancelled} from './jobExecution';
import {newsSourceCandidates,newsSourceIdentity,newsSourceRejection} from './newsSourceUrls';

export const baiduBoard='https://top.baidu.com/board?tab=realtime';
export const hnBoard='https://news.ycombinator.com/';
const plain=(s:string)=>s.replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,v)=>{const n=parseInt(v.replace(/^x/i,''),/^x/i.test(v)?16:10);return n>0&&n<0x110000?String.fromCodePoint(n):' ';}).replace(/&(?:nbsp|amp|quot|lt|gt|apos);/gi,m=>({'&nbsp;':' ','&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>','&apos;':"'"}[m.toLowerCase()]||m)).replace(/\s+/g,' ').trim();
export const normalizeEvidence=(s:string)=>plain(s).replace(/\s/g,'');

export function parseBaiduBoard(html:string,observedAt:string):HotTopicSignal[]{
  const chunk=/<!--s-data:([\s\S]*?)-->/.exec(html)?.[1];
  if(!chunk)throw new Error('百度热榜页面格式已变化，未读取到榜单。');
  const data=JSON.parse(chunk),rows=data.data?.cards?.find((c:any)=>c.component==='hotList')?.content;
  if(!Array.isArray(rows))throw new Error('百度热榜没有实际榜单数据。');
  let rank=0;
  return rows.slice(0,35).flatMap((r:any)=>{
    const url=publicResearchUrl(r.url||r.rawUrl||''),title=plain(String(r.word||r.query||''));
    if(!url||!title)return [];
    const pinned=r.isTop===true;if(!pinned)rank++;
    const score=Number(r.hotScore);
    return [{id:`baidu-${pinned?'pinned':rank}`,title:title.slice(0,180),url,boardUrl:baiduBoard,source:'baidu' as const,rank:pinned?0:rank,pinned,observedAt,description:plain(String(r.desc||'')).slice(0,600),...(Number.isFinite(score)&&score>=0?{metric:{label:'百度热搜指数',value:score}}:{})}];
  });
}
export function parseHnItem(item:any,rank:number,observedAt:string):HotTopicSignal|undefined{
  if(item?.type!=='story'||item.dead||item.deleted||!Number.isSafeInteger(item.id)||typeof item.title!=='string')return;
  const url=publicResearchUrl(item.url||'')||`https://news.ycombinator.com/item?id=${item.id}`;
  const submittedAt=Number.isFinite(item.time)?new Date(item.time*1000).toISOString():undefined;
  return {id:`hn-${item.id}`,title:plain(item.title).slice(0,180),url,boardUrl:hnBoard,source:'hackernews',rank,observedAt,submittedAt,description:'HN社区当前榜单；提交时间不是原文章发布时间。',...(Number.isFinite(item.score)&&item.score>=0?{metric:{label:'HN积分',value:item.score}}:{})};
}
let hnRetryAt = 0;
export async function discoverHotTopics(read:PublicReader=readPublicPage,now=Date.now(),options:{timeoutMs?:number}={}){
  const observedAt=new Date(now).toISOString(),failures:string[]=[];
  const timeoutMs=options.timeoutMs??5000;
  async function feed<T>(load:(reader:PublicReader)=>Promise<T>):Promise<T>{
    const controller=new AbortController();
    const signal=currentJobSignal();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      return await Promise.race([load((url)=>{combined.throwIfAborted();return read(url,{signal:combined,timeoutMs});}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('热榜读取超过预算，继续检索新闻正文。'));},timeoutMs);})]);
    }finally{clearTimeout(timer);controller.abort();}
  }
  const feeds=await Promise.allSettled([
    feed(reader=>reader(baiduBoard).then(page=>parseBaiduBoard(page.text,observedAt))),
    read===readPublicPage&&now<hnRetryAt?Promise.reject(new Error('近期访问失败，五分钟内跳过该可选热榜。')):feed(async reader=>{const ids=JSON.parse((await reader('https://hacker-news.firebaseio.com/v0/topstories.json')).text);if(!Array.isArray(ids))throw new Error('HN榜单无效');
      const results=await mapLimited(ids.filter(Number.isSafeInteger).slice(0,20),4,async(id,index)=>{try{return parseHnItem(JSON.parse((await reader(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).text),index+1,observedAt);}catch{failures.push(`HN条目${id}读取失败`);return;}});
      return results.filter((v):v is HotTopicSignal=>Boolean(v));}),
  ]);
  throwIfJobCancelled();
  if(read===readPublicPage&&feeds[1].status==='rejected'&&now>=hnRetryAt)hnRetryAt=now+5*60000;
  const signals:HotTopicSignal[]=[];
  feeds.forEach((r,i)=>{if(r.status==='fulfilled')signals.push(...r.value);else failures.push(`${i?'Hacker News':'百度'}热榜不可用：${r.reason instanceof Error?r.reason.message:'读取失败'}`);});
  if(!signals.length)failures.push('没有可验证热度信号；仍可查证有日期的新闻，不得声称已上热榜。');
  return {signals,failures,observedAt};
}
export function newsWindowHours(prompt:string):number{
  if(/今日|今天|当日|today/i.test(prompt))return 24;
  const range=/(?:近|过去|最近)\s*(\d+|[一二三四五六七八九十两]+)\s*(天|小时|周)/.exec(prompt);
  const english=/\b(?:last|past)\s+(\d+)\s+(hours?|days?|weeks?)\b/i.exec(prompt);
  if(range||english){
    const value=(range||english)![1],unit=(range||english)![2].toLowerCase();
    const digits='零一二三四五六七八九';
    const parts=value.replace(/两/g,'二').split('十');
    const count=/^\d+$/.test(value)?Number(value):parts.length===2?(parts[0]?digits.indexOf(parts[0]):1)*10+(parts[1]?digits.indexOf(parts[1]):0):digits.indexOf(parts[0]);
    return Math.min(720,Math.max(1,count*(/天|day/.test(unit)?24:/周|week/.test(unit)?168:1)));
  }
  const configured=Number(process.env.QINGJIAN_NEWS_WINDOW_HOURS||72);
  return /本周|近一周|一周|this week/i.test(prompt)?168:Number.isFinite(configured)&&configured>=1&&configured<=720?configured:72;
}
export function articlePublication(html:string):{publishedAt?:string;dateEvidence?:string}{
  return readPublication(html);
}
export function freshness(publishedAt:string|undefined,now:number,hours:number):NonNullable<ResearchReference['freshness']>{
  const at=Date.parse(publishedAt&&/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)?publishedAt+'T00:00:00+08:00':publishedAt||'');if(!Number.isFinite(at))return 'undated';if(at>now+60000)return 'future';return now-at<=hours*3600000?'fresh':'stale';
}
export function parseNewsPage(html:string):{title:string;excerpt:string;publishedAt?:string;dateEvidence?:string}{
  return readNewsDocument(html);
}
export async function verifyNewsPages(references:ResearchReference[],hours:number,read:PublicReader=readPublicPage,now=Date.now()){
  const pages:Array<{url:string;finalURL?:string;status:'read'|'failed';reason?:string;retryable?:boolean}>=[];
  const failures:string[]=[];const rows=await mapLimited(newsSourceCandidates([references],()=>true,12,12),3,async ref=>{
    try{const rejected=newsSourceRejection(ref.url);if(rejected)throw new Error(rejected);const page=await read(ref.url),parsed=parseNewsPage(page.text),url=readNewsCanonical(page.text,page.url);const redirectRejection=newsSourceRejection(url);if(redirectRejection)throw new Error(redirectRejection);pages.push({url:ref.url,finalURL:url,status:'read'});return {...ref,...parsed,publishedAt:parsed.publishedAt,dateEvidence:parsed.dateEvidence,url,retrievedAt:new Date().toISOString(),verification:'news-page' as const,freshness:freshness(parsed.publishedAt,now,hours)};}
    catch(error){throwIfJobCancelled();const reason=error instanceof Error?error.message:'读取失败';failures.push(`${ref.title}：${reason}`);pages.push({url:ref.url,status:'failed',reason,retryable:/HTTP (?:429|5\d\d)|超时|timeout|fetch failed|ECONN|网络/i.test(reason)});return;}
  });
  const unique=new Map<string,NonNullable<typeof rows[number]>>();for(const row of rows)if(row&&!unique.has(newsSourceIdentity(row.url)))unique.set(newsSourceIdentity(row.url),row);
  const verified=[...unique.values()];
  return {references:verified,failures,pages,metrics:{attempted:pages.length,read:verified.length,failed:pages.filter(p=>p.status==='failed').length,dated:verified.filter(r=>r.publishedAt).length,fresh:verified.filter(r=>r.freshness==='fresh').length,undated:verified.filter(r=>r.freshness==='undated').length}};
}
