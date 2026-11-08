import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { researchDeepQuestion } from '../server/deepQuestionResearch';
import { questionNeedsResearch, resolveResearchMode, type QuestionResearch } from '../server/questionResearch';
import { searchSearx } from '../server/searxSearch';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';
import type { ModelConfig } from '../server/modelRegistry';

const config: ModelConfig = { id: 'test', name: 'Test', modelId: 'fixture', kind: 'text', provider: 'ark', enabled: true, apiKey: 'fixture-private-key', baseUrl: 'https://example.invalid' };
function evidence(n: number): QuestionResearch {
  return { observedAt: new Date().toISOString(), references: [{ id: 'ref-1', title: 'Evidence ' + n, url: `https://source${n}.example.org/article`, excerpt: '实际读取的正文 ' + n, verification: 'public-page' }], failures: [], queries: [{ query: 'query-' + n }] };
}

test('capability questions avoid irrelevant searches; deep intent and explicit offline instructions resolve independently', () => {
  for (const p of ['你会上网查资料吗~', '轻喵可以联网搜索吗？', '请问你支持联网吗']) assert.equal(questionNeedsResearch(p), false, p);
  assert.equal(questionNeedsResearch('请帮我联网搜索最新政策'), true);
  assert.equal(resolveResearchMode('联网搜索和深度探索有什么区别？'), 'auto');
  assert.equal(resolveResearchMode('帮我深度研究太阳能储能方案'), 'deep');
  assert.equal(resolveResearchMode('深度探索：太阳能储能方案'), 'deep');
  assert.equal(resolveResearchMode('不用搜索，只解释原理', 'deep'), 'off');
  assert.equal(resolveResearchMode('解释原理', 'web'), 'web');
});

test('deep exploration continues past three rounds, reads new evidence and keeps every source in snapshots', async () => {
  let searches = 0, plans = 0; const snapshots: number[] = [], rounds: number[] = [];
  const result = await researchDeepQuestion(config, '原问题', {
    research: async () => evidence(++searches),
    plan: async (_model, original, current) => {
      assert.equal(original, '原问题'); assert.equal(current.references.length, searches);
      return ++plans < 6 ? { done: false, queries: ['待核验缺口-' + plans], reason: '补足证据' } : { done: true, queries: [], reason: '主要问题已有充分证据' };
    }, onRound: async round => { rounds.push(round); }, onSnapshot: async e => { snapshots.push(e.references.length); },
  });
  assert.equal(searches, 6); assert.equal(plans, 6); assert.equal(result.mode, 'deep');
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6]); assert.equal(result.references.length, 6);
  assert.deepEqual(result.references.map(r => r.id), ['ref-1', 'ref-2', 'ref-3', 'ref-4', 'ref-5', 'ref-6']);
  assert.equal(snapshots.at(-1), 6); assert.equal(result.failures.length, 0);
});

test('duplicate queries or duplicate bodies cannot manufacture research progress', async () => {
  for (const repeatedQuery of [true, false]) {
    let searches = 0, plans = 0;
    const result = await researchDeepQuestion(config, '原问题', {
      research: async () => { const e = evidence(++searches); e.references[0].excerpt = '所有网址实际上同一段正文'; return e; },
      plan: async () => { plans++; return { done: false, queries: [repeatedQuery ? '原问题' : '另一个问题'], reason: '缺口' }; },
    });
    assert.equal(plans, 1); assert.equal(searches, repeatedQuery ? 1 : 2); assert.equal(result.references.length, 1);
    assert.match(result.failures.join('\n'), repeatedQuery ? /重复/ : /没有取得新增/);
  }
});

test('later provider or planner failures retain earlier evidence and redact the configured key', async () => {
  let searches = 0;
  const result = await researchDeepQuestion(config, '原问题', {
    research: async () => { if (++searches > 1) throw new Error('HTTP 503 ' + config.apiKey); return evidence(1); },
    plan: async () => ({ done: false, queries: ['缺口'], reason: '缺口' }),
  });
  assert.equal(result.references.length, 1); assert.match(result.failures.join('\n'), /后续查询失败/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-key/);
  const failedPlan = await researchDeepQuestion(config, '原问题', { research: async () => evidence(1), plan: async () => { throw new Error('invalid JSON'); } });
  assert.equal(failedPlan.references.length, 1); assert.match(failedPlan.failures.join('\n'), /规划未完成/);
});

test('user stop cancels deep exploration instead of being swallowed as a search failure', async () => {
  const stop = new AbortController(); let searches = 0;
  await assert.rejects(runWithJobSignal(stop.signal, () => researchDeepQuestion(config, '原问题', {
    research: async () => { searches++; return evidence(1); },
    plan: async () => { stop.abort(); return { done: false, queries: ['不应执行'], reason: '继续' }; },
  })), JobCancelledError);
  assert.equal(searches, 1);
});

test('real planner validates a structured decision and stops once evidence is sufficient', async t => {
  const provider = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.equal(req.url, '/chat/completions'); assert.equal(body.response_format.type, 'json_object');
    assert.equal(req.headers.authorization, 'Bearer ' + config.apiKey);
    assert.match(body.messages[0].content, /不设置固定检索轮数/); assert.match(body.messages[1].content, /原问题/);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ done: true, queries: [], reason: '证据充分' }) } }] }));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise<void>(r => provider.close(() => r())));
  const result = await researchDeepQuestion({ ...config, baseUrl: `http://127.0.0.1:${(provider.address() as any).port}` }, '原问题', { research: async () => evidence(1) });
  assert.equal(result.references.length, 1); assert.equal((result.queries.at(-1) as any).rounds, 1);
});

test('SearXNG adapter uses the documented JSON API, filters private URLs and exposes failed engines without claiming body verification', async t => {
  let code = 200, body: any = { results: [null, { url: 'https://example.org/article', title: '原文', content: '搜索摘要' }, { url: 'https://example.org/article', title: '重复' }, { url: 'https://127.0.0.1/secret', title: 'Private' }], unresponsive_engines: [['bing', 'timeout']] };
  const provider = createServer((req, res) => {
    const url = new URL(req.url!, 'http://fixture');
    assert.equal(req.method, 'GET'); assert.equal(url.pathname, '/search'); assert.equal(url.searchParams.get('q'), '搜索词');
    assert.equal(url.searchParams.get('format'), 'json'); assert.equal(url.searchParams.get('language'), 'zh-CN');
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise<void>(r => provider.close(() => r())));
  const base = `http://127.0.0.1:${(provider.address() as any).port}`;
  const result = await searchSearx('搜索词', base);
  assert.equal(result.references.length, 1); assert.equal(result.references[0].verification, 'search-cited'); assert.match(result.references[0].excerpt, /不是网页正文/);
  assert.deepEqual((result.queries[0] as any).unresponsiveEngines, [['bing', 'timeout']]);
  code = 403; await assert.rejects(searchSearx('搜索词', base), /HTTP 403/);
  code = 200; body = null; await assert.rejects(searchSearx('搜索词', base), /JSON 搜索结果/);
  await assert.rejects(searchSearx('搜索词', 'https://outside.example.org'), /回环/);
  await assert.rejects(searchSearx('搜索词', ''), /尚未配置/);
});
