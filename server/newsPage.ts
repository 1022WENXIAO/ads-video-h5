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
const contains=(root:Tree.Element,node:Tree.Element)=>{
  let parent:Tree.Node|null=node;
  while(parent){if(parent===root)return true;parent='parentNode' in parent?parent.parentNode:null;}
  return false;
};
function entryParent(node:Tree.Element):Tree.Element|undefined{
  let parent:Tree.Node|null=node;
  while(parent&&element(parent)){
    if(['li','tr'].includes(parent.tagName)||attr(parent,'role')==='listitem'||attr(parent,'itemprop')==='itemListElement')return parent;
    parent=parent.parentNode;
  }
}
function nestedIn(node:Tree.Element,parents:Set<Tree.Element>):boolean{
  let parent=node.parentNode;
  while(parent&&element(parent)){if(parents.has(parent))return true;parent=parent.parentNode;}
  return false;
}
function inArticleScope(node:Tree.Element,article:Tree.Element|undefined):boolean{
  if(entryParent(node))return false;
  if(!article)return true;
  let parent:Tree.Node|null=node;
  while(parent&&element(parent)){
    if(parent===article)return true;
    if(parent.tagName==='article')return false;
    parent=parent.parentNode;
  }
  return false;
}
function primaryArticle(elements:Tree.Element[]):Tree.Element|undefined{
  const articles=elements.filter(n=>(n.tagName==='article'||attr(n,'itemprop')==='articleBody')&&!ignored(n)&&!ignoredParent(n)&&!entryParent(n));
  const articleSet=new Set(articles),top=articles.filter(n=>!nestedIn(n,articleSet));
  if(top.length===1)return top[0];
  const headed=top.filter(n=>nodes(n).some(child=>child.tagName==='h1'&&!entryParent(child)));
  return headed.length===1?headed[0]:undefined;
}
function collectionPage(elements:Tree.Element[]):boolean{
  const times=elements.filter(n=>n.tagName==='time'&&!ignoredParent(n));
  const entries=new Set(times.map(entryParent).filter(Boolean));
  if(entries.size>1)return true;
  const articles=new Set<Tree.Element>();
  for(const time of times){let parent=time.parentNode;while(parent&&element(parent)){if(parent.tagName==='article')articles.add(parent);parent=parent.parentNode;}}
  return [...articles].filter(n=>!nestedIn(n,articles)).length>1;
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
const nonPublication=/(?:更新|修改)(?:时间|日期|于)|最后(?:更新|修改)|(?:网站|系统|当前|现在)(?:时间|日期|时钟)|Last\s+updated|Copyright|版权|活动开始|会议时间|开幕时间|截止时间|\b(?:updated|modified|clock|event|scheduled|deadline|current\s+(?:time|date)|site\s+(?:time|date))\b/i;
const updateLabel=(node:Tree.Element)=>/^更新[：:\s]*$/.test(text(node));
function nonPublicationByline(node:Tree.Element):boolean{
  const parent=node.parentNode,scope=parent&&element(parent)&&['p','div','span','header'].includes(parent.tagName)&&text(parent).length<=220?parent:node;
  return nonPublication.test(text(scope))||nodes(scope).some(updateLabel);
}
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
        else if(/^https?:\/\/ziyuan\.baidu\.com\/contexts\/cambrian\.jsonld$/.test(String(node['@context']))&&typeof node.title==='string'&&typeof node.pubDate==='string')result.push({...node,headline:node.title});
        for(const key of ['@graph','mainEntity']){if(Array.isArray(node[key]))queue.push(...node[key]);else if(node[key]&&typeof node[key]==='object')queue.push(node[key]);}
      }
    }catch{}
  }
  const key=(value:string)=>compact(value).toLowerCase();
  const article=primaryArticle(elements);
  const articleSet=new Set(elements.filter(n=>n.tagName==='article'));
  const headings=elements.filter(n=>n.tagName==='h1'&&!ignoredParent(n)&&inArticleScope(n,article)&&(!!article||!nestedIn(n,articleSet)));
  const identities=(headings.length?headings.map(n=>text(n)):[title]).map(key).filter(Boolean);
  if(new Set(identities).size>1)return [];
  if(!identities.length)return result.length===1?result:[];
  const exact=result.filter(node=>typeof node.headline==='string'&&identities.includes(key(node.headline)));
  const matched=exact.length?exact:headings.length?[]:result.filter(node=>{
    if(typeof node.headline!=='string'||key(node.headline).length<8)return false;
    const headline=compact(node.headline).toLowerCase(),pageTitle=compact(title).toLowerCase();
    return pageTitle.startsWith(headline)&&/^\s*(?:\||｜|[-–—])\s*\S/u.test(pageTitle.slice(headline.length));
  });
  if(matched.length)return new Set(matched.map(node=>key(node.headline))).size===1?matched:[];
  // A lone, headline-less Article can still describe a single actual article,
  // but cannot turn a release index's timestamps into publication metadata.
  return result.length===1&&!result[0].headline&&primaryArticle(elements)&&!collectionPage(elements)?result:[];
}

