import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type { HotTopicSignal, LessonReport } from '../src/types';
import { beijingTimestamp, newsObservationContext, newsObservationFindings } from '../server/newsTime';
import { reviewLessonScript } from '../server/lessonWorkflow';
import { canReuseNewsEvidence, newsFreshAtOriginalRequest } from '../server/reviewResults';

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
  // Reusable news must now also bind a real publication date to a core fact.
  report.references[0].dateEvidence='JSON-LD datePublished: 2026-10-13T02:56:00Z';
  const coreQuote=report.references[0].excerpt.split('，')[0];
  report.chapters[0].claims=[{text:coreQuote,referenceIds:['r1'],basis:'source'}];
  report.hotResearch!.topics=[{title:'双11活动规则',hook:'新报道',angle:'规则',signalIds:['baidu-1'],facts:[{text:coreQuote,evidence:[{referenceId:'r1',quote:coreQuote}]}],visualPlan:'图解',uncertainties:[]}];
  assert.equal(canReuseNewsEvidence(report, '制作最近三天新闻视频', Date.parse(asOf), Date.parse(asOf) + 25 * 3600000), true);
});

test('an actually read historical source can prove its reported chart date, while a search snippet cannot', () => {
  const text = '十月十四日傍晚，双11告别算数题登上百度热搜';
  const report = make(text); report.references[0].excerpt = '10月14日傍晚，双11告别算数题登上百度热搜。平台介绍了活动规则。';
  assert.deepEqual(newsObservationFindings(report), []);
  report.references[0].verification = 'search-cited';
  assert.equal(newsObservationFindings(report).length, 1);
});

