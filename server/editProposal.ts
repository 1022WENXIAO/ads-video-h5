import type { EditPlan } from '../shared/types';
import { timelineDuration } from './timeline';

/** An incoming transition has no predecessor on clip zero; it is a direct cut. */
export function normalizeEditProposal(plan: EditPlan): { plan: EditPlan; repairs: string[] } {
  const next = structuredClone(plan), repairs: string[] = [];
  if (next.clips?.[0]?.transition?.kind === 'fade') {
    next.clips[0].transition = { kind: 'cut', duration: 0 };
    repairs.push('首片段没有前一个镜头，入场叠化已按直切处理。');
  }
  return { plan: next, repairs };
}

/** Return simultaneous timing problems so the model can repair one coherent edit. */
export function editProposalTimingFeedback(plan: EditPlan, prompt: string): string[] {
  if (!Array.isArray(plan.clips) || !plan.clips.length || plan.clips.some(clip => !Number.isFinite(clip.start) || !Number.isFinite(clip.end) || clip.end <= clip.start)) return [];
  const duration = timelineDuration(plan);
  if (!Number.isFinite(duration)) return [];
  const failures: string[] = [];
  const requested = /(?:约|大约|控制在|改成|改为|剪成|时长)?\s*(\d+(?:\.\d+)?)\s*(?:秒|seconds?|sec)/i.exec(prompt);
  const target = requested ? Number(requested[1]) : undefined;
  // Quiet padding added later can extend a short candidate, but cannot make an
  // overlong selection shorter. Whole-sentence and final duration checks remain.
  if (target && target <= 60 && duration > target + (plan.fineCut ? Math.max(2, target * .1) : .5)) failures.push(`剪辑方案时长${duration.toFixed(3)}秒超过用户要求${target}秒。请减少所选完整句子，不能保留全部逐字稿、截断句子或修改目标。当前各片段时长：${plan.clips.map((clip, index) => `第${index + 1}段${(clip.end - clip.start).toFixed(2)}秒`).join('、')}。`);
  for (const [kind, rows] of [['字幕', plan.captions], ['覆盖层', plan.overlays]] as const) {
    if (!Array.isArray(rows)) continue;
    for (const [index, row] of rows.entries()) if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < 0 || row.end <= row.start || row.end > duration + .05) failures.push(`${kind}第${index + 1}条“${String(row.text).slice(0, 28)}”时间${row.start}–${row.end}秒无效；当前成片时间线是0–${duration.toFixed(3)}秒。时间必须按最终片段顺序和叠化重新计算，不能沿用源视频时间或删片前的旧轴。`);
  }
  return failures;
}
