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
  return value && [...value].every(char => digits.includes(char)) ? Number([...value].map(char => digits.indexOf(char)).join('')) : NaN;
};
const numeral = '[\\d零〇一二两三四五六七八九十]';
const datePattern = new RegExp(`(${numeral}{1,3})月(${numeral}{1,3})[日号]`, 'g');
const compact = (text: string) => text.replace(/([零〇一二两三四五六七八九]{4})年/g, (_, year) => `${number(year)}年`).replace(datePattern, (_, month, day) => `${number(month)}月${number(day)}日`).replace(/[\s，。！？；：“”‘’、,.!?;:"']/g, '');
const isHeat = (text: string) => /热搜|热榜|榜单|上榜|登榜|HN\b|Hacker\s*News/i.test(text);
const entryPattern = /上榜|登榜|(?:登上|冲上|冲进|进入|跻身)[^，,。！？；;\n]{0,12}?(?:热搜|热榜|榜单|排行榜)|上(?:了)?(?:百度|微博)?热搜/g;
const observationPattern = /截至|快照|采样|抓取|观察|核验|榜单显示/g;
// These are attribution predicates, not a whitelist of acceptable sentences.
// Their dates remain subject to the independent fact/today/publication gates.
const otherDatePattern = /(?:报道|新闻|通报|文章|事件|事情|案件)(?:的)?(?:发布日期|发布时间|报道日期|发生日期|发生时间|日期|时间)(?:是|为|在|于|：|:)?|发布日期|发布时间|报道日期|(?:报道|通报)(?:于|在)(?=[\d零〇一二两三四五六七八九十今昨]|北京时间)|(?:报道|通报|事件|事情|案件)(?:是|为|：|:)?(?=[\d零〇一二两三四五六七八九十])|发布|刊发|刊登|发生|事发/g;
const periods: Array<[RegExp, (hour: number) => boolean]> = [
  [/凌晨/, hour => hour < 6], [/清晨/, hour => hour >= 5 && hour < 9], [/早上|上午/, hour => hour >= 6 && hour < 12],
  [/中午/, hour => hour >= 11 && hour < 14], [/下午/, hour => hour >= 12 && hour < 18], [/傍晚/, hour => hour >= 17 && hour < 20], [/晚上|晚间/, hour => hour >= 18], [/夜间|深夜/, hour => hour >= 18 || hour < 6],
];
type ObservationTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; value: string };
type TimeMention = { start: number; end: number; year?: number; month?: number; day?: number; hour?: number; minute?: number; second?: number; period?: (hour: number) => boolean; relative?: 'today' | 'yesterday' };
function timeMentions(text: string): TimeMention[] {
  const result: TimeMention[] = [];
  const add = (match: RegExpMatchArray, value: Omit<TimeMention, 'start' | 'end'>) => result.push({ start: match.index!, end: match.index! + match[0].length, ...value });
  for (const match of text.matchAll(new RegExp(`(?:(\\d{4}|[零〇一二两三四五六七八九]{4})年)?(${numeral}{1,3})月(${numeral}{1,3})[日号]`, 'g'))) add(match, { year: match[1] ? number(match[1]) : undefined, month: number(match[2]), day: number(match[3]) });
  for (const match of text.matchAll(/((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})/g)) add(match, { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})[:：](\d{2})(?:[:：](\d{1,3}))?(?!\d)/g)) add(match, { hour: Number(match[1]), minute: Number(match[2]), second: match[3] === undefined ? undefined : Number(match[3]) });
  for (const match of text.matchAll(new RegExp(`(${numeral}{1,3})(?:点|时)(半|${numeral}{1,3}分?)?(?:(${numeral}{1,3})秒)?`, 'g'))) {
    let hour = number(match[1]);
    if (/下午|傍晚|晚上|晚间|中午/.test(text.slice(0, match.index)) && hour < 12) hour += 12;
    if (/凌晨/.test(text.slice(0, match.index)) && hour === 12) hour = 0;
    add(match, { hour, minute: match[2] ? match[2] === '半' ? 30 : number(match[2].replace(/分$/, '')) : undefined, second: match[3] === undefined ? undefined : number(match[3]) });
  }
  for (const [pattern, accepts] of periods) for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) add(match, { period: accepts });
  for (const match of text.matchAll(/今天|今日|今早|今晨|今晚|今夜|昨天|昨日|昨晚/g)) add(match, { relative: /^昨/.test(match[0]) ? 'yesterday' : 'today' });
  return result.sort((a, b) => a.start - b.start);
}
const propositions = (text: string) => text.split(/[，,]|但是|然而|不过|但|却|而且|并且|而是|同时|且|随后|接着|也(?=不|无法|不能|今日|今天|首次|首度|第一次|刚)/).map(value => value.trim()).filter(Boolean);
const dateOnly = (text: string) => {
  let remainder = text;
  for (const mention of timeMentions(text).reverse()) remainder = remainder.slice(0, mention.start) + remainder.slice(mention.end);
  return !remainder.replace(/在|于|北京时间|\s|[，,:：]/g, '');
};
function hasRelativeSubject(text: string): boolean {
  const relativeEnd = text.lastIndexOf('的');
  if (relativeEnd < 0) return false;
  let head = text.slice(relativeEnd + 1);
  for (const mention of timeMentions(head).reverse()) head = head.slice(0, mention.start) + head.slice(mention.end);
  return !!head.replace(/首次|首度|第一次|刚刚|已经|并非|并不是|不是|不能|不可|无法|未能|不足以|没有|否认|确实|真的|当天|当日|那天|彼时|正在|就|才|还|已|刚|没|未|不|无|\s/g, '');
}
type Entry = { start: number; end: number; negative: boolean; negativeStart?: number; precise: boolean; already: boolean };
function entries(text: string): Entry[] {
  const result: Entry[] = [];
  let previousEnd = 0;
  for (const match of text.matchAll(entryPattern)) {
    const start = match.index!, prefix = text.slice(previousEnd, start), suffix = text.slice(start + match[0].length);
    // Scope is one proposition and one entry predicate. A denial before one
    // entry cannot hide a second affirmative entry, even without punctuation.
    const proof = [...prefix.matchAll(/证明|代表|说明|确认|确定|推断|倒推|断言|认定|意味着|表明|证实|判断|等于|说/g)].filter(value => { const after = prefix.slice(value.index! + value[0].length); return !/^过?的/.test(after) || !hasRelativeSubject(after); }).at(-1);
    const objectStart = proof ? proof.index! + proof[0].length : 0;
    const object = prefix.slice(objectStart), relativeEnd = object.lastIndexOf('的');
    const relativeObject = hasRelativeSubject(object);
    // A relative modifier negates a property of the subject, not the entry:
    // "不是谣言的消息首次上榜". Keep any independent governing proof denial.
    const scope = [
      ...(proof && !(relativeObject && /^过?的/.test(object)) ? [{ text: prefix.slice(0, objectStart), start: previousEnd }] : []),
      { text: relativeObject ? object.slice(relativeEnd + 1) : object, start: previousEnd + objectStart + (relativeObject ? relativeEnd + 1 : 0) },
    ];
    const operators = scope.flatMap(piece => [...piece.text.replace(/不但|不仅|不只|不论|不管|不妨|不久|无论/g, word => ' '.repeat(word.length)).matchAll(/并非|并不是|不是|不能|不可|无法|未能|不足以|没有|没|未|不|无|否认/g)].map(match => ({ start: piece.start + match.index! })));
    const doubleNegative = operators.length > 0 && operators.length % 2 === 0;
    const unknown = /^(?:的)?(?:时间|时刻|日期)?(?:仍然|仍|尚)?(?:未知|不明|不清楚|不得而知|未获证实|(?:无法|不能)(?:确定|判断|确认)|(?:尚未|未|没有)(?:披露|公布|证实|确认))/.test(suffix) || /是否|能否/.test(prefix) || /(?:是否|能否).*(?:不清楚|不得而知)/.test(suffix);
    const negative = !doubleNegative && (operators.length % 2 === 1 || unknown);
    const lastAttribution = [...prefix.matchAll(otherDatePattern)].at(-1);
    const qualifier = prefix.slice(lastAttribution ? lastAttribution.index! + lastAttribution[0].length : 0);
    const precise = /首次|首度|第一次|刚刚|刚$/.test(qualifier);
    const selection = /(?:今天|今日)?(?:我们)?(?:选择|选取|关注|讨论|解读|拆解)/.test(prefix);
    const datedModifier = /当天|当日|那天|彼时/.test(prefix) || !lastAttribution && !selection && timeMentions(prefix).length > 0;
    // "上榜的新闻" describes an observed item; "今天上榜的新闻" or
    // "首次上榜的新闻" additionally asserts an entry and still needs proof.
    if (/^(?:上榜|登榜)$/.test(match[0]) && /^(?:的)?(?:新闻|消息|报道|话题|事件|通报|条目)/.test(suffix) && !precise && !datedModifier) { previousEnd = start + match[0].length; continue; }
    result.push({ start, end: start + match[0].length, negative, negativeStart: negative && operators.length ? operators[0].start : undefined, precise, already: /(?:已经|已)\s*$/.test(prefix) });
    previousEnd = start + match[0].length;
  }
  return result;
}
/** Date ownership follows an explicit predicate near the date. A heat-topic
 * descriptor by itself does not turn an article/event date into chart time. */
