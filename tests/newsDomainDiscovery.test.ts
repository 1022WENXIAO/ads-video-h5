import test from 'node:test';
import assert from 'node:assert/strict';
import { researchHotTopics } from '../server/hotResearch';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';
import { beijingDate } from '../server/lessonAcceptance';

const cutoff=Date.now()-10*60000;
const quote=`${beijingDate(cutoff)}，官方宣布开放新的AI功能，并明确实际使用范围及已知限制。`;
const page=(fresh:boolean)=>`<title>${fresh?'新AI公告':'旧候选回顾'}</title><meta property="article:published_time" content="${new Date(cutoff-(fresh?2:240)*3600000).toISOString()}"><article>${(fresh?quote:'旧候选已在此前发布，本页回顾原有能力和使用限制。').repeat(12)}</article>`;

for(const {fixed,size} of [{fixed:false,size:2},{fixed:true,size:2},{fixed:false,size:1}])test(fixed?'an explicit product/version never switches to a domain discovery query':`two all-stale rounds force one original-domain discovery without increasing ${size} submitted queries`,async()=>{
  const original=globalThis.fetch,queries:string[]=[],events:any[]=[];
  const prompt=fixed?'制作Fable5.5的最新新闻视频':'生成今天的热点 AI 新闻视频';
  const candidate=fixed?'Fable5.5 旧候选':'AI 旧候选';
  let refinements=0,modelCalls=0;
  const reply=(name:string,args:unknown)=>new Response(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:TEXT_MODEL_PRESETS[0].modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+modelCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  globalThis.fetch=async(_url,init)=>{
    modelCalls++;
    const body=JSON.parse(String(init?.body)),name=body.tools[0].function.name;
    if(name==='select_hot_topics')return reply(name,{signalIds:[],queries:[`${candidate} 官方`,`${candidate} 媒体`].slice(0,size)});
    if(name==='refine_news_search'){
      refinements++;
      // The model keeps the same exhausted event while varying query wording,
      // exactly the failure that prompt-only reselection did not prevent.
      return reply(name,{signalIds:[],queries:[`${candidate} 其他公告 ${refinements}`,`${candidate} 更多报道 ${refinements}`].slice(0,size)});
    }
    assert.equal(name,'propose_hot_brief');assert.equal(fixed,false);
    return reply(name,{topics:[{title:'新的AI功能公告',hook:'近期AI有什么新变化？',angle:'说明新功能及使用限制',signalIds:[],facts:[{text:quote,evidence:[{passageId:`ref-${2*size+1}-p1`},{passageId:`ref-${2*size+2}-p1`}]}],visualPlan:'已有功能和新功能对照图',uncertainties:[]}]});
  };
  try{
    const result=await researchHotTopics({...TEXT_MODEL_PRESETS[0],kind:'text',provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-only'},prompt,async updates=>{events.splice(0,events.length,...structuredClone(updates));},{requestedAt:cutoff,
      read:async url=>{
        if(url.includes('top.baidu.com'))return {url,text:'<!--s-data:{"data":{"cards":[{"component":"hotList","content":[]}]}}-->',contentType:'text/html'};
        if(url.includes('topstories.json'))return {url,text:'[]',contentType:'application/json'};
        return {url,text:page(url.includes('/fresh')),contentType:'text/html'};
      },
      search:async(_config,query,_gaps,_purpose,context)=>{
        queries.push(query);assert.equal(context!.cutoffUtc,new Date(cutoff).toISOString());
        const urls=query.includes(prompt)?['https://official.example.org/fresh','https://media.example.net/fresh']:[`https://old.example.com/old-${queries.length}`];
        return {summary:'Controlled actual-page references',references:urls.map((url,i)=>({id:'search-'+i,title:'Search citation',url,verification:'search-cited',excerpt:'Search snippets do not prove publication dates.',retrievedAt:''})),queries:[query]};
      },
    });
    assert.equal(refinements,2);assert.equal(queries.length,3*size,'the fix replaces an existing query instead of adding a round or search');
    const searchEvents=events.filter(event=>event.tool==='search_news');
    assert(searchEvents.every(event=>event.input.attempt<=3));
    assert.equal(modelCalls,fixed?3:4,'only the original selection/refinements and, when eligible, proposal run');
    if(fixed){
      assert.equal(result.current!.topics.length,0);assert.equal(queries.some(query=>query.includes(prompt)),false);
      assert(queries.every(query=>query.includes('Fable5.5')));
      assert(result.current!.failures.some(reason=>reason.includes('保留用户指定主题')));
    }else{
      assert.equal(queries.filter(query=>query.includes(prompt)).length,1);
      assert(queries[2*size].endsWith(`${beijingDate(cutoff-24*3600000)} ${beijingDate(cutoff)}`));
      assert.doesNotMatch(queries[2*size],/旧候选/);
      assert.equal(result.current!.topics.length,1);
      assert.equal(result.current!.topics[0].facts[0].evidence.length,2);
      assert.deepEqual(result.current!.topics[0].signalIds,[]);
    }
  }finally{globalThis.fetch=original;}
});
