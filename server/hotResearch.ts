import { Type } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { HotResearchBrief, ResearchReference, WorkflowEvent } from '../src/types';
import type { ModelConfig } from './modelRegistry';
import type { ResearchResult } from './researchTypes';
import { getAgent } from './core';
import { createToolTrace, observeToolErrors } from './toolTrace';
import { discoverHotTopics, newsWindowHours, normalizeEvidence, verifyNewsPages } from './hotSources';
import { createNewsSearchContext, mergeResearch, newsSearchInstructions, researchGaps } from './narrativeResearch';
import { loadEditingSkill } from './skills';
import type { PublicReader } from './publicResearch';
import { runRequiredTool } from './requiredTool';
import {requestedModelNames} from './creativeRequest';
import {beijingDate,hasTodayEventEvidence,requiresTodayEvent} from './lessonAcceptance';
import {newsPublisher,newsSourceCandidates,newsSourceIdentity} from './newsSourceUrls';
export {newsPublisher} from './newsSourceUrls';
import { beijingTimestamp, NEWS_OBSERVATION_POLICY, newsObservationContext } from './newsTime';

export function newsSearchPolicy(prompt:string){
  const subject=prompt.split(/\n(?:研究方向：|制作路径：)/)[0],anchors=requestedModelNames(subject);
  return {subject,anchors,scope:anchors.length?'fixed-topic' as const:'user-domain' as const};
}

