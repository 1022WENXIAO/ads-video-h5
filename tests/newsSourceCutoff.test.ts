import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNewsPages } from '../server/hotSources';
import { researchHotTopics, refreshHotTopics } from '../server/hotResearch';
import type { ResearchResult } from '../server/researchTypes';
import { TEXT_MODEL_PRESETS, ARK_BASE_URL } from '../shared/textModels';
import type { ResearchReference } from '../shared/types';

test('rereading a now-undated source clears its old publication fields instead of inheriting search/cache metadata',async()=>{
  const cutoff=Date.now()-1800000,old:ResearchReference={id:'ref-old',title:'Old cached metadata',url:'https://news.example.com/undated',verification:'news-page',excerpt:'Old body',publishedAt:new Date(cutoff-60000).toISOString(),dateEvidence:'Previously parsed unrelated entry',freshness:'fresh',retrievedAt:new Date(cutoff).toISOString()};
  const before=Date.now();
  const result=await verifyNewsPages([old],24,async url=>({url,text:`<title>未确定日期的资料</title><article>${'实际可读正文，没有可确认的文章发布日期，不能沿用旧缓存的其他条目日期。'.repeat(12)}</article>`,contentType:'text/html'}),cutoff);
  const ref=result.references[0];assert.equal(ref.freshness,'undated');assert.equal(ref.publishedAt,undefined);assert.equal(ref.dateEvidence,undefined);
  assert(Date.parse(ref.retrievedAt)>=before,'retrieval time records the real read, not the earlier request cutoff');
  assert.equal(old.dateEvidence,'Previously parsed unrelated entry','the original snapshot is not overwritten');
});

test('expiry refresh honors the earlier request window instead of moving it to the reread time',async()=>{
  const cutoff=Date.now()-30*60000,publication=new Date(cutoff-24*3600000+60000).toISOString(),quote='官方宣布开放新的AI功能，并说明使用范围及已知限制。';
  const references:ResearchReference[]=['https://official.example.org/news','https://media.example.net/news'].map((url,i)=>({id:`ref-${i+1}`,title:'AI公告',url,verification:'news-page',excerpt:quote.repeat(12),publishedAt:publication,dateEvidence:'Controlled original source date',freshness:'fresh',retrievedAt:new Date(cutoff).toISOString()}));
  const previous:ResearchResult={summary:'Controlled old research',references,queries:[],current:{asOf:new Date(cutoff).toISOString(),expiresAt:new Date(cutoff+30*60000).toISOString(),windowHours:24,signals:[],topics:[{title:'近期AI公告',hook:'近期AI有什么新变化？',angle:'说明功能及限制',signalIds:[],facts:[{text:quote,evidence:references.map(ref=>({referenceId:ref.id,quote}))}],visualPlan:'功能和限制示意',uncertainties:[]}],failures:[]}};
  let reads=0;
  const refreshed=await refreshHotTopics(previous,'生成今天的热点 AI 新闻视频',{requestedAt:cutoff,read:async url=>{reads++;return {url,text:`<title>AI公告</title><meta property="article:published_time" content="${publication}"><article>${quote.repeat(12)}</article>`,contentType:'text/html'};}});
  assert.equal(reads,2);assert.equal(refreshed.current!.topics.length,1);
  assert(refreshed.references.every(ref=>ref.freshness==='fresh'));
  assert(Date.parse(refreshed.current!.asOf)>cutoff+20*60000,'research records the actual reread time separately');
  assert.equal(previous.references[0].dateEvidence,'Controlled original source date');
});

test('a long-running research uses the original cutoff for both 24-hour edges, while recording the actual later read time',async()=>{
  const original=globalThis.fetch,cutoff=Date.now()-30*60000,nearEdge=new Date(cutoff-24*3600000+60000).toISOString(),afterCutoff=new Date(cutoff+5*60000).toISOString();
  const quote='官方宣布开放新的AI工具，并说明实际使用范围、试用安排以及已知限制。';
  let modelCalls=0,searches=0;
  const reply=(name:string,args:unknown)=>new Response(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:TEXT_MODEL_PRESETS[0].modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  globalThis.fetch=async(_url,init)=>{
    modelCalls++;const name=JSON.parse(String(init?.body)).tools[0].function.name;
    if(name==='select_hot_topics')return reply(name,{signalIds:[],queries:['AI新功能 官方与媒体公告']});
    assert.equal(name,'propose_hot_brief','original-window evidence must not be discarded as stale while later publications become eligible');
    return reply(name,{topics:[{title:'近期AI工具公告',hook:'AI工具近期有什么变化？',angle:'说明功能与限制',signalIds:[],facts:[{text:quote,evidence:[{passageId:'ref-1-p1'},{passageId:'ref-2-p1'}]}],visualPlan:'功能示意与限制',uncertainties:[]}]});
  };
  try{
    const result=await researchHotTopics({...TEXT_MODEL_PRESETS[0],kind:'text',provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-only'},'生成今天的热点 AI 新闻视频',undefined,{requestedAt:cutoff,
      read:async url=>{
        if(url.includes('top.baidu.com'))return {url,text:'<!--s-data:{"data":{"cards":[{"component":"hotList","content":[]}]}}-->',contentType:'text/html'};
        if(url.includes('topstories.json'))return {url,text:'[]',contentType:'application/json'};
        return {url,text:`<title>AI工具公告</title><meta property="article:published_time" content="${url.includes('/future')?afterCutoff:nearEdge}"><article>${quote.repeat(12)}</article>`,contentType:'text/html'};
      },
      search:async(_config,_query,_gaps,_purpose,context)=>{
        searches++;assert.equal(context!.cutoffUtc,new Date(cutoff).toISOString());
        return {summary:'Controlled actual pages',references:['https://official.example.org/news','https://media.example.net/news','https://later.example.com/future'].map((url,i)=>({id:'search-'+i,title:'Source',url,excerpt:'Search snippet',verification:'search-cited',retrievedAt:''})),queries:[]};
      },
    });
    assert.equal(searches,1);assert.equal(modelCalls,2);assert.equal(result.current!.topics.length,1);
    assert.deepEqual(result.references.map(ref=>ref.freshness),['fresh','fresh','future']);
    assert(result.references.every(ref=>Date.parse(ref.retrievedAt)>cutoff+20*60000));
  }finally{globalThis.fetch=original;}
});
