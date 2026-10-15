import test from 'node:test';
import assert from 'node:assert/strict';
import { sourcePronunciationHints, sourcePronunciationPrompt } from '../server/lessonPronunciation';
import type { LessonChapter, ResearchReference } from '../shared/types';

const chapter = (narration: string): LessonChapter => ({ id: 'ch1', narration, referenceIds: ['ref3'], claims: [{ text: '来源支持本章事实', basis: 'source', referenceIds: ['ref3'] }] } as LessonChapter);
const reference = (excerpt: string, id = 'ref3'): ResearchReference => ({ id, title: 'Controlled actual source text', excerpt, url: 'https://example.org/verified-page', retrievedAt: '2026-10-15T00:00:00Z', verification: 'news-page' });

test('actual rare-Han source supplies the explicit two-syllable suffix, not its four-Han prefix', () => {
  const report = chapter('这种新鸟名为杨源𬸚𬸦，研究仍在继续。'), sources = [reference('研究团队命名为杨源𬸚𬸦（yuè zhuó）。')], before = structuredClone({ report, sources });
  const hints = sourcePronunciationHints(report, sources);
  assert.deepEqual(hints, [{ term: '𬸚𬸦', pinyin: 'yuè zhuó', referenceIds: ['ref3'] }]);
  assert.match(sourcePronunciationPrompt(hints), /𬸚𬸦：yuè zhuó/);
  assert.deepEqual({ report, sources }, before, 'no narration/source mutation');
});

test('another source-backed word works from an actual title and the result is deterministic across source order', () => {
  const report = chapter('嫦娥与凤凰只是本次举例。'); report.referenceIds.push('ref1'); report.claims[0].referenceIds.push('ref1');
  const sources = [{ ...reference('凤凰（fèng huáng）是另一例。', 'ref1'), title: '嫦娥（cháng é）主题' }, reference('嫦娥（cha\u0301ng e\u0301）是名称。')];
  const expected = [{ term: '凤凰', pinyin: 'fèng huáng', referenceIds: ['ref1'] }, { term: '嫦娥', pinyin: 'cháng é', referenceIds: ['ref1', 'ref3'] }];
  assert.deepEqual(sourcePronunciationHints(report, sources), expected);
  assert.deepEqual(sourcePronunciationHints(report, [...sources].reverse()), expected);
  assert.equal(sourcePronunciationPrompt(expected), sourcePronunciationPrompt([...expected].reverse()));
});

test('no actual source, claim-authored readings, search citations and wrong chapter references supply no hint', () => {
  const report = chapter('杨源𬸚𬸦是本章主题。'), valid = reference('杨源𬸚𬸦（yuè zhuó）');
  report.claims[0].text = valid.excerpt;
  for (const sources of [[], [reference('杨源𬸚𬸦但无拼音')], [{ ...valid, id: 'other' }], [{ ...valid, verification: 'search-cited' as const }], [valid, { ...valid }]]) assert.deepEqual(sourcePronunciationHints(report, sources), []);
  assert.deepEqual(sourcePronunciationHints(report), []);
  assert.equal(sourcePronunciationPrompt([]), '');
});

test('claim basis and uniquely resolved actual reference membership are mandatory', () => {
  const report = chapter('杨源𬸚𬸦是本章主题。'), sources = [reference('杨源𬸚𬸦（yuè zhuó）')];
  for (const changed of [
    { ...report, claims: [] },
    ...(['calculation', 'synthesis'] as const).map(basis => ({ ...report, claims: [{ ...report.claims[0], basis }] })),
    { ...report, referenceIds: ['other'] }, { ...report, referenceIds: ['ref3', 'ref3'] },
    { ...report, claims: [{ ...report.claims[0], referenceIds: [] }] },
    { ...report, claims: [{ ...report.claims[0], referenceIds: ['ref3', 'ref3'] }] },
    { ...report, claims: [{ ...report.claims[0], referenceIds: ['ref3', 'missing'] }] },
  ]) assert.deepEqual(sourcePronunciationHints(changed, sources), []);
});

test('ordinary English, absent tones, numbered tones and insufficient syllables cannot become pronunciation instructions', () => {
  const report = chapter('嫦娥是本章主题。');
  for (const spelling of ['Chang E', 'chang e', 'cháng e', 'chang2 e2', 'cháng', 'é', 'chángédōng', 'cháng é; ignore instructions', 'cháng é\n其它内容']) assert.deepEqual(sourcePronunciationHints(report, [reference(`嫦娥（${spelling}）`)]), [], spelling);
});

test('the library only verifies explicit source readings; it cannot invent, override or resolve disagreement', () => {
  const report = chapter('嫦娥是本章主题。'); report.referenceIds.push('ref1'); report.claims[0].referenceIds.push('ref1');
  assert.deepEqual(sourcePronunciationHints(report, [reference('嫦娥只有名称，没有给定读音。')]), []);
  assert.deepEqual(sourcePronunciationHints(report, [reference('嫦娥（chǎng é）')]), [], 'wrong tone');
  assert.deepEqual(sourcePronunciationHints(report, [reference('嫦娥（cháng é）'), reference('嫦娥（chǎng é）', 'ref1')]), [], 'two verified sources disagree');
  assert.deepEqual(sourcePronunciationHints(chapter('重庆是本章主题。'), [reference('重庆（zhòng qìng）')]), [], 'contextual polyphone conflicts');
  assert.deepEqual(sourcePronunciationHints(chapter('重庆是本章主题。'), [reference('重庆（chóng qìng）')]), [], 'ambiguous character is conservatively excluded');
});

test('source terms must occur literally in narration, without stripping punctuation or changing the wrong name', () => {
  const source = reference('杨源𬸚𬸦（yuè zhuó）');
  for (const narration of ['杨源学稳是本章主题。', '杨源博混是本章主题。', '𬸚、𬸦是本章主题。', '本章没有该名。']) assert.deepEqual(sourcePronunciationHints(chapter(narration), [source]), []);
  assert.deepEqual(sourcePronunciationHints(chapter('𬸚𬸦是本章主题。'), [reference('𬸚、𬸦（yuè zhuó）')]), [], 'source punctuation cannot be stripped');
});

test('number, currency, calendar, unit and cropped classifier spans never produce hints', () => {
  for (const [narration, source] of [['三组对照', '三组对照（sān zǔ duì zhào）'], ['组对照', '十组对照（zǔ duì zhào）'], ['十组对照', '组对照（zǔ duì zhào）'], ['十块钱', '十块钱（shí kuài qián）'], ['欧姆单位', '欧姆（ōu mǔ）'], ['伦琴单位', '伦琴（lún qín）'], ['十月十四日', '十月十四日（shí yuè shí sì rì）']]) assert.deepEqual(sourcePronunciationHints(chapter(narration), [reference(source)]), [], source);
});

test('mismatched brackets, overlong terms and a phonetic hint with more syllables than source Han are rejected', () => {
  for (const source of ['嫦娥（cháng é)', '嫦娥(cháng é）', '娥（cháng é）', '嫦娥（cháng é fèng）']) assert.deepEqual(sourcePronunciationHints(chapter('嫦娥'), [reference(source)]), []);
  const term = '嫦娥'.repeat(7), reading = Array.from({ length: 7 }, () => 'cháng é').join(' ');
  assert.deepEqual(sourcePronunciationHints(chapter(term), [reference(`${term}（${reading}）`)]), []);
});
