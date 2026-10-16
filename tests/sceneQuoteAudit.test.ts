import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MediaItem, SelectedScene } from '../src/types';
import { sceneQuoteAuditEntries, sceneQuoteAuditVersion, SceneQuoteAuditProtocolError, validateSceneQuoteAuditCache, validateSceneQuoteAuditResult } from '../server/sceneQuoteAudit';
import { verifySceneQuotes } from '../server/sceneUnderstanding';
import { selectScenes } from '../server/editorialWorkflow';
import { withModelSnapshot } from '../server/modelContext';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';

const fixture = JSON.parse(await readFile(new URL('./fixtures/p38-scene-quote-context-failure.json', import.meta.url), 'utf8'));
const config = { id: 'controlled-audit', kind: 'understanding' as const, name: 'Controlled quote audit', provider: 'ark', modelId: 'controlled-understanding', enabled: true, baseUrl: 'https://example.invalid/v3', apiKey: 'fake-quote-audit-key' };
const sources = () => [structuredClone(fixture.source)] as MediaItem[];
const selection = (source: MediaItem[], ids = ['s3', 's6']) => selectScenes(ids.map(id => ({ sourceId: source[0].id, sentenceIds: [id], reason: '保留真实完整原话进行协议核验', purpose: 'conclusion' as const })), source);
const response = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] });
const snapshot = { text: null, image: null, audio: null, understanding: config };
const audit = (scenes: SelectedScene[], media: MediaItem[], dir: string) => withModelSnapshot(snapshot, () => verifySceneQuotes(scenes, media, dir));
const rejection = (entry: ReturnType<typeof sceneQuoteAuditEntries>[number]) => ({ id: entry.id, quote: entry.selected.quote, evidence: { start: 0, end: entry.selected.quote.length, text: entry.selected.quote }, reason: '受控模型理由；只用于检验原始缺陷保留，不是对真实完整句的事实裁决' });

test('three actual saved context misattributions cannot become selected-quote quality verdicts', () => {
  const media = sources(), before = structuredClone(media), entries = sceneQuoteAuditEntries(selection(media), media);
  for (const observed of fixture.observations) {
    const entry = entries.find(item => item.selected.quote === observed.selectedQuote)!;
    const malformed = { rejected: [{ id: entry.id, quote: observed.rejectedContextText, evidence: { start: 0, end: observed.rejectedContextText.length, text: observed.rejectedContextText }, reason: `quote「${observed.rejectedContextText}」是未说完的半句话` }] };
    assert.throws(() => validateSceneQuoteAuditResult(malformed, entries), error => error instanceof SceneQuoteAuditProtocolError && error.field.endsWith('.quote'));
    const forged = structuredClone(malformed); forged.rejected[0].quote = entry.selected.quote;
    assert.throws(() => validateSceneQuoteAuditResult(forged, entries), SceneQuoteAuditProtocolError, 'copying the selected full quote cannot legalize an out-of-quote evidence span');
  }
  assert.deepEqual(media, before, 'source text, timing, complete flags and test words are unchanged');
});

test('valid complete principles, modal imperatives and real incomplete quotes retain their separate contracts', () => {
  const media = sources(), complete = sceneQuoteAuditEntries(selection(media, ['s1', 's3', 's6']), media);
  assert.deepEqual(validateSceneQuoteAuditResult({ rejected: [] }, complete), { rejected: [] });
  assert.equal(complete[0].context.previous, '比较两个方案时');
  assert.throws(() => selectScenes([{ sourceId: media[0].id, sentenceIds: ['s0', 's1'], reason: '不能把原false短语强行作为完整句合并', purpose: 'comparison' }], media), /选句必须来自已转写的完整原话/);
  const broken = structuredClone(media);
  broken[0].analysis!.sentences[3].text = '他把不确定的需求';
  broken[0].analysis!.sentences[3].words = [{ start: 9.15, end: 11.28, text: '他把不确定的需求' }];
  const entry = sceneQuoteAuditEntries(selection(broken, ['s3']), broken)[0], raw = { rejected: [rejection(entry)] };
  assert.equal(validateSceneQuoteAuditResult(raw, [entry]), raw, 'bound true-fragment rejection remains a rejection despite the upstream complete=true flag');
  assert.equal(raw.rejected[0].reason, '受控模型理由；只用于检验原始缺陷保留，不是对真实完整句的事实裁决');
});