/** Some publishers use an otherwise unlabelled date beside the author, directly
 * under the article h1. Recognize that bounded byline structure rather than
 * treating any date in an article (or the site's clock) as publication evidence. */
function headingPublication(elements:Tree.Element[]):{publishedAt?:string;dateEvidence?:string}{
  for(const heading of elements.filter(node=>node.tagName==='h1'&&!ignored(node)&&!ignoredParent(node)).slice(0,8)){
    const titleNodes=new Set(nodes(heading));
    let parent=heading.parentNode;
    for(let depth=0;parent&&element(parent)&&depth<3;depth++,parent=parent.parentNode){
      if(['article','main','body','html'].includes(parent.tagName))break;
      const descriptor=attr(parent,'class')+' '+attr(parent,'id');
      if(ignored(parent)||ignoredParent(parent)||/modif|updat|copyright/i.test(descriptor))break;
      if(parent.tagName!=='header'&&!/(?:^|[\s_-])(?:title|header)(?:$|[\s_-])/i.test(descriptor))continue;
      const value=text(parent);if(value.length>700||nonPublication.test(value))continue;
      const scope=nodes(parent);if(scope.filter(node=>node.tagName==='h1').length!==1||scope.some(node=>/modif|updat|copyright/i.test(attr(node,'class')+' '+attr(node,'id')+' '+attr(node,'itemprop'))||updateLabel(node)))continue;
      const dates=scope.filter(node=>['span','em','time'].includes(node.tagName)&&!titleNodes.has(node)&&!ignored(node)&&!ignoredParent(node)).flatMap(node=>{
        const value=attr(node,'datetime')||text(node),candidate=datePattern.exec(value)?.[0];
        // An attributed byline can supply only a calendar day. Preserve that
        // precision; never manufacture hours or seconds for the source.
        if(!candidate||candidate!==value)return [];
        const date=sourceDate(candidate),byline=node.parentNode;
        if(!date||!byline||!element(byline)||text(byline).length>220||nonPublicationByline(node))return [];
        const attributed=children(byline).some(sibling=>{
          if(!element(sibling)||sibling===node||!['a','span'].includes(sibling.tagName)||ignored(sibling)||ignoredParent(sibling))return false;
          const attribution=text(sibling);return attribution.length>=2&&attribution.length<=100&&!datePattern.test(attribution)&&!nonPublication.test(attribution);
        });
        return attributed?[{date,candidate}]:[];
      });
      const unique=new Map(dates.map(date=>[date.date,date]));
      if(unique.size===1){const date=[...unique.values()][0];return {publishedAt:date.date,dateEvidence:`原页标题署名行日期：${date.candidate}`};}
    }
  }
  return {};
}

