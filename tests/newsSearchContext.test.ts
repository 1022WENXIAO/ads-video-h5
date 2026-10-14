import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsSearchContext, newsSearchInstructions, openNewsSearchQuery, researchGaps, type NewsSearchContext } from '../server/narrativeResearch';
import { researchHotTopics } from '../server/hotResearch';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

const originalRequest = '帮我生成一个最新新闻的一个口播视频，介绍今天发生的事情。呃，你在选择新闻的时候先啊，深度思考一下，为什么选这篇新闻的原因，我希望和大模型相关的。然后的热点。';
const requestedAt = Date.parse('2026-10-14T17:44:53.685Z');
const config = { ...TEXT_MODEL_PRESETS[0], kind: 'text' as const, provider: 'ark', baseUrl: ARK_BASE_URL, enabled: true, apiKey: 'fake-context-key' };

test('strict Beijing today is a frozen calendar interval and request cutoff, not a moving 24h or UTC date', () => {
  const context = createNewsSearchContext(originalRequest, true, requestedAt);
  assert.equal(context.calendarDate, '2026-10-15');
  assert.equal(context.startUtc, '2026-10-14T16:00:00.000Z');
  assert.equal(context.endExclusiveUtc, '2026-10-15T16:00:00.000Z');
  assert.equal(context.cutoffUtc, '2026-10-14T17:44:53.685Z');
  assert.equal(context.originalRequest, originalRequest);
  assert.deepEqual(context.scopeKeywords, ['大模型']);
  assert.equal(context.strictToday, true);
  assert.match(newsSearchInstructions(context), /近24小时只是背景资料.*不等于今天发生/);
  assert.match(newsSearchInstructions(context), /西半球当地前一天.*不能强行改写原文日期/);
  assert.match(newsSearchInstructions(context), /不随补查轮次移动/);
  assert.equal(createNewsSearchContext(originalRequest, true, Date.parse('2026-12-31T16:00:00Z')).startUtc, '2026-12-31T16:00:00.000Z');
  assert.equal(createNewsSearchContext(originalRequest, true, Date.parse('2026-12-31T16:00:00Z')).calendarDate, '2027-01-01');
  assert.match(newsSearchInstructions(createNewsSearchContext('今天值得讲的近三天模型新闻', false, requestedAt)), /未要求事件必须在当日日历日发生/);
});

test('Ark news search receives original scope and fixed boundaries without rewriting a valid western-local previous date', async () => {
  const previous = globalThis.fetch, previousBase = process.env.QINGJIAN_OPEN_WEBSEARCH_URL;
  delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL;
  let captured: any;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ output: [{ type: 'web_search_call', status: 'completed', action: { query: 'actual search' } }, { content: [{ type: 'output_text', text: 'Actual retrieved citation.', annotations: [{ type: 'url_citation', url: 'https://news.example.org/article', title: 'Actual news' }] }] }] }));
  };
  try {
    const context = createNewsSearchContext(originalRequest, true, requestedAt);
    const result = await researchGaps(config, 'October 14 2026 US afternoon model announcement', ['近24小时仅作背景'], 'news', context);
    assert.match(captured.input, /October 14 2026 US afternoon model announcement/);
    assert.ok(captured.input.includes(originalRequest));
    assert.ok(captured.input.includes(JSON.stringify(context)));
    assert.doesNotMatch(captured.input, /当前UTC时间/);
    assert.deepEqual((result.queries[0] as any).newsContext, context);
    assert.equal(result.references[0].verification, 'search-cited', 'context cannot promote a search citation to verified body evidence');
  } finally {
    globalThis.fetch = previous;
    if (previousBase === undefined) delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL; else process.env.QINGJIAN_OPEN_WEBSEARCH_URL = previousBase;
  }
});

