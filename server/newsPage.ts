import {parse,parseFragment,type DefaultTreeAdapterTypes as Tree} from 'parse5';
import {canonicalNewsUrl} from './newsSourceUrls';

const element=(node:Tree.Node):node is Tree.Element=>'tagName' in node;
const attr=(node:Tree.Element,name:string)=>node.attrs.find(a=>a.name===name)?.value||'';
const children=(node:Tree.Node):Tree.Node[]=>'childNodes' in node?node.childNodes:[];
const compact=(value:string)=>value.replace(/\s+/g,' ').trim();
const ignored=(node:Tree.Element)=>/^(?:script|style|nav|aside|footer|form|button|template|noscript|svg|canvas|iframe|head)$/.test(node.tagName)||attr(node,'aria-hidden')==='true'||node.attrs.some(a=>a.name==='hidden')||/(?:^|[\s_-])(?:related|recommend|share|cookie|breadcrumb|menu|comment|advert)(?:$|[\s_-])/i.test(attr(node,'class')+' '+attr(node,'id'));
function ignoredParent(node:Tree.Element):boolean{
  let parent=node.parentNode;
  while(parent&&element(parent)){if(ignored(parent))return true;parent=parent.parentNode;}
  return false;
}
function nodes(root:Tree.Node):Tree.Element[]{
  const result:Tree.Element[]=[],stack=[root];
  while(stack.length&&result.length<50000){const node=stack.pop()!;if(element(node))result.push(node);stack.push(...children(node).slice().reverse());}
  return result;
}
function text(root:Tree.Node,visible=true):string{
  const parts:string[]=[],stack=[root];let size=0;
  if(visible&&element(root)&&ignoredParent(root))return '';
  while(stack.length&&size<20000){
    const node=stack.pop()!;
    if(node.nodeName==='#text'&&'value' in node){parts.push(node.value);size+=node.value.length;continue;}
    if(element(node)&&visible){
      if(ignored(node))continue;
      if(/^(?:p|div|article|main|section|h[1-6]|br|li|time)$/.test(node.tagName))parts.push(' ');
    }
    stack.push(...children(node).slice().reverse());
  }
  return compact(parts.join(' '));
}

