import type { HotTopicSignal, LessonReport } from '../src/types';

export const NEWS_OBSERVATION_POLICY = '热榜 observedAt 是本次抓取时看到榜单的观察时间，不是首次上榜或事件发生时间；HN submittedAt 只是社区提交时间，不是原文发布或模型发布时刻。所有观察时间按 Asia/Shanghai（北京时间）展示。可以说“截至本次核验，榜单显示……”；若要断言某日某时首次、刚刚或登上热搜，须有已读正文直接证明该上榜时间，不能从采样时间倒推。';

export function beijingTimestamp(value: string | number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('新闻观察时间无效。');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

export function newsObservationContext(signals: HotTopicSignal[] = []) {
  return signals.map(signal => ({ id: signal.id, title: signal.title, rank: signal.rank, observedAtUtc: signal.observedAt, observedAtBeijing: beijingTimestamp(signal.observedAt), timeZone: 'Asia/Shanghai', meaning: '榜单快照观察时刻，首次上榜时间未知', ...(signal.submittedAt ? { communitySubmittedAtUtc: signal.submittedAt, communitySubmittedAtBeijing: beijingTimestamp(signal.submittedAt), submissionMeaning: '社区提交时刻，不能充当原文或事件发布时间' } : {}) }));
}

const number = (value: string) => {
  value = value.replace(/〇/g, '零').replace(/两/g, '二');
  if (/^\d+$/.test(value)) return Number(value);
  const digits = '零一二三四五六七八九';
  if (value.includes('十')) { const [a, b] = value.split('十'); return (a ? digits.indexOf(a) : 1) * 10 + (b ? digits.indexOf(b) : 0); }
  return digits.indexOf(value);
};
const datePattern = /([\d一二三四五六七八九十]{1,3})月([\d一二三四五六七八九十]{1,3})[日号]/g;
const dates = (text: string) => [...text.matchAll(datePattern)].map(match => ({ month: number(match[1]), day: number(match[2]) })).concat([...text.matchAll(/(?:19|20)\d{2}[-/](\d{1,2})[-/](\d{1,2})/g)].map(match => ({ month: Number(match[1]), day: Number(match[2]) })));
const compact = (text: string) => text.replace(datePattern, (_, month, day) => `${number(month)}月${number(day)}日`).replace(/[\s，。！？；：“”‘’、,.!?;:"']/g, '');
const isHeat = (text: string) => /热搜|热榜|榜单|上榜|HN\b|Hacker\s*News/i.test(text);
const isOnset = (text: string) => /首次|首度|第一次|刚刚|登上|冲上|进入.*(?:榜|热搜)|上榜/.test(text);
const periods: Array<[RegExp, (hour: number) => boolean]> = [
  [/凌晨/, hour => hour < 6], [/清晨/, hour => hour >= 5 && hour < 9], [/早上|上午/, hour => hour >= 6 && hour < 12],
  [/中午/, hour => hour >= 11 && hour < 14], [/下午/, hour => hour >= 12 && hour < 18], [/傍晚/, hour => hour >= 17 && hour < 20], [/晚上|晚间/, hour => hour >= 18], [/夜间|深夜/, hour => hour >= 18 || hour < 6],
];
const dateOnly = (text: string) => text.replace(datePattern, '').replace(/(?:19|20)\d{2}年|凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|晚间|夜间|深夜|在|于|截至|北京时间|\s|[，,:：]/g, '').length === 0;

/** A separate, deterministic guard. Model fact-review scores cannot turn a
 * snapshot into evidence for when a headline first entered the chart. */
export function newsObservationFindings(report: LessonReport, requestedAt = Date.parse(report.hotResearch?.asOf || '')): string[] {
  if (!report.hotResearch) return [];
  const signals = report.hotResearch.signals || [];
  const times = signals.flatMap(signal => { try { const value = beijingTimestamp(signal.observedAt); return [{ month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)), hour: Number(value.slice(11, 13)), minute: Number(value.slice(14, 16)), value }]; } catch { return []; } });
  const findings: string[] = [];
  for (const [index, chapter] of (report.chapters || []).entries()) {
    const texts = [index === 0 ? report.title : undefined, chapter.title, chapter.narration, ...(chapter.claims || []).map(claim => claim.text), chapter.visual?.takeaway, ...(chapter.visual?.items || []).flatMap(item => [item.label, item.detail])].filter((text): text is string => typeof text === 'string');
    for (const text of texts) for (const [sentenceIndex, part] of text.split(/[。！？；;\n]/).entries()) {
      const previous = sentenceIndex ? text.split(/[。！？；;\n]/)[sentenceIndex - 1] : '';
      const sentence = isHeat(part) && previous && dateOnly(previous) ? `${previous}，${part}` : part;
      if (!isHeat(sentence)) continue;
      const mentionedDates = dates(sentence), period = periods.find(([pattern]) => pattern.test(sentence));
      const relative = /今天|今日|今早|今晨|今晚|今夜|昨天|昨日|昨晚/.test(sentence), precise = /首次|首度|第一次|刚刚|刚(?:登上|冲上|进入|上榜)/.test(sentence);
      if (!mentionedDates.length && !period && !relative && !precise) continue;
      if (!isOnset(sentence) && !mentionedDates.length && !period && /(?:今天|今日)(?:我们)?(?:选择|选|关注|讨论|看|解读|拆解)/.test(sentence)) continue;
      // Exact source wording is a narrow exception for an actually reported
      // historical chart event. A page's publication header alone never is.
      const sourceClaim = sentence.replace(/^.*?(?=(?:(?:19|20)\d{2}年)?[\d一二三四五六七八九十]{1,3}月[\d一二三四五六七八九十]{1,3}[日号])/, '').trim();
      const sourceProvesOnset = mentionedDates.length > 0 && isOnset(sourceClaim) && report.references.some(ref => ref.verification === 'news-page' && ref.freshness !== 'future' && compact(sourceClaim).length >= 12 && compact(ref.excerpt).includes(compact(sourceClaim)));
      if (sourceProvesOnset) continue;
      const snapshot = /截至|采样|抓取|观察到|本次核验|榜单显示/.test(sentence);
      const digitalClock = sentence.match(/(?:^|[^\d])(\d{1,2})[:：](\d{2})(?:[^\d]|$)/);
      const spokenClock = sentence.match(/([\d零〇一二两三四五六七八九十]{1,3})(?:点|时)(半|[\d零〇一二两三四五六七八九十]{1,3}分?)?/);
      let clock = digitalClock ? { hour: Number(digitalClock[1]), minute: Number(digitalClock[2]) } : spokenClock ? { hour: number(spokenClock[1]), minute: spokenClock[2] ? spokenClock[2] === '半' ? 30 : number(spokenClock[2].replace(/分$/, '')) : undefined } : undefined;
      if (clock && spokenClock && !digitalClock) {
        if (/下午|傍晚|晚上|晚间|中午/.test(sentence) && clock.hour < 12) clock.hour += 12;
        if (/凌晨/.test(sentence) && clock.hour === 12) clock.hour = 0;
      }
      const datedOnset = sentence.split(/[，,]/).some(clause => isOnset(clause) && (dates(clause).length > 0 || periods.some(([pattern]) => pattern.test(clause)) || /今天|今日|今早|今晨|今晚|今夜|昨天|昨日|昨晚/.test(clause)) && !/^\s*截至/.test(clause));
      const stateOnly = !isOnset(sentence) || /(?:已经|已)(?:登上|上榜)/.test(sentence) && !datedOnset;
      let relativeDate: { month: number; day: number } | undefined;
      if (relative && Number.isFinite(requestedAt)) {
        const day = new Date(beijingTimestamp(requestedAt).slice(0, 10) + 'T00:00:00Z');
        if (/昨天|昨日|昨晚/.test(sentence)) day.setUTCDate(day.getUTCDate() - 1);
        relativeDate = { month: day.getUTCMonth() + 1, day: day.getUTCDate() };
      }
      const matchesObservation = snapshot && stateOnly && !precise && (!relative || Boolean(relativeDate)) && times.some(time => mentionedDates.every(date => date.month === time.month && date.day === time.day) && (!relativeDate || relativeDate.month === time.month && relativeDate.day === time.day) && (!period || period[1](time.hour)) && (!clock || clock.hour === time.hour && (clock.minute === undefined || clock.minute === time.minute)));
      if (matchesObservation) continue;
      findings.push(`${chapter.id}：热榜时间证据错误：“${sentence.trim()}”。实际快照为北京时间${[...new Set(times.map(time => time.value))].slice(0, 3).join('、') || '未知'}；观察时刻不能证明首次上榜或事件发生时间。改为“截至本次核验，榜单显示……”并保留真实事件的正文日期，不能推断上榜时刻。`);
    }
  }
  return [...new Set(findings)];
}

/** Bind displayed publication dates to core facts, using the original request
 * cutoff. Publication dates never stand in for an event or chart observation. */
export function createNewsPublicationAnnotation(report: LessonReport, requestedAt: number): import('../src/types').NewsPublicationAnnotation | undefined {
  const news = report.hotResearch;
  if (!news || !Number.isFinite(requestedAt) || !Number.isFinite(news.windowHours) || news.windowHours <= 0) return;
  const used = new Set((report.chapters||[]).flatMap(chapter => (chapter.claims||[]).flatMap(claim => claim.referenceIds||[])));
  const normalize = (value: string) => value.replace(/\s/g, '');
  for (const topic of news.topics||[]) for (const fact of topic.facts||[]) for (const evidence of fact.evidence||[]) {
    const ref = report.references.find(source => source.id === evidence.referenceId);
    if (!ref || !used.has(ref.id) || ref.verification !== 'news-page' || ref.freshness !== 'fresh' || !ref.dateEvidence?.trim()) continue;
    const quote = normalize(evidence.quote);
    if (quote.length < 12 || !normalize(ref.excerpt).includes(quote)) continue;
    const time = newsPublicationTimestamp(ref.publishedAt);
    if (!Number.isFinite(time) || time > requestedAt || time < requestedAt - news.windowHours * 3600000) continue;
    const publishedDateBeijing = beijingTimestamp(time).slice(0, 10);
    return { referenceId: ref.id, publishedAt: ref.publishedAt!, publishedDateBeijing, cutoffUtc: new Date(requestedAt).toISOString(), windowHours: news.windowHours, label: `报道日期：${publishedDateBeijing}（北京时间）` };
  }
}

// The verified news parser treats date-only publications as Beijing midnight.
// Do not re-interpret them as UTC midnight or guess a timezone for naive times.
export function newsPublicationTimestamp(value: string | undefined): number {
  if (!value) return NaN;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const time = Date.parse(value + 'T00:00:00+08:00');
    return Number.isFinite(time) && beijingTimestamp(time).slice(0, 10) === value ? time : NaN;
  }
  return /T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? Date.parse(value) : NaN;
}

