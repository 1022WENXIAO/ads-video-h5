import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResearchReference, HotResearchBrief, WorkflowEvent } from '../src/types';
import { canonicalNewsUrl, newsSourceCandidates, newsSourceIdentity } from '../server/newsSourceUrls';
import { readNewsCanonical } from '../server/newsPage';
import { verifyNewsPages } from '../server/hotSources';
import { independentReportRecovery, researchHotTopics, validateHotBrief } from '../server/hotResearch';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

// These four article aliases occupied four read slots in the failed original
// spoken-request trace. They all returned the same 2,413-character article.
const official = 'https://www.anthropic.com/news/singapore-office-opening';
const aliases = [
  '?11c68ba5_page=2&30420a06_page=4&b8442f14_page=2&categoryid=2826699&d0ca0847_page=5&submissionguid=adab3198-bcb2-4708-b645-1721139a2d3d',
  '?35444d06_page=2&campaign_id=120212720648800419&nb_placement=Instagram_Reels&nbt=nb%3Afb%3Aig&page=20&r=0',
  '?35444d06_page=2&campaign_id=120212720648800424&nb_placement=Instagram_Reels&scroll_speed=instant&tab=case-studies',
  '?2621e453_page=2&b5089712_page=2&b8442f14_page=2&categoryid=2826701',
].map(query => official + query);
const ref = (url: string, id = 'r1'): ResearchReference => ({ id, url, title: 'News', excerpt: 'Search snippet is not source evidence', retrievedAt: '', verification: 'search-cited' });
const topic = (quote: string): HotResearchBrief['topics'][number] => ({ title: 'Anthropic 新模型公告', hook: '公告有何变化？', angle: '核对官方表述与独立报道', signalIds: [], facts: [{ text: quote, evidence: [{ referenceId: 'r1', quote }] }], visualPlan: '展示变化与限制', uncertainties: [] });

test('ambiguous original-trace query keys require actual HTML canonical proof; known click tracking is discarded', () => {
  for (const alias of aliases) assert.notEqual(canonicalNewsUrl(alias), official);
  assert.equal(newsSourceIdentity(official + '#section'), newsSourceIdentity(official.replace('www.', '')));
  assert.equal(canonicalNewsUrl('https://news.example.com/story?id=123&utm_source=ad&fbclid=x#text'), 'https://news.example.com/story?id=123');
  assert.notEqual(newsSourceIdentity('https://news.example.com/story?id=123'), newsSourceIdentity('https://news.example.com/story?id=456'));
  assert.notEqual(newsSourceIdentity('https://news.example.com/story?page=1'), newsSourceIdentity('https://news.example.com/story?page=2'));
  assert.notEqual(newsSourceIdentity('https://news.example.com/story?lang=en'), newsSourceIdentity('https://news.example.com/story?lang=zh'));
  assert.notEqual(newsSourceIdentity('https://news.example.com/forum?tid=123'), newsSourceIdentity('https://news.example.com/forum?tid=456'));
});

test('read slots deduplicate known tracking before limiting, reserve queries, and cap one publisher without suppressing independent articles', () => {
  const crowded = [...aliases, ...Array.from({ length: 9 }, (_, i) => `https://docs.example.com/page-${i}`), 'https://independent.example.net/report'];
  const other = Array.from({ length: 8 }, (_, i) => `https://other.example.org/report-${i}`);
  const sources = newsSourceCandidates([crowded.map(url => ref(url)), other.map(url => ref(url))]);
  assert.equal(sources.filter(source => new URL(source.url).hostname === 'www.anthropic.com').length, 3);
  assert.equal(sources.filter(source => source.url.includes('docs.example.com')).length, 3);
  assert.equal(sources.filter(source => source.url.includes('other.example.org')).length, 3);
  assert.ok(sources.some(source => source.url === 'https://independent.example.net/report'));
  assert.equal(sources[1].url, other[0]);
  const freshOnly = newsSourceCandidates([crowded.map(url => ref(url))], source => !source.url.includes('docs.example.com'));
  assert.ok(freshOnly.some(source => source.url.includes('independent.example.net')));
});

test('actual canonical links resolve original-trace official aliases to one source without accepting cross-site or section links', async () => {
  const reads: string[] = [], now = Date.parse('2026-10-14T17:08:24Z');
  const quote = 'Today, we are expanding our Asia-Pacific operations by opening a new office in Singapore.';
  const html = `<title>Singapore office and government MOU</title><link rel="canonical" href="${official}"><meta property="article:published_time" content="2026-10-14T08:30:00Z"><article>${quote.repeat(8)}</article>`;
  const verified = await verifyNewsPages(aliases.map(url => ref(url)), 24, async url => { reads.push(url); return { url, text: html, contentType: 'text/html' }; }, now);
  assert.deepEqual(reads, aliases.map(canonicalNewsUrl));
  assert.equal(verified.references.length, 1);
  assert.equal(verified.references[0].publishedAt, '2026-10-14T08:30:00.000Z');
  assert.equal(verified.references[0].freshness, 'fresh', 'within 24h still does not mean Beijing today');
  assert.equal(readNewsCanonical('<link rel="canonical" href="/news/story">', 'https://news.example.com/news/story?alias=1'), 'https://news.example.com/news/story');
  for (const target of ['https://other.example.net/news/story', '/', '/news/']) assert.equal(readNewsCanonical(`<link rel="canonical" href="${target}">`, 'https://news.example.com/news/story?alias=1'), 'https://news.example.com/news/story?alias=1');
});

