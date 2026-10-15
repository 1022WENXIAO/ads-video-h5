import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alignLessonSpeech, correctLessonTranscript } from '../server/lessonSpec';
import type { AudioAnalysis, LessonChapter, ResearchReference } from '../shared/types';

// Saved actual ASR projected to public chapter/source text and heard word times.
// This is an offline transcription regression, not waveform or movie acceptance.
const recorded = JSON.parse(readFileSync(new URL('./fixtures/news-first-asr-homophone.json', import.meta.url), 'utf8')) as {
  scope: string; chapter: LessonChapter; references: ResearchReference[]; raw: AudioAnalysis;
};
const fresh = () => structuredClone(recorded);

test('actual first ASR aligns the whole chapter after only source-backed 商→伤, retaining newline and original word ownership', () => {
  const { chapter, references, raw } = fresh(), before = structuredClone({ chapter, references, raw });
  assert.equal(chapter.claims.some(claim => claim.text.includes('伤人')), false, 'claim self-text cannot supply this spelling');
  assert.ok(references[0].title.includes('型锁伤人'));
  assert.equal(references[0].excerpt, '#女子因行车纠纷持U型锁伤人#');
  assert.match(raw.transcript, /十三点四\n十四分/);
  assert.match(raw.transcript, /型锁商人/);

  const corrected = correctLessonTranscript(chapter, raw, references);
  const result = alignLessonSpeech(chapter, corrected);
  assert.equal(result.similarity, 1);
  assert.equal(corrected.transcript, raw.transcript.replace('型锁商人', '型锁伤人'));
  assert.equal(corrected.transcript.length, raw.transcript.length);
  assert.deepEqual(result.cues.map(cue => cue.text), chapter.visual.items.map(item => item.cue));
  assert.deepEqual(result.cues[0], { text: '十月十二日十三点四十四分', start: 3.09, end: 5.15 });

  const changes: Array<{ sentence: number; word: number; from: string; to: string; start: number; end: number }> = [];
  assert.equal(corrected.sentences.length, raw.sentences.length);
  corrected.sentences.forEach((sentence, si) => {
    const original = raw.sentences[si];
    assert.deepEqual({ id: sentence.id, start: sentence.start, end: sentence.end, complete: sentence.complete },
      { id: original.id, start: original.start, end: original.end, complete: original.complete });
    assert.equal(sentence.words.length, original.words.length);
    sentence.words.forEach((word, wi) => {
      const originalWord = original.words[wi];
      assert.equal([...word.text].length, [...originalWord.text].length, 'no owner may gain or lose heard characters');
      assert.deepEqual({ start: word.start, end: word.end }, { start: originalWord.start, end: originalWord.end });
      if (word.text !== originalWord.text) changes.push({ sentence: si, word: wi, from: originalWord.text, to: word.text, start: word.start, end: word.end });
      else assert.equal(word, originalWord, 'unmodified words keep their original owners');
    });
  });
  assert.deepEqual(changes, [{ sentence: 0, word: 5, from: '商', to: '伤', start: .93, end: 1.11 }]);
  for (const key of ['sourceHash', 'duration', 'timing', 'pauses', 'captionBreaks'] as const) assert.deepEqual(corrected[key], raw[key]);
  assert.match(corrected.warnings.at(-1)!, /ASR来源同音正字/);
  assert.match(corrected.warnings.at(-1)!, /"referenceIds":\["ref-5"\]/);
  assert.deepEqual({ chapter, references, raw }, before, 'raw ASR, source records and intended script remain immutable');
});

test('actual first ASR remains rejected without uniquely resolved literal verified source support', () => {
  const variants: Array<{ name: string; change: (value: ReturnType<typeof fresh>) => void; omitReferences?: boolean }> = [
    { name: 'default no references', change: () => {}, omitReferences: true },
    { name: 'empty references', change: value => { value.references = []; } },
    { name: 'duplicate source ID', change: value => { value.references.push(structuredClone(value.references[0])); } },
    { name: 'search summary only', change: value => { value.references[0].verification = 'search-cited'; } },
    { name: 'another chapter references', change: value => { value.chapter.referenceIds = ['other-chapter-ref']; } },
    { name: 'source contains no literal spelling', change: value => { value.references[0].title = '警方公布警情通报'; value.references[0].excerpt = '成都市公安局于十月十四日发布通报。'; } },
  ];
  for (const variant of variants) {
    const value = fresh(); variant.change(value);
    const before = structuredClone(value);
    const corrected = variant.omitReferences
      ? correctLessonTranscript(value.chapter, value.raw)
      : correctLessonTranscript(value.chapter, value.raw, value.references);
    assert.equal(corrected, value.raw, variant.name);
    assert.match(corrected.transcript, /型锁商人/);
    assert.throws(() => alignLessonSpeech(value.chapter, corrected), /汉字|匹配|原词/, variant.name);
    assert.deepEqual(value, before, variant.name);
  }
});
