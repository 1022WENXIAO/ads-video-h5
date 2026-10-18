import test from 'node:test';
import assert from 'node:assert/strict';
import {articlePublication,discoverHotTopics,verifyNewsPages,newsWindowHours} from '../server/hotSources';
import {newsDatePolicy} from '../server/newsDatePolicy';
import {newsSourceRejection} from '../server/newsSourceUrls';
import {researchHotTopics,validateHotBrief,refreshHotTopics} from '../server/hotResearch';
import {assertLessonNewsSources} from '../server/lessonSpec';
import {createNewsPublicationAnnotation,newsPublicationNoteHtml} from '../server/newsTime';
import {researchGaps} from '../server/narrativeResearch';
import {ARK_BASE_URL,TEXT_MODEL_PRESETS} from '../shared/textModels';
import type {HotResearchBrief,LessonReport,ResearchReference} from '../src/types';

const quote='官方说明这项工具的实际使用方式、适用范围与已知限制，用户应按文档核对能力。';
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'fixture-only'};
const refs:ResearchReference[]=['https://official.example.org/announcement','https://media.example.net/report'].map((url,i)=>({id:`ref-${i+1}`,url,title:'工具资讯',excerpt:quote.repeat(12),retrievedAt:new Date().toISOString(),verification:'news-page',freshness:'undated'}));
const topic:HotResearchBrief['topics'][number]={title:'工具使用范围',hook:'工具能解决什么问题？',angle:'说明使用方式及限制',signalIds:[],facts:[{text:quote,evidence:refs.map(ref=>({referenceId:ref.id,quote}))}],visualPlan:'功能和限制图解',uncertainties:[]};

test('real NBD Cambrian pubDate and embassy News_Body_Time no longer become undated',()=>{
  const title='多家银行严控贷款违规流向';
  const nbd=`<title>${title} | 每日经济新闻</title><script type="application/ld+json">${JSON.stringify({'@context':'https://ziyuan.baidu.com/contexts/cambrian.jsonld',title,pubDate:'2026-10-16T14:48:53',upDate:'2026-10-18T20:00:00'})}</script><h1>${title}</h1><div class="g-articleMsg"><span>2026-10-16 14:48</span></div><article>${quote.repeat(12)}</article>`;
  assert.deepEqual(articlePublication(nbd),{publishedAt:'2026-10-16T06:48:53.000Z',dateEvidence:'JSON-LD pubDate: 2026-10-16T14:48:53'});
  assert.equal(articlePublication('<h1>使馆提醒</h1><div id="News_Body_Time">2026-04-24 12:41</div>').publishedAt,'2026-04-24T04:41:00.000Z');
  assert.equal(articlePublication(nbd.replace(`"title":"${title}"`,'"title":"另一篇无关新闻"')).publishedAt,undefined);
  assert.equal(articlePublication('<div class="updated"><div id="News_Body_Time">2026-10-18</div></div>').publishedAt,undefined);
});

test('an attributed day-only byline preserves day precision without inventing a clock',()=>{
  const html='<div class="article-header"><h1>工具公告</h1><p><span>新闻记者</span><em>2026-10-18</em></p></div>';
  assert.equal(articlePublication(html).publishedAt,'2026-10-18');
  assert.equal(articlePublication(html.replace('新闻记者','当前时间')).publishedAt,undefined);
});

test('default date policy permits missing publication but explicit time windows and strict deployments win',()=>{
  const saved=process.env.QINGJIAN_NEWS_DATE_POLICY,window=process.env.QINGJIAN_NEWS_WINDOW_HOURS;
  try{
    delete process.env.QINGJIAN_NEWS_DATE_POLICY;
    assert.equal(newsDatePolicy('做一条工具新闻视频'),'flexible');
    for(const prompt of ['今天发生的新闻','最近24小时的报道','过去三天的资讯','本周AI新闻','last 48 hours of news'])assert.equal(newsDatePolicy(prompt),'strict',prompt);
    process.env.QINGJIAN_NEWS_DATE_POLICY='strict';assert.equal(newsDatePolicy('做一条工具新闻视频'),'strict');
    process.env.QINGJIAN_NEWS_WINDOW_HOURS='168';assert.equal(newsWindowHours('工具资讯'),168);assert.equal(newsWindowHours('今天新闻'),24);assert.equal(newsWindowHours('过去四天新闻'),96);assert.equal(newsWindowHours('last 48 hours of news'),48);
    process.env.QINGJIAN_NEWS_WINDOW_HOURS='bad';assert.equal(newsWindowHours('工具资讯'),72);
  }finally{if(saved===undefined)delete process.env.QINGJIAN_NEWS_DATE_POLICY;else process.env.QINGJIAN_NEWS_DATE_POLICY=saved;if(window===undefined)delete process.env.QINGJIAN_NEWS_WINDOW_HOURS;else process.env.QINGJIAN_NEWS_WINDOW_HOURS=window;}
});