test('open-web search receives the same typed original-domain/calendar contract and keeps its existing response contract', async () => {
  const previous = globalThis.fetch, previousBase = process.env.QINGJIAN_OPEN_WEBSEARCH_URL;
  process.env.QINGJIAN_OPEN_WEBSEARCH_URL = 'http://127.0.0.1:18000';
  let captured: any;
  globalThis.fetch = async (_input, init) => {
    captured = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: 'ok', data: { results: [{ title: 'Actual linked page', url: 'https://news.example.org/report', description: 'Search-only excerpt' }], engines: ['bing'] } }));
  };
  try {
    const context = createNewsSearchContext(originalRequest, true, requestedAt);
    const result = await researchGaps(config, 'October 14 2026 US afternoon model announcement', ['新闻正文及独立来源'], 'news', context);
    assert.match(captured.query, /October 14 2026 US afternoon model announcement/);
    for (const value of ['大模型','2026-10-14','2026-10-15']) assert.ok(captured.query.includes(value));
    assert.doesNotMatch(captured.query, /strictToday|startUtc|endExclusiveUtc|cutoffUtc|originalRequest|[{}]/);
    assert.ok(!captured.query.includes(originalRequest));
    assert.ok(captured.query.length <= 1000);
    assert.ok(openNewsSearchQuery('x'.repeat(5000),context).length <= 1000);
    assert.equal(captured.searchMode, 'request');
    assert.deepEqual((result.queries[0] as any).newsContext, context);
    assert.equal(result.references[0].verification, 'search-cited');
  } finally {
    globalThis.fetch = previous;
    if (previousBase === undefined) delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL; else process.env.QINGJIAN_OPEN_WEBSEARCH_URL = previousBase;
  }
});

test('short and lesson open-web queries retain their prior keywords and do not inherit a news contract', async () => {
  const previous=globalThis.fetch,previousBase=process.env.QINGJIAN_OPEN_WEBSEARCH_URL;
  process.env.QINGJIAN_OPEN_WEBSEARCH_URL='http://127.0.0.1:18000';
  const queries:string[]=[];
  globalThis.fetch=async(_input,init)=>{queries.push(JSON.parse(String(init?.body)).query);return new Response(JSON.stringify({status:'ok',data:{results:[{title:'Primary source',url:'https://official.example.com/flask',description:'Source'}]}}));};
  try{
    for(const purpose of ['short','lesson'] as const){
      const result=await researchGaps(config,'保温杯',['真空隔热原理'],purpose,createNewsSearchContext(originalRequest,true,requestedAt));
      assert.ok(!(result.queries[0] as any).newsContext);
    }
    assert.deepEqual(queries,['保温杯 真空隔热原理 官方 原始资料','保温杯 真空隔热原理 官方 原始资料']);
  }finally{globalThis.fetch=previous;if(previousBase===undefined)delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL;else process.env.QINGJIAN_OPEN_WEBSEARCH_URL=previousBase;}
});

