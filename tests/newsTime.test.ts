import test from 'node:test';
import assert from 'node:assert/strict';
import type { HotTopicSignal, LessonReport } from '../src/types';
import { beijingTimestamp, newsObservationContext, newsObservationFindings } from '../server/newsTime';
import { reviewLessonScript } from '../server/lessonWorkflow';
import { canReuseNewsEvidence } from '../server/reviewResults';

const asOf = '2026-10-14T16:57:03.000Z';
const signal = { id: 'baidu-1', title: '双11告别算数题', source: 'baidu', observedAt: asOf, rank: 1 } as HotTopicSignal;
const make = (narration: string): LessonReport => ({ hotResearch: { asOf, windowHours: 72, signals: [signal] }, chapters: [{ id: 'ch1', narration, visual: { takeaway: '', items: [] } }], references: [{ id: 'r1', verification: 'news-page', freshness: 'fresh', publishedAt: '2026-10-13T02:56:00Z', excerpt: '北京商报报道平台双11活动规则，未提供首次上榜时间。' }], factReview: { score: 100, needsRepair: false } } as unknown as LessonReport);

test('news observations expose an explicit Beijing timestamp across UTC midnight without inventing onset or publication', () => {
  assert.equal(beijingTimestamp(asOf), '2026-10-15 00:57:03');
  const context = newsObservationContext([{ ...signal, source: 'hackernews', submittedAt: '2026-10-14T08:30:00Z' }])[0];
  assert.equal(context.observedAtBeijing, '2026-10-15 00:57:03');
  assert.equal(context.communitySubmittedAtBeijing, '2026-10-14 16:30:00');
  assert.match(context.meaning, /首次上榜时间未知/);
  assert.match(context.submissionMeaning!, /不能充当.*发布时间/);
});

test('actual production phrase cannot turn a UTC chart snapshot into a dated chart event', () => {
  for (const text of ['十月十四日傍晚，双11告别算数题登上百度热搜', '十月十五日凌晨，双11首次登上热搜', '刚刚双11冲上百度热搜']) {
    const findings = newsObservationFindings(make(text));
    assert.equal(findings.length, 1, text); assert.match(findings[0], /2026-10-15 00:57:03/);
  }
});

test('accurate chart snapshots and selection actions remain valid, including later review across midnight', () => {
  for (const text of ['截至十月十五日凌晨，榜单显示双11告别算数题位居百度热搜第一', '截至10月15日00:57，双11位居百度热搜第一', '截至今天凌晨，百度热榜显示双11位居第一', '今天我们选择双11这个热搜，因为它关系到购物门槛', '本次核验看到双11已经登上热搜']) assert.deepEqual(newsObservationFindings(make(text), Date.parse(asOf)), [], text);
  for (const text of ['截至十月十四日傍晚，榜单显示双11位居百度热搜第一', '截至十月十五日下午，榜单显示双11位居热搜第一', '截至10月15日16:57，双11位居热搜第一']) assert.equal(newsObservationFindings(make(text)).length, 1, text);
  const report = make('截至十月十五日凌晨，榜单显示双11位居热搜第一');
  assert.equal(canReuseNewsEvidence(report, '制作最近三天新闻视频', Date.parse(asOf), Date.parse(asOf) + 25 * 3600000), true);
});

test('an actually read historical source can prove its reported chart date, while a search snippet cannot', () => {
  const text = '十月十四日傍晚，双11告别算数题登上百度热搜';
  const report = make(text); report.references[0].excerpt = '10月14日傍晚，双11告别算数题登上百度热搜。平台介绍了活动规则。';
  assert.deepEqual(newsObservationFindings(report), []);
  report.references[0].verification = 'search-cited';
  assert.equal(newsObservationFindings(report).length, 1);
});

test('a model score of 100 cannot bypass a chart-time error or reuse the invalid dated report', async () => {
  const report = make('十月十四日傍晚，双11告别算数题登上百度热搜');
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 100, needsRepair: false, findings: [], suggestions: [] }) } }] }), { status: 200 })) as typeof fetch;
  try {
    const reviewed = await reviewLessonScript({ id: 'fixture', name: 'fixture', provider: 'ark', kind: 'text', modelId: 'fixture', apiKey: 'test-private-credential', enabled: true, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, report, '真实榜单观察时间', undefined, undefined, '制作最近三天热点视频', Date.parse(asOf));
    assert.equal(reviewed.needsRepair, true); assert.match(reviewed.findings.join('；'), /热榜时间证据错误/);
    assert.equal(canReuseNewsEvidence(report, '制作最近三天热点视频', Date.parse(asOf), Date.parse(asOf)), false);
  } finally { globalThis.fetch = original; }
});

test('a snapshot qualifier cannot launder explicit onset times, sentence breaks, rendered headings or a different source year', () => {
  for (const text of ['截至十月十五日凌晨，双11于十月十五日凌晨登上百度热搜', '截至北京时间十月十五日凌晨，双11登上百度热搜', '十月十四日傍晚。双11登上百度热搜。', '今晚双11登上热搜', '双11刚登上热搜']) assert.equal(newsObservationFindings(make(text)).length, 1, text);
  const heading = make('截至本次核验，榜单显示双11位居热搜第一'); heading.chapters[0].title = '十月十四日傍晚登上百度热搜';
  assert.equal(newsObservationFindings(heading).length, 1);
  const old = make('2026年十月十四日傍晚，双11告别算数题登上百度热搜');
  old.references[0].excerpt = '2025年10月14日傍晚，双11告别算数题登上百度热搜';
  assert.equal(newsObservationFindings(old).length, 1);
  assert.deepEqual(newsObservationFindings(make('截至十月十五日凌晨，双11已经登上百度热搜')), []);
});

test('spoken Chinese clock values retain the exact observation hour and minute', () => {
  for (const text of ['截至十月十五日凌晨四点，榜单显示双11位居百度热搜第一', '截至十月十五日凌晨零点半，榜单显示双11位居百度热搜第一']) assert.equal(newsObservationFindings(make(text)).length, 1, text);
  for (const text of ['截至十月十五日凌晨零点五十七分，榜单显示双11位居百度热搜第一', '截至十月十五日凌晨〇点，榜单显示双11位居百度热搜第一']) assert.deepEqual(newsObservationFindings(make(text)), [], text);
  const afternoon = make('截至十月十五日下午两点半，榜单显示双11位居百度热搜第一');
  afternoon.hotResearch!.signals[0] = { ...signal, observedAt: '2026-10-15T06:30:00Z' };
  assert.deepEqual(newsObservationFindings(afternoon), []);
});