test('missing-date allowance survives research, script, refresh and the rendered disclosure contract',async()=>{
  assert.throws(()=>validateHotBrief([topic],refs,[]),/发布时间/);
  assert.equal(validateHotBrief([topic],refs,[],'flexible').length,1);
  const cutoff=Date.now(),brief:HotResearchBrief={asOf:new Date(cutoff).toISOString(),expiresAt:new Date(cutoff+1800000).toISOString(),windowHours:72,datePolicy:'flexible',signals:[],topics:[topic],failures:[]};
  const report={references:refs,hotResearch:brief,chapters:[{claims:[{referenceIds:refs.map(r=>r.id)}]}]} as LessonReport;
  assert.doesNotThrow(()=>assertLessonNewsSources(report));
  const annotation=createNewsPublicationAnnotation(report,cutoff)!;
  assert.equal(annotation.dateStatus,'unknown');assert.equal(annotation.publishedAt,'');assert.equal(annotation.label,'报道日期：原文未注明');
  assert.match(newsPublicationNoteHtml(annotation),/data-news-published-at=""/);
  assert.throws(()=>newsPublicationNoteHtml({...annotation,publishedAt:new Date(cutoff).toISOString()}),/日期注释/);
  assert.equal(createNewsPublicationAnnotation({...report,hotResearch:{...brief,datePolicy:'strict'}},cutoff),undefined);
  assert.equal(createNewsPublicationAnnotation({...report,references:[refs[0]]},cutoff),undefined);
  const refreshed=await refreshHotTopics({summary:'',queries:[],references:refs,current:brief},'工具新闻',{requestedAt:cutoff,read:async url=>({url,text:`<title>工具资讯</title><article>${quote.repeat(12)}</article>`,contentType:'text/html'})});
  assert.equal(refreshed.current!.topics.length,1);assert(refreshed.references.every(ref=>ref.publishedAt===undefined));
  const future=refs.map(ref=>({...ref,freshness:'future' as const}));assert.throws(()=>validateHotBrief([topic],future,[],'flexible'),/非未来/);
  const stale=refs.map(ref=>({...ref,freshness:'stale' as const}));assert.throws(()=>validateHotBrief([topic],stale,[],'flexible'),/发布时间/);
  assert.throws(()=>validateHotBrief([{...topic,title:'今天刚刚发布的工具'}],refs,[],'flexible'),/缺省日期/);
  assert.doesNotThrow(()=>validateHotBrief([{...topic,title:'今天了解工具的用途',hook:'没有证据证明工具今天刚刚发布'}],refs,[],'flexible'));
});

test('optional trend hangs are aborted within the shared budget while Baidu evidence survives',async()=>{
  let aborted=false;
  const start=Date.now(),result=await discoverHotTopics(async(url,options)=>{
    if(url.includes('baidu.com'))return {url,text:'<!--s-data:{"data":{"cards":[{"component":"hotList","content":[{"word":"真实榜单","url":"https://www.baidu.com/s?wd=test"}]}]}}-->',contentType:'text/html'};
    return new Promise((_,reject)=>options!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));
  },Date.now(),{timeoutMs:25});
  assert(Date.now()-start<500);assert(aborted);assert.equal(result.signals.length,1);assert.match(result.failures.join(' '),/Hacker News.*预算/);
});

test('known non-articles never become verified current news, and reader metrics expose the actual stage',async()=>{
  const rejected=['https://www.cac.gov.cn/#/?f=pc','https://www.mofcom.gov.cn/xxgksearch.html','https://m.nbd.com.cn/web_app/column/375/','https://m.weibo.cn/detail/123','https://disc.static.szse.cn/announcement.PDF'];
  rejected.forEach(url=>assert.ok(newsSourceRejection(url),url));
  assert.equal(newsSourceRejection(refs[0].url),undefined);
  const result=await verifyNewsPages([...rejected.map((url,i)=>({...refs[0],id:'bad-'+i,url})),refs[0]],72,async url=>{assert.equal(url,refs[0].url);return {url,text:`<title>工具资讯</title><article>${quote.repeat(12)}</article>`,contentType:'text/html'};});
  assert.equal(result.references.length,1);assert.deepEqual(result.metrics,{attempted:6,read:1,failed:5,dated:0,fresh:0,undated:1});
});

