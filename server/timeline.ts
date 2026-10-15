import type { EditPlan, MediaItem, TimelineText } from '../src/types';
import { excludesBgm } from './intents';
import { createHash } from 'node:crypto';
import { validateLesson } from './lessonSpec';
import { validateAvatarTracks } from './avatarAssets';

export function timelineOffsets(plan: EditPlan): number[] {
  let position = 0;
  return plan.clips.map((clip, index) => {
    if (index > 0 && clip.transition?.kind === 'fade') position -= clip.transition.duration;
    const start = position; position += clip.end - clip.start; return start;
  });
}
export function timelineDuration(plan: EditPlan): number {
  const offsets = timelineOffsets(plan); const last = plan.clips.at(-1)!;
  return +(offsets.at(-1)! + last.end - last.start).toFixed(3);
}
export function captionsFromTranscript(plan: EditPlan, media: MediaItem[], style: TimelineText['style'] = 'subtitle'): TimelineText[] {
  const offsets = timelineOffsets(plan); const captions: TimelineText[] = [];
  const sourceCaptionOwners=new Map<TimelineText,{clip:number;sentence:NonNullable<MediaItem['analysis']>['sentences'][number]|undefined;last:NonNullable<MediaItem['analysis']>['sentences'][number]['words'][number]}>();
  plan.clips.forEach((clip, index) => {
    const analysis = media.find((m) => m.id === clip.sourceId)?.analysis;
    const allWords = analysis?.sentences.flatMap((s) => s.words) || [];
    const wordOwners=new Map(analysis?.sentences.flatMap(sentence=>sentence.words.map(word=>[word,sentence] as const)));
    const wordIndices=new Map(allWords.map((word,i)=>[word,i]));
    const breakWords = new Set(analysis?.captionBreaks?.map((i) => allWords[i]));
    const words = allWords.filter((w) => w.start >= clip.start - 0.03 && w.end <= clip.end + 0.03);
    const safeEnds=new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(words.map((w)=>w.text).join(''))].map((s)=>s.index+s.segment.length));
    if(plan.lesson){
      const joined=words.map(w=>w.text).join('');
      // Protect heard quantities within verified clauses. A provider's visual
      // line break must not turn 六十九亿美元 into 六 / 十九亿美元; distinct
      // spoken clauses such as 六；十九美元 must remain distinct.
      let clause='',clauseStart=0;const clauses:Array<{text:string;start:number}>=[];
      for(const word of words){clause+=word.text;if(analysis?.captionBoundarySource==='matched-clauses'&&breakWords.has(word)){clauses.push({text:clause,start:clauseStart});clauseStart+=clause.length;clause='';}}if(clause)clauses.push({text:clause,start:clauseStart});
      const quantities=clauses.flatMap(({text,start})=>[...text.matchAll(/(?:百分之)?[\d零〇一二三四五六七八九十百千万亿两]+(?:[点.][\d零〇一二三四五六七八九]+)?(?:[万亿]?(?:美元|人民币|欧元|港元|元)|个百分点|%|％|GB|MB|TB|毫秒|秒|分钟|小时|天|日|年|台|家|次|个|人)/gi)].map(m=>({start:start+m.index!,end:start+m.index!+m[0].length})));
      const terms=['德尔塔','西格玛','伽马','贝塔','铰链损失','交叉熵','均方误差','易样本','难样本','简单样本','相似关系','残差','正在训练','正确类别概率','合页','灰度测试','灰度','负责人','正式发布','游戏手柄','InfoNCE','Focal Loss',...(joined.match(/[零〇一二三四五六七八九]+点[零〇一二三四五六七八九]+/g)||[]),...(joined.match(/(?<![A-Za-z\d零〇一二三四五六七八九十])[1-9一二三四五六七八九]G(?![A-Za-z\d])/g)||[])];
      for(const term of terms){let start=joined.indexOf(term);while(start>=0){for(let k=start+1;k<start+term.length;k++)safeEnds.delete(k);safeEnds.add(start+term.length);start=joined.indexOf(term,start+term.length);}}
      // A verified sentence end separates adjacent numbers ("损失零；零点五").
      // Protecting a decimal in concatenated ASR must not erase that boundary.
      if(analysis?.captionBoundarySource==='matched-clauses'){let end=0;for(const word of words){end+=word.text.length;if(breakWords.has(word))safeEnds.add(end);}}
      for(const span of quantities){for(let k=span.start+1;k<span.end;k++)safeEnds.delete(k);safeEnds.add(span.end);}
    }
    let position=0;let pendingBreak=false;
    let text = ''; let start = 0; let end = 0;let firstWord:typeof words[number]|undefined;let lastWord:typeof words[number]|undefined;let previousEndedClause=true;
    const flush = () => {
      if (text){
        const caption={ start: +(offsets[index] + start - clip.start).toFixed(3), end: +(offsets[index] + end - clip.start).toFixed(3), text, style, animation:'none' as const },prior=captions.at(-1);
        const owner=prior&&sourceCaptionOwners.get(prior),sentence=firstWord&&wordOwners.get(firstWord);
        // A provider's display break may leave a grammatical particle alone.
        // Join display blocks only inside one actual source sentence/clip and
        // across adjacent word owners sharing a time boundary. This preserves
        // every heard word/time and does not repair source completeness flags.
        const mergeSourceSuffix=!plan.lesson&&/^[的地得了着过吗呢吧]$/.test(text)&&prior&&owner&&firstWord&&lastWord&&sentence
          &&owner.clip===index&&owner.sentence===sentence&&wordOwners.get(lastWord)===sentence
          &&wordIndices.get(firstWord)===wordIndices.get(owner.last)!+1
          &&Math.abs(firstWord.start-owner.last.end)<=.03
          &&[...prior.text+text].reduce((width,char)=>width+(/[\u0000-\u007f]/.test(char)?.5:1),0)<=18
          &&caption.end-prior.start<=3;
        if(mergeSourceSuffix&&lastWord){prior.text+=text;prior.end=caption.end;owner.last=lastWord;}
        else if(plan.lesson&&text.length<=2&&!previousEndedClause&&prior&&prior.start>=offsets[index]&&prior.text.length+text.length<=26&&caption.end-prior.start<=6&&caption.start-prior.end<=.6){prior.text+=text;prior.end=caption.end;}
        else {captions.push(caption);if(!plan.lesson&&lastWord)sourceCaptionOwners.set(caption,{clip:index,sentence,last:lastWord});}
        previousEndedClause=Boolean(lastWord&&breakWords.has(lastWord));
      }
      text = '';firstWord=undefined;lastWord=undefined;
    };
    for (const w of words) {
      if (text && (text.length + w.text.length > 40 || (plan.lesson&&w.start-end>0.5&&safeEnds.has(position)) || (!analysis?.captionBreaks && (text.length + w.text.length > 18 || w.end - start > 3 || w.start - end > 0.5)))) {flush();pendingBreak=false;}
      if (!text) {start = w.start;firstWord=w;}
      text += w.text; end = w.end;lastWord=w;
      position+=w.text.length;pendingBreak ||= breakWords.has(w)||Boolean(plan.lesson&&(text.length>=18||w.end-start>=3));
      if (pendingBreak&&safeEnds.has(position)) {flush();pendingBreak=false;}
    }
    flush();
  });
  return captions;
}