export function currentResearchExpired(result:ResearchResult,now=Date.now()):boolean{
  const c=result.current;if(!c)return true;
  const asOf=Date.parse(c.asOf),expires=Date.parse(c.expiresAt);
  return !Number.isFinite(asOf)||!Number.isFinite(expires)||asOf>now+60000||now>=expires||expires-asOf>30*60000;
}
export function independentReportRecovery(topic:HotResearchBrief['topics'][number],refs:ResearchReference[],daily:boolean,requestedAt:number,anchors:string[]=[]){
  const content=normalizeEvidence([topic.title,topic.hook,...topic.facts.map(f=>f.text)].join(' ')).toLowerCase();
  if(anchors.some(name=>!content.includes(normalizeEvidence(name).toLowerCase())))return;
  const evidence=topic.facts.flatMap(f=>f.evidence.map(e=>({e,ref:refs.find(r=>r.id===e.referenceId)})));
  const sources=evidence.flatMap(({ref})=>ref?.verification==='news-page'?[ref]:[]),publishers=[...new Set(sources.map(r=>newsPublisher(r.url)))];
  if(publishers.length!==1||!sources.some(r=>r.freshness==='fresh')||daily&&!evidence.some(({e,ref})=>hasTodayEventEvidence(ref,e.quote,requestedAt)))return;
  return {title:topic.title,query:`${topic.title.slice(0,160)} 独立新闻报道 -site:${publishers[0]}`.slice(0,240),excludePublishers:publishers,sourceDates:sources.map(r=>({url:r.url,publishedAt:r.publishedAt})),facts:topic.facts.map(f=>f.text)};
}
export function newsPassages(ref:ResearchReference):Array<{id:string;text:string}>{
  const parts=ref.excerpt.match(/[^。！？.!?]{12,280}(?:[。！？.!?]|$)|[^。！？.!?]{12,280}/g)||[];
  return parts.map(text=>text.trim()).filter(text=>normalizeEvidence(text).length>=12).slice(0,42).map((text,i)=>({id:`${ref.id}-p${i+1}`,text}));
}
export function hydrateHotEvidence(topics:any[],refs:ResearchReference[]):HotResearchBrief['topics']{
  const passages=new Map(refs.flatMap(ref=>newsPassages(ref).map(p=>[p.id,{referenceId:ref.id,quote:p.text}] as const)));
  return topics.map(topic=>({...topic,facts:topic.facts.map((fact:any)=>({...fact,evidence:fact.evidence.map((e:any)=>{
    const p=passages.get(e.passageId);if(!p||e.referenceId!==undefined&&p.referenceId!==e.referenceId)throw new Error(`新闻证据片段ID ${String(e.passageId)} 不在对应实际来源内。只能选择已读正文的 passageId；baidu/hn 榜单编号仅放在 signalIds，不能作为新闻事实证据。`);return {...p};
  })}))}));
}
export function hotBriefParameters(refs:ResearchReference[],maxTopics=3){
  const passage=Type.Union(refs.flatMap(newsPassages).map(p=>Type.Literal(p.id)),{description:'仅选择实际已读正文片段ID，来源编号与原话由程序补全。'});
  return Type.Object({topics:Type.Array(Type.Object({title:Type.String({maxLength:180}),hook:Type.String({maxLength:300}),angle:Type.String({maxLength:500}),signalIds:Type.Array(Type.String()),facts:Type.Array(Type.Object({text:Type.String({maxLength:400}),evidence:Type.Array(Type.Object({passageId:passage},{additionalProperties:false}),{minItems:1,maxItems:3})}),{minItems:1,maxItems:4,description:'每题只保留1–4条核心新闻事实；榜单排名、热度、访问日期不属于这里的新闻事实。'}),visualPlan:Type.String({maxLength:500}),uncertainties:Type.Array(Type.String({maxLength:500}))}),{maxItems:maxTopics})});
}
export function validateHotBrief(topics:HotResearchBrief['topics'],refs:ResearchReference[],signals:HotResearchBrief['signals']):HotResearchBrief['topics']{
  if(!Array.isArray(topics)||topics.length>3)throw new Error('热点选题最多3个。');
  const reference=new Map(refs.map(r=>[r.id,r])),signalIds=new Set(signals.map(s=>s.id));
  for(const topic of topics){
    if(![topic.title,topic.hook,topic.angle,topic.visualPlan].every(v=>typeof v==='string'&&v.trim()&&v.length<=500)||!Array.isArray(topic.uncertainties)||topic.uncertainties.some(s=>typeof s!=='string'||s.length>500))throw new Error('热点标题、钩子、角度和画面计划格式无效。');
    if(!Array.isArray(topic.signalIds)||topic.signalIds.some(id=>!signalIds.has(id)))throw new Error('热点关联的榜单ID不存在，不得编造热度。');
    if(!Array.isArray(topic.facts)||!topic.facts.length||topic.facts.length>4)throw new Error('每个选题需要1–4条有原文证据的事实。');
    const sources:ResearchReference[]=[];
    for(const fact of topic.facts){
      if(typeof fact.text!=='string'||!fact.text.trim()||fact.text.length>400||!Array.isArray(fact.evidence)||!fact.evidence.length||fact.evidence.length>3)throw new Error('每条新闻事实须有可定位的原文证据。');
      for(const evidence of fact.evidence){
        const ref=reference.get(evidence.referenceId);
        if(!ref||ref.verification!=='news-page'||ref.freshness==='future')throw new Error('新闻事实引用须来自实际读取的非未来网页。');
        const quote=normalizeEvidence(evidence.quote||'');
        if(quote.length<12||quote.length>300||!normalizeEvidence(ref.excerpt).includes(quote))throw new Error('新闻证据摘录不在实际读取的正文内。');
        sources.push(ref);
      }
    }
    if(new Set(sources.map(r=>newsPublisher(r.url))).size<2)throw new Error('热点选题至少需要两家独立发布者的实际正文，不把同站子域名当多来源。');
    if(!sources.some(r=>r.freshness==='fresh'))throw new Error('热点选题缺少时效窗口内的真实发布时间，旧稿或无日期资料只能作背景。');
  }
  return structuredClone(topics);
}

