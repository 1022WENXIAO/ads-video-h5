import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,brotliCompressSync,deflateSync} from 'node:zlib';
import {decodePublicPageBody} from '../server/publicResearch';
import {parseNewsPage,articlePublication,verifyNewsPages} from '../server/hotSources';
import {sourceDate} from '../server/newsPage';
import {researchHotTopics,newsSearchPolicy} from '../server/hotResearch';
import {hasTodayEventEvidence,beijingDate} from '../server/lessonAcceptance';
import {TEXT_MODEL_PRESETS,ARK_BASE_URL} from '../shared/textModels';
import type {ResearchReference} from '../src/types';

const body='官方今日宣布开放新的大模型功能，并说明使用范围与已知限制。'.repeat(12);
const html=`<html><title>官方新闻</title><meta property="article:published_time" content="2026-10-05T09:00:00+08:00"><article>${body}</article></html>`;
test('public news reads gzip, deflate, Brotli and declared character encodings before parsing',()=>{
  for(const [encoding,bytes] of [['gzip',gzipSync(html)],['deflate',deflateSync(html)],['br',brotliCompressSync(html)],['gzip, br',brotliCompressSync(gzipSync(html))]] as const){
    const decoded=decodePublicPageBody(bytes,'text/html;charset=utf-8',encoding);
    assert.equal(decoded,html);assert.equal(parseNewsPage(decoded).publishedAt,'2026-10-05T01:00:00.000Z');
  }
  const gbk=Buffer.concat([Buffer.from('<meta charset="gb2312"><title>'),Buffer.from([0xd0,0xc2,0xce,0xc5]),Buffer.from('</title>')]);
  assert.equal(decodePublicPageBody(gbk,'text/html'),'<meta charset="gb2312"><title>新闻</title>');
});
test('compressed news size limits and corrupt encodings do not bypass reader protections',()=>{
  assert.throws(()=>decodePublicPageBody(gzipSync('x'.repeat(1500001)),'text/html','gzip'),/1.5 MB/);
  assert.throws(()=>decodePublicPageBody(Buffer.alloc(1500001),'text/html'),/1.5 MB/);
  assert.throws(()=>decodePublicPageBody(Buffer.from('not gzip'),'text/html','gzip'),/解压/);
  assert.throws(()=>decodePublicPageBody(Buffer.from('text'),'text/html','unknown'),/解压/);
});
test('publication parsing recognizes actual press-room and news-byline fields',()=>{
  assert.equal(articlePublication('<input id="releaseFormatTime" type="hidden" value="Oct 05, 2026">').publishedAt,'2026-10-05');
  assert.equal(articlePublication('<div class="detail-info"><span>来源：证券时报网</span><span>作者：记者</span><span>2026-10-05 15:57</span></div>').publishedAt,'2026-10-05T07:57:00.000Z');
  assert.equal(articlePublication('<article><time datetime="2026-10-05T00:30:00Z">2026年10月5日</time></article>').publishedAt,'2026-10-05T00:30:00.000Z');
  assert.equal(articlePublication('<span class="publish-time">2026年10月5日 9:05</span>').publishedAt,'2026-10-05T01:05:00.000Z');
  assert.equal(sourceDate('2026-10-05T03:00:00.123Z'),'2026-10-05T03:00:00.123Z');
  assert.equal(sourceDate('2026-02-30'),undefined);
});
test('publication parsing never upgrades update times, navigation dates or old event dates',()=>{
  assert.equal(articlePublication('<div class="updated"><time datetime="2026-10-05">Updated</time></div>').publishedAt,undefined);
  assert.equal(articlePublication('<aside><time datetime="2026-10-05">推荐新闻</time></aside><article>模型在9月28日发布。</article>').publishedAt,undefined);
  assert.equal(articlePublication('<meta property="article:modified_time" content="2026-10-05"><article>2026年9月28日模型已经发布。</article>').publishedAt,undefined);
  assert.equal(articlePublication('<footer class="article-info">版权日期：2026-10-05</footer>').publishedAt,undefined);
});
test('nested article headers and structured article bodies stay readable without executing scripts',()=>{
  const nested=`<html><title>模型公告</title><aside><article>${'推荐广告。'.repeat(300)}</article></aside><main><article><header><h1>模型公告</h1><time datetime="2026-10-05">发布日期</time></header><section><article><p>${body}</p></article></section></article></main></html>`;
  const parsed=parseNewsPage(nested);assert.ok(parsed.excerpt.includes(body));assert.ok(!parsed.excerpt.includes('推荐广告'));assert.equal(parsed.publishedAt,'2026-10-05');
  const data={ '@type':'NewsArticle',headline:'模型公告',articleBody:body,datePublished:'2026-10-05T00:00:00Z'};
  const structured=parseNewsPage(`<title>模型公告</title><script type="application/ld+json">${JSON.stringify(data)}</script><main id="app"></main>`);
  assert.equal(structured.excerpt,body);assert.equal(structured.publishedAt,'2026-10-05T00:00:00.000Z');
  assert.throws(()=>parseNewsPage('<title>模型公告</title><main id="app"></main><script>document.body.innerText="'+body+'"</script>'),/正文不足/);
});
test('a fresh article about an old release is not a same-day event',()=>{
  const now=Date.parse('2026-10-05T12:00:00Z');
  const ref=(excerpt:string):ResearchReference=>({id:'ref-1',title:'Model',url:'https://news.example.com/model',verification:'news-page',publishedAt:'2026-10-05',freshness:'fresh',excerpt,retrievedAt:new Date(now).toISOString()});
  for(const quote of ['2026年10月5日报道，模型已在2026年9月28日发布。','今天报道此前消息：模型在9月28日发布了。','发布时间：2026年10月5日。模型之前已经发布，今天重新报道。','2026年10月5日没有宣布新的模型发布。'])assert.equal(hasTodayEventEvidence(ref(quote),quote,now),false,quote);
  for(const quote of ['2026年10月5日，官方宣布推出新模型。','官方今日宣布开放模型的新功能。','[Shenzhen, China, October 5, 2026] The company today announced a new model.'])assert.equal(hasTodayEventEvidence(ref(quote),quote,now),true,quote);
});
test('news selection keeps explicit versions but allows replacing agent-selected domain candidates',()=>{
  assert.equal(newsSearchPolicy('帮我生成今天发生的大模型热点口播视频').scope,'user-domain');
  assert.deepEqual(newsSearchPolicy('制作Fable5.5资讯视频').anchors,['Fable5.5']);
  assert.equal(newsSearchPolicy('制作今天的大模型视频\n研究方向：排除Claude5.5候选').scope,'user-domain');
});
test('page failures expose URLs and distinguish replaceable pages from retryable service faults',async()=>{
  const refs=['https://news.example.com/login','https://news.example.org/service'].map((url,i)=>({id:'ref-'+i,url,title:'News',excerpt:'search snippet',verification:'search-cited' as const,retrievedAt:''}));
  const result=await verifyNewsPages(refs,24,async url=>{if(url.includes('login'))return {url,text:'<title>Login</title><main>请登录</main>',contentType:'text/html'};throw new Error('HTTP 503');});
  assert.equal(result.references.length,0);assert.equal(result.pages.find(p=>p.url===refs[0].url)?.retryable,false);assert.equal(result.pages.find(p=>p.url===refs[1].url)?.retryable,true);
});