const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const datePattern=/(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?:[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/i;
export function sourceDate(value:string):string|undefined{
  let v=compact(value),match:RegExpExecArray|null;
  if((match=/^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(v))){
    const month=months.findIndex(m=>m.toLowerCase().startsWith(match![1].replace(/\.$/,'').toLowerCase()));
    if(month<0)return;v=`${match[3]}-${String(month+1).padStart(2,'0')}-${match[2].padStart(2,'0')}`;
  }
  v=v.replace(/^(\d{4})[/.年](\d{1,2})[/.月](\d{1,2})日?/,'$1-$2-$3');
  match=/^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(v);if(!match)return;
  const date=`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}`,tail=match[4];
  const check=new Date(date+'T00:00:00Z');if(!Number.isFinite(check.getTime())||check.toISOString().slice(0,10)!==date)return;
  if(!tail)return date;
  if(!/^[T\s]+\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/i.test(tail))return;
  let full=date+tail.replace(/^[T\s]+/,'T').replace(/^T(\d):/,'T0$1:');
  if(!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(full))full+='+08:00';
  const time=Date.parse(full);return Number.isFinite(time)?new Date(time).toISOString():undefined;
}

function articleData(elements:Tree.Element[],title:string):Record<string,any>[] {
  const result:Record<string,any>[]=[];
  for(const script of elements.filter(n=>n.tagName==='script'&&attr(n,'type').toLowerCase()==='application/ld+json')){
    try{
      const root=JSON.parse(text(script,false)),queue=Array.isArray(root)?[...root]:[root];
      for(let count=0;queue.length&&count<100;count++){
        const node=queue.shift();if(!node||typeof node!=='object')continue;
        const types=Array.isArray(node['@type'])?node['@type']:[node['@type']];
        if(types.some((v:unknown)=>typeof v==='string'&&/^(?:NewsArticle|Article|BlogPosting|ReportageNewsArticle|TechArticle)$/.test(v)))result.push(node);
        for(const key of ['@graph','mainEntity']){if(Array.isArray(node[key]))queue.push(...node[key]);else if(node[key]&&typeof node[key]==='object')queue.push(node[key]);}
      }
    }catch{}
  }
  const key=title.toLowerCase().replace(/\s/g,'').slice(0,20);
  return result.sort((a,b)=>Number(typeof b.headline==='string'&&b.headline.toLowerCase().replace(/\s/g,'').includes(key))-Number(typeof a.headline==='string'&&a.headline.toLowerCase().replace(/\s/g,'').includes(key)));
}

function publication(elements:Tree.Element[],data:Record<string,any>[]):{publishedAt?:string;dateEvidence?:string}{
  for(const node of data){const date=sourceDate(String(node.datePublished||''));if(date)return {publishedAt:date,dateEvidence:`JSON-LD datePublished: ${node.datePublished}`};}
  for(const node of elements.filter(n=>n.tagName==='meta')){
    const name=attr(node,'property')||attr(node,'name')||attr(node,'itemprop');
    if(!/^(?:article:published_time|datePublished|pubdate|publishdate|publish_time|OriginalPublicationDate|DC.date.issued)$/i.test(name))continue;
    const value=attr(node,'content'),date=sourceDate(value);if(date)return {publishedAt:date,dateEvidence:`meta ${name}: ${value}`};
  }
  for(const node of elements){
    const descriptor=[attr(node,'class'),attr(node,'id'),attr(node,'itemprop')].join(' ');
    let parent=node.parentNode,modified=/modif|updat|copyright/i.test(descriptor);
    while(parent&&element(parent)&&!['article','main','body'].includes(parent.tagName)){modified ||= /modif|updat|copyright/i.test(attr(parent,'class')+' '+attr(parent,'id')+' '+attr(parent,'itemprop'));parent=parent.parentNode;}
    if(modified||ignoredParent(node))continue;
    const field=/(?:publish|publication|release).*(?:time|date)|datePublished|(?:article|post|news|detail)[-_](?:info|meta|date|time)|\bbyline\b/i.test(descriptor);
    if(!field&&node.tagName!=='time')continue;
    const value=attr(node,'datetime')||attr(node,'content')||attr(node,'value')||text(node);
    if(value.length>700||/更新时间|更新于|Last updated|Modified/i.test(value))continue;
    const candidate=datePattern.exec(value)?.[0],date=candidate&&sourceDate(candidate);
    if(date)return {publishedAt:date,dateEvidence:`原页发布字段：${candidate}`};
  }
  for(const node of elements.filter(n=>['article','main','p'].includes(n.tagName))){
    const value=text(node),label=/(?:发布时间|发布日期|发布于|Published(?: on)?)[：:\s]*/i.exec(value);
    if(!label)continue;
    const candidate=datePattern.exec(value.slice(label.index+label[0].length, label.index+label[0].length+80))?.[0],date=candidate&&sourceDate(candidate);
    if(date)return {publishedAt:date,dateEvidence:label[0]+candidate};
  }
  return {};
}

export function readNewsDocument(html:string):{title:string;excerpt:string;publishedAt?:string;dateEvidence?:string}{
  const document=parse(html),elements=nodes(document);
  const titleNode=elements.find(n=>n.tagName==='title'),metaTitle=elements.find(n=>n.tagName==='meta'&&attr(n,'property')==='og:title'),heading=elements.find(n=>n.tagName==='h1');
  const title=compact(titleNode?text(titleNode,false):'')||(metaTitle?attr(metaTitle,'content'):'')||(heading?text(heading):'');
  if(!title||/just a moment|access denied|captcha|security check|attention required|checking your browser|验证|访问受限/i.test(title))throw new Error('新闻页面不可读或要求验证。');
  const data=articleData(elements,title),candidates:Array<{value:string;score:number}>=[];
  for(const node of elements){
    if(candidates.length>=64)break;
    const descriptor=attr(node,'id')+' '+attr(node,'class'),body=node.tagName==='body',main=node.tagName==='main'||attr(node,'role')==='main';
    const article=node.tagName==='article'||attr(node,'itemprop')==='articleBody',content=/(?:article|post|news|detail)[-_]?(?:body|content)|rich_media_content|content[-_]?(?:article|body)/i.test(descriptor);
    if(!body&&!main&&!article&&!content)continue;
    const value=text(node);if(value.length<180)continue;
    const score=(article?100:content?90:main?30:0)+Math.min(value.length/100,40);
    candidates.push({value,score});
  }
  for(const node of data)if(typeof node.articleBody==='string'){
    const value=text(parseFragment(node.articleBody));if(value.length>=180)candidates.push({value,score:140+Math.min(value.length/100,40)});
  }
  const excerpt=candidates.sort((a,b)=>b.score-a.score)[0]?.value.slice(0,9000)||'';
  if(excerpt.length<180||/enable javascript and cookies|please enable javascript to continue|verify you are human/i.test(excerpt)&&excerpt.length<700)throw new Error('新闻页面正文不足，不能当作已核验来源。');
  return {title:title.slice(0,180),excerpt,...publication(elements,data)};
}

export function readPublication(html:string):{publishedAt?:string;dateEvidence?:string}{
  const elements=nodes(parse(html)),title=text(elements.find(n=>n.tagName==='title')||parseFragment(''),false);
  return publication(elements,articleData(elements,title));
}

/** A canonical link can resolve a site's own article aliases, but cannot turn
 * a different publisher or a section/home page into the page we actually read. */
export function readNewsCanonical(html:string, finalURL:string):string {
  const actual=new URL(finalURL),host=(url:URL)=>url.hostname.toLowerCase().replace(/^www\./,'');
  for(const node of nodes(parse(html)).filter(n=>n.tagName==='link'&&attr(n,'rel').toLowerCase().split(/\s+/).includes('canonical'))){
    try{
      const candidate=new URL(attr(node,'href'),actual);
      if(!['https:','http:'].includes(candidate.protocol)||candidate.username||candidate.password||host(candidate)!==host(actual)||candidate.pathname==='/'||candidate.pathname!==actual.pathname&&actual.pathname.startsWith(candidate.pathname.replace(/\/?$/,'/')))continue;
      return canonicalNewsUrl(candidate.href);
    }catch{}
  }
  return canonicalNewsUrl(actual.href);
}