export async function refreshHotTopics(previous:ResearchResult,prompt:string,options:{read?:PublicReader;trace?:ReturnType<typeof createToolTrace>;requestedAt?:number}={}):Promise<ResearchResult>{
  if(!previous.current)throw new Error('没有可续查的新闻选题。');
  const now=Date.now(),asOf=new Date(now).toISOString(),windowHours=newsWindowHours(prompt);
  const cutoff=options.requestedAt??now;
  const read=()=>verifyNewsPages(previous.references,windowHours,options.read,cutoff);
  const verified=options.trace?await options.trace.run('refresh_news_sources','重读已选新闻原文',{urls:previous.references.map(r=>r.url),asOf,cutoffUtc:new Date(cutoff).toISOString(),windowHours},read):await read();
  const topics=previous.current.topics.flatMap(topic=>{try{return validateHotBrief([topic],verified.references,previous.current!.signals);}catch{return [];}});
  if(!topics.length)throw new Error('已选新闻原文未能重新满足日期、逐字证据和交叉来源要求。'+verified.failures.slice(-4).join('；'));
  const current={...previous.current,asOf,expiresAt:new Date(now+30*60000).toISOString(),windowHours,topics,failures:verified.failures};
  return {summary:`锁定原选题重新读取来源，核验截止北京时间${beijingTimestamp(asOf)}（UTC ${asOf}），新闻窗口${windowHours}小时；热度信号仍为首次发现时的记录，不表示已刷新榜单。${NEWS_OBSERVATION_POLICY}\n原始榜单快照：${JSON.stringify(newsObservationContext(previous.current.signals))}\n选题与实际证据：${JSON.stringify(topics)}\n本次已读正文：${JSON.stringify(verified.references)}\n限制：${verified.failures.join('；')}`,references:verified.references,current,queries:[...previous.queries,{provider:'source-pages',action:'refresh',urls:verified.references.map(r=>r.url)}]};
}

