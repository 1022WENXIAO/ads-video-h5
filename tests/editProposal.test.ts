import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanWithPi, validatePlan } from '../server/core';
import { applyEditAudioPolicy, editAudioNormalization, editProposalNarrativeFeedback, editProposalTimingFeedback, editSentenceBudgetHint, normalizeEditProposal } from '../server/editProposal';
import { applyTimelineRequest } from '../server/timeline';
import type { EditPlan, MediaItem } from '../shared/types';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';

const config = { ...TEXT_MODEL_PRESETS[0], kind: 'text' as const, provider: 'ark', baseUrl: ARK_BASE_URL, enabled: true, apiKey: 'controlled-test-credential' };
const source = (id: string, times: Array<[number, number, string]>): MediaItem => ({ id, name: `${id}.mp4`, kind: 'video', mimeType: 'video/mp4', duration: 24.75, hasAudio: true, url: '', createdAt: '', analysis: { status: 'ready', modelId: 'controlled-fixture', sourceHash: id, duration: 24.75, transcript: times.map(row => row[2]).join('\n'), timing: 'model-estimated', warnings: [], pauses: [], createdAt: '', sentences: times.map(([start, end, text], index) => ({ id: `${id}:${index}`, start, end, text, complete: true, words: [...text].map((text, i, chars) => ({ text, start: start + i * (end - start) / chars.length, end: start + (i + 1) * (end - start) / chars.length })) })) } });
const media = [source('observation', [[.09, 5.44, '观察一个现象时先记录看到了什么再提出可能的解释'], [6.12, 10.33, '这段画面是程序绘制的示意不是真实现场'], [11.04, 17.91, '把观察和推测分开可以让表达更清楚也让后续核验有明确方向']]), source('comparison', [[.45, 6.22, '比较两个方案时要先保持比较条件一致再看差异来自哪里'], [6.9, 9.56, '这段画面也是程序绘制的示意'], [10.35, 17.67, '结论应当由证据支持暂时没有把握的部分需要保留限制不能把猜测说成事实']])];
const clip = (sourceIndex: number, sentence: number, fade = false) => { const s = media[sourceIndex].analysis!.sentences[sentence]; return { sourceId: media[sourceIndex].id, start: s.start, end: s.end, sentenceIds: [s.id], transition: { kind: fade ? 'fade' as const : 'cut' as const, duration: fade ? .3 : 0 } }; };
const failedProposal = (): EditPlan => ({ format: '9:16', targetSeconds: 0, summary: '对比观察与解释', fineCut: true, clips: [clip(0, 0, true), clip(0, 1), clip(1, 0, true), clip(1, 1), clip(0, 2, true), clip(1, 2, true)], overlays: [{ start: .3, end: 5, text: '先记录事实', style: 'keyword' }, { start: 27.55, end: 34.55, text: '结论必须由证据支持', style: 'keyword' }] });
const prompt = '把附加两段视频剪成20秒竖屏，保留选中完整原话和原声，添加同步字幕，不新增配音或图片，结论清楚，转场自然。';