export function validateTimeline(plan: EditPlan, media: MediaItem[]): EditPlan {
  const clips = plan.clips.map((clip, index) => {
    const zoom = clip.zoom ?? 1; const volume = clip.volume ?? 1;
    if (!Number.isFinite(zoom) || zoom < 1 || zoom > 1.15 || !Number.isFinite(volume) || volume < 0 || volume > 2) throw new Error('缩放需为1–1.15，片段音量需为0–2。');
    const transition = clip.transition;
    if (transition && (!['cut', 'fade'].includes(transition.kind) || !Number.isFinite(transition.duration) || transition.duration < 0 || transition.duration > 0.5 || (transition.kind === 'fade' && (index === 0 || transition.duration < 0.05 || transition.duration > Math.min(clip.end - clip.start, plan.clips[index - 1].end - plan.clips[index - 1].start) / 2)))) throw new Error(`第${index + 1}个片段转场类型或时长无效：${index === 0 ? '第一片段没有前一镜头，请使用cut/0；' : ''}叠化需为0.05–0.5秒且不得超过相邻片段的一半。`);
    if (clip.purpose && !['hook', 'argument', 'conclusion', 'context', 'comparison'].includes(clip.purpose)) throw new Error('片段叙事用途无效。');
    const source = media.find((m) => m.id === clip.sourceId)!;
    const selected = clip.sentenceIds?.map((id) => source.analysis?.sentences.find((s) => s.id === id));
    if (clip.sentenceIds && (!selected?.length || selected.some((s) => !s))) throw new Error('剪辑方案句子ID无效。');
    if (plan.fineCut && source.analysis?.status === 'ready' && source.analysis.sentences.length) {
      if (!selected?.length || selected.some((s) => !s?.complete)) throw new Error('口播精剪只能选择已分析的完整句子。');
      const first = selected[0]!; const last = selected.at(-1)!;
      if (clip.start > first.start + 0.03 || clip.start < first.start - 0.35 || clip.end < last.end - 0.03 || clip.end > last.end + 0.35 || selected.some((s, i) => i > 0 && s!.start < selected[i - 1]!.end - 0.03)) throw new Error('口播精剪剪点应位于完整句子外缘，不得截断或重排字词。');
      const inRange = source.analysis.sentences.filter((s) => s.end > clip.start + 0.03 && s.start < clip.end - 0.03);
      if (inRange.some((s) => !s.complete || !clip.sentenceIds!.includes(s.id))) throw new Error('口播精剪片段包含未选中的半句，请拆分为独立片段。');
    }
    return { ...clip, zoom, volume };
  });
  const candidate = { ...plan, clips };
  const duration = timelineDuration(candidate);
  candidate.avatars = validateAvatarTracks(plan.avatars, { ...candidate, targetSeconds: duration }, media);
  if(plan.lesson){
    const lesson=validateLesson(plan.lesson,`教学视频 ${plan.lesson.requestedSeconds}秒 ${plan.lesson.format}`,plan.lesson.pacing);
    if(lesson.chapters.length!==clips.length||lesson.format!==plan.format||duration>600.05||!lesson.factReview||lesson.factReview.needsRepair||!lesson.voice?.anchorHash)throw new Error('教学方案的章节、事实审查、画幅或统一声音参考无效。');
    for(const [i,ch] of lesson.chapters.entries()){
      const c=clips[i],m=media.find(m=>m.id===c.sourceId),g=m?.generation;
      const lineHash=createHash('sha256').update(ch.narration).digest('hex');
      if(c.sceneId!==ch.id||c.sourceId!==ch.mediaId||!g||g.workflowId!==lesson.workflowId||g.beatId!==ch.id||g.mode!=='generated'||g.lineHash!==lineHash||!ch.htmlHash||g.htmlHash!==ch.htmlHash||!ch.audioHash||g.audioHash!==ch.audioHash||g.referenceHash!==lesson.voice.anchorHash||c.start!==0||Math.abs(c.end-(m?.duration||0))>.03)throw new Error('教学HTML、旁白或分镜时间范围与生成记录不一致。');
      if(!ch.speechMatch||ch.speechMatch<.86||ch.cues?.length!==ch.visual.items.length||!m?.analysis?.sentences.length)throw new Error('教学旁白缺少实际转写、匹配或动画时间码。');
    }
  }
  if (plan.motions) {
    if (plan.motions.length > 16 || plan.motions.some((m) => !Number.isFinite(m.start) || !Number.isFinite(m.end) || m.start < 0 || m.end - m.start < 1 || m.end > duration + 0.03 || !['underline','circle','arrow','steps'].includes(m.kind) || !['top','bottom'].includes(m.zone) || !m.label.trim() || m.label.length > 20 || !plan.clips.some((c) => c.sceneId === m.sceneId))) throw new Error('绘制动效的分镜、时长或标签无效。');
  }
  if (plan.editorial) {
    const report = plan.editorial;
    if (report.script.beats.length !== clips.length || clips.some((c,i) => report.script.beats[i].sceneId !== c.sceneId)) throw new Error('叙事脚本与时间线分镜顺序不一致。');
    for (const clip of clips) {
      const scene = report.scenes.find((s) => s.id === clip.sceneId);
      const analysis = media.find((m) => m.id === clip.sourceId)?.analysis;
      const selected = analysis?.sentences.filter((s) => clip.sentenceIds?.includes(s.id)) || [];
      if (!scene || scene.sourceId !== clip.sourceId || scene.sourceHash !== analysis?.sourceHash || scene.quote !== selected.map((s) => s.text).join('') || scene.start !== selected[0]?.start || scene.end !== selected.at(-1)?.end || !scene.reason.trim()) throw new Error('分镜原话、源时间码或选句依据与素材不一致。');
    }
  }
  if(plan.reconstruction){
    const r=plan.reconstruction;
    if(r.beats.length!==clips.length||!r.beats.some(b=>b.mode==='original'))throw new Error('重构脚本与镜头数不一致或未复用原话。');
    for(const [i,b] of r.beats.entries()){
      const c=clips[i],m=media.find(m=>m.id===c.sourceId);
      if(c.sceneId!==b.id||c.sourceId!==b.mediaId||!b.reason||b.referenceIds.some(id=>!r.references.some(ref=>ref.id===id)))throw new Error('重构分镜顺序、媒体或引用无效。');
      if(b.mode==='original'){
        const e=b.evidence,a=media.find(m=>m.id===e?.sourceId)?.analysis;const selected=a?.sentences.filter(s=>e?.sentenceIds.includes(s.id))||[];
        if(!e||e.quote!==b.line||e.sourceHash!==a?.sourceHash||selected.map(s=>s.text).join('')!==e.quote||selected.some(s=>!s.complete)||e.start!==selected[0]?.start||e.end!==selected.at(-1)?.end)throw new Error('重构原话证据与原始素材不一致。');
        if(b.visual==='person'&&(c.sourceId!==e.sourceId||c.start>e.start+.03||c.end<e.end-.03))throw new Error('重构原声镜头截断原话。');
        if(b.visual==='html'&&(m?.generation?.originalSourceId!==e.sourceId||m.generation.originalStart!==e.start||m.generation.originalEnd!==e.end))throw new Error('HTML原声音轨缺少真实出处。');
      }
      if(b.visual==='html'){
        const g=m?.generation;const hash=createHash('sha256').update(b.line).digest('hex');
        if(!g||g.workflowId!==r.workflowId||g.beatId!==b.id||g.mode!==b.mode||g.lineHash!==hash||g.htmlHash!==b.htmlHash||g.audioHash!==b.audioHash||c.start!==0||Math.abs(c.end-(m?.duration||0))>.03)throw new Error('HTML分镜生成哈希或完整音轨范围无效。');
        if(b.mode==='generated'&&(!b.referenceIds.length||g.referenceHash!==r.voiceReference?.audioHash))throw new Error('新增台词缺少联网证据或用户声音参考。');
      }
    }
  }
  function validateTexts(items: TimelineText[] | undefined, caption: boolean): TimelineText[] | undefined {
    if (items === undefined) return undefined;
    if (!Array.isArray(items) || items.length > (caption ? 200 : 30)) throw new Error('字幕或覆盖层数量无效。');
    return items.map((item, index) => {
      if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end <= item.start || item.end > duration + 0.05 || typeof item.text !== 'string' || !item.text.trim() || item.text.length > (caption ? 40 : 60) || !['subtitle', 'keyword', 'title', 'lower-third'].includes(item.style) || (caption && item.style !== 'subtitle') || (item.animation && !['none', 'pop', 'rise', 'underline'].includes(item.animation))) throw new Error(`${caption ? '字幕' : '覆盖层'}第${index + 1}条的时间、文字或样式无效。起止必须在成片0–${duration.toFixed(3)}秒内，文字1–${caption ? 40 : 60}字；${caption ? '字幕style只能为subtitle' : '覆盖层style仅支持subtitle、keyword、title、lower-third'}，animation仅支持none、pop、rise、underline。`);
      return { ...item, end: Math.min(item.end, duration), text: item.text.trim() };
    });
  }
  const audio = plan.audio || { originalVolume: 1, bgmVolume: 0.12, narrationVolume: 1, normalize: false };
  if (![audio.originalVolume, audio.bgmVolume, audio.narrationVolume].every((n) => Number.isFinite(n) && n >= 0 && n <= 2) || typeof audio.normalize !== 'boolean') throw new Error('音轨音量或响度设置无效。');
  return { ...candidate, targetSeconds: +duration.toFixed(3), captions: validateTexts(plan.captions, true), overlays: validateTexts(plan.overlays, false), audio };
}