export function newsPublicationSourceFindings(report: LessonReport, requestedAt: number): string[] {
  return report.hotResearch && !createNewsPublicationAnnotation(report, requestedAt)
    ? ['新闻报道日期缺少来源：需要本稿核心事实实际引用、正文逐字支持且位于原指令时间窗内的已核验发布日期；旧事件日期、热榜采样和搜索摘要不能替代。'] : [];
}

const publicationEscape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function newsPublicationNoteHtml(annotation: import('../src/types').NewsPublicationAnnotation): string {
  const time = newsPublicationTimestamp(annotation.publishedAt), cutoff = Date.parse(annotation.cutoffUtc);
  if (!annotation.referenceId || !Number.isFinite(time) || !Number.isFinite(cutoff) || !(annotation.windowHours > 0) || time > cutoff || time < cutoff - annotation.windowHours * 3600000 || beijingTimestamp(time).slice(0, 10) !== annotation.publishedDateBeijing || annotation.label !== `报道日期：${annotation.publishedDateBeijing}（北京时间）`) throw new Error('新闻报道日期注释未绑定有效来源与原指令时间窗。');
  return `<p id="note" data-news-source-id="${publicationEscape(annotation.referenceId)}" data-news-published-at="${publicationEscape(annotation.publishedAt)}" data-news-cutoff="${publicationEscape(annotation.cutoffUtc)}">${publicationEscape(annotation.label)} · 画面示意</p>`;
}
export function newsPublicationNoteCss(portrait: boolean): string {
  return `#note{box-sizing:border-box;position:absolute;left:40px;top:${portrait ? 180 : 106}px;width:calc(100% - 80px);height:40px;margin:0;padding:0;font-size:24px;font-weight:500;line-height:40px;text-align:center;white-space:nowrap;color:#252935;background:#fffdfa;opacity:1;z-index:10}`;
}
