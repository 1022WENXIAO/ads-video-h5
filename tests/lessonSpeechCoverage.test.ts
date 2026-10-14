import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioAnalysis, LessonChapter } from '../shared/types';
import { alignLessonSpeech, compactSpeech, correctLessonTranscript } from '../server/lessonSpec';

const chapter = (narration: string): LessonChapter => ({ id: 'chapter-2', title: '任务与限制', role: 'development', goal: '说明能力和边界', prerequisites: [], narration, reason: '准确说明', referenceIds: [], claims: [{ text: '课堂演示', referenceIds: [], basis: 'calculation', explanation: '示例' }], visual: { kind: 'concept', takeaway: '任务与限制', items: [{ label: '限制', detail: '边界条件', cue: '仍需验证' }, { label: '用途', detail: '实际范围', cue: '任务' }] } });
const audio = (transcript: string): AudioAnalysis => ({ status: 'ready', modelId: 'controlled-asr', sourceHash: 'same-audio', duration: 40, transcript, sentences: [{ id: 'sentence', text: transcript, complete: true, start: 0, end: 40, words: [...transcript].map((text, i, all) => ({ text, start: i * 40 / all.length, end: (i + 1) * 40 / all.length })) }], pauses: [], warnings: [], timing: 'model-estimated', createdAt: '' });

test('the actual middle-character omission in 编程 cannot pass behind a high chapter match', () => {
  const narration = '它面向编程代理、数学和数据分析任务。官方介绍的能力需要结合具体工作测试，不能只看模型名称就作结论，结果仍需验证。';
  const value = chapter(narration), raw = audio(narration.replace('编程', '编')), before = structuredClone(raw);
  assert.ok((compactSpeech(narration).length - 1) / compactSpeech(narration).length > .98);
  assert.throws(() => alignLessonSpeech(value, correctLessonTranscript(value, raw)), /未完整匹配汉字「程」/);
  assert.deepEqual(raw, before, 'rejection never fills the expected character into heard words');
  assert.equal(alignLessonSpeech(value, audio(narration)).similarity, 1);
});

test('one-character omissions across video topics, positions and ASR sentence boundaries stay blocking', () => {
  for (const term of ['证据', '比较', '步骤', '变化', '限制', '安全', '输入', '输出', '准确']) {
    for (const position of [0, 1]) {
      const narration = `这个任务需要${term}，不能仅凭一次结果下结论，其他条件保持一致，再比较观察与实际证据，结论仍需验证。`;
      const value = chapter(narration), heard = narration.replace(term, term.slice(0, position) + term.slice(position + 1));
      const raw = audio(heard), at = heard.indexOf(term[position ? 0 : 1]) + 1, words = raw.sentences[0].words;
      raw.sentences = [
        { ...raw.sentences[0], id: 'first', text: heard.slice(0, at), words: words.slice(0, at), end: words[at - 1].end },
        { ...raw.sentences[0], id: 'second', text: heard.slice(at), words: words.slice(at), start: words[at].start },
      ];
      assert.throws(() => alignLessonSpeech(value, raw), /未完整匹配汉字/, `${term}:${position}`);
      assert.equal(alignLessonSpeech(value, audio(narration)).similarity, 1);
    }
  }
});

test('punctuation and case differences do not invent missing content or change heard timings', () => {
  const value = chapter('AI模型处理任务，结果仍需验证。'), raw = audio('ai模型处理任务。结果仍需验证！'), before = structuredClone(raw);
  assert.equal(alignLessonSpeech(value, raw).similarity, 1);
  assert.deepEqual(raw, before);
});

test('verified equivalent numerals still pass but a missing ordinary 点 or changed number does not', () => {
  const value = chapter('这个任务比较十六个样本的特点，其他条件保持一致，结论仍需验证。');
  const equivalent = audio(value.narration.replace('十六', '16'));
  assert.doesNotThrow(() => alignLessonSpeech(value, equivalent));
  assert.throws(() => alignLessonSpeech(value, audio(value.narration.replace('十六', '17'))), /数字|单位/);
  assert.throws(() => alignLessonSpeech(value, audio(value.narration.replace('十六', '16').replace('特点', '特'))), /未完整匹配汉字「点」/);
});