function publication(elements:Tree.Element[],data:Record<string,any>[]):{publishedAt?:string;dateEvidence?:string}{
  const article=primaryArticle(elements),collection=collectionPage(elements);
  const structured=data.flatMap(node=>{
    for(const key of ['datePublished','pubDate','publishDate','publicationDate']){
      const date=sourceDate(String(node[key]||''));
      if(date)return [{date,evidence:`JSON-LD ${key}: ${node[key]}`}];
    }
    return [];
  });
  if(structured.length){const unique=new Set(structured.map(row=>row.date));return unique.size===1?{publishedAt:structured[0].date,dateEvidence:structured[0].evidence}:{};}
  // A summary such as Last Release belongs to an index, not to each of its
  // independent entries. Preserve the readable body, without a page-level date.
  if(collection&&!article)return {};
  const metadata=[];
  for(const node of elements.filter(n=>n.tagName==='meta'&&n.parentNode&&element(n.parentNode)&&n.parentNode.tagName==='head')){
    const name=attr(node,'property')||attr(node,'name')||attr(node,'itemprop');
    if(!/^(?:article:published_time|datePublished|pubdate|publishdate|publish_time|publication_date|OriginalPublicationDate|DC.date.issued)$/i.test(name))continue;
    const value=attr(node,'content'),date=sourceDate(value);if(date)metadata.push({date,evidence:`meta ${name}: ${value}`});
  }
  if(metadata.length){const unique=new Set(metadata.map(row=>row.date));return unique.size===1?{publishedAt:metadata[0].date,dateEvidence:metadata[0].evidence}:{};}
  const available=elements.filter(node=>inArticleScope(node,article)),byline=headingPublication(available);
  if(byline.publishedAt)return byline;
  const headers=available.filter(parent=>parent.tagName==='header'&&nodes(parent).some(child=>child.tagName==='h1'));
  const dates:Array<{date:string;evidence:string;rank:number}>=[];
  for(const node of available){
    const descriptor=[attr(node,'class'),attr(node,'id'),attr(node,'itemprop')].join(' ');
    let parent=node.parentNode,modified=/modif|updat|copyright/i.test(descriptor);
    while(parent&&element(parent)&&!['article','main','body'].includes(parent.tagName)){modified ||= /modif|updat|copyright/i.test(attr(parent,'class')+' '+attr(parent,'id')+' '+attr(parent,'itemprop'));parent=parent.parentNode;}
    if(modified||ignoredParent(node))continue;
    const field=/(?:publish|publication|release).*(?:time|date)|datePublished|(?:article|post|news|detail)[-_](?:body[-_])?(?:info|meta|date|time)|\bbyline\b/i.test(descriptor);
    if(!field&&node.tagName!=='time')continue;
    if(node.tagName==='time'&&nonPublicationByline(node))continue;
    const header=headers.some(parent=>contains(parent,node));
    if(collection&&!field&&!header)continue;
    const value=attr(node,'datetime')||attr(node,'content')||attr(node,'value')||text(node);
    if(value.length>700||/更新时间|更新于|Last updated|Modified/i.test(value))continue;
    const candidates=[...value.matchAll(new RegExp(datePattern.source,'gi'))].map(match=>match[0]);
    if(candidates.length!==1)continue;
    const candidate=candidates[0],date=sourceDate(candidate);
    if(date)dates.push({date,evidence:`原页发布字段：${candidate}`,rank:field?3:header?2:1});
  }
  for(const node of available.filter(n=>['article','main','p'].includes(n.tagName))){
    const value=text(node),label=/(?:发布时间|发布日期|发布于|Published(?: on)?)[：:\s]*/i.exec(value);
    if(!label||value.length>700||collection&&nodes(node).some(child=>entryParent(child)))continue;
    const candidate=datePattern.exec(value.slice(label.index+label[0].length, label.index+label[0].length+80))?.[0],date=candidate&&sourceDate(candidate);
    if(date)dates.push({date,evidence:label[0]+candidate,rank:3});
  }
  const rank=Math.max(0,...dates.map(row=>row.rank)),preferred=dates.filter(row=>row.rank===rank);
  return preferred.length&&new Set(preferred.map(row=>row.date)).size===1&&(rank>1||preferred.length===1)?{publishedAt:preferred[0].date,dateEvidence:preferred[0].evidence}:{};
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
  const structuredBodies=[...new Set(data.filter(node=>typeof node.articleBody==='string').map(node=>node.articleBody as string))];
  const structuredDates=new Set(data.map(node=>sourceDate(String(node.datePublished||''))).filter(Boolean));
  if(structuredBodies.length===1&&structuredDates.size<=1){
    const value=text(parseFragment(structuredBodies[0]));if(value.length>=180)candidates.push({value,score:140+Math.min(value.length/100,40)});
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
