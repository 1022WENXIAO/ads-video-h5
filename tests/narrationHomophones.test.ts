import test from 'node:test';
import assert from 'node:assert/strict';
import { pinyin } from 'pinyin-pro';
import { correctNarrationHomophones } from '../server/narrationHomophones';
import { alignLessonSpeech } from '../server/lessonSpec';
import type { AudioAnalysis, LessonChapter, ResearchReference } from '../shared/types';

const chapter = (narration: string, source = narration): LessonChapter => ({ id: 'ch1', narration, referenceIds: ['ref1'], claims: [{ text: source, referenceIds: ['ref1'], basis: 'source' }], visual: { items: [] } } as unknown as LessonChapter);
const sourceReferences = (report: LessonChapter): ResearchReference[] => [{ id: 'ref1', title: 'Controlled verified source fixture', excerpt: report.claims.map(claim => claim.text).join('。'), url: 'https://example.org/controlled-fixture', retrievedAt: '2026-10-15T00:00:00Z', verification: 'primary-page' }];
const normalize = (report: LessonChapter, raw: AudioAnalysis, references = sourceReferences(report)) => correctNarrationHomophones(report, raw, references);

function analysis(text: string, words = [...text]): AudioAnalysis {
  let at = 0;
  return { status: 'ready', modelId: 'offline-fixture', sourceHash: 'retained-source-hash', duration: 10, timing: 'model-estimated', createdAt: '', warnings: ['Original ASR retained'], captionBreaks: [0, words.length - 1], pauses: [{ start: 3, end: 3.4 }], transcript: text, sentences: [{ id: 'utterance-1', text, start: 0, end: words.length * .2, complete: true, words: words.map(text => { const start = at; at += .2; return { text, start, end: at }; }) }] };
}

test('generic source-bound homophones normalize multiple unrelated phrases without a word whitelist', () => {
  for (const [canonical, heard] of [['受伤者已送医', '受商者已送医'], ['警方通报', '警方通抱'], ['程序公开', '城序公开'], ['公示结果', '工示结果'], ['会议记录', '会议记鹿']]) {
    const report = chapter(canonical), raw = analysis(heard), original = structuredClone(raw);
    const corrected = normalize(report, raw);
    assert.equal(corrected.transcript, canonical, heard);
    assert.deepEqual(raw, original);
    assert.match(corrected.warnings.at(-1)!, /ASR来源同音正字/);
    assert.match(corrected.warnings.at(-1)!, /ref1/);
    assert.doesNotThrow(() => alignLessonSpeech(report, corrected));
  }
});

test('equal-length correction preserves every original word boundary, time, owner, completeness and caption index', () => {
  const raw = analysis('受商者已经送医', ['受商', '者', '已经', '送医']);
  raw.sentences[0].words[1].start = .5; raw.sentences[0].words[1].end = .7;
  raw.sentences[0].complete = false;
  const original = structuredClone(raw), corrected = normalize(chapter('受伤者已经送医'), raw);
  assert.equal(corrected.sentences[0].words[0].text, '受伤');
  assert.equal(corrected.sentences[0].words.length, raw.sentences[0].words.length);
  assert.deepEqual(corrected.sentences[0].words.map(({ start, end }) => ({ start, end })), raw.sentences[0].words.map(({ start, end }) => ({ start, end })));
  assert.equal(corrected.sentences[0].words[1], raw.sentences[0].words[1]);
  assert.equal(corrected.sentences[0].complete, false);
  assert.equal(corrected.captionBreaks, raw.captionBreaks);
  assert.equal(corrected.sourceHash, raw.sourceHash); assert.equal(corrected.duration, raw.duration); assert.equal(corrected.pauses, raw.pauses);
  assert.deepEqual(raw, original);
});

test('original transcript separators and unrelated punctuation survive independent sentence corrections', () => {
  const raw = analysis('警方通抱\n城序公开');
  raw.sentences = [analysis('警方通抱').sentences[0], { ...analysis('城序公开').sentences[0], id: 'utterance-2' }];
  const corrected = normalize(chapter('警方通报，程序公开'), raw);
  assert.equal(corrected.transcript, '警方通报\n程序公开');
  assert.equal(corrected.sentences.length, 2);
});