for(const preset of TEXT_MODEL_PRESETS)test(`${preset.modelId}: replaces an unreadable/stale candidate and completes original spoken daily request`,async()=>{
  const original=globalThis.fetch,queries:string[]=[],reads:string[]=[],events:any[]=[];let refinements=0;
  const now=new Date().toISOString(),date=beijingDate(),quote=`${date}，官方宣布推出新模型。`;
  const page=(old=false)=>`<title>${old?'旧型号回顾':'新模型官方公告'}</title><meta property="article:published_time" content="${old?'2026-09-28T00:00:00Z':now}"><article>${(old?'2026年9月28日，官方发布旧型号。':quote).repeat(12)}</article>`;
  const reply=(name:string,args:unknown)=>new Response(`data: ${JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:preset.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  globalThis.fetch=async(_input,init)=>{
    const payload=JSON.parse(String(init?.body)),name=payload.tools[0].function.name,context=JSON.stringify(payload.messages);
    if(name==='select_hot_topics')return reply(name,{signalIds:[],queries:['大模型 旧候选 官方']});
    if(name==='refine_news_search'){
      refinements++;assert.match(context,/第一次自行选出的候选不是用户指定主题/);assert.match(context,/login/);
      return reply(name,{signalIds:[],queries:[refinements===1?'大模型 新候选 当日发布 官方':'大模型 新候选 当日发布 可读媒体']});
    }
    assert.equal(name,'propose_hot_brief');
    return reply(name,{topics:[{title:'今日新模型正式推出',hook:'模型今天有什么新变化？',angle:'关系实际使用的新功能',signalIds:[],facts:[{text:quote,evidence:(refinements===1?['ref-2-p1']:['ref-2-p1','ref-3-p1']).map(passageId=>({passageId}))}],visualPlan:'功能变化对比图',uncertainties:[]}]});
  };
  try{
    const result=await researchHotTopics({...preset,kind:'text',provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'test-source-key'},'帮我生成一个最新新闻的一个口播视频，介绍今天发生的事情。呃，我希望和大模型相关的热点。',async e=>{events.splice(0,events.length,...structuredClone(e));},{
      read:async url=>{
        reads.push(url);
        if(url.includes('top.baidu.com'))return {url,text:'<!--s-data:{"data":{"cards":[{"component":"hotList","content":[]}]}}-->',contentType:'text/html'};
        if(url.includes('topstories.json'))return {url,text:'[]',contentType:'application/json'};
        if(url.includes('login'))return {url,text:'<title>登录</title><main>登录后查看</main>',contentType:'text/html'};
        return {url,text:page(url.includes('old')),contentType:'text/html'};
      },
      search:async(_config,query)=>{
        queries.push(query);const urls=query.includes('旧候选')?['https://forum.example.com/login','https://news.example.com/old']:query.includes('可读媒体')?['https://media.example.net/new','https://forum.example.com/login']:['https://news.example.org/new','https://forum.example.com/login'];
        return {summary:'Controlled actual-page references',references:urls.map((url,i)=>({id:'r'+i,url,title:'Article',excerpt:'Search is not body evidence',verification:'search-cited',retrievedAt:now})),queries:[query]};
      },
    });
    assert.equal(result.current?.topics.length,1);assert.equal(reads.filter(u=>u.includes('/login')).length,1);assert.equal(queries.length,4);assert.equal(refinements,2);
    assert.ok(queries.some(q=>q.includes('今日新模型正式推出')&&q.includes('-site:example.org')),'an eligible candidate missing a publisher gets one targeted independent-report query');
    assert.ok(result.current?.topics[0].facts[0].evidence.every(e=>!e.referenceId.includes('fake')));
    assert.ok(events.some(e=>e.tool==='refine_news_search'&&e.status==='succeeded'));
    assert.ok(!result.current?.failures.some(f=>f.includes('继续锁定原主题')));
  }finally{globalThis.fetch=original;}
});