test('real incident timing feedback includes duration and stale overlay together without weakening validators', () => {
  const original = failedProposal(), normalized = normalizeEditProposal(original);
  assert.equal(original.clips[0].transition!.kind, 'fade'); assert.equal(normalized.plan.clips[0].transition!.kind, 'cut');
  assert.equal(normalized.repairs.length, 1); assert.throws(() => validatePlan(original, media), /第1个片段.*cut\/0/);
  const feedback = editProposalTimingFeedback(normalized.plan, prompt).join('\n');
  assert.match(feedback, /31\.280秒.*20秒/); assert.match(feedback, /覆盖层第2条.*27\.55–34\.55/); assert.match(feedback, /减少所选完整句子/); assert.match(feedback, /删片前的旧轴/);
  assert.throws(() => validatePlan(normalized.plan, media), /覆盖层第2条.*0–31\.280秒/);
});
test('original speech defaults to actual loudness processing and only explicit audio processing exclusions disable it', () => {
  for (const request of ['保留原声，不重新配音', '不要新增配音图片，音量统一一点', '不要压缩视频，保留原声', '不要关闭响度归一化', 'keep original speech without generating voiceover']) assert.equal(editAudioNormalization(request), true, request);
  for (const request of ['不做响度归一化', '不要调整原声的音量', '不要动态处理', '保留原始动态', '关闭响度均衡', 'do not normalize audio', 'without dynamic compression']) assert.equal(editAudioNormalization(request), false, request);
  const raw = { ...failedProposal(), audio: { originalVolume: .8, bgmVolume: 0, narrationVolume: 1, normalize: false } };
  const normalized = normalizeEditProposal(raw, '保留原话原声，加字幕');
  assert.equal(normalized.plan.audio!.normalize, true); assert.equal(normalized.plan.audio!.originalVolume, .8); assert.equal(raw.audio.normalize, false);
  assert(normalized.repairs.some(message => /逐段与混音/.test(message)));
  assert.equal(applyEditAudioPolicy(normalized.plan, '保持原始响度，不做动态处理').audio!.normalize, false);
});
test('a complete ASR conclusion still needs its adjacent stated limitation for a coherent ending', () => {
  const sources = structuredClone(media), original = sources[1].analysis!.sentences[2];
  const conclusion = { ...original, id: 'conclusion', start: 10.35, end: 12.35, text: '结论应当由证据支持', words: [{ text: '结论应当由证据支持', start: 10.35, end: 12.35 }] };
  const limitation = { ...original, id: 'limitation', start: 12.6, end: 17.67, text: '暂时没有把握的部分需要保留限制不能把猜测说成事实', words: [{ text: '暂时没有把握的部分需要保留限制不能把猜测说成事实', start: 12.6, end: 17.67 }] };
  sources[1].analysis!.sentences.splice(2, 1, conclusion, limitation);
  const before = structuredClone(sources);
  const candidate = { ...failedProposal(), clips: [clip(0, 0), { sourceId: sources[1].id, start: 10.1, end: 12.5, sentenceIds: ['conclusion'], purpose: 'conclusion' as const }] };
  assert.match(editProposalNarrativeFeedback(candidate, sources).join('\n'), /当前句在ASR中完整.*丢失论证边界/);
  assert.equal(conclusion.complete, true); assert.deepEqual(sources, before);
  const repaired = { ...candidate, clips: [candidate.clips[0], { ...candidate.clips[1], end: 17.82, sentenceIds: ['conclusion', 'limitation'] }] };
  assert.deepEqual(editProposalNarrativeFeedback(repaired, sources), []);
});
test('sentence budget suggestions are computed through actual plan and padding validation within the central duration band', () => {
  let validated = 0;
  const hint = editSentenceBudgetHint(failedProposal(), prompt, media, candidate => { const result = applyTimelineRequest(validatePlan(candidate, media), prompt, media); validated++; assert(Math.abs(result.targetSeconds - 20) <= 2); return result; });
  assert(validated > 0); assert.match(hint, /实际源时间.*padding/);
  const suggestions = hint.split('\n').slice(1); assert(suggestions.length > 0 && suggestions.length <= 3);
  for (const row of suggestions) { const seconds = Number(/\d+\.\s+(\d+(?:\.\d+)?)秒/.exec(row)![1]); assert(seconds >= 19 && seconds <= 21); }
  assert.equal(editSentenceBudgetHint(failedProposal(), prompt, media, () => { throw new Error('invalid source or timing'); }), '');
});
test('the real Pi adapter overrides model normalize=false and preserves an explicit user opt-out after timeline application', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const candidate = { ...failedProposal(), fineCut: false, clips: [clip(0, 0), clip(1, 0), clip(1, 2)], overlays: [], audio: { originalVolume: 1, bgmVolume: 0, narrationVolume: 1, normalize: false } };
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'normalization-fixture', type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify(candidate) } }] };
    const chunks = [{ delta, finish_reason: null }, { delta: {}, finish_reason: 'tool_calls' }].map(choice => `data: ${JSON.stringify({ id: 'controlled-normalization', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, ...choice }] })}\n\n`).join('');
    return new Response(chunks + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    assert.equal((await createPlanWithPi(prompt, config, structuredClone(media), [], null, [])).audio!.normalize, true);
    assert.equal((await createPlanWithPi(prompt + ' 不做响度归一化，保留原始动态。', config, structuredClone(media), [], null, [])).audio!.normalize, false);
    const natural = await createPlanWithPi('把两段视频剪成20秒横屏小片，两段都用到，所选句子保留完整原话原声，加字幕，不新增配音图片，给我成片。', config, structuredClone(media), [], null, []);
    assert.equal(natural.fineCut, true); assert(Math.abs(natural.targetSeconds - 20) <= 2); assert.equal(natural.audio!.normalize, true);
  } finally { globalThis.fetch = originalFetch; }
});
test('overlong speech and obsolete overlays are repaired in one Pi turn and selected original words stay complete', async () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  const corrected = { ...failedProposal(), clips: [clip(0, 0, true), clip(1, 0), clip(1, 2)], overlays: [] };
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); requests++;
    assert.equal(body.tool_choice, 'required');
    if (requests > 1) { const messages = JSON.stringify(body.messages); assert.match(messages, /31\.280秒.*20秒/); assert.match(messages, /覆盖层第2条/); }
    const arguments_ = requests === 1 ? failedProposal() : corrected;
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: `edit-fixture-${requests}`, type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify(arguments_) } }] };
    const chunks = [{ delta, finish_reason: null }, { delta: {}, finish_reason: 'tool_calls' }].map(choice => `data: ${JSON.stringify({ id: 'controlled-edit-recovery', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, ...choice }] })}\n\n`).join('');
    return new Response(chunks + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    const plan = await createPlanWithPi(prompt, config, structuredClone(media), [], null, []);
    assert.equal(requests, 2); assert(Math.abs(plan.targetSeconds - 20) <= 2); assert.equal(new Set(plan.clips.map(clip => clip.sourceId)).size, 2);
    assert.equal(plan.clips[0].transition!.kind, 'cut'); assert.equal(plan.clips.length, 3);
    const heard = [media[0].analysis!.sentences[0].text, media[1].analysis!.sentences[0].text, media[1].analysis!.sentences[2].text].join('');
    assert.equal(plan.captions!.map(caption => caption.text).join(''), heard);
    assert(plan.captions!.every(caption => caption.start >= 0 && caption.end <= plan.targetSeconds));
    assert.doesNotThrow(() => validatePlan(plan, media));
  } finally { globalThis.fetch = originalFetch; }
});
test('the planner can repair more than three bounded validation rejections while ordinary tools retain their default budget', async () => {
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (_url, init) => {
    requests++;
    if (requests > 1) assert.match(JSON.stringify(JSON.parse(String(init?.body)).messages), /候选/);
    const candidate = requests <= 3 ? failedProposal() : { ...failedProposal(), clips: [clip(0, 0), clip(1, 0), clip(1, 2)], overlays: [] };
    const delta = { role: 'assistant', tool_calls: [{ index: 0, id: `repair-${requests}`, type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify(candidate) } }] };
    return new Response([{ delta, finish_reason: null }, { delta: {}, finish_reason: 'tool_calls' }].map(choice => `data: ${JSON.stringify({ id: 'bounded-edit-recovery', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try { assert((await createPlanWithPi(prompt, config, structuredClone(media), [], null, [])).clips.length); assert.equal(requests, 4); }
  finally { globalThis.fetch = originalFetch; }
});
