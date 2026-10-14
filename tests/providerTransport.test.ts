import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';
import { getAgent, createImagePromptWithPi, answerForSessionWithPi, runFFmpeg } from '../server/core';
import { jobFetch, runWithJobSignal, JobCancelledError, jobErrorDiagnostics, getJobTransportDiagnostics } from '../server/jobExecution';
import { executionFailure, isTransientExecutionError, canRetryWorkflowError, blocksModelOutputRecovery, TEXT_TRANSPORT_FINAL } from '../server/executionErrors';
import { providerTransportSettings } from '../server/providerTransport';
import { createCredits } from '../server/credits';
import { withCreditUsage } from '../server/creditUsage';
import { driveWorkflow } from '../server/workflowDriver';
import { executionDiagnostics } from '../server/toolTrace';
import { ARK_BASE_URL, TEXT_MODEL_PRESETS } from '../shared/textModels';
import { transcribeWindow } from '../server/audioUnderstanding';
import { requestSemanticReview } from '../server/semanticReview';
import { inspectVoice } from '../server/audioQuality';
import type { EditPlan } from '../src/types';

const config = () => ({ ...TEXT_MODEL_PRESETS[0], kind: 'text' as const, provider: 'ark', baseUrl: ARK_BASE_URL, enabled: true, apiKey: 'private-transport-credential' });
const socketFailure = () => new TypeError('fetch failed', { cause: new AggregateError([
  Object.assign(new Error('IPv4 connection timed out'), { code: 'ETIMEDOUT' }),
  Object.assign(new Error('IPv6 network unreachable'), { code: 'ENETUNREACH' }),
], 'connection attempts failed') });
const call = (name: string, id: string, args: unknown = {}) => new Response(
  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: config().modelId, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } } })}\n\ndata: [DONE]\n\n`,
  { headers: { 'Content-Type': 'text/event-stream' } },
);

test('connection attempt waiting is sufficient by default and text retry budget is bounded', () => {
  assert.equal(providerTransportSettings().connectAttemptTimeoutMs, 1500);
  assert.equal(providerTransportSettings().textMaxRetries, 2);
});

test('actual Pi required tool recovers a failed first connection and executes the submission once', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { if (++requests === 1) throw socketFailure(); return call('submit_image_prompt', 'recovered', { prompt: '新闻插图' }); };
  try {
    await runWithJobSignal(new AbortController().signal, async () => {
      assert.equal(await createImagePromptWithPi('画新闻插图', config(), []), '新闻插图');
      const diagnostics = getJobTransportDiagnostics();
      assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].outcome, 'recovered'); assert.equal(diagnostics[0].attempts, 2);
      assert.match(JSON.stringify(diagnostics), /ETIMEDOUT|ENETUNREACH/);
    });
    assert.equal(requests, 2);
  } finally { globalThis.fetch = original; }
});

test('exhausted Pi connections retain typed causes beyond the job context and do not multiply workflow retries', async () => {
  const original = globalThis.fetch; let requests = 0, prepared = 0, written = false;
  globalThis.fetch = async () => { requests++; if (requests === 1) return call('prepare', 'prepared'); throw socketFailure(); };
  const tools = [
    { name: 'prepare', label: '准备', description: '', parameters: Type.Object({}), execute: async () => { prepared++; return { content: [], details: {} }; } },
    { name: 'write', label: '提交', description: '', parameters: Type.Object({}), execute: async () => { written = true; return { content: [], details: {} }; } },
  ];
  try {
    const agent = getAgent(config(), tools, '仅执行当前工具', true);
    await assert.rejects(runWithJobSignal(new AbortController().signal, () => driveWorkflow(agent, {
      config: config(), prompt: '完成任务', label: '连接测试', stage: () => ({ key: prepared ? 'writing' : 'preparing', tools: [prepared ? 'write' : 'prepare'] }),
      done: () => written, advance: async () => [], context: () => ({ prepared }),
    })), error => {
      assert.match(String(error), new RegExp(TEXT_TRANSPORT_FINAL));
      const diagnostic = jobErrorDiagnostics(error);
      assert.equal(diagnostic.length, 1); assert.equal(diagnostic[0].attempts, 3); assert.equal(diagnostic[0].failure.retryExhausted, true);
      assert.match(JSON.stringify(diagnostic), /ETIMEDOUT/); assert.doesNotMatch(JSON.stringify(diagnostic), /private-transport-credential/);
      return true;
    });
    assert.equal(requests, 4, 'one successful decision plus exactly three transport attempts');
    assert.equal(prepared, 1, 'completed tool cannot be replayed'); assert.equal(written, false);
  } finally { globalThis.fetch = original; }
});

for (const status of [401, 403]) test(`HTTP ${status} is not retried and remains an authentication failure`, async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({ error: { message: 'unauthorized network policy private-transport-credential' } }), { status }); };
  try {
    await assert.rejects(createImagePromptWithPi('图片', config(), []), error => { assert.match(String(error), new RegExp(String(status))); assert.doesNotMatch(String(error), /private-transport-credential/); return true; });
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('cancellation interrupts transport backoff immediately without another request', async () => {
  const original = globalThis.fetch, controller = new AbortController(); let requests = 0;
  globalThis.fetch = async () => { requests++; setTimeout(() => controller.abort(), 10); throw socketFailure(); };
  const started = Date.now();
  try {
    await assert.rejects(runWithJobSignal(controller.signal, () => createImagePromptWithPi('图片', config(), [])), JobCancelledError);
    assert.equal(requests, 1); assert.ok(Date.now() - started < 500);
  } finally { globalThis.fetch = original; }
});

test('completed tools and provider usage are recorded once when a later model turn reconnects', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qj-transport-credit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credits = createCredits(directory); await credits.load([{ id: 'owner', displayName: '验收', email: 'owner@example.test' }]);
  const original = globalThis.fetch; let requests = 0, prepared = 0, written = false;
  globalThis.fetch = async () => {
    requests++; if (requests === 1) return call('prepare', 'prepare-usage');
    if (requests === 2) throw Object.assign(new Error('Connection error.'), { code: 'ECONNRESET' });
    return call('write', 'write-usage');
  };
  const agent = getAgent(config(), [
    { name: 'prepare', label: '准备', description: '', parameters: Type.Object({}), execute: async () => { prepared++; return { content: [], details: {} }; } },
    { name: 'write', label: '提交', description: '', parameters: Type.Object({}), execute: async () => { written = true; return { content: [], details: {} }; } },
  ], '按顺序准备并提交', true);
  agent.onPayload = payload => ({ ...(payload as object), tool_choice: { type: 'function', function: { name: prepared ? 'write' : 'prepare' } } });
  agent.finishTurn = async () => ({ action: written ? 'end' : 'continue' });
  try {
    await runWithJobSignal(new AbortController().signal, () => withCreditUsage(credits, 'owner', 'one-task', () => agent.prompt('开始')));
    assert.equal(requests, 3); assert.equal(prepared, 1); assert.equal(written, true);
    const history = await credits.history('owner');
    const debits = history.entries.filter(entry => entry.kind === 'model_usage');
    assert.equal(debits.length, 2); assert.deepEqual(debits.map(entry => entry.requestId).sort(), ['prepare-usage', 'write-usage']);
  } finally { globalThis.fetch = original; }
});

test('response-body failure is not replayed after headers, and media submissions never auto retry', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(new ReadableStream({ pull(controller) { controller.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })); } }));
  };
  try {
    await assert.rejects(async () => (await jobFetch('https://provider.test/chat/completions', { method: 'POST', body: '{}' })).text(), /ECONNRESET/);
    assert.equal(requests, 1);
    globalThis.fetch = async () => { requests++; throw socketFailure(); };
    await assert.rejects(jobFetch('https://provider.test/images/generations', { method: 'POST', body: '{}' }));
    await assert.rejects(jobFetch('https://provider.test/tts/create', { method: 'POST', body: '{}' }));
    assert.equal(requests, 3);
  } finally { globalThis.fetch = original; }
});

test('an interrupted model stream preserves its cause without replaying a partial tool or multiplying retry budgets', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    let sent = false;
    return new Response(new ReadableStream({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('data: {"id":"partial","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"partial-call","type":"function","function":{"name":"submit_image_prompt","arguments":"{\\"prompt\\":\\"partial"}}]},"finish_reason":null}]}\n\n')); }
      else controller.error(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try {
    await assert.rejects(runWithJobSignal(new AbortController().signal, () => createImagePromptWithPi('图片', config(), [])), error => {
      assert.match(String(error), /TEXT_TRANSPORT_FINAL/);
      assert.match(JSON.stringify(jobErrorDiagnostics(error)), /ECONNRESET/);
      return true;
    });
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});

test('an explicit decision token budget is forwarded to the real Pi payload', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).max_tokens, 8192);
    return call('done', 'bounded-decision');
  };
  const agent = getAgent(config(), [{ name: 'done', label: '完成', description: '', parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }], '测试', true, { maxTokens: 8192 });
  agent.finishTurn = async () => ({ action: 'end' });
  try { await agent.prompt('生成测试用例'); }
  finally { globalThis.fetch = original; }
});

test('semantic review does not multiply an exhausted connection budget with output-format retries', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw socketFailure(); };
  try { await assert.rejects(requestSemanticReview(config(), [{ role: 'user', content: '检查成片' }]), /TEXT_TRANSPORT_FINAL/); assert.equal(requests, 3); }
  finally { globalThis.fetch = original; }
});

test('conversational reply does not create a new agent after transport recovery is exhausted', async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw socketFailure(); };
  try {
    await assert.rejects(runWithJobSignal(new AbortController().signal, () => answerForSessionWithPi({ prompt: '没有素材能做视频吗？只解释。', config: config(), media: [], history: [], plan: null, attached: [] })), error => {
      assert.equal(jobErrorDiagnostics(error)[0].attempts, 3); assert.equal(executionFailure(error).retryExhausted, true); return true;
    });
    assert.equal(requests, 3);
  } finally { globalThis.fetch = original; }
});

test('audio windows never retry or recursively split authentication and transport failures, but still split malformed transcripts', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qj-window-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'source.wav');
  await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000', '-t', '12', file]);
  const original = globalThis.fetch; let requests = 0;
  try {
    globalThis.fetch = async () => { requests++; throw socketFailure(); };
    await assert.rejects(transcribeWindow(file, 0, 12, config(), directory), /TEXT_TRANSPORT_FINAL/);
    assert.equal(requests, 3, 'an unavailable provider must not create more audio windows');
    requests = 0; globalThis.fetch = async () => { requests++; return new Response('', { status: 403 }); };
    await assert.rejects(transcribeWindow(file, 0, 12, config(), directory), /HTTP 403/); assert.equal(requests, 1);
    requests = 0; globalThis.fetch = async () => {
      requests++;
      const transcript = requests <= 2 ? {} : { sentences: [{ complete: true, words: [{ text: '测试', start: 0, end: 1 }] }] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(transcript) } }] });
    };
    const repaired = await transcribeWindow(file, 0, 12, config(), directory);
    assert.equal(requests, 4, 'two format attempts followed by two smaller verified windows');
    assert.equal(repaired.length, 2); assert.deepEqual(repaired.map(sentence => sentence.start), [0, 6]);
  } finally { globalThis.fetch = original; }
});

test('voice audit retains the exhausted provider cause and makes no second logical audit request', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'qj-voice-transport-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'speech.wav');
  await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000', '-t', '1', file]);
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw socketFailure(); };
  try {
    await assert.rejects(inspectVoice(file, { clips: [{ sourceId: 'speech', sceneId: 'ch1', start: 0, end: 1 }], lesson: {} } as EditPlan, undefined, directory, config()), /TEXT_TRANSPORT_FINAL/);
    assert.equal(requests, 3);
  } finally { globalThis.fetch = original; }
});

test('transient errors share cause-aware classification while exhausted budgets and auth stop recovery', () => {
  for (const error of ['Connection error.', 'ECONNRESET', 'getaddrinfo EAI_AGAIN', socketFailure(), { status: 503 }]) assert.equal(isTransientExecutionError(error), true);
  assert.equal(canRetryWorkflowError('Connection error.'), true);
  assert.equal(canRetryWorkflowError('Connection error. ' + TEXT_TRANSPORT_FINAL), false);
  assert.equal(isTransientExecutionError({ status: 401, cause: socketFailure() }), false);
  assert.equal(isTransientExecutionError({ name: 'CreditError', status: 503, message: '价格未配置' }), false);
  assert.equal(isTransientExecutionError({ name: 'AbortError', message: 'network interrupted' }), false);
  assert.equal(isTransientExecutionError(new Error('音频理解时间码越界：start=503，end=504')), false);
  assert.equal(blocksModelOutputRecovery(new Error('音频理解时间码越界：start=401，end=403')), false);
  const safe = executionFailure(new Error('Authorization: Bearer secret-key https://user:password@example.test/v1?api_key=private'), ['secret-key']);
  assert.doesNotMatch(JSON.stringify(safe), /secret-key|password|api_key=private/);
  for (const detail of ['Connection error.', 'ECONNRESET', 'getaddrinfo EAI_AGAIN']) {
    assert.equal(executionDiagnostics([{ tool: 'research_topic', stage: '选题', callId: 'test', status: 'failed', at: '', detail }]).failures[0].kind, 'provider-unavailable');
  }
});