test('each stateless proposal receives current actual queries and specific prior rejections; new evidence may repair the same topic', async () => {
  const previous = globalThis.fetch, previousNow = Date.now;
  Date.now = () => requestedAt;
  let refinements = 0, proposals = 0;
  const proposalContexts: any[] = [], searchContexts: NewsSearchContext[] = [], searches: string[] = [];
  const firstTitle = 'Gemini 4 Argon 今日新功能上线';
  const oldQuote = '谷歌宣布为Gemini 4 Argon开放新的模型功能，详细限制需要进一步核验。';
  const newQuote = '2026年10月15日，谷歌宣布为Gemini 4 Argon开放新的模型功能。';
  const page = (quote: string, publishedAt?: string) => `<title>模型功能公告</title>${publishedAt ? `<meta property="article:published_time" content="${publishedAt}">` : ''}<article>${quote.repeat(12)}</article>`;
  const text = (messages: any[]) => messages.flatMap(message => typeof message.content === 'string' ? [message.content] : Array.isArray(message.content) ? message.content.map((part: any) => part.text || '') : []).join('\n');
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)), name = payload.tools[0].function.name;
    let args: any;
    if (name === 'select_hot_topics') args = { signalIds: [], queries: ['2026年10月14日 大模型 官方发布'] };
    else if (name === 'refine_news_search') {
      refinements++;
      args = { signalIds: [], queries: [refinements === 1 ? 'Linus Torvalds October 14 Claude Code' : '2026年10月15日 Gemini 4 Argon 新功能 独立报道'] };
    } else {
      assert.equal(name, 'propose_hot_brief');
      proposals++;
      const context = /本轮提案上下文[^\n]*?：({[^\n]+})。选题须/.exec(text(payload.messages));
      assert.ok(context, 'fresh proposal Agent needs an explicit stage contract');
      proposalContexts.push(JSON.parse(context[1]));
      const title = proposals === 2 ? '谷歌Gemini 4 Argon的新功能正式上线' : firstTitle;
      args = { topics: [{ title, hook: '大模型功能有什么变化？', angle: '核对本轮查证的模型更新及限制', signalIds: [], facts: [{ text: proposals === 3 ? newQuote : oldQuote, evidence: (proposals === 3 ? ['ref-4-p1', 'ref-5-p1'] : ['ref-1-p1', 'ref-2-p1']).map(passageId => ({ passageId })) }], visualPlan: '说明新功能与适用边界', uncertainties: [] }] };
    }
    return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + name + refinements + proposals, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await researchHotTopics(config, originalRequest, undefined, { requestedAt,
      read: async url => {
        if (url.includes('top.baidu.com')) return { url, text: '<!--s-data:{"data":{"cards":[{"component":"hotList","content":[]}]}}-->', contentType: 'text/html' };
        if (url.includes('topstories.json')) return { url, text: '[]', contentType: 'application/json' };
        return { url, text: url.includes('/new') ? page(newQuote, '2026-10-14T17:00:00Z') : url.includes('background') ? page('这份报道仅作背景，不能证明模型今天发布。', '2026-10-14T10:00:00Z') : page(oldQuote), contentType: 'text/html' };
      },
      search: async (_config, query, _gaps, purpose, context) => {
        assert.equal(purpose, 'news');
        assert.ok(context);
        searchContexts.push(structuredClone(context)); searches.push(query);
        const urls = refinements === 2 ? ['https://official.example.com/new', 'https://report.example.net/new'] : ['https://official.example.com/undated', 'https://report.example.net/undated', 'https://background.example.org/article'];
        return { summary: 'Controlled original-trace source shape', references: urls.map((url, i) => ({ id: 'r' + i, title: 'News', url, excerpt: 'Search-only snippet', retrievedAt: '', verification: 'search-cited' as const })), queries: [query] };
      },
    });
    assert.equal(proposals, 3);
    assert.equal(proposalContexts[0].rejectedTopics.length, 0);
    assert.equal(proposalContexts[1].actualQueries[0], 'Linus Torvalds October 14 Claude Code');
    assert.deepEqual(proposalContexts[1].selection.queries, proposalContexts[1].actualQueries);
    assert.equal(proposalContexts[1].rejectedTopics[0].title, firstTitle);
    assert.match(proposalContexts[1].rejectedTopics[0].reason, /真实发布时间/);
    assert.equal(proposalContexts[2].rejectedTopics.length, 2);
    assert.equal(proposalContexts[2].actualQueries[0], searches[2]);
    for (const context of searchContexts) assert.deepEqual(context, createNewsSearchContext(originalRequest, true, requestedAt));
    assert.equal(result.current?.topics.length, 1);
    assert.equal(result.current!.topics[0].title, firstTitle, 'a rejection must not permanently ban the same topic after its evidence gap is actually fixed');
    assert.equal(result.current!.topics[0].facts[0].evidence.length, 2);
    assert.ok(result.current!.failures.some(reason => reason.includes('真实发布时间')), 'the original failed attempts remain recorded');
  } finally { globalThis.fetch = previous; Date.now = previousNow; }
});