function observationMentions(text: string, frame: boolean, entry: Entry[]): TimeMention[] {
  const anchors = [
    ...[...text.matchAll(observationPattern)].map(match => ({ start: match.index!, end: match.index! + match[0].length, observation: true })),
    ...[...text.matchAll(otherDatePattern)].map(match => ({ start: match.index!, end: match.index! + match[0].length, observation: false })),
  ];
  return timeMentions(text).filter(mention => {
    if (entry.some(value => value.negative && value.negativeStart !== undefined && mention.start >= value.negativeStart)) return false;
    // Dates normally follow their attribution verb. A preceding date may also
    // be bound to the next verb, as in "十月十四日发布的报道".
    const before = anchors.filter(anchor => anchor.end <= mention.start).sort((a, b) => b.end - a.end)[0];
    const after = anchors.filter(anchor => anchor.start >= mention.end).sort((a, b) => a.start - b.start)[0];
    const postfixPublication = mention.month !== undefined && after && !after.observation && after.start === mention.end && /^(?:发布|刊发|刊登|发生|事发)/.test(text.slice(after.start));
    const owner = postfixPublication ? after : before || after;
    if (owner) return owner.observation;
    if (!frame && /(?:今天|今日)(?:我们)?(?:选择|选|关注|讨论|看|解读|拆解)/.test(text)) return false;
    return frame && !entry.some(value => !value.negative) || /在榜|位居|位列|排名|(?:热搜|热榜|榜单)(?:第[\d一二三四五六七八九十]+|上有)/.test(text) && !entry.length;
  });
}
function matchesObservation(mentions: TimeMention[], times: ObservationTime[], requestedAt: number): boolean {
  return times.some(time => mentions.every(mention => {
    let relativeDate: { year: number; month: number; day: number } | undefined;
    if (mention.relative) {
      if (!Number.isFinite(requestedAt)) return false;
      const day = new Date(beijingTimestamp(requestedAt).slice(0, 10) + 'T00:00:00Z');
      if (mention.relative === 'yesterday') day.setUTCDate(day.getUTCDate() - 1);
      relativeDate = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() };
    }
    return (mention.year === undefined || mention.year === time.year) && (mention.month === undefined || mention.month === time.month) && (mention.day === undefined || mention.day === time.day) && (!relativeDate || relativeDate.year === time.year && relativeDate.month === time.month && relativeDate.day === time.day) && (!mention.period || mention.period(time.hour)) && (mention.hour === undefined || mention.hour === time.hour) && (mention.minute === undefined || mention.minute === time.minute) && (mention.second === undefined || mention.second === time.second);
  }));
}

