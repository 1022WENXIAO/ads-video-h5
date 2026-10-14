import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanWithPi, validatePlan } from '../server/core';
import { editProposalTimingFeedback, normalizeEditProposal } from '../server/editProposal';
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