test('source text, source basis and actual reference IDs are required, not an intended narration alone', () => {
  for (const report of [
    { ...chapter('受伤者送医'), claims: [] },
    { ...chapter('受伤者送医'), claims: [{ text: '受伤者送医', referenceIds: [], basis: 'source' as const }] },
    ...(['calculation', 'synthesis'] as const).map(basis => ({ ...chapter('受伤者送医'), claims: [{ text: '受伤者送医', referenceIds: ['ref1'], basis }] })),
    chapter('受伤者送医', '警方公布结果'),
    chapter('警方公布结果', '受伤者送医'),
  ]) {
    const raw = analysis('受商者送医');
    assert.equal(normalize(report, raw), raw);
  }
});

test('source claims with omitted basis retain the validated schema source default', () => {
  const report = chapter('受伤者送医'); delete report.claims[0].basis;
  assert.equal(normalize(report, analysis('受商者送医')).transcript, report.narration);
});

test('actual resolved source text supports spelling even when the selecting claim states a different fact', () => {
  const report = chapter('持型锁伤人', '警方于当天公布通报'), raw = analysis('持型锁商人');
  const references = sourceReferences(report); references[0].excerpt = '警方通报证实持型锁伤人，伤情以通报为准。';
  const before = structuredClone({ report, references, raw });
  assert.equal(normalize(report, raw, references).transcript, report.narration);
  assert.deepEqual({ report, references, raw }, before);
});

test('claim self-report without actual resolved verified reference text cannot authorize normalization', () => {
  const report = chapter('受伤者送医'), raw = analysis('受商者送医'), references = sourceReferences(report);
  assert.equal(correctNarrationHomophones(report, raw), raw, 'default has no actual source records');
  references[0].excerpt = '警方于当天公布通报';
  assert.equal(normalize(report, raw, references), raw, 'claim spelling is not source evidence');
});

test('missing, duplicate, search-only, or another chapter reference cannot supply canonical text', () => {
  const report = chapter('受伤者送医'), raw = analysis('受商者送医'), valid = sourceReferences(report)[0];
  for (const references of [[], [{ ...valid, id: 'other-chapter' }], [valid, { ...valid }], [{ ...valid, verification: 'search-cited' as const }]]) assert.equal(normalize(report, raw, references), raw);
  for (const changed of [
    { ...report, referenceIds: ['other-chapter'] },
    { ...report, referenceIds: ['ref1', 'ref1'] },
    { ...report, claims: [{ ...report.claims[0], referenceIds: ['ref1', 'ref1'] }] },
    { ...report, claims: [{ ...report.claims[0], referenceIds: ['missing'] }] },
  ]) assert.equal(normalize(changed, raw, [valid]), raw);
});

test('homophones without a literal anchor and isolated single characters cannot be repaired', () => {
  for (const [canonical, heard] of [['受伤', '授商'], ['伤', '商']]) {
    const raw = analysis(heard); assert.equal(normalize(chapter(canonical), raw), raw);
  }
});

test('all phonetic canonical alternatives participate in ambiguity rejection', () => {
  const raw = analysis('全利受保护'), report = chapter('权力受保护，权利受保护');
  assert.equal(normalize(report, raw), raw, 'a literal 利 anchor cannot select 权利 while the source also contains 权力');
});

test('full context rejects the polyphone escape even though its shorter inner span is homophonic', () => {
  const phonetic = (text: string) => pinyin(text, { type: 'array', toneType: 'num', toneSandhi: false });
  assert.deepEqual(phonetic('心检'), phonetic('新检'));
  assert.notDeepEqual(phonetic('重心检查'), phonetic('重新检查'));
  const raw = analysis('重心检查'); assert.equal(normalize(chapter('重新检查'), raw), raw);
});

test('changed polyphonic characters and tone differences remain rejected', () => {
  for (const [canonical, heard] of [['长安通报', '常安通报'], ['受伤者送医', '收伤者送医'], ['重伤者送医', '中伤者送医']]) {
    const report = chapter(canonical), raw = analysis(heard), corrected = normalize(report, raw);
    assert.equal(corrected, raw, heard);
    assert.throws(() => alignLessonSpeech(report, corrected), /汉字|匹配|原词/);
  }
});