test('identity, quote and current span are strict for fresh and cached results', () => {
  const media = sources(), entries = sceneQuoteAuditEntries(selection(media), media), good = { rejected: [rejection(entries[0])] };
  const controls: Array<(value: any) => void> = [
    value => { delete value.rejected[0].quote; },
    value => { value.rejected[0].id = 'foreign-scene'; },
    value => { value.rejected.push(structuredClone(value.rejected[0])); },
    value => { delete value.rejected[0].evidence; },
    value => { value.rejected[0].evidence.start = -1; },
    value => { value.rejected[0].evidence.end += 1; },
    value => { value.rejected[0].evidence.start = 0.5; },
    value => { value.rejected[0].evidence.end = 0; },
    value => { value.rejected[0].evidence.text = '需要保留限制'; },
    value => { value.rejected[0].reason = ''; },
    value => { value.rejected[0].reason = 'x'.repeat(1001); },
  ];
  for (const mutate of controls) {
    const bad = structuredClone(good); mutate(bad);
    assert.throws(() => validateSceneQuoteAuditResult(bad, entries), SceneQuoteAuditProtocolError);
    assert.throws(() => validateSceneQuoteAuditCache({ version: sceneQuoteAuditVersion, entries, result: bad }, entries), SceneQuoteAuditProtocolError);
  }
  for (const bad of [null, {}, { rejected: null }, { rejected: {} }, { rejected: [null] }]) assert.throws(() => validateSceneQuoteAuditResult(bad, entries), SceneQuoteAuditProtocolError);
  const cache = { version: sceneQuoteAuditVersion, entries: structuredClone(entries), result: good };
  assert.equal(validateSceneQuoteAuditCache(cache, entries), good);
  for (const mutate of [(value: any) => { value.version = 'sentence-audit-v2'; }, (value: any) => { value.entries[0].selected.sourceHash = 'stale'; }, (value: any) => { value.entries[0].selected.start += 0.01; }, (value: any) => { value.entries[0].context.next = 'different context'; }]) {
    const stale = structuredClone(cache); mutate(stale); assert.throws(() => validateSceneQuoteAuditCache(stale, entries), SceneQuoteAuditProtocolError);
  }
  for (const mutate of [(value: SelectedScene[]) => { value[0].sourceHash = 'stale'; }, (value: SelectedScene[]) => { value[0].quote += '补词'; }, (value: SelectedScene[]) => { value[0].end += 0.01; }]) {
    const stale = selection(media); mutate(stale); assert.throws(() => sceneQuoteAuditEntries(stale, media), SceneQuoteAuditProtocolError);
  }
});

test('one mock request preserves the original invalid reason without caching a quality verdict or auto retry', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-quote-audit-invalid-')), original = globalThis.fetch;
  t.after(async () => { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); });
  const media = sources(), scenes = selection(media), before = structuredClone({ media, scenes }), requests: any[] = [];
  const bad = { rejected: [{ id: scenes[0].id, quote: '暂时没有把握的部分', evidence: { start: 0, end: 9, text: '暂时没有把握的部分' }, reason: 'ORIGINAL_WRONG_REASON：把next错当成quote' }] };
  globalThis.fetch = async (_input, init) => { requests.push(JSON.parse(String(init?.body))); return response(bad); };
  await assert.rejects(audit(scenes, media, dir), SceneQuoteAuditProtocolError);
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tokens, 1800);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' }); assert.deepEqual(requests[0].thinking, { type: 'disabled' });
  const wireEntries = JSON.parse(requests[0].messages[1].content);
  assert.equal(wireEntries[0].selected.quote, '结论应当由证据支持'); assert.equal(wireEntries[0].context.next, '暂时没有把握的部分');
  assert.match(requests[0].messages[0].content, /context.*不能成为.*拒绝/);
  let files = await readdir(dir); assert.equal(files.length, 1); assert.match(files[0], /\.response-.*\.json$/);
  const saved = JSON.parse(await readFile(path.join(dir, files[0]), 'utf8'));
  assert.deepEqual(JSON.parse(saved.content), bad, 'the wrong original reason is preserved verbatim, not filtered away');
  assert.doesNotMatch(JSON.stringify(saved), /fake-quote-audit-key/);
  globalThis.fetch = async () => { requests.push({ controlledNextAllowedInvocation: true }); return response({ rejected: [] }); };
  await audit(scenes, media, dir); assert.equal(requests.length, 2, 'a caller-controlled later invocation is the only recovery; no internal new round');
  files = await readdir(dir); assert.equal(files.filter(file => file.includes('.response-')).length, 2);
  assert.equal(files.filter(file => !file.includes('.response-')).length, 1);
  assert.deepEqual({ media, scenes }, before);
});

