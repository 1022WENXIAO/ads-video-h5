import { jobFetch, currentJobSignal } from './jobExecution';
import type { ResearchReference } from '../src/types';
import type { researchGaps } from './narrativeResearch';
import { mapLimited } from './taskPool';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);
export function paperExcerpt(text:string):string{
  const keywords=/InfoNCE|focal loss|DPO|\\beta|β|KL.divergence|least.squares|Huber/ig;
  const sections=[text.slice(0,1800),...[...text.matchAll(keywords)].slice(0,8).map(m=>text.slice(Math.max(0,m.index!-200),m.index!+900))];
  return [...new Set(sections)].join('\n…\n').slice(0,8000);
}
async function readPaper(url:string):Promise<{title:string;excerpt:string}|undefined>{
  let dir:string|undefined;
  try{
    const response=await jobFetch(url,{redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!response.ok||!response.headers.get('content-type')?.includes('pdf')){await response.body?.cancel();return;}
    const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let length=0;
    for(;;){const r=await reader.read();if(r.done)break;length+=r.value.byteLength;if(length>5000000){await reader.cancel();return;}chunks.push(r.value);}
    dir=await mkdtemp(path.join(tmpdir(),'qingjian-paper-'));const file=path.join(dir,'paper.pdf');await writeFile(file,Buffer.concat(chunks),{mode:0o600});
    const {stdout}=await execFileAsync(process.env.QINGJIAN_RESEARCH_PYTHON||'python3',['-c','from pypdf import PdfReader; import sys; r=PdfReader(sys.argv[1]); print("\\n".join((p.extract_text() or "") for p in r.pages[:16]))',file],{timeout:15000,maxBuffer:500000,signal:currentJobSignal()});
    if(stdout.length<500)return;
    return {title:stdout.split('\n').map(s=>s.trim()).filter(Boolean).slice(0,2).join(' ').slice(0,180),excerpt:'实际论文PDF文本摘录（最多前16页，可能有数学排版提取误差）：\n'+paperExcerpt(stdout)};
  }catch{return;}finally{if(dir)await rm(dir,{recursive:true,force:true});}
}
async function bibliography(doi:string):Promise<ResearchReference|undefined>{
  try{
    const response=await jobFetch('https://api.crossref.org/works/'+encodeURIComponent(doi),{signal:AbortSignal.timeout(18000)});if(!response.ok)return;
    const record=(await response.json()).message;if(String(record?.DOI).toLowerCase()!==doi.toLowerCase()||!record.title?.[0])return;
    return {id:'',url:'https://doi.org/'+doi,title:record.title[0],verification:'primary-record',retrievedAt:new Date().toISOString(),excerpt:'实际读取Crossref出版方登记书目，只支持书目信息，不支持论文公式或实验结论：'+JSON.stringify({title:record.title,author:record.author,published:record.published,'container-title':record['container-title'],volume:record.volume,issue:record.issue,page:record.page,DOI:record.DOI})};
  }catch{return;}
}

const primaryHosts=new Set(['arxiv.org','openaccess.thecvf.com','proceedings.mlr.press','proceedings.neurips.cc','papers.nips.cc','jmlr.org','projecteuclid.org','dl.acm.org','link.springer.com','academic.oup.com','research.google','hastie.su.domains','archive.org','www.deeplearningbook.org','deeplearningbook.org','mitpress.mit.edu','www.wiley.com','doi.org','ieeexplore.ieee.org','docs.pytorch.org']);
export function primaryLessonUrl(value:string):string|undefined{
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.port||(!primaryHosts.has(u.hostname)&&!/(?:\.edu|\.ac\.[a-z]{2})$/.test(u.hostname)))return;
    if(u.hostname==='arxiv.org')u.pathname=u.pathname.replace(/^\/pdf\//,'/abs/').replace(/\.pdf$/,'').replace(/(\d{4}\.\d{4,5})v\d+$/,'$1');
    u.hash='';u.search='';return u.href;
  }catch{return;}
}
export function primaryPageText(html:string):{title:string;excerpt:string}|undefined{
  const plain=(v:string)=>v.replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&(?:nbsp|amp|quot|lt|gt);/g,m=>({'&nbsp;':' ','&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>'}[m]!)).replace(/\s+/g,' ').trim();
  const title=plain(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]||'');
  if(!title||/just a moment|access denied|captcha|security check|attention required|checking your browser/i.test(title))return;
  const abstract=/<blockquote[^>]*class=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i.exec(html)?.[1]||/<div[^>]*id=["']abstract["'][^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[1];
  // Some documentation puts a short footer <article> after the real <main>.
  // Strip inert/chrome markup first, then prefer the substantial content scope
  // rather than whichever article tag appears first (including in scripts).
  const clean=html.replace(/<(script|style|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi,' ');
  const candidates=[...clean.matchAll(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map(match=>plain(match[2]));
  const text=candidates.sort((a,b)=>b.length-a.length)[0]||plain(clean);if(text.length<100)return;
  return {title:title.slice(0,180),excerpt:(abstract?plain(abstract)+'\n页面日期/元数据：'+text.slice(0,2200):text.slice(0,4200)).slice(0,4200)};
}
async function readPrimary(url:string):Promise<{title:string;excerpt:string}|undefined>{
  try{
    let current=url;
    for(let redirects=0;redirects<3;redirects++){
      const response=await jobFetch(current,{redirect:'manual',signal:AbortSignal.timeout(18000),headers:{Accept:'text/html','User-Agent':'Qingjian-Lesson-Research/1.0'}});
      if(response.status>=300&&response.status<400){const next=response.headers.get('location');await response.body?.cancel();const validated=next&&primaryLessonUrl(new URL(next,current).href);if(!validated)return;current=validated;continue;}
      if(!response.ok||!response.headers.get('content-type')?.includes('text/html')){await response.body?.cancel();return;}
      const reader=response.body?.getReader();if(!reader)return;let length=0;const chunks:Uint8Array[]=[];
      while(length<250000){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.byteLength;chunks.push(chunk.value);}
      await reader.cancel();const html=Buffer.concat(chunks).toString('utf8');
      const refresh=/<meta\b[^>]*http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"']+)["']/i.exec(html)?.[1];
      if(refresh){const next=primaryLessonUrl(new URL(refresh,current).href);if(!next)return;current=next;continue;}
      return primaryPageText(html);
    }
  }catch{/* Unavailable primary pages remain explicit, never fabricated. */}
}

export function lessonResearchSummary(summary:string,references:ResearchReference[]):string{
  const body=summary.split('\n\n可用原始来源与实际网页摘录')[0];
  return body+'\n\n可用原始来源与实际网页摘录（以下ID为唯一权威映射，禁止使用以前搜索结果的编号；页面摘录不是论文全文）：\n'+JSON.stringify(references);
}
export async function verifyLessonResearch(raw:Awaited<ReturnType<typeof researchGaps>>,topic=''){
  const references:ResearchReference[]=raw.references.filter(r=>Boolean(primaryLessonUrl(r.url))).map(r=>({...r,url:primaryLessonUrl(r.url)!}));
  for(const ref of references){
    if(!ref.excerpt.startsWith('搜索引用：'))continue;
    const at=raw.summary.indexOf(ref.url)>=0?raw.summary.indexOf(ref.url):raw.summary.indexOf(ref.title);
    if(at<0)continue;const start=raw.summary.lastIndexOf('\n## ',at);
    ref.excerpt='实际联网检索摘要关联段落（不是网页原文）：'+raw.summary.slice(Math.max(0,start),Math.min(raw.summary.length,at+500)).slice(-3500);
  }
  const textUrls=[...raw.summary.matchAll(/https:\/\/[^\s<>"'\])]+/g)].map(m=>primaryLessonUrl(m[0].replace(/[.,;。；]+$/,''))).filter((u):u is string=>Boolean(u));
  const paperIds=raw.references.flatMap(r=>[...r.title.matchAll(/arxiv[:\s]+(\d{4}\.\d{4,5})/gi)].map(m=>`https://arxiv.org/abs/${m[1]}`));
  const formulaUrls=/损失函数|loss function/i.test(topic)?[...['MSELoss','L1Loss','HuberLoss','BCELoss','MarginRankingLoss'].map(n=>`https://docs.pytorch.org/docs/stable/generated/torch.nn.${n}.html`),'https://math.utep.edu/faculty/mleung/probabilityandstatistics/chronology.htm','https://research.google/pubs/support-vector-networks/']:[];
  const urls=[...new Set([...formulaUrls,...paperIds,...textUrls,...references.map(r=>r.url)])].filter(u=>!u.endsWith('.pdf')).slice(0,18);
  const pages=await mapLimited(urls,4,async url=>({url,page:await readPrimary(url)}));
  for(const {url,page} of pages){if(!page)continue;const prior=references.find(r=>r.url===url);
    if(prior){prior.excerpt=page.excerpt;prior.title=page.title;prior.verification='primary-page';}
    else references.push({id:'',url,title:page.title,excerpt:page.excerpt,retrievedAt:new Date().toISOString(),verification:'primary-page'});
  }
  const paperUrls=[...new Set(references.map(r=>r.url))].filter(u=>/^https:\/\/arxiv.org\/abs\/(?:1708\.02002|1807\.03748|2305\.18290)$/.test(u));
  for(const result of await mapLimited(paperUrls,3,async url=>({url,paper:await readPaper(url.replace('/abs/','/pdf/'))}))){if(result.paper){const ref=references.find(r=>r.url===result.url)!;ref.excerpt=ref.excerpt+'\n'+result.paper.excerpt;ref.verification='primary-paper';}}
  if(/损失函数|loss function/i.test(topic))for(const ref of await mapLimited(['10.1214/aoms/1177703732','10.1023/A:1022627411411'],2,bibliography)){if(ref&&!references.some(r=>r.url===ref.url))references.push(ref);}
  references.forEach((r,i)=>r.id=`ref-${i+1}`);
  if(references.length<3)throw new Error('教学研究缺少至少3个可核查的原始研究或教材来源，请定向检索原始论文。');
  return {...raw,summary:lessonResearchSummary(raw.summary,references),references};
}
