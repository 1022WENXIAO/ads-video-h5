import type { EditPlan, MediaItem, SelectedScene } from '../shared/types';
import { timelineDuration } from './timeline';

/** Explicit full-frame requests disable added zoom in both automatic and
 * manually submitted arrangements. Ordinary framing defaults are unchanged. */
export function editFrameZoom(proposed:number,prompt:string):number {
  const originalFrame=prompt.split(/[，,。！？；;\n]/).some(clause=>/(?:按|以|保持|保留|画面)?原比例完整(?:地)?(?:放|呈现|展示)/.test(clause)&&!/(?:不要|不用|不必|无需|别|禁止|勿)[^，,。！？；;\n]{0,8}原比例完整/.test(clause));
  if(originalFrame)return 1;
  return /画面完整|完整画面|(?:不要|别|不|禁止|勿|无需)(?:再|进行)?裁(?:剪|切)?(?:(?:视频|原)?画面|镜头)?(?=[，。！？；;\s]|$)|\b(?:no|without)\s+crop(?:ping)?\b|\b(?:do not|don't)\s+crop\b|\bkeep\s+(?:the\s+)?(?:entire|full)\s+frame\b/i.test(prompt)?1:proposed;
}

export function editAudioNormalization(prompt: string): boolean {
  const disabled = /(?:不要|不做|禁止|关闭|禁用|取消|无需|不用|不进行|不应用)[^，,。！？；;\n]{0,12}(?:响度(?:归一化|处理|均衡|统一)?|音量(?:归一化|平衡|均衡|统一|处理|调整)?|动态(?:处理|压缩|均衡)|压缩(?:器|人声|音频)?(?!视频|画面|图片|图像|文件)|限幅)|(?:保留|保持)[^，,。！？；;\n]{0,8}(?:原始|原有|未经处理的)(?:响度|音量|动态)|(?:no|without|disable|do not|don't)\s+(?:audio\s+)?(?:normaliz\w*|loudness\s+(?:normaliz\w*|process\w*)|dynamic\s+(?:compress\w*|process\w*)|compress\w*)/i;
  return !prompt.split(/[，,。！？；;\n]/).some(clause => !/(?:不要|不能|勿|别)(?:关闭|禁用|取消|停止)[^，,。！？；;\n]{0,8}(?:响度|音量|归一化|动态处理)/.test(clause) && disabled.test(clause));
}

export function applyEditAudioPolicy(plan: EditPlan, prompt: string): EditPlan {
  return { ...plan, audio: { originalVolume: 1, bgmVolume: .12, narrationVolume: 1, ...plan.audio, normalize: editAudioNormalization(prompt) } };
}

/** An incoming transition has no predecessor on clip zero; it is a direct cut. */
export function normalizeEditProposal(plan: EditPlan, prompt = ''): { plan: EditPlan; repairs: string[] } {
  const next = applyEditAudioPolicy(structuredClone(plan), prompt), repairs: string[] = [];
  if (next.clips?.[0]?.transition?.kind === 'fade') {
    next.clips[0].transition = { kind: 'cut', duration: 0 };
    repairs.push('首片段没有前一个镜头，入场叠化已按直切处理。');
  }
  if (plan.audio?.normalize === false && next.audio!.normalize) repairs.push('用户未禁止响度处理，已启用逐段与混音响度归一化；保留原话、原声音色与原有音轨。');
  if (plan.audio?.normalize !== false && !next.audio!.normalize) repairs.push('按用户明确要求关闭响度与动态处理。');
  return { plan: next, repairs };
}

/** Preserve ASR facts, while requiring an editorially coherent conclusion. */
export function editProposalNarrativeFeedback(plan: EditPlan, media: MediaItem[]): string[] {
  const clip = plan.clips?.at(-1), source = media.find(item => item.id === clip?.sourceId);
  if (!clip?.sentenceIds?.length || source?.analysis?.status !== 'ready') return [];
  const sentences = source.analysis.sentences, last = sentences.filter(sentence => clip.sentenceIds!.includes(sentence.id)).at(-1);
  if (!last || !/(?:结论|因此|所以|表明|说明|结果|总之)/.test(last.text)) return [];
  const following = sentences.find(sentence => sentence.start >= last.end - .03 && sentence.id !== last.id);
  if (!following || following.start - last.end > 1.2 || !/^(?:[，。；、\s]*(?:但|不过|然而|暂时|前提|仅|只在|尚|不能|不代表|并不|仍|需要|须|如果|除非|没有))/.test(following.text)) return [];
  if (plan.clips.some(selected => selected.sourceId === clip.sourceId && selected.sentenceIds?.includes(following.id))) return [];
  return [`结尾选句“${last.text}”之后紧随必要的限制或前提“${following.text}”（句子ID：${following.id}）。当前句在ASR中完整，但单独作为成片结尾会丢失论证边界；请完整保留这组结论与限制，或重新选择有完整收束的原句，同时删减其他重复内容满足时长，不得修改ASR完整性或截断原话。`];
}

/** Bounded arithmetic assistance; the model still owns meaning and ordering. */
export function editSentenceBudgetHint(plan: EditPlan, prompt: string, media: MediaItem[], validate: (candidate: EditPlan) => EditPlan, verifiedGroups?:SelectedScene[]): string {
  const requested = /(?:约|大约|控制在|改成|改为|剪成|时长)?\s*(\d+(?:\.\d+)?)\s*(?:秒|seconds?|sec)/i.exec(prompt), target = Number(requested?.[1]);
  if (!plan.fineCut || !target || target > 60) return '';
  const sourceIds = new Set(plan.clips.map(clip => clip.sourceId));
  const pool = (verifiedGroups?verifiedGroups.flatMap(group=>{
    const source=media.find(item=>item.id===group.sourceId),sentences=group.sentenceIds.map(id=>source?.analysis?.sentences.find(sentence=>sentence.id===id));
    if(!sourceIds.has(group.sourceId)||source?.analysis?.status!=='ready'||source.analysis.sourceHash!==group.sourceHash||!sentences.length||sentences.some(sentence=>!sentence?.complete)||group.start!==sentences[0]!.start||group.end!==sentences.at(-1)!.end||group.quote!==sentences.map(sentence=>sentence!.text).join(''))return [];
    return [{source,start:group.start,end:group.end,sentenceIds:group.sentenceIds}];
  }):media.filter(source => sourceIds.has(source.id) && source.analysis?.status === 'ready').flatMap(source => source.analysis!.sentences.filter(sentence => sentence.complete).map(sentence => ({ source, start:sentence.start,end:sentence.end,sentenceIds:[sentence.id] })))).slice(0, 18);
  if (!pool.length || sourceIds.size > 5) return '';
  const options: Array<{ plan: EditPlan; distance: number }> = []; let visited = 0, checked = 0;
  function search(from: number, selected: typeof pool, seconds: number) {
    if (++visited > 5000 || checked >= 240) return;
    if (selected.length >= sourceIds.size && seconds >= target - 3 && seconds <= target + 1 && new Set(selected.map(row => row.source.id)).size === sourceIds.size) {
      checked++;
      const candidate: EditPlan = { format: plan.format, summary: '仅用于实际完整句时长预算核算，语义由模型选定', targetSeconds: 0, fineCut: true, audio: plan.audio, clips: selected.map(({ source,start,end,sentenceIds }, index) => ({ sourceId: source.id, start, end, sentenceIds, purpose: index === 0 ? 'hook' : index === selected.length - 1 ? 'conclusion' : 'argument', transition: { kind: 'cut', duration: 0 } })) };
      if (!editProposalNarrativeFeedback(candidate, media).length) try {
        const actual = validate(candidate), distance = Math.abs(actual.targetSeconds - target);
        // Leave encoding/padding margin; prefer the center of the allowed band.
        if (distance <= Math.min(1, target * .05)) options.push({ plan: actual, distance });
      } catch { /* Never suggest an unvalidated selection. */ }
    }
    if (selected.length >= 5 || seconds > target + 1) return;
    for (let index = from; index < pool.length; index++) search(index + 1, [...selected, pool[index]], seconds + pool[index].end - pool[index].start);
  }
  search(0, [], 0);
  options.sort((a, b) => a.distance - b.distance || a.plan.clips.length - b.plan.clips.length);
  if (!options.length) return '';
  return '实际源时间、完整句、间隙padding及最终校验已验算的候选（仅时间可行，仍须你核对语义并选择叙事顺序；不要原样堆砌）：\n' + options.slice(0, 2).map(({ plan: candidate }, index) => `${index + 1}. ${candidate.targetSeconds}秒；` + candidate.clips.map(clip => clip.sentenceIds!.join('+')).join(' → ')).join('\n');
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