/** Deterministic heat-time guard. It checks affirmative entry claims and
 * attributed observations; publication/event dates have their own gates. */
export function newsObservationFindings(report: LessonReport, requestedAt = Date.parse(report.hotResearch?.asOf || '')): string[] {
  if (!report.hotResearch) return [];
  const times: ObservationTime[] = (report.hotResearch.signals || []).flatMap(signal => { try { const value = beijingTimestamp(signal.observedAt); return [{ year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)), day: Number(value.slice(8, 10)), hour: Number(value.slice(11, 13)), minute: Number(value.slice(14, 16)), second: Number(value.slice(17, 19)), value }]; } catch { return []; } });
  const findings: string[] = [];
  for (const [index, chapter] of (report.chapters || []).entries()) {
    const texts = [index === 0 ? report.title : undefined, chapter.title, chapter.narration, ...(chapter.claims || []).map(claim => claim.text), chapter.visual?.takeaway, ...(chapter.visual?.items || []).flatMap(item => [item.label, item.detail])].filter((text): text is string => typeof text === 'string');
    for (const text of texts) {
      const sentences = text.split(/[。！？；;\n]/);
      for (const [sentenceIndex, part] of sentences.entries()) {
        const previous = sentences[sentenceIndex - 1] || '', next = sentences[sentenceIndex + 1] || '';
        const sentence = isHeat(part) && previous && dateOnly(previous) ? `${previous}，${part}` : part;
        if (!isHeat(sentence) && !(/截至|快照|采样|抓取|观察|核验|榜单显示/.test(sentence) && (isHeat(previous) || isHeat(next)))) continue;
        const clauses = propositions(sentence), frame = /截至|快照|采样|抓取|观察|核验|榜单显示/.test(sentence) || /截至|快照|采样|抓取|观察|核验|榜单显示/.test(previous) && isHeat(previous);
        let invalid = false;
        const observation: TimeMention[] = [];
        for (const clause of clauses) {
          const entry = entries(clause);
          const active = entry.filter(value => !value.negative);
          if (active.length) {
            // An exact, actually read historical entry quote is the sole source
            // exception. A publication header/search snippet cannot prove entry.
            const sourceClaim = sentence.replace(/^.*?(?=(?:(?:19|20)\d{2}年|[零〇一二两三四五六七八九]{4}年)?[\d零〇一二两三四五六七八九十]{1,3}月[\d零〇一二两三四五六七八九十]{1,3}[日号])/, '').trim();
            const sourceProvesEntry = timeMentions(sourceClaim).some(value => value.month !== undefined) && (report.references || []).some(ref => {
              if (ref.verification !== 'news-page' || ref.freshness === 'future') return false;
              const claim = compact(sourceClaim);
              if (claim.length < 12) return false;
              for(const sourceSentence of ref.excerpt.split(/[。！？；;\n]/)){
                const body=compact(sourceSentence),sourceEntries=entries(body);
                for (let at = body.indexOf(claim); at >= 0; at = body.indexOf(claim, at + 1)) {
                  // Matching words inside a source denial are not evidence
                  // for the opposite affirmative claim. Bind the actual
                  // matched predicate, not another entry elsewhere on a page.
                  if(!sourceEntries.some(entry=>!entry.negative&&entry.start>=at&&entry.end<=at+claim.length))continue;
                  const sourceYear = body.slice(0, at).match(/(\d{4})年$/);
                  if (!sourceYear || Number.isFinite(requestedAt) && Number(sourceYear[1]) === Number(beijingTimestamp(requestedAt).slice(0, 4))) return true;
                }
              }
              return false;
            });
            const clauseObservation = observationMentions(clause, frame, entry);
            const ownDate = timeMentions(clause).some(value => !clauseObservation.some(observed => observed.start === value.start && observed.end === value.end));
            if (!sourceProvesEntry && !active.every(value => value.already && !value.precise && frame && !ownDate)) invalid = true;
          }
          observation.push(...observationMentions(clause, frame, entry));
        }
        if (observation.length && (!frame || !matchesObservation(observation, times, requestedAt))) invalid = true;
        if (invalid) findings.push(`${chapter.id}：热榜时间证据错误：“${sentence.trim()}”。实际快照为北京时间${[...new Set(times.map(time => time.value))].slice(0, 3).join('、') || '未知'}；观察时刻不能证明首次上榜或事件发生时间。改为“截至本次核验，榜单显示……”并保留真实事件的正文日期，不能推断上榜时刻。`);
      }
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
