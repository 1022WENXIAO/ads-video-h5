import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LessonReport } from '../shared/types';
import { lessonScriptReviewContext } from '../server/lessonScriptReviewContext';
import { reviewLessonScript } from '../server/lessonWorkflow';

const report = (): LessonReport => ({
  workflowId: 'controlled-script', title: '观察与推测', audience: '初学者', objectives: ['区分观察和推测'], arc: '观察、对照、限制', requestedSeconds: 30, explicitDuration: true, format: '16:9', limitations: ['网页摘录只支持已读内容。'],
  references: [{ id: 'r1', title: 'Controlled source', url: 'https://example.org/observation', verification: 'public-page', excerpt: '重复观察可以检验结论是否稳定，但不能自动排除所有其他原因。' }],
  chapters: [{ id: 'ch1', title: '观察与结论', role: 'foundation', goal: '区分两个概念', prerequisites: [], narration: '先记录小球的实际轨迹，再比较同样条件下的结果，重复观察可以检查结论是否稳定。', reason: '先描述再解释', referenceIds: ['r1'], claims: [{ text: '重复观察可以检验结论是否稳定。', referenceIds: ['r1'] }], visual: { kind: 'concept', takeaway: '观察提供证据，解释需要检验', items: [{ label: '观察', detail: '记录实际轨迹', cue: '实际轨迹' }, { label: '比较', detail: '保持条件相同', cue: '同样条件' }] } }],
});

test('script review context retains source evidence and current script without inheriting old reviews or voice state', () => {
  const value = report();
  value.factReview = { score: 82, needsRepair: true, findings: ['尚未提供最终MP4文件。'] };
  value.voice = { mode: 'preset', modelId: 'test', revision: 1, tempo: 1 };
  const before = structuredClone(value), context = lessonScriptReviewContext(value);
  assert.equal(context.reviewStage.name, 'script-fact-review');
  assert.ok(context.reviewStage.pendingSteps.includes('render_lesson'));
  assert.deepEqual(context.report.chapters, value.chapters);
  assert.deepEqual(context.report.references, value.references);
  assert.match(context.researchSummary, /重复观察可以检验结论是否稳定/);
  assert.ok(!('factReview' in context.report)); assert.ok(!('voice' in context.report));
  assert.deepEqual(value, before);
});

test('the real HTTP script-review request excludes search-model capability refusals and keeps actual factual defects blocking', async () => {
  const payloads: any[] = [];
  let response = { score: 88, needsRepair: false, findings: [] as string[] };
  const server = createServer(async (request, outgoing) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    outgoing.writeHead(200, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { id: 'local-script-review', name: 'Controlled model', provider: 'controlled', kind: 'text' as const, modelId: 'controlled', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: 'controlled-test-only', enabled: true };
  const value = report(), userPrompt = '生成30秒知识讲解视频，最终交付可播放MP4，解释观察和推测的区别。';
  try {
    for (const refusal of ['我当前不能直接生成并导出可播放的MP4成片文件。', '这里没有视频导出工具，请用户另行上传真人素材。', '只能提供脚本，无法生成最终视频。']) {
      const result = await reviewLessonScript(config, value, refusal + '\n资料：' + value.references[0].excerpt, undefined, undefined, userPrompt);
      assert.equal(result.needsRepair, false);
      const request = payloads.at(-1), input = JSON.parse(request.messages.at(-1).content);
      assert.equal(input.userPrompt, userPrompt, 'the actual final-delivery requirement remains authorized');
      assert.equal(input.reviewStage.artifact, 'script');
      assert.ok(input.reviewStage.pendingSteps.includes('render_lesson'));
      assert.doesNotMatch(input.researchSummary, new RegExp(refusal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.deepEqual(input.report.chapters, value.chapters);
      assert.match(input.researchSummary, /只支持|实际网页摘录/);
    }
    response = { score: 84, needsRepair: true, findings: ['ch1：重复观察可以排除一切其他原因；依据：来源只说明检验稳定性；修正：保留限制。'] };
    const invalid = report(); invalid.chapters[0].narration = '重复观察可以排除一切其他原因。';
    const failed = await reviewLessonScript(config, invalid, '我不能导出MP4。', undefined, undefined, userPrompt);
    assert.equal(failed.needsRepair, true);
    assert.match(failed.findings.join('；'), /排除一切其他原因/);
    assert.equal(payloads.length, 4);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
