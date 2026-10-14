import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { probeVideo, runFFmpeg } from '../server/core';
import { evaluationStreamDurationCheck, inspectEvaluationStreamDuration } from '../server/evaluationMediaGate';

test('packet gate uses actual presentation endpoints, including reordered frames, rather than declared durations', () => {
  const probe = { streams: [{ index: 0, codec_type: 'video', duration: '10' }, { index: 1, codec_type: 'audio', duration: '10' }], packets: [{ stream_index: 0, pts_time: '0', duration_time: '1' }, { stream_index: 0, pts_time: '2', duration_time: '1' }, { stream_index: 0, pts_time: '1', duration_time: '1' }, { stream_index: 1, pts_time: '0', duration_time: '3' }] };
  assert.equal(evaluationStreamDurationCheck(probe, 3).passed, true);
  assert.equal(evaluationStreamDurationCheck(probe, 10).passed, false);
  assert.equal(evaluationStreamDurationCheck({ ...probe, packets: probe.packets.map(packet => ({ ...packet, duration_time: undefined })) }, 3).passed, false);
  assert.equal(evaluationStreamDurationCheck({ streams: probe.streams, packets: [] }, 3).passed, false);
});

test('real packet gate rejects short video hidden by full audio/container duration and accepts fractional-frame/AAC rounding', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qingjian-stream-gate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const videoSeconds of [3.3, 5.61]) {
    const file = path.join(dir, `${videoSeconds}.mp4`);
    await runFFmpeg(['-v', 'error', '-y', '-f', 'lavfi', '-t', String(videoSeconds), '-i', 'color=c=blue:s=64x96:r=30', '-f', 'lavfi', '-t', '5.61', '-i', 'sine=frequency=660:sample_rate=44100', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
    // Both containers satisfy the former duration gate and fully decode.
    assert.ok(Math.abs((await probeVideo(file)).duration - 5.61) < .1);
    await runFFmpeg(['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', file, '-f', 'null', '-']);
    const check = await inspectEvaluationStreamDuration(file, 5.61);
    assert.equal(check.id, 'stream-duration'); assert.equal(check.weight, 0);
    assert.equal(check.passed, videoSeconds === 5.61, check.detail);
    assert.match(check.detail, /video实际起点.*终点.*audio实际起点.*终点.*0\.25/);
  }
});