test('new cache namespace ignores old v2 verdicts, revalidates current cache, and preserves a valid real rejection', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-quote-audit-cache-')), original = globalThis.fetch;
  t.after(async () => { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); });
  const media = sources(), scenes = selection(media), entries = sceneQuoteAuditEntries(scenes, media);
  const oldEntries = entries.map(entry => ({ id: entry.id, quote: entry.selected.quote, previous: entry.context.previous, next: entry.context.next }));
  const oldKey = createHash('sha256').update(JSON.stringify([scenes.map(scene => scene.sourceHash), oldEntries, config.modelId, 'sentence-audit-v2'])).digest('hex');
  const oldFile = path.join(dir, oldKey + '.json'), oldBytes = JSON.stringify({ rejected: [{ id: scenes[0].id, reason: '原v2上下文错位拒绝' }] });
  await writeFile(oldFile, oldBytes);
  let calls = 0; const rejected = { rejected: [rejection(entries[0])] };
  globalThis.fetch = async () => { calls++; return response(rejected); };
  await assert.rejects(audit(scenes, media, dir), /受控模型理由/); assert.equal(calls, 1);
  await assert.rejects(audit(scenes, media, dir), /受控模型理由/); assert.equal(calls, 1, 'validated new rejection cache preserves the rejection without another model request');
  assert.equal(await readFile(oldFile, 'utf8'), oldBytes);
  const key = createHash('sha256').update(JSON.stringify([entries, config.modelId, sceneQuoteAuditVersion])).digest('hex'), currentFile = path.join(dir, key + '.json');
  const malformed = JSON.parse(await readFile(currentFile, 'utf8')); malformed.result.rejected[0].evidence.text = entries[0].context.next;
  const malformedBytes = JSON.stringify(malformed); await writeFile(currentFile, malformedBytes);
  await assert.rejects(audit(scenes, media, dir), SceneQuoteAuditProtocolError); assert.equal(calls, 1, 'invalid cache is unavailable, not a pass or automatic replay');
  assert.equal(await readFile(currentFile, 'utf8'), malformedBytes, 'invalid original cache is retained');
});

test('HTTP401 and cancellation retain failure identity and cannot become a passing audit', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-quote-audit-transport-')), original = globalThis.fetch;
  t.after(async () => { globalThis.fetch = original; await rm(dir, { recursive: true, force: true }); });
  const media = sources(), scenes = selection(media); let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('not an audit', { status: 401 }); };
  await assert.rejects(audit(scenes, media, dir), /选句审查失败HTTP 401/); assert.equal(calls, 1);
  assert.deepEqual(await readdir(dir), []);
  const controller = new AbortController();
  globalThis.fetch = async () => { calls++; controller.abort(); throw new DOMException('Controlled cancellation', 'AbortError'); };
  await assert.rejects(runWithJobSignal(controller.signal, () => audit(scenes, media, dir)), JobCancelledError);
  assert.equal(calls, 2); assert.deepEqual(await readdir(dir), []);
});