export function applyTimelineRequest(plan: EditPlan, prompt: string, media: MediaItem[]): EditPlan {
  const next = structuredClone(plan);
  if (next.fineCut) next.clips.forEach((clip, index) => {
    if (index === 0 || clip.transition?.kind !== 'fade') return;
    const gap = (side: typeof clip, leading: boolean) => {
      const source = media.find((m) => m.id === side.sourceId);
      const sentences = source?.analysis?.sentences || [];
      const chosen = sentences.filter((s) => side.sentenceIds?.includes(s.id));
      if (!chosen.length) return 0.35;
      const first = chosen[0], last = chosen.at(-1)!;
      return leading ? first.start - (sentences.filter((s) => s.end <= first.start).at(-1)?.end || 0) : (sentences.find((s) => s.start >= last.end && !chosen.includes(s))?.start ?? source!.duration!) - last.end;
    };
    const safe = Math.min(0.35, gap(next.clips[index - 1], false), gap(clip, true), clip.transition.duration);
    clip.transition = safe >= 0.05 ? { kind: 'fade', duration: +safe.toFixed(3) } : { kind: 'cut', duration: 0 };
  });
  // Crossfade within surrounding silence instead of fading two spoken words
  // into each other. Never borrow padding from an adjacent spoken sentence.
  next.clips.forEach((clip, index) => {
    if (!next.fineCut) return;
    const source = media.find((m) => m.id === clip.sourceId);
    const sentences = source?.analysis?.sentences || [];
    const chosen = sentences.filter((s) => clip.sentenceIds?.includes(s.id));
    if (!chosen.length) return;
    const first = chosen[0], last = chosen.at(-1)!;
    const incoming = index > 0 && clip.transition?.kind === 'fade' ? clip.transition.duration : 0;
    const outgoing = next.clips[index + 1]?.transition?.kind === 'fade' ? next.clips[index + 1].transition!.duration : 0;
    const prior = sentences.filter((s) => s.end <= first.start).at(-1)?.end || 0;
    const following = sentences.find((s) => s.start >= last.end && !chosen.includes(s))?.start ?? source!.duration!;
    if (incoming > Math.min(0.35, first.start - prior) + 0.03 || outgoing > Math.min(0.35, following - last.end) + 0.03) throw new Error('叠化附近没有足够的原声间隙，请减短转场或使用直切，不能淡化或重叠完整原话。');
    const nearbyQuiet = source?.analysis?.pauses.find((p) => p.start >= last.end - 0.35 && p.start <= last.end + 0.35 && p.end > last.end);
    const tail = nearbyQuiet ? Math.max(0.06, nearbyQuiet.start + 0.06 - last.end) : 0.15;
    clip.start = +Math.max(prior, 0, Math.min(clip.start, first.start - Math.max(incoming, 0.1))).toFixed(3);
    clip.end = +Math.min(following, source!.duration!, last.end + 0.35, Math.max(clip.end, last.end + Math.max(outgoing, tail))).toFixed(3);
  });
  if (/关键词|叠字/.test(prompt) && /覆盖.{0,6}(?:对比|比较)(?:段落)?/.test(prompt)) {
    const comparison = next.clips.findIndex((c) => c.purpose === 'comparison');
    if (comparison >= 0) {
      const clip = next.clips[comparison]; const offset = timelineOffsets(next)[comparison];
      const selected = media.find((m) => m.id === clip.sourceId)?.analysis?.sentences.filter((s) => clip.sentenceIds?.includes(s.id)) || [];
      const quoted = /(?:叠字|关键词)[：:\s]*[“「"]([^”」"]+)[”」"]/.exec(prompt)?.[1];
      if (selected.length && quoted) {
        const overlay = next.overlays?.find((o) => o.text.includes(quoted));
        if (overlay) { overlay.start = +(offset + selected[0].start - clip.start).toFixed(3); overlay.end = +(offset + selected.at(-1)!.end - clip.start).toFixed(3); }
      }
    }
  }
  if (/不要.{0,8}字幕|去掉字幕|关闭字幕|without subtitles|no captions/i.test(prompt)) next.captions = [];
  else if (/字幕|caption|subtitle/i.test(prompt) || (next.fineCut && next.captions?.length)) {
    next.captions = captionsFromTranscript(next, media);
    if (!next.captions.length) throw new Error('字幕需要有效的音频逐字稿，请先分析原声素材。');
  }
  if (/保留原(?:声|音)|不要.{0,8}(?:配音|旁白)|original audio/i.test(prompt)) next.audio = { ...(next.audio || { bgmVolume: 0.12, narrationVolume: 1, normalize: false }), originalVolume: 1 };
  if (/响度|音量均衡|音量统一|normalize/i.test(prompt)) next.audio = { ...(next.audio || { originalVolume: 1, bgmVolume: 0.12, narrationVolume: 1 }), normalize: true };
  if (excludesBgm(prompt)) next.audio = { ...(next.audio || { originalVolume:1,narrationVolume:1,normalize:false }), bgmVolume:0 };
  const validated = validateTimeline(next, media);
  const requested = /(?:约|大约|控制在|改成|改为|剪成|时长)?\s*(\d+(?:\.\d+)?)\s*(?:秒|seconds?|sec)/i.exec(prompt);
  if (requested) {
    const target = Number(requested[1]);
    if (target > 0 && target <= 60 && Math.abs(validated.targetSeconds - target) > (validated.fineCut ? Math.max(2, target * 0.1) : 0.5)) throw new Error(`剪辑方案时长${validated.targetSeconds}秒不符合用户要求${target}秒，请重新选择片段。`);
  }
  return validated;
}