test('source-supported spelling cannot insert missing 程 or a missing ending, or reorder heard words', () => {
  for (const [canonical, heard] of [['程序已经公开', '序已经公开'], ['受伤者已经送医', '受商者已经送'], ['警方通报', '通报警方']]) {
    const report = chapter(canonical), raw = analysis(heard), corrected = normalize(report, raw);
    assert.equal([...corrected.sentences[0].text].length, [...raw.sentences[0].text].length);
    assert.deepEqual(corrected.sentences[0].words.map(w => [w.start, w.end]), raw.sentences[0].words.map(w => [w.start, w.end]));
    assert.throws(() => alignLessonSpeech(report, corrected), /汉字|匹配|原词|末尾/);
  }
});

test('numbers and dates are not repaired and still fail the mandatory speech gate after unrelated spelling correction', () => {
  for (const [canonical, heard] of [['受伤者于十四日送医', '受商者于十五日送医'], ['受伤者共三人', '受商者共四人'], ['受伤者于一点四十四分送医', '受商者于一点十四分送医']]) {
    const report = chapter(canonical), raw = analysis(heard), corrected = normalize(report, raw);
    assert.throws(() => alignLessonSpeech(report, corrected), /数字|日期|汉字|匹配|时钟/);
    for (const digit of heard.match(/[一二三四五六七八九十]+/g) || []) assert.ok(corrected.transcript.includes(digit));
  }
});

test('unit, quantity, clock and mathematical symbol spellings are excluded from candidates', () => {
  for (const [canonical, heard] of [['毫米', '豪米'], ['一点', '衣点'], ['三时', '三实'], ['余数', '余述'], ['三角', '三脚'], ['英寸', '鹰寸'], ['立方', '利方'], ['平方', '平芳'], ['加减法', '家减法'], ['壹佰', '衣佰']]) {
    const raw = analysis(heard); assert.equal(normalize(chapter(canonical), raw), raw);
  }
});

test('named physical-unit spans prevent cropped homophones from escaping neighboring quantity protection', () => {
  for (const [canonical, heard] of [['电阻为十欧姆', '电阻为十欧母'], ['亮度达到百尼特', '亮度达到百尼忑'], ['使用伦琴单位', '使用伦芹单位'], ['电容以法拉计', '电容以法喇计'], ['剂量使用希沃特', '剂量使用希沃忑'], ['磁场以特斯拉计', '磁场以特丝拉计'], ['辐射用贝可勒尔', '辐射用贝可勒耳']]) {
    const raw = analysis(heard); assert.equal(normalize(chapter(canonical), raw), raw, heard);
  }
});

test('quantity and currency units cannot be repaired by cropping away the adjacent numeral', () => {
  for (const [canonical, heard] of [['千兆的网络', '千赵的网络'], ['十项指标', '十向指标'], ['三组对照', '三祖对照'], ['花了十块钱', '花了十快钱'], ['费用为十圆整', '费用为十园整'], ['3项指标', '3向指标'], ['十多组对照', '十多祖对照'], ['半组对照', '半祖对照']]) {
    const raw = analysis(heard), before = structuredClone(raw);
    assert.equal(normalize(chapter(canonical), raw), raw, heard);
    assert.deepEqual(raw, before);
  }
});

test('quantity spans are protected in both actual source and script while ordinary classifier words remain eligible', () => {
  const raw = analysis('祖建团队'), report = chapter('组建团队');
  assert.equal(normalize(report, raw).transcript, '组建团队', '组 is ordinary language here, not a quantity');
  const sources = sourceReferences(report); sources[0].excerpt = '三组建团队';
  assert.equal(normalize(report, raw, sources), raw, 'the only source occurrence belongs to a quantity span');
  const numbered = chapter('三组建团队', '组建团队'), numberedRaw = analysis('三祖建团队');
  assert.equal(normalize(numbered, numberedRaw), numberedRaw, 'an unnumbered source cannot override the script quantity span');
});

test('punctuation and heard extra characters cannot be stripped to manufacture a supported phrase', () => {
  for (const [canonical, heard, source] of [['受伤', '受，商', '受伤'], ['受伤', '受商', '受，伤'], ['受伤', '受一商', '受伤']]) {
    const raw = analysis(heard); assert.equal(normalize(chapter(canonical, source), raw), raw);
  }
});

test('inconsistent ASR text or invalid word timing remains untouched rather than silently reconstructed', () => {
  const raw = analysis('受商者送医'); raw.sentences[0].text = '受，商者送医';
  assert.equal(normalize(chapter('受伤者送医'), raw), raw);
  const zero = analysis('受商者送医'); zero.sentences[0].words[0].end = 0;
  assert.equal(normalize(chapter('受伤者送医'), zero), zero);
});
