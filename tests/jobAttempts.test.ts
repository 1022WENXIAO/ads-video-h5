import test from 'node:test';
import assert from 'node:assert/strict';
import type { Job } from '../shared/types';
import { beginJobAttempt, finishJobAttempt, interruptJobAttempt, jobFailureMessage, publicJob } from '../server/jobAttempts';
import { restoreInterruptedJobs } from '../server/jobRunner';

const job = (): Job => ({ id: 'job', sessionId: 'session', messageId: 'message', kind: 'export', status: 'queued', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' });
const revision = 'a'.repeat(40), start = '2026-10-14T00:00:01Z', end = '2026-10-14T00:00:02Z';

test('manual retry preserves the earlier trace, model, outcome and release snapshot', () => {
  const value = job(), first = beginJobAttempt(value, revision, start);
  value.textModel = { id: 'model-a', name: 'A', modelId: 'upstream-a' };
  value.workflow = [{ tool: 'research_topic', stage: '研究', status: 'failed', at: start, detail: 'Connection error.' }];
  value.error = '连接失败'; value.status = 'failed';
  finishJobAttempt(value, end);
  const snapshot = structuredClone(first);
  value.status = 'queued'; value.kind = 'review';
  const second = beginJobAttempt(value, 'b'.repeat(40), end);
  value.textModel = { id: 'model-b', name: 'B', modelId: 'upstream-b' };
  value.workflow!.push({ tool: 'review_existing_video', stage: '审查', status: 'succeeded', at: end });
  value.status = 'succeeded'; value.error = undefined; value.artifactId = 'video';
  finishJobAttempt(value, '2026-10-14T00:00:03Z');
  assert.deepEqual(first, snapshot);
  assert.notEqual(first.id, second.id);
  assert.equal(second.number, 2); assert.equal(second.reason, 'retry');
  assert.equal(first.kind, 'export'); assert.equal(second.kind, 'review');
  assert.equal(second.workflow?.length, 1); assert.equal(first.workflow?.length, 1);
});

test('restart marks the open attempt interrupted once and starts a separate attempt', () => {
  const value = job(), first = beginJobAttempt(value, revision, start);
  value.status = 'running'; value.workflow = [{ tool: 'render', stage: '渲染', status: 'running', at: start }];
  restoreInterruptedJobs([value], end);
  assert.equal(value.status, 'queued'); assert.equal(first.status, 'interrupted');
  assert.equal(first.workflow?.length, 1);
  const second = beginJobAttempt(value, revision, end);
  assert.equal(second.reason, 'restart');
  interruptJobAttempt(value, '2026-10-14T00:00:04Z');
  interruptJobAttempt(value, '2026-10-14T00:00:05Z');
  assert.equal(second.finishedAt, '2026-10-14T00:00:04Z');
});

test('legacy merged traces are retained without inventing historical attempts', () => {
  const value = job();
  value.workflow = [{ tool: 'legacy', stage: '历史记录', status: 'succeeded', at: start }];
  beginJobAttempt(value, revision, start);
  assert.equal(value.attempts?.length, 1); assert.equal(value.legacyWorkflow?.length, 1);
  assert.equal(value.workflow?.length, 0);
  const visible = publicJob(value);
  assert.equal(visible.legacyWorkflow, undefined);
  assert.equal(visible.attempts?.[0].workflow, undefined);
  assert.equal(value.legacyWorkflow?.length, 1);
});

test('public polling omits heavy attempt traces and transport while retaining status', () => {
  const value = job(); beginJobAttempt(value, revision, start);
  value.status = 'failed'; value.error = '失败';
  finishJobAttempt(value, end, [{ at: start, origin: 'https://example.com', path: '/chat/completions', attempts: 3, durationMs: 100, outcome: 'failed', failure: { name: 'Error', message: 'Connection error.', retryable: true, retryExhausted: true } }]);
  const visible = publicJob(value);
  assert.equal(visible.attempts?.[0].status, 'failed');
  assert.equal(visible.attempts?.[0].transport, undefined);
  assert.equal(value.attempts?.[0].transport?.length, 1);
});

test('a failed retry retains an old video without claiming it was produced again', () => {
  const value = job(); value.artifactId = 'old-video';
  const attempt = beginJobAttempt(value, revision, start);
  value.status = 'failed'; finishJobAttempt(value, end);
  assert.equal(attempt.inheritedArtifactId, 'old-video');
  assert.equal(attempt.artifactId, 'old-video'); assert.equal(attempt.artifactOrigin, 'retained');
  value.status = 'queued'; value.kind = 'review';
  const review = beginJobAttempt(value, revision, end);
  value.status = 'succeeded'; finishJobAttempt(value, end);
  assert.equal(review.artifactOrigin, 'reviewed');
});

test('restored workflow context is not counted as new tool execution in an attempt', () => {
  const value = job(), attempt = beginJobAttempt(value, revision, start);
  value.workflow = [
    { tool: 'research_topic', callId: 'previous-call', stage: '研究', status: 'succeeded', at: value.createdAt },
    { tool: 'render', callId: 'new-call', stage: '渲染', status: 'succeeded', at: end },
  ];
  value.status = 'succeeded'; finishJobAttempt(value, end);
  assert.equal(value.workflow.length, 2);
  assert.equal(attempt.workflow?.length, 1); assert.equal(attempt.workflow?.[0].callId, 'new-call');
  assert.equal(attempt.restoredCallCount, 1); assert.deepEqual(attempt.restoredCallIds, ['previous-call']);
});

test('user errors distinguish transient outages, authorization and evidence gaps', () => {
  assert.match(jobFailureMessage(new Error('新闻制作工作流未完成：Connection error.'), '读取实时热榜'), /自动恢复.*读取实时热榜/);
  assert.match(jobFailureMessage(Object.assign(new Error('401 secret-value'), { status: 401 }), '研究'), /授权验证失败/);
  assert.doesNotMatch(jobFailureMessage(Object.assign(new Error('401 secret-value'), { status: 401 }), '研究'), /secret-value/);
  assert.match(jobFailureMessage(new Error('热点研究缺少可核验来源。'), '研究'), /缺少可核验来源/);
  assert.doesNotMatch(jobFailureMessage(new Error('API Key=private-secret'), '配置', ['private-secret']), /private-secret/);
});
