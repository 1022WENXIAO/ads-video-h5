import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { createOssStorage } from '../server/ossStorage';
import { withReviewAssets, requestReviewJson, type ReviewRequestMetric } from '../server/reviewAssets';
import { reviewAudio } from '../server/reviewAudio';
import { runFFmpeg, probeAudio } from '../server/core';
import { privateEvaluationStorage } from '../server/evaluationIsolation';
import { JobCancelledError, runWithJobSignal } from '../server/jobExecution';

function storage() {
  const objects = new Map<string, Buffer>(), removed: string[] = [];
  const store = {
    bucket: 'fixture', key: (_owner: string, _category: string, id: string) => id,
    publicUrl: (_owner: string, _category: string, id: string) => `https://media.example.test/${id}`,
    put: async (_owner: string, _category: string, id: string, file: string) => { objects.set(id, await readFile(file)); },
    remove: async (_owner: string, _category: string, id: string) => { removed.push(id); objects.delete(id); },
    ensure: async () => {}, exists: async () => false,
  } as NonNullable<ReturnType<typeof createOssStorage>>;
  return { store, objects, removed };
}

test('hosted review retains actual complete audio and frame bytes, sends one audio representation and only removes its temporary assets', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-review-assets-')), s = storage();
  s.objects.set('original-movie', Buffer.from('immutable original'));
  try {
    const wav = path.join(dir, 'input.wav'), mp3 = path.join(dir, 'audio.mp3'), jpg = path.join(dir, 'frame.jpg');
    await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '2.37', wav]);
    await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=720x1280', '-frames:v', '1', jpg]);
    await withReviewAssets(s.store, 'normal-user', async publish => {
      const audio = await reviewAudio(wav, mp3, publish);
      assert.ok('url' in audio && audio.url); assert.equal(audio.data, undefined);
      assert.equal(audio.format, 'mp3'); assert.ok(Math.abs(await probeAudio(mp3) - 2.37) < .15);
      assert.deepEqual(s.objects.get(path.basename(audio.url)), await readFile(mp3));
      const image = await publish!(jpg, 'image/jpeg');
      assert.deepEqual(s.objects.get(path.basename(image)), await readFile(jpg));
    });
    assert.equal(s.removed.length, 2); assert.ok(s.removed.every(id => /^review-/.test(id)));
    assert.equal(s.objects.size, 1); assert.deepEqual(s.objects.get('original-movie'), Buffer.from('immutable original'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('private evaluation and private storage never publish review media', async () => {
  const s = storage();
  await withReviewAssets(s.store, 'evaluation:run:case', async publish => assert.equal(publish, undefined));
  await withReviewAssets(privateEvaluationStorage(s.store), 'evaluation:run:case', async publish => assert.equal(publish, undefined));
  await withReviewAssets({ ...s.store, publicUrl: () => null }, 'normal-user', async publish => assert.equal(publish, undefined));
  assert.equal(s.objects.size, 0); assert.equal(s.removed.length, 0);
});

test('provider failure cleans up temporary assets and does not replace a failed judgment with success', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-review-failure-')), s = storage(), file = path.join(dir, 'image.jpg');
  try {
    await writeFile(file, 'controlled transport bytes');
    await assert.rejects(withReviewAssets(s.store, 'owner', async publish => { await publish!(file, 'image/jpeg'); throw new Error('actual auditor failed'); }), /actual auditor failed/);
    assert.equal(s.objects.size, 0); assert.equal(s.removed.length, 1);
    await assert.rejects(withReviewAssets({ ...s.store, put: async () => { throw new Error('private storage credential detail'); } }, 'owner', async publish => publish!(file, 'image/jpeg')), /审查媒体传输未完成/);
    assert.equal(s.removed.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('cancellation cleans review assets and remains cancellation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-review-stop-')), s = storage(), file = path.join(dir, 'image.jpg'), controller = new AbortController();
  try {
    await writeFile(file, 'controlled transport bytes');
    await assert.rejects(runWithJobSignal(controller.signal, () => withReviewAssets({ ...s.store, put: async (...args) => { await s.store.put(...args); controller.abort(); } }, 'owner', async publish => publish!(file, 'image/jpeg'))), JobCancelledError);
    assert.equal(s.objects.size, 0); assert.equal(s.removed.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('review request diagnostics measure failures without storing credentials, payloads or media URLs', async () => {
  const original = globalThis.fetch, metrics: ReviewRequestMetric[] = [];
  const config = { modelId: 'fixture', apiKey: 'private-test-key', baseUrl: 'https://provider.example.test' } as any;
  const payload = { messages: [{ content: [{ input_audio: { url: 'https://private-media.example.test/audio.mp3' } }] }] };
  try {
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new DOMException('private timeout description', 'TimeoutError'); };
    await assert.rejects(requestReviewJson(config, payload, 'semantic', 0, metric => metrics.push(metric)), error => {
      assert.equal((error as Error).name, 'TextTransportError');
      assert.equal(((error as Error).cause as Error).name, 'TimeoutError');
      return true;
    });
    assert.equal(requests,3,'one bounded transport retry budget, retaining the original timeout cause');
    assert.equal(metrics[0].error, 'TextTransportError'); assert.equal(metrics[0].bytes, Buffer.byteLength(JSON.stringify(payload)));
    assert.doesNotMatch(JSON.stringify(metrics), /private-test-key|private-media|private timeout description/);
    globalThis.fetch = async () => new Response(JSON.stringify({ result: 'actual judgment' }));
    assert.deepEqual(await requestReviewJson(config, payload, 'voice', 1, metric => metrics.push(metric)), { result: 'actual judgment' });
    assert.equal(metrics[1].status, 200); assert.equal(metrics[1].attempt, 2);
  } finally { globalThis.fetch = original; }
});
