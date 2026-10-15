import type {LessonReport} from '../shared/types';

const compact=(value:string)=>value.replace(/\s+/g,' ').trim();
const trusted=new Set(['news-page','primary-page','primary-record','primary-paper','public-page']);
const actionPattern='修复|恢复|开放|上线|发布|部署|交付|完成|批准|实施';
const clauses=(value:string)=>value.split(/[，,。；;！？!?]/).map(compact).filter(Boolean);
const quotes=(value:string)=>[...value.matchAll(/[“「『"]([^”」』"\n]{4,180})[”」』"]/g)].map(match=>compact(match[1]));
function completed(value:string,action:string):boolean{
  return clauses(value).some(clause=>{
    const at=clause.indexOf(action);if(at<0)return false;
    const before=clause.slice(0,at);
    return /(?:已|已经|完成)/.test(before)&&!/(?:未|尚|没有|正在|仍在|计划|准备|预计|宣布|将|拟)/.test(before);
  });
}
function pending(value:string,action:string):boolean{
  return clauses(value).some(clause=>new RegExp(`(?:正在|仍在|正|计划|准备|预计|将要|即将|将|拟|尚未|还未|仍未)(?:实施|进行|着手|推进)?[^，,。；;！？!?]{0,12}${action}`).test(clause));
}
function scope(value:string):'all'|'partial'|undefined{
  if(/全部|所有|全体|全量|全站|全面/.test(value))return'all';
  if(/部分|局部|少量|某些|试点|分批/.test(value))return'partial';
}
const actor=(value:string)=>compact(value.split(/已|正在|仍在|计划|准备|预计|将|拟|尚未|还未|仍未/)[0]).replace(/[“”「」『』：:]/g,'');
function anchors(script:string,action:string):string[]{
  const content=script.replaceAll(action,'').replace(/已经|正在|仍在|计划|准备|预计|将要|即将|尚未|还未|仍未|全部|所有|全量|部分|实施|官方|公司|模型|用户|开发者/g,' ');
  return [...content.matchAll(/[\p{Script=Han}]{3,}|[A-Za-z][A-Za-z0-9._-]{2,}/gu)].flatMap(match=>{
    const text=match[0];return /[A-Za-z]/.test(text)?[text]:Array.from({length:Math.max(0,text.length-2)},(_,i)=>text.slice(i,i+3));
  });
}
function sameContext(script:string,claim:string,action:string):boolean{
  // A repeated predicate alone cannot bind different incidents in one chapter.
  if(/此前|上次|去年|昨日|昨天|上一轮/.test(script)!==/此前|上次|去年|昨日|昨天|上一轮/.test(claim))return false;
  const left=actor(script),right=actor(claim);
  if(left.length>=2&&right.length>=2&&!left.startsWith(right)&&!right.startsWith(left))return false;
  return anchors(script,action).some(part=>claim.includes(part));
}
function localSourceContext(script:string,excerpt:string,quote:string,action:string):boolean{
  const value=compact(excerpt),at=value.indexOf(quote);if(at<0)return false;
  const local=value.slice(Math.max(0,at-100),at+quote.length+100),subject=actor(script);
  return (subject.length<2||local.includes(subject))&&anchors(script,action).some(anchor=>local.includes(anchor));
}

/** Promote only an explicitly quoted correction already supported by this
 * chapter's actual source evidence. This is not a general event-state parser:
 * ambiguous actors/time scopes remain for the independent review to assess. */
export function lessonFactualCorrectionFindings(report:LessonReport,suggestions:readonly string[]=[]):string[]{
  const findings:string[]=[];
  for(const suggestion of suggestions.slice(0,36)){
    if(!/(?:建议|应|须|需要|必须).{0,12}(?:改为|改成|改写|明确|保留|使用)/.test(suggestion))continue;
    const chapter=report.chapters?.find(chapter=>suggestion.startsWith(chapter.id+'：')||suggestion.startsWith(chapter.id+':'));if(!chapter)continue;
    const cited=quotes(suggestion),visible=[chapter.narration,chapter.title,chapter.visual?.takeaway,...(chapter.visual?.items||[]).flatMap(item=>[item.label,item.detail])].filter((v):v is string=>typeof v==='string').map(compact);
    const actual=cited.filter(quote=>visible.some(value=>value.includes(quote)));
    for(const scriptQuote of actual)for(const sourceQuote of cited){
      if(scriptQuote===sourceQuote)continue;
      for(const claim of chapter.claims||[]){
        if(claim.basis!=='source'||!compact(claim.text).includes(sourceQuote))continue;
        const sources=claim.referenceIds.filter(id=>chapter.referenceIds.includes(id)).flatMap(id=>{const refs=report.references.filter(ref=>ref.id===id);return refs.length===1&&trusted.has(refs[0].verification||'')&&compact(refs[0].excerpt).includes(sourceQuote)?refs:[];});
        if(!sources.length)continue;
        const actions=[...new Set((sourceQuote.match(new RegExp(actionPattern,'g'))||[]))];
        const action=actions.find(action=>scriptQuote.includes(action)&&sameContext(scriptQuote,claim.text,action)&&sources.some(ref=>localSourceContext(scriptQuote,ref.excerpt,sourceQuote,action))&&(completed(scriptQuote,action)&&pending(sourceQuote,action)||scope(scriptQuote)==='all'&&scope(sourceQuote)==='partial'));
        if(!action)continue;
        // A source-backed completed state in the same local claim makes a
        // historical/current transition ambiguous, rather than an automatic veto.
        if(completed(claim.text,action)&&!(scope(scriptQuote)==='all'&&scope(sourceQuote)==='partial'))continue;
        const evidenceSources=sources.filter(ref=>localSourceContext(scriptQuote,ref.excerpt,sourceQuote,action));
        findings.push(`${chapter.id}：本版原句「${scriptQuote}」改变了事实状态或范围；本章实际来源${evidenceSources.map(ref=>ref.id).join('、')}原话「${sourceQuote}」。这是事实纠正，不能降为非阻塞措辞建议。`);
      }
    }
  }
  return [...new Set(findings)];
}

export function needsPassedScriptAdjudication(review:NonNullable<LessonReport['factReview']>):boolean{
  return !review.needsRepair&&review.score>=80&&!review.adjudication&&Boolean(review.suggestions?.length);
}