export async function researchHotTopics(config:ModelConfig,prompt:string,progress?:(events:WorkflowEvent[])=>Promise<void>,options:{read?:PublicReader;trace?:ReturnType<typeof createToolTrace>;search?:typeof researchGaps;requestedAt?:number}={}):Promise<ResearchResult>{
  const requestedAt=options.requestedAt??Date.now(),asOf=new Date().toISOString(),windowHours=newsWindowHours(prompt),expiresAt=new Date(Date.parse(asOf)+30*60000).toISOString();
  const trace=options.trace||createToolTrace(progress||(async()=>{}),[config.apiKey]);
  const skill=await loadEditingSkill('qingjian-hot-video');
  const policy=newsSearchPolicy(prompt),daily=requiresTodayEvent(policy.subject),requested=/(\d+)\s*个.{0,25}选题/.exec(prompt),maxTopics=Math.min(3,Math.max(1,Number(requested?.[1]||1)));
  const searchContext=createNewsSearchContext(policy.subject,daily,requestedAt);
  const discovered=await trace.run('discover_hot_topics','读取实时热榜',{sources:['baidu','hackernews']},()=>discoverHotTopics(options.read));
  let selection:{signalIds:string[];queries:string[]}|undefined;
  const choose:AgentTool={name:'select_hot_topics',label:'选择热点与查证问题',description:'根据用户领域从真实榜单选择0–2个相关ID，提交1–2条具体新闻查证查询。没有相关榜单时按用户领域查新闻；不得编造榜单ID。',parameters:Type.Object({signalIds:Type.Array(Type.String(),{maxItems:2}),queries:Type.Array(Type.String({minLength:2,maxLength:240}),{minItems:1,maxItems:2})}),execute:async(_id,args)=>{
    const a=args as NonNullable<typeof selection>;
    if(a.signalIds.some(id=>!discovered.signals.some(s=>s.id===id)))throw new Error('选择的热点ID不在真实榜单内。');
    selection=structuredClone(a);return {content:[{type:'text',text:'已确定检索问题，随后实际联网读取来源。'}],details:a};
  }};
  async function plan(tool:AgentTool,input:string,done:()=>boolean){
    const agent=getAgent(config,trace.wrap([tool]),skill+'\n本轮只执行'+tool.name+'。其他搜索、读取或制作步骤由服务端按阶段执行，无需本轮提供所有下游工具。',true),drain=observeToolErrors(agent,trace);
    const payload=agent.onPayload;
    agent.onPayload=async value=>{const next=payload?await payload(value,agent.state.model):value;return next&&typeof next==='object'?{...next,max_tokens:16000}:next;};
    try{await runRequiredTool(agent,input,{name:tool.name,label:tool.label,done,config,secrets:[config.apiKey]});}finally{await drain();}
  }
  const selectionScope=policy.scope==='fixed-topic'?`用户明确指定了${policy.anchors.join('、')}：名称、版本和事件须锁定，不能换产品。遇到网页不可读应查同一事件的官方公告或其他可读媒体。`:'用户没有指定具体对象或事件、只指定领域时，选题由你决定。第一次自行选出的候选不是用户指定主题；日期过时、无法取得正文或交叉来源时，主动淘汰它，在用户原始领域内重选其他合格事件。用户明确指定的对象与事件仍须保留。不得因为你选的新闻失败就停止整个视频需求，也不能换到仅泛泛提及AI的无关新闻。';
  const userDemand=`用户需求：${prompt.slice(0,3000)}\n原始制作指令日期为北京时间${beijingDate(requestedAt)}，今天按该日期核验。资料截止北京时间${beijingTimestamp(asOf)}（UTC ${asOf}）；新闻时效窗口${windowHours}小时。${selectionScope}用户要求今天发生时，至少一个核心事件必须确有北京时间今天发生或首次公开的正文依据；今天报道旧事件、下载统计旧日期或无日期页面不能替代，缺少合格候选时补查后保留缺口。只要求今天值得讲或最新热点时，可以选择明确标注日期的近期事件。未核实的发布或能力传闻应查证传闻本身和官方状态，保留不确定性，不能当成已发布事实。优先可直接读取正文的当事方公告和有日期的媒体报道；讨论页、登录页、只有摘要或需执行JavaScript的页面不能当来源。\n${newsSearchInstructions(searchContext)}\n${NEWS_OBSERVATION_POLICY}\n真实榜单观察时间：${JSON.stringify(newsObservationContext(discovered.signals))}`;
  await plan(choose,`${userDemand}\n实际榜单：${JSON.stringify(discovered.signals)}。选择后搜索原始公告和独立报道，不以宽泛年度综述代替新闻。`,()=>Boolean(selection));
  let raw:ResearchResult|undefined;
  const failures=[...discovered.failures],readReferences=new Map<string,ResearchReference>(),searched=new Set<string>(),attempts=new Map<string,number>(),unusable=new Set<string>(),readURLs=new Set<string>(),rejected:Array<{title:string;reason:string;recovery?:ReturnType<typeof independentReportRecovery>}>=[];
  let references:ResearchReference[]=[];
  const brief:HotResearchBrief={asOf,expiresAt,windowHours,signals:discovered.signals,topics:[],failures};
  for(let round=0;round<3;round++){
    if(round){
      selection=undefined;
      const recovery=[...rejected].reverse().map(r=>r.recovery).find(r=>r&&!searched.has(r.query));
      // Exhausted agent-selected candidates are not the user's topic. Reserve
      // one of the existing final-round queries for the original domain rather
      // than spending the whole budget renaming the same undated/old event.
      const discoverDomain=policy.scope==='user-domain'&&round===2&&!references.some(r=>r.freshness==='fresh');
      const domainQuery=discoverDomain?`${policy.subject.slice(0,160)} 新闻 官方公告 ${beijingDate(requestedAt-windowHours*3600000)} ${beijingDate(requestedAt)}`:undefined;
      await plan({...choose,name:'refine_news_search',label:'补查新闻来源',execute:async(id,args)=>{
        const next=args as NonNullable<typeof selection>,queries=domainQuery?[domainQuery,...next.queries.filter(q=>q!==domainQuery)].slice(0,next.queries.length):recovery?[recovery.query,...next.queries.filter(q=>q!==recovery.query)].slice(0,2):next.queries;
        if(queries.every(q=>searched.has(q)))throw new Error('补查必须更换查询或来源，不能重复全部失败查询。');
        return choose.execute(id,{...next,...(discoverDomain?{signalIds:[]}:{}),queries});
      }},`${userDemand}\n前次未找到合格选题。${policy.scope==='user-domain'?(round===2?'最后一轮必须回到用户原始领域重新选择其他事件，不围绕已失败候选反复改标题。':'若原候选过时或缺少交叉正文，优先重选其他相关事件；只有已有合格事件的交叉报道缺口才继续定向补查。'):'保留用户指定的名称、版本和事件，改查可读的一手公告与其他媒体，不反复尝试访问检查页面。'}换查询、域名或检索传闻核验与官方状态。不要再次返回以下不可用页面：${JSON.stringify([...unusable])}。已搜索：${JSON.stringify([...searched])}；已读资料：${JSON.stringify(references.map(({excerpt,...r})=>r))}；淘汰候选：${JSON.stringify(rejected)}；实际缺口：${JSON.stringify(failures.slice(-12))}。`,()=>Boolean(selection));
    }
    const queries=selection!.queries;queries.forEach(q=>searched.add(q));
    const searches=await Promise.allSettled(queries.map(query=>trace.run('search_news','检索新闻与一手来源',{query,windowHours,asOf,attempt:round+1,context:searchContext},()=>(options.search||researchGaps)(config,query,[`原始请求北京时间日期${searchContext.calendarDate}；近${windowHours}小时仅是资料新鲜度，不代替事件日历日要求`,`同一事件至少两家发布者的新闻正文或官方公告；列出实际链接和日期`],'news',searchContext))));
    // Reserve source slots for each query so one cannot crowd out the other.
    let candidates:ResearchResult|undefined;
    const sourceGroups:ResearchReference[][]=[];
    for(const result of searches){if(result.status==='fulfilled'){sourceGroups.push(result.value.references);candidates=mergeResearch(candidates,{...result.value,references:newsSourceCandidates([result.value.references],()=>true,12,12)});}else failures.push(result.reason instanceof Error?result.reason.message:'新闻搜索失败');}
    if(candidates)raw=mergeResearch(raw,candidates);
    const unread=newsSourceCandidates(sourceGroups,r=>{const key=newsSourceIdentity(r.url);return !readURLs.has(key)&&!readReferences.has(key)&&!unusable.has(key)&&(attempts.get(key)||0)<2;});
    unread.forEach(r=>{const key=newsSourceIdentity(r.url);attempts.set(key,(attempts.get(key)||0)+1);});
    const verified=await trace.run('read_news_sources','读取正文与发布时间',{urls:unread.map(r=>r.url),windowHours,cutoffUtc:searchContext.cutoffUtc,attempt:round+1},()=>verifyNewsPages(unread,windowHours,options.read,requestedAt));
    failures.push(...verified.failures);
    for(const page of verified.pages){if(page.status==='read'){readURLs.add(newsSourceIdentity(page.url));if(page.finalURL)readURLs.add(newsSourceIdentity(page.finalURL));}else if(!page.retryable)unusable.add(newsSourceIdentity(page.url));}
    verified.references.forEach(r=>readReferences.set(newsSourceIdentity(r.url),r));
    references=[...readReferences.values()].map((r,i)=>({...r,id:`ref-${i+1}`}));
    if(references.some(r=>r.freshness==='fresh')){
      let submitted=false;
      const tool:AgentTool={name:'propose_hot_brief',label:'提炼有证据的热点选题',description:`用实际新闻正文提交最多${maxTopics}个选题；每题仅1–4条核心事实，至少1个新稿。通过仍要求两家独立发布者；若已有合格事件的逐字正文、仅缺独立报道，可提交该候选，程序会明确拒绝并定向补查，不会当作通过。每条事实只选择1–3个passageId，精简事实以适配证据数量；程序保存来源与原话，不另写referenceId或摘录。热度仅放在signalIds，不作为facts证据。没有可定位事件正文时返回topics:[]，不要提交空facts的选题。`,parameters:hotBriefParameters(references,maxTopics),execute:async(_id,args)=>{
        const hydrated=hydrateHotEvidence((args as {topics:any[]}).topics,references),accepted:HotResearchBrief['topics']=[];
        for(const topic of hydrated){try{
          validateHotBrief([topic],references,discovered.signals);
          const content=normalizeEvidence([topic.title,topic.hook,...topic.facts.map(f=>f.text)].join(' ')).toLowerCase();
          if(policy.anchors.some(name=>!content.includes(normalizeEvidence(name).toLowerCase())))throw new Error('选题没有保留用户指定的名称和版本。');
          if(daily&&!topic.facts.some(f=>f.evidence.some(e=>hasTodayEventEvidence(references.find(r=>r.id===e.referenceId),e.quote,requestedAt))))throw new Error('该候选缺少今天发生或首次宣布的核心事件原文；今天报道旧事件不能满足用户要求。');
          accepted.push(topic);
        }catch(error){const reason=error instanceof Error?error.message:String(error),recovery=/两家独立发布者/.test(reason)?independentReportRecovery(topic,references,daily,requestedAt,policy.anchors):undefined;rejected.push({title:topic.title,reason,...(recovery?{recovery}:{})});failures.push(`淘汰选题「${topic.title}」：${reason}`);}}
        brief.topics=accepted;submitted=true;
        const result={topics:accepted,rejected:rejected.slice(-3),nextStrategy:accepted.length?'complete':rejected.at(-1)?.recovery?'independent-report':policy.scope==='user-domain'?'reselect-within-user-domain':'same-topic-readable-sources'};
        return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
      }};
      const sources=references.map(({excerpt,...ref})=>({...ref,passages:newsPassages({...ref,excerpt})}));
      const proposalContext={round:round+1,selection:structuredClone(selection),actualQueries:queries,rejectedTopics:rejected.map(({title,reason})=>({title,reason}))};
      await plan(tool,`${userDemand}\n本轮提案上下文（各阶段使用新Agent，不依赖上一阶段的对话记忆）：${JSON.stringify(proposalContext)}。选题须结合本轮实际查询与选择；累计已读资料仍可作背景，但不能无视本轮查证结果、重新用相同不合格证据给已拒主题换标题。被拒的是证据缺口，不是永久禁止该对象；用户指定的对象须保留，同事件取得能解决上述具体缺口的新正文后可以重新提交，并指出补齐的证据。不得声称新闻发生于抓取日期；只有publishedAt是原文发布日期，eventDate须依据正文。制作角度是建议，不能写成事实或保证爆款。最多提交${maxTopics}个选题，每题只提交1–4条核心事实，至少两家发布者。${daily?'必须选择含当日事件日期或“今日/今天/today宣布”的实际正文片段作为核心事件证据；西半球日期按来源明确时区换算，不改写原文日期。':''}每条事实最多1–3个正文片段，超出时精简事实，只保留核心信息。evidence只填写已读正文的passageId，程序补全来源与逐字引文；不要填写referenceId。榜单编号baidu/hn只放在signalIds，不能写入evidence；热度、排名和抓取时间不要作为facts。标题与钩子也应遵循正文证据。可以区分新报道与旧背景。只使用以下已读正文，不使用以前搜索摘要的编号或事实。\n实际已读来源（以下ref-ID与passage-ID为唯一映射）：${JSON.stringify(sources)}\n真实热度信号：${JSON.stringify(discovered.signals.filter(s=>selection!.signalIds.includes(s.id)))}`,()=>submitted);
    }
    if(brief.topics.length)break;
    failures.push(`第${round+1}轮未找到合格选题；${policy.scope==='user-domain'?'淘汰不合格候选，在用户领域内重选并更换可读来源。':'保留用户指定主题，改查其他可读来源。'}`);
  }
  if(!brief.topics.length)failures.push('本次缺少时效与交叉来源同时满足的选题；不能生成今日热点事实性脚本。');
  if(requested&&brief.topics.length<Number(requested[1]))failures.push(`用户希望${requested[1]}个选题，本次仅${brief.topics.length}个通过证据校验；没有凑数，其他候选仍需补充可读来源。`);
  return {summary:`热点研究截止北京时间${beijingTimestamp(asOf)}（UTC ${asOf}），新闻窗口${windowHours}小时，榜单热度与新闻事实分开记录。${NEWS_OBSERVATION_POLICY}\n榜单观察时刻：${JSON.stringify(newsObservationContext(brief.signals))}\n可制作选题及实际证据：\n${JSON.stringify(brief.topics)}\n实际已读来源与日期：\n${JSON.stringify(references)}\n限制：${failures.join('；')}`,references,queries:raw?.queries||[],usage:raw?.usage,current:brief};
}
