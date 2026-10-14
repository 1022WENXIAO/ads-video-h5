import { createRequire } from 'node:module';
import type { EvaluationCheck } from '../src/evaluationTypes';
import { spawnForJob, throwIfJobCancelled } from './jobExecution';

export const EVALUATION_STREAM_TOLERANCE_SECONDS = .25;
interface PacketProbe {
  streams: Array<{ index: number; codec_type: string }>;
  packets: Array<{ stream_index: number; pts_time?: string; duration_time?: string }>;
}

// Inspect actual demuxed packet timestamps rather than format/stream duration
// metadata. Full FFmpeg decoding remains a separate mandatory evaluation gate.
export function evaluationStreamDurationCheck(probe: PacketProbe, target: number): EvaluationCheck {
  const streams = probe.streams.filter(stream => ['video', 'audio'].includes(stream.codec_type));
  const endpoints = streams.map(stream => {
    const packets = probe.packets.filter(packet => packet.stream_index === stream.index);
    let start = Infinity, end = -Infinity;
    const valid = packets.length > 0 && packets.every(packet => {
      const pts = Number(packet.pts_time), duration = Number(packet.duration_time);
      if (!Number.isFinite(pts) || !Number.isFinite(duration) || duration <= 0) return false;
      start = Math.min(start, pts); end = Math.max(end, pts + duration); return true;
    });
    return { kind: stream.codec_type, start, end, valid };
  });
  const tolerance = EVALUATION_STREAM_TOLERANCE_SECONDS;
  const passed = Number.isFinite(target) && target > 0 && endpoints.some(stream => stream.kind === 'video') && endpoints.some(stream => stream.kind === 'audio') && endpoints.every(stream => stream.valid && Math.abs(stream.start) <= tolerance && Math.abs(stream.end - target) <= tolerance) && Math.max(...endpoints.map(stream => stream.end)) - Math.min(...endpoints.map(stream => stream.end)) <= tolerance;
  const detail = endpoints.map(stream => `${stream.kind}实际起点${Number.isFinite(stream.start) ? stream.start.toFixed(3) : '缺失'}秒、终点${Number.isFinite(stream.end) ? stream.end.toFixed(3) : '缺失'}秒${stream.valid ? '' : '（缺少有效packet时间）'}`).join('；');
  return { id: 'stream-duration', name: '实际音画流完整性', weight: 0, passed, detail: `计划${target.toFixed(3)}秒；${detail || '缺少音画流'}；逐流终点及音画尾差容差${tolerance}秒。` };
}

export async function inspectEvaluationStreamDuration(file: string, target: number): Promise<EvaluationCheck> {
  const ffprobe: string = createRequire(import.meta.url)('ffprobe-static').path;
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawnForJob(ffprobe, ['-v', 'error', '-show_packets', '-show_streams', '-show_entries', 'stream=index,codec_type:packet=stream_index,pts_time,duration_time', '-of', 'json', file]);
    let stdout = '', overflow = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 16 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); } });
    // Drain diagnostics without persisting paths or arbitrary media metadata.
    child.stderr?.resume();
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try { throwIfJobCancelled(); } catch (error) { reject(error); return; }
      if (code !== 0 || overflow) reject(new Error('无法读取成片实际音画packet时间，未通过完整性验收。'));
      else resolve(stdout);
    });
  });
  const probe = JSON.parse(raw) as PacketProbe;
  if (!Array.isArray(probe.streams) || !Array.isArray(probe.packets)) throw new Error('成片缺少可验证的实际音画packet时间。');
  return evaluationStreamDurationCheck(probe, target);
}