test('an exact dated phrase inside source denial cannot prove its opposite affirmative chart entry',()=>{
  const text='10月14日傍晚，该报道首次登上百度热搜';
  for(const prefix of ['尚无证据表明','该页面否认','快照不能证明','该报道已上榜，但本次观察不能证明']){
    const report=make(text);report.references[0].excerpt=prefix+text+'。';assert.equal(newsObservationFindings(report).length,1,prefix);
  }
  const affirmative=make(text);affirmative.references[0].excerpt='报道写明：'+text+'。';assert.deepEqual(newsObservationFindings(affirmative),[]);
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


test('original-request publication freshness keeps exact Beijing date-only boundaries and rejects future or unverifiable source dates',()=>{
  const requestedAt=Date.parse('2026-10-14T16:00:00Z'),reviewedAt=requestedAt+2*3600000;
  const report={hotResearch:{asOf:new Date(requestedAt+10*60000).toISOString(),windowHours:24},references:[{id:'r1',verification:'news-page',freshness:'fresh',publishedAt:'2026-10-14'}]} as unknown as LessonReport;
  assert.equal(newsFreshAtOriginalRequest(report,requestedAt,reviewedAt),true,'date-only publication is Beijing midnight exactly 24h before the cutoff');
  assert.equal(newsFreshAtOriginalRequest(report,requestedAt+1,reviewedAt),false,'one millisecond beyond the original window cannot pass for a new request');
  for(const date of ['2026-10-15T00:00:00+08:00','2026-10-15T00:00:00.001+08:00','2026-02-31','unknown']){
    report.references[0].publishedAt=date;assert.equal(newsFreshAtOriginalRequest(report,requestedAt,reviewedAt),date==='2026-10-15T00:00:00+08:00',date);
  }
  report.references[0].publishedAt='2026-10-14';report.references[0].verification='search-cited';assert.equal(newsFreshAtOriginalRequest(report,requestedAt,reviewedAt),false);
  report.references[0].verification='news-page';report.references[0].freshness='stale';assert.equal(newsFreshAtOriginalRequest(report,requestedAt,reviewedAt),false);
});


const productionSnapshot=JSON.parse(await readFile(new URL('./fixtures/news-time-snapshot-1fc.json',import.meta.url),'utf8'));
const snapshotReport=(narration:string):LessonReport=>({hotResearch:{asOf:productionSnapshot.signal.observedAt,windowHours:24,signals:[structuredClone(productionSnapshot.signal)]},chapters:[{id:'chapter-1',narration,claims:[],visual:{takeaway:'',items:[]}}],references:[]} as unknown as LessonReport);
test('exact production snapshot statements and the narrow unknown-onset warning are not first-entry claims',()=>{
  const original=JSON.stringify(productionSnapshot.signal);
  for(const text of [...productionSnapshot.texts,productionSnapshot.claimText,'本次观察 2026年10月15日04时27分57秒，百度热搜显示该报道在榜','首次上榜时间未知','本次观察无法确认首次上榜日期']){
    const report=snapshotReport(text);assert.deepEqual(newsObservationFindings(report,productionSnapshot.requestedAt),[],text);assert.equal(JSON.stringify(report.hotResearch!.signals[0]),original);
  }
  const actual=snapshotReport(productionSnapshot.narration);actual.chapters[0].claims=[{text:productionSnapshot.claimText,referenceIds:[]}];actual.chapters[0].visual.items=[{label:productionSnapshot.texts[2],detail:'',cue:''}];
  assert.deepEqual(newsObservationFindings(actual,productionSnapshot.requestedAt),[],'actual narration, combined claim and visible snapshot label share the same source clock');assert.equal(JSON.stringify(productionSnapshot.signal),original);
});
test('snapshot markers still require the exact source year date hour minute and explicit seconds',()=>{
  for(const text of ['热搜快照 10月14日 04:27','热搜快照 10月15日 16:27','热搜快照 10月15日 04:28','热搜快照 2025年10月15日04时27分57秒','热搜快照 2026年10月15日04时27分58秒','热搜快照 2026-10-15 04:27:58','本次观察 10月14日04:27，百度热搜显示该报道在榜','不证明首次上榜时间，热搜快照10月15日04:28'])assert.ok(newsObservationFindings(snapshotReport(text),productionSnapshot.requestedAt).length,text);
  for(const text of ['热搜快照 2026年10月15日04时27分57秒','热搜快照 2026-10-15 04:27:57','热搜快照 十月十五日凌晨四点二十七分五十七秒'])assert.deepEqual(newsObservationFindings(snapshotReport(text),productionSnapshot.requestedAt),[],text);
});
test('a warning never excuses an actual first-entry claim before after or inside the same clause',()=>{
  for(const text of ['不证明首次上榜时间，但今天首次上榜','今天首次上榜，但不证明首次上榜时间','不证明首次上榜时间但今天首次上榜','首次上榜时间未知；今天首次上榜','本次观察无法确认首次上榜日期，今日刚刚冲上热搜','热搜快照10月15日04:27显示今天首次上榜','并非不证明首次上榜时间','不是不代表首次上榜时间','不能不证明首次上榜时间'])assert.ok(newsObservationFindings(snapshotReport(text),productionSnapshot.requestedAt).length,text);
  const dated='2026年10月14日傍晚，该报道首次登上百度热搜。',report=snapshotReport(dated);report.references=[{id:'historical',title:'Actual historical quote fixture',url:'https://example.invalid/historical',verification:'news-page',freshness:'fresh',excerpt:dated}];
  assert.deepEqual(newsObservationFindings(report,productionSnapshot.requestedAt),[],'an exact actually-read historical onset quote remains a distinct source-backed exception');
  report.references[0].verification='search-cited';assert.ok(newsObservationFindings(report,productionSnapshot.requestedAt).length,'a search snippet still cannot prove historical first entry');
});


test('the first production draft separates explicit reporting and event dates from the chart observation date',()=>{
  for(const text of [productionSnapshot.firstDraftText,'热搜关注这条成都通报，通报发布日期为2026年10月14日','热搜关注这条成都通报，事件发生日期是十月十二日','热搜快照10月15日04:27，报道日期是十月十四日','报道日期是十月十四日，事件发生日期是十月十二日，热搜快照10月15日04:27'])assert.deepEqual(newsObservationFindings(snapshotReport(text),productionSnapshot.requestedAt),[],text);
  for(const text of ['十月十四日上榜','热搜关注这条成都通报，报道日期是十月十四日，十月十四日上榜','热搜关注这条成都通报，报道日期是十月十四日，说明当天上榜','热搜关注这条成都通报，报道日期是十月十四日且当天首次上榜','报道日期是十月十四日，但今天首次登上热搜','不证明首次上榜时间，报道日期是十月十四日，但今天首次上榜','热搜快照10月14日04:27，报道日期是十月十四日','热搜快照10月15日04:28，报道日期是十月十四日'])assert.ok(newsObservationFindings(snapshotReport(text),productionSnapshot.requestedAt).length,text);
});

const p8Incident=JSON.parse(await readFile(new URL('./fixtures/news-time-attribution-p8.json',import.meta.url),'utf8'));
const p8Report=(text:string):LessonReport=>({hotResearch:{asOf:p8Incident.signal.observedAt,windowHours:24,signals:[structuredClone(p8Incident.signal)]},chapters:[{id:'ch1',narration:text,visual:{takeaway:'',items:[]}}],references:[]} as unknown as LessonReport);
const p8Findings=(text:string)=>newsObservationFindings(p8Report(text),p8Incident.requestedAt);

test('P8 full production clauses attribute reporting/event dates without changing any real heat signals',()=>{
  const original=JSON.stringify(p8Incident.signal);
  for(const text of p8Incident.texts){
    const report=p8Report(text);assert.deepEqual(newsObservationFindings(report,p8Incident.requestedAt),[],text);assert.equal(JSON.stringify(report.hotResearch!.signals[0]),original);
  }
  // Publication/event-date correctness is still checked by the separate fact,
  // today and source-publication gates; this guard only prevents chart inference.
  for(const descriptor of ['这条热搜','热榜关注的这条消息','当前在榜的新闻','百度热搜第12的这条通报']){
    for(const dateAttribution of ['报道于二零二六年十月十四日','报道日期是10月14日','于10月14日发布','是十月十四日发布的报道']){
      for(const separator of ['，','。','；','，但'])assert.deepEqual(p8Findings(`${descriptor}${dateAttribution}${separator}事情发生在十月十二日下午一点四十四分。`),[],`${descriptor}/${dateAttribution}/${separator}`);
    }
  }
  for(const text of ['报道日期10月14日，榜单快照10月15日04:53:24，事件发生在10月12日13:44','热搜快照10月15日04:53:24，报道于10月14日，案件发生在10月12日13:44','截至核验，榜单显示该报道在榜，报道日期是十月十四日','10月14日发布的这条热搜报道，事件发生日期为十月十二日'])assert.deepEqual(p8Findings(text),[],text);
});

test('P8 observation warnings use proposition-level negation rather than a subject or time-noun whitelist',()=>{
  for(const subject of ['该观察','这次观察','此次快照','这张榜单的截屏','现在看到的排名','本次采样结果','这一抓取记录',''])for(const denial of ['不代表','不能证明','无法确认','不足以说明','并非表明','尚无证据证明'])for(const object of ['首次上榜','这是首次上榜','首次上榜时间','刚刚登上热搜']){
    const warning=`${subject}${denial}${object}`;
    for(const separator of ['，','。','；'])assert.deepEqual(p8Findings(`10月15日04:53:24榜单快照${separator}${warning}`),[],warning);
  }
  for(const text of ['首次上榜时间仍未知','首次上榜日期未获证实','首次上榜日期未证实','首次上榜时间尚未披露','首次上榜日期没有公布','是否首次上榜尚不清楚','该观察不能证明未发布的模型首次上榜','并非今天发布的报道首次上榜时间未知'])assert.deepEqual(p8Findings(text),[],text);
});

test('P8 attribution and warnings do not hide affirmative onset before after or within the same proposition',()=>{
  const warnings=['该观察不能证明首次上榜','这次快照不代表刚刚上榜','尚无证据证明首次上榜'];
  const assertions=['今天首次上榜','该消息登上百度热搜','说明当天上榜','这条消息刚刚进入热榜','该通报于10月14日首次登上热搜'];
  for(const warning of warnings)for(const assertion of assertions)for(const separator of ['，','。','；','但','，然而','而且'])for(const text of [`${warning}${separator}${assertion}`,`${assertion}${separator}${warning}`])assert.ok(p8Findings(text).length,text);
  for(const text of ['并非不代表首次上榜','该观察不是不能证明首次上榜','此次快照不能不证明今天首次上榜','该观察不代表不是首次上榜','报道于10月14日并说明当天首次上榜','10月14日发布的报道首次上榜','并非今天发布的消息首次上榜','未发布的新模型首次登上热搜','未证实的消息今日首次上榜','不但首次上榜而且今天登上热搜','该观察不代表首次上榜首次上榜发生在今天','热搜快照10月15日04:53:24显示今日首次上榜','截至10月15日04:53:24，已于十月十四日登上热搜'])assert.ok(p8Findings(text).length,text);
});

test('P8 report-date ownership never excuses a wrong snapshot year day period clock or explicit second',()=>{
  const bad=['2025年10月15日04:53:24','二零二五年十月十五日凌晨四点五十三分二十四秒','10月14日04:53:24','10月15日16:53:24','10月15日04:54:24','10月15日04:53:25','10月15日下午四点五十三分','昨日凌晨'];
  for(const clock of bad)for(const text of [`榜单快照${clock}显示该报道在榜，报道日期是10月14日`,`报道于10月14日，事件发生在10月12日，榜单快照${clock}，不代表首次上榜`,`截至${clock}，榜单显示已上榜`])assert.ok(p8Findings(text).length,text);
  for(const clock of ['2026年10月15日04:53:24','二零二六年十月十五日凌晨四点五十三分二十四秒','10月15日04:53','今天凌晨四点五十三分二十四秒'])for(const text of [`榜单快照${clock}显示该报道在榜，报道日期是10月14日`,`报道于10月14日，事件发生在10月12日，榜单快照${clock}，不代表首次上榜`,`截至${clock}，榜单显示已经上榜`])assert.deepEqual(p8Findings(text),[],text);
});

test('P8 no-date affirmative entries still need actual body evidence and earlier dated source rules remain strict',()=>{
  for(const text of ['该消息首次上榜','该消息登上百度热搜','刚刚冲上热榜','报道于10月14日，当天登上热搜','十月十四日。该消息登上百度热搜。'])assert.ok(p8Findings(text).length,text);
  const text='2026年10月14日傍晚，该报道首次登上百度热搜';
  const report=p8Report(text);report.references=[{id:'history',verification:'news-page',freshness:'fresh',excerpt:`据报道，${text}。这不是此次采样推断。`} as LessonReport['references'][number]];
  assert.deepEqual(newsObservationFindings(report,p8Incident.requestedAt),[]);
  for(const change of [{verification:'search-cited'},{excerpt:text.replace('2026年','2025年')},{freshness:'future'}])assert.ok(newsObservationFindings({...report,references:[{...report.references[0],...change}]} as LessonReport,p8Incident.requestedAt).length,JSON.stringify(change));
});

test('P8 full raw successful script drafts keep narration claims labels and details in the same time contract',()=>{
  for(const [index,draft] of p8Incident.scriptDrafts.entries()){
    const report={...p8Report(''),title:draft.title,chapters:structuredClone(draft.chapters)} as LessonReport;
    const findings=newsObservationFindings(report,p8Incident.requestedAt);
    if(index===0){assert.equal(findings.length,1,'the original raw draft retains its genuine unsupported chart-entry assertion');assert.match(findings[0],/使事件在核验时进入百度热搜第十二位/);}
    else assert.deepEqual(findings,[],`actual draft ${index+1} ${draft.tool}`);
  }
});

test('chart descriptors and editorial selection do not assert an entry date but dated modifiers still do',()=>{
  for(const text of ['今天我们选择百度热榜上的这条新闻','今天解读这条上榜新闻，报道于十月十四日','这条上榜的消息发布于10月14日','报道于10月14日的上榜消息','首次发布的新模型已成为热搜关注话题'])assert.deepEqual(p8Findings(text),[],text);
  for(const text of ['今日上榜的新闻','首次上榜的消息','报道于10月14日当天上榜的新闻','报道于10月14日，该消息当天上榜','该报道刚刚上榜的消息'])assert.ok(p8Findings(text).length,text);
});

test('subject-relative negation cannot hide an affirmative entry or cancel a genuine proof denial',()=>{
  for(const text of ['这条不是谣言的消息首次上榜','这条没有争议的新闻首次登上百度热搜','这条不是旧闻的消息刚刚进入热榜','未证实的消息今日首次上榜','无法证明的消息首次上榜'])assert.ok(p8Findings(text).length,text);
  for(const text of ['这条不是谣言的消息没有首次上榜','该观察不能证明没有争议的消息首次上榜','该观察无法证明未证实的消息首次上榜','这不是该报道的首次上榜','不是该消息的第一次登上热搜'])assert.deepEqual(p8Findings(text),[],text);
  for(const text of ['该观察并非不能证明没有争议的消息首次上榜','这不是不能证明的首次上榜','不是不代表该报道的首次上榜','不是谣言的快照10月14日04:53:24不代表首次上榜'])assert.ok(p8Findings(text).length,text);
});

test('an omitted narration year cannot borrow the suffix of an explicitly older source entry',()=>{
  const text='10月14日傍晚，该报道首次登上百度热搜',report=p8Report(text);
  report.references=[{id:'history',verification:'news-page',freshness:'fresh',publishedAt:'2026-10-14T14:33:39Z',excerpt:`本篇回顾旧事：2025年${text}。`} as LessonReport['references'][number]];
  assert.ok(newsObservationFindings(report,p8Incident.requestedAt).length,'a fresh article does not turn an explicitly 2025 entry into a yearless current claim');
  report.chapters[0].narration=`2025年${text}`;assert.deepEqual(newsObservationFindings(report,p8Incident.requestedAt),[],'an explicit exact historical quote preserves its actual year');
  report.chapters[0].narration=text;report.references[0].excerpt=`2026年${text}。`;assert.deepEqual(newsObservationFindings(report,p8Incident.requestedAt),[],'a source explicitly in the original request year is not rejected');
  report.references[0].excerpt=`2025年${text}。后来2026年${text}。`;assert.deepEqual(newsObservationFindings(report,p8Incident.requestedAt),[],'all exact matches are considered rather than accepting/rejecting only the first occurrence');
  report.references[0].verification='search-cited';assert.ok(newsObservationFindings(report,p8Incident.requestedAt).length);
});

test('Chinese alternate zero and two forms are normalized before parsing full observed clocks',()=>{
  assert.deepEqual(p8Findings('热搜快照二〇二六年十月十五日凌晨〇四点五十三分二十四秒'),[]);
  assert.ok(p8Findings('热搜快照二〇二六年十月十五日凌晨两点五十三分二十四秒').length);
  assert.ok(p8Findings('热搜快照二〇二六年两月十五日凌晨〇四点五十三分二十四秒').length);
  assert.ok(p8Findings('热搜快照二〇二六年十月两日凌晨〇四点五十三分二十四秒').length);
});