test('targeted recovery requires an eligible event and never treats yesterday official announcement or aliases as independent proof', () => {
  const now = Date.parse('2026-10-14T17:08:24Z'), quote = 'Today, we announced our new model and its public availability.';
  const yesterday: ResearchReference = { ...ref(official), excerpt: quote.repeat(5), verification: 'news-page', publishedAt: '2026-10-14T08:30:00.000Z', freshness: 'fresh' };
  assert.equal(independentReportRecovery(topic(quote), [yesterday], true, now), undefined);
  const today = { ...yesterday, publishedAt: '2026-10-14T16:30:00.000Z' };
  const recovery = independentReportRecovery(topic(quote), [today], true, now);
  assert.match(recovery!.query, /Anthropic.*-site:anthropic\.com/);
  assert.equal(independentReportRecovery(topic(quote), [today], true, now, ['Fable5.5']), undefined, 'do not inject another product into a fixed-version request');
  const duplicated = { ...today, id: 'r2', url: aliases[2] }, twoAliases = topic(quote);
  twoAliases.facts[0].evidence.push({ referenceId: 'r2', quote });
  assert.throws(() => validateHotBrief([twoAliases], [today, duplicated], []), /两家独立发布者/);
});

test('natural spoken-news workflow resolves canonical sources and actually searches a missing independent report before accepting', async () => {
  const original = globalThis.fetch, queries: string[] = [], reads: string[] = [], events: WorkflowEvent[] = [];
  const now = new Date().toISOString(), quote = 'Today, Anthropic announced a new model with public access and documented limitations.';
  const page = `<title>Anthropic new model announcement</title><meta property="article:published_time" content="${now}"><article>${quote.repeat(9)}</article>`;
  let proposals = 0;
  globalThis.fetch = async (_input, init) => {
    const payload = JSON.parse(String(init?.body)), name = payload.tools[0].function.name;
    let args: unknown;
    if (name === 'select_hot_topics') args = { signalIds: [], queries: ['大模型 最新公告'] };
    else if (name === 'refine_news_search') args = { signalIds: [], queries: ['大模型 其他当日新闻'] };
    else {
      assert.equal(name, 'propose_hot_brief'); proposals++;
      args = { topics: [{ ...topic(quote), facts: [{ text: quote, evidence: (proposals === 1 ? ['ref-1-p1'] : ['ref-1-p1', 'ref-2-p1']).map(passageId => ({ passageId })) }] }] };
    }
    return new Response(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: TEXT_MODEL_PRESETS[0].modelId, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + name + proposals, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const result = await researchHotTopics({ ...TEXT_MODEL_PRESETS[0], kind: 'text', provider: 'ark', baseUrl: ARK_BASE_URL, enabled: true, apiKey: 'fake-test-key' }, '帮我生成一个最新新闻的一个口播视频，介绍今天发生的事情。呃，你在选择新闻的时候先啊，深度思考一下，为什么选这篇新闻的原因，我希望和大模型相关的。然后的热点。', async next => { events.splice(0, events.length, ...structuredClone(next)); }, {
      read: async url => {
        if (url.includes('top.baidu.com')) return { url, text: '<!--s-data:{"data":{"cards":[{"component":"hotList","content":[]}]}}-->', contentType: 'text/html' };
        if (url.includes('topstories.json')) return { url, text: '[]', contentType: 'application/json' };
        reads.push(url); return { url, text: url.includes('anthropic.com') ? page + `<link rel="canonical" href="${official}">` : page, contentType: 'text/html' };
      },
      search: async (_config, query) => {
        queries.push(query);
        const urls = query.includes('-site:anthropic.com') ? ['https://independent.example.net/anthropic-new-model', ...aliases] : aliases;
        return { summary: 'Fixture search citations', references: urls.map((url, i) => ref(url, 'r' + i)), queries: [query] };
      },
    });
    assert.equal(result.current?.topics.length, 1);
    assert.equal(proposals, 2);
    assert.equal(reads.filter(url => url.includes('anthropic.com')).length, 4, 'each ambiguous alias is read at most once, then actual canonical proof merges its evidence');
    assert.equal(reads.filter(url => url === 'https://independent.example.net/anthropic-new-model').length, 1);
    assert.equal(new Set(reads).size, reads.length);
    assert.equal(queries.length, 3);
    assert.ok(queries.some(query => /Anthropic.*-site:anthropic\.com/.test(query)));
    const proposalsTrace = events.filter(event => event.tool === 'propose_hot_brief' && event.status === 'succeeded');
    assert.equal(proposalsTrace.length, 2);
    assert.match(JSON.stringify(proposalsTrace[0].output), /independent-report/);
    assert.match(JSON.stringify(proposalsTrace[0].output), /"topics":\[\]/);
    assert.equal(result.references.length, 2);
    assert.equal(result.current!.topics[0].facts[0].evidence.length, 2);
  } finally { globalThis.fetch = original; }
});