test('Ark search retries when every citation is a homepage instead of reporting usable-source success',async()=>{
  const saved=globalThis.fetch,base=process.env.QINGJIAN_OPEN_WEBSEARCH_URL;let calls=0;
  delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({output:[{type:'web_search_call',status:'completed',action:{query:'actual query'}},{content:[{type:'output_text',text:'Actual search',annotations:[{type:'url_citation',url:calls===1?'https://www.cac.gov.cn/':refs[0].url,title:'Source'}]}]}]}));};
  try{const r=await researchGaps(config,'工具资讯',[],'news');assert.equal(calls,2);assert.equal(r.references[0].url,refs[0].url);assert.equal((r.queries[0] as any).excluded.length,1);}
  finally{globalThis.fetch=saved;if(base===undefined)delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL;else process.env.QINGJIAN_OPEN_WEBSEARCH_URL=base;}
});

test('the real Agent path completes undated cross-source research and records the default disclosure',async()=>{
  const saved=globalThis.fetch;let proposals=0;
  globalThis.fetch=async(_input,init)=>{
    const name=JSON.parse(String(init?.body)).tools[0].function.name;
    const args=name==='select_hot_topics'?{signalIds:[],queries:['工具 官方说明 独立报道']}:{topics:[{...topic,facts:[{text:quote,evidence:refs.map(ref=>({passageId:ref.id+'-p1'}))}]}]};
    if(name==='propose_hot_brief')proposals++;else assert.equal(name,'select_hot_topics');
    return new Response(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const result=await researchHotTopics(config,'制作工具新闻口播',undefined,{read:async url=>({url,text:url.includes('top.baidu.com')?'<!--s-data:{"data":{"cards":[]}}-->':url.includes('topstories')?'[]':`<title>工具资讯</title><article>${quote.repeat(12)}</article>`,contentType:'text/html'}),search:async()=>({summary:'实际文章',references:refs,queries:[]})});
    assert.equal(proposals,1);assert.equal(result.current!.datePolicy,'flexible');assert.equal(result.current!.topics.length,1);assert.match(result.current!.topics[0].uncertainties.join(' '),/未注明发布时间/);
    assert(result.references.every(ref=>ref.publishedAt===undefined));assert(result.queries.some((q:any)=>q.action==='verify'&&q.metrics.undated===2));
  }finally{globalThis.fetch=saved;}
});

test('the last round repairs a rejected one-publisher proposal from already-read evidence',async()=>{
  const saved=globalThis.fetch,queries:string[]=[];let proposals=0,refinements=0;
  const now=new Date(Date.now()-60000).toISOString();
  globalThis.fetch=async(_input,init)=>{
    const name=JSON.parse(String(init?.body)).tools[0].function.name;
    let args:unknown;
    if(name==='select_hot_topics')args={signalIds:[],queries:['工具 官方新闻']};
    else if(name==='refine_news_search')args={signalIds:[],queries:['工具 独立报道 '+(++refinements)]};
    else{assert.equal(name,'propose_hot_brief');proposals++;args={topics:[{...topic,facts:[{text:quote,evidence:refs.slice(0,proposals>=4?2:1).map(ref=>({passageId:ref.id+'-p1'}))}]}]};}
    return new Response(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+name+proposals,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  try{
    const result=await researchHotTopics(config,'制作最近24小时工具新闻',undefined,{read:async url=>({url,text:url.includes('top.baidu.com')?'<!--s-data:{"data":{"cards":[]}}-->':url.includes('topstories')?'[]':`<title>工具资讯</title><meta property="article:published_time" content="${now}"><article>${quote.repeat(12)}</article>`,contentType:'text/html'}),search:async(_config,query)=>{queries.push(query);return {summary:'实际文章',references:refs,queries:[query]};}});
    assert(queries.length>=3&&queries.length<=5);assert.equal(refinements,2);assert.equal(proposals,4);assert.equal(result.current!.topics.length,1);assert.equal(result.current!.datePolicy,'strict');
  }finally{globalThis.fetch=saved;}
});
