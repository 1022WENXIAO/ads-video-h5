import { readFile, mkdir, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { EditPlan, MediaItem, RenderReview } from '../src/types';
import { probeVideo, runFFmpeg } from './core';
import { getModelConfig } from './modelRegistry';
import { dimensions, planHash } from './renderTimeline';
import { captionsFromTranscript, timelineOffsets } from './timeline';
import { loadEditingSkill } from './skills';
import { excludesBgm } from './intents';
import { inspectAudioLevels, inspectVoice, soundChecks, hasRejectedVoice } from './audioQuality';
import { newsFreshAtOriginalRequest } from './reviewResults';
import { newsRenderAcceptance } from './lessonAcceptance';
import { sampleVisualRetentionSources, pairedVisualRetentionMessages, VISUAL_RETENTION_FRAME_SCALE, type VisualRetentionSourceFrame } from './visualRetentionSources';
import { extractVisualRetentionRequirements, visualRetentionReviewInstruction, VisualRetentionReviewError } from './visualRetentionReview';
import { requestSemanticReview, semanticReviewProtocolDiagnostics, semanticReviewDispositionAttempts, SEMANTIC_EVIDENCE_REVIEW_INSTRUCTION } from './semanticReview';
import { reviewAudio } from './reviewAudio';
import type { ReviewAssetPublisher, ReviewRequestMetric } from './reviewAssets';
import { compactSpeech, lessonPadding } from './lessonSpec';
import { inspectLessonSpeechGaps, lessonPacingCheck } from './lessonAudio';
import type { AvatarRenderRecord } from './renderAvatar';
import { PNG } from 'pngjs';
import { opaqueFrameDifference, spriteFrames } from './avatarAssets';
import { createNewsPublicationCandidate, validateNewsPublicationProof } from './newsPublicationProof';
import { newsPublicationFrameEvidence } from './newsPublicationReview';
import { NUMERIC_VISUAL_REVIEW_INSTRUCTION } from './visualReviewEvidence';
import { reviewFrameSampling } from './reviewFrameSampling';

/** Plan references beside an actual sampled image, never an observation that
 * those captions or chapters were really visible/audible in the encoded file. */
export function reviewFrameCaptionContext(plan:EditPlan,time:number){
  if(!Number.isFinite(time)||time<0)throw new Error('实际审查抽帧时间无效。');
  const offsets=timelineOffsets(plan);
  const clips=plan.clips.flatMap((clip,index)=>{
    const start=offsets[index],end=start+clip.end-clip.start;
    const chapters=clip.sceneId?plan.lesson?.chapters.filter(chapter=>chapter.id===clip.sceneId)||[]:[];
    return Number.isFinite(start)&&Number.isFinite(end)&&time>=start&&time<end?[{
      clipIndex:index,sourceId:clip.sourceId,sceneId:clip.sceneId||null,
      chapterId:chapters.length===1?chapters[0].id:null,start,end,
    }]:[];
  });
  const entries=(plan.captions||[]).map((caption,index)=>({index,start:caption.start,end:caption.end,text:caption.text,style:caption.style}));
  const valid=entries.filter(c=>Number.isFinite(c.start)&&Number.isFinite(c.end)&&c.start>=0&&c.end>c.start&&typeof c.text==='string');
  const active=valid.filter(c=>c.start<=time&&time<c.end),previous=valid.filter(c=>c.end<=time).sort((a,b)=>b.end-a.end||b.index-a.index)[0]||null;
  const next=valid.filter(c=>c.start>time).sort((a,b)=>a.start-b.start||a.index-b.index)[0]||null;
  const invalidEntries=entries.length-valid.length;
  const status=!clips.length||invalidEntries?'unverified':active.length?'active':valid.length?'planned-gap':'no-caption-events';
  return {basis:'plan-reference-not-pixel-or-audio-proof',frameTime:time,clips,mixedChapterTransition:clips.length>1,
    captions:{status,active:active.slice(0,3),activeCount:active.length,previous,next,invalidEntries,
      gap:status==='planned-gap'?{start:previous?.end??0,end:next?.start??plan.targetSeconds}:null}};
}

type ReviewFrameImage={type:string;image_url?:{url:string};text?:string};
export function reviewFrameMessages(plan:EditPlan,outputs:Array<{time:number;image:ReviewFrameImage}>,sources?:Array<{frame:VisualRetentionSourceFrame;image:ReviewFrameImage}>):ReviewFrameImage[]{
  const parts=sources?pairedVisualRetentionMessages(outputs,sources):outputs.flatMap(({time,image})=>[{type:'text',text:`成片时间 ${time} 秒`},image]);
  // Preserve the original time label directly before its output image and
  // every same-clock source pair. Never attach output context to a source image.
  return parts.flatMap((part,index)=>{
    const output=outputs.find(o=>o.image===parts[index+1]);
    return output?[{type:'text',text:'本张真实成片抽帧的计划参照（不能代替像素或听辨）：'+JSON.stringify(reviewFrameCaptionContext(plan,output.time))},part]:[part];
  });
}

/** Keep the final response example consistent with this same request's
 * mandatory protocols. These values are placeholders, not review evidence. */
export function reviewJsonOutputExample(requirements:readonly {id:string;quote:string}[],newsCandidate?:{chapterId:string},firstFrameTime=0){
  return {score:0,findings:[] as string[],suggestions:['非阻塞改进建议'],needsRepair:true,
    ...(requirements.length?{visualRetentionChecks:requirements.map(({id,quote})=>({id,quote,status:'unverified',frameTimes:[],detail:'按本次实际帧填写观察结果，不照抄示例状态'}))}:{}),
    ...(newsCandidate?{newsPublication:{visible:false,chapterId:newsCandidate.chapterId,quote:'',frameTime:firstFrameTime}}:{})};
}

export async function reviewRender(file: string, plan: EditPlan, media: MediaItem[], prompt: string, publish?: ReviewAssetPublisher, requestedAt=Date.now()): Promise<RenderReview> {
  const sampledMovieSha256=plan.lesson?.hotResearch?createHash('sha256').update(await readFile(file)).digest('hex'):undefined;
  const checks: RenderReview['checks'] = [];
  const requests: ReviewRequestMetric[] = [];
  const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
  const probe = await probeVideo(file);
  add('实际时长', Math.abs(probe.duration - plan.targetSeconds) <= 0.25, `文件${probe.duration.toFixed(3)}秒，方案${plan.targetSeconds}秒`);
  const [width, height] = dimensions(plan);
  let info = ''; try { info = await runFFmpeg(['-hide_banner', '-i', file]); } catch (e) { info = e instanceof Error ? e.message : ''; }
  add('画幅与音轨', new RegExp(`\\b${width}x${height}\\b`).test(info) && probe.hasAudio, `预期${width}×${height}，${probe.hasAudio ? '有' : '无'}音轨`);
  const manifest = JSON.parse(await readFile(file.replace(/\.mp4$/, '.render.json'), 'utf8')) as { planHash: string; captions: number; overlays: number; motions?: EditPlan['motions']; avatars?:AvatarRenderRecord[]; drawingEngine?: string; bgm?:boolean; narration?:boolean; audioNormalization?:{mode:string} };
  if(excludesBgm(prompt))add('无背景音乐',manifest.bgm===false,'按实际渲染混音输入核对，未启用的音量参数不表示新增音轨');
  add('方案版本', manifest.planHash === planHash(plan), '渲染清单哈希与当前方案比对');
  if(plan.avatars?.length){
    add('作者形象资产与透明序列',plan.avatars.every((track,i)=>{
      const actual=manifest.avatars?.[i],sprite=media.find(m=>m.id===track.mediaId)?.character?.sprite;
      return Boolean(actual&&sprite&&actual.engine==='png-sequence/ffmpeg'&&actual.mediaId===track.mediaId&&actual.assetHash===track.assetHash&&actual.frameCount===sprite.frameCount&&new Set(actual.frameHashes).size>1&&actual.fps===track.fps&&actual.start===track.start&&actual.end===track.end&&actual.layout===track.layout&&JSON.stringify(actual.frameHashes)===JSON.stringify(sprite.frameHashes));
    }),'真实帧数、资产哈希、帧率、时间和布局与渲染记录比对');
    const record=manifest.avatars?.[0];
    if(record){
      const dir=path.join(path.dirname(file),`avatar-review-${randomUUID()}`);await mkdir(dir);
      try{
        const images:PNG[]=[];
        const count=Math.min(record.frameCount,8);
        for(let i=0;i<count;i++){
          const time=record.start+(i+.4)/record.fps;if(time>=record.end-.03)break;
          const frame=path.join(dir,`${i}.png`);
          await runFFmpeg(['-v','error','-y','-ss',String(time),'-i',file,'-frames:v','1','-vf',`crop=${record.width}:${record.height}:${record.x}:${record.y},scale=96:96`,frame],20000);
          images.push(PNG.sync.read(await readFile(frame)));
        }
        const differences=images.slice(1).map(img=>{let sum=0;for(let p=0;p<img.data.length;p++)if(p%4!==3)sum+=Math.abs(img.data[p]-images[0].data[p]);return sum/(img.width*img.height*3);});
        add('作者形象实际动画变化',differences.some(d=>d>.5),`形象区域连续抽取 ${images.length} 帧，最大像素变化 ${(Math.max(0,...differences)).toFixed(2)}；同时参与语义抽帧审查`);
        const source=media.find(m=>m.id===record.mediaId),sprite=source?.character?.sprite;
        if(!source||!sprite)throw new Error('形象资产不存在');
        const frames=spriteFrames(await readFile(path.join(path.dirname(path.dirname(file)),'media',source.id)),sprite);
        const coverage:number[]=[];
        for(const [i,time] of [record.start+.04,record.end-.08].entries()){
          const actualPath=path.join(dir,`coverage-${i}.png`),raw=path.join(dir,`expected-${i}.png`),expectedPath=path.join(dir,`scaled-${i}.png`);
          const index=Math.floor(Math.max(0,time-record.start)*record.fps)%frames.length;
          await writeFile(raw,frames[index]);
          await runFFmpeg(['-v','error','-y','-ss',String(time),'-i',file,'-frames:v','1','-vf',`crop=${record.width}:${record.height}:${record.x}:${record.y},scale=96:96:flags=lanczos`,actualPath],20000);
          await runFFmpeg(['-v','error','-y','-i',raw,'-frames:v','1','-vf','scale=96:96:flags=lanczos,format=rgba',expectedPath],20000);
          coverage.push(opaqueFrameDifference(PNG.sync.read(await readFile(expectedPath)),PNG.sync.read(await readFile(actualPath))));
        }
        add('作者形象首尾覆盖',coverage.every(d=>d<35),`与预期原帧的不透明区域对比，片头/片尾平均像素误差 ${coverage.map(d=>d.toFixed(2)).join(' / ')}，阈值35；不是身份认证`);
      }catch{add('作者形象检查完成度',false,'实际动画换帧或首尾覆盖检查未完成，不能视为通过');}
      finally{await rm(dir,{recursive:true,force:true});}
    }
  }
  if (plan.editorial) add('分镜证据与叙事', plan.clips.every((c,i) => {
    const s=plan.editorial!.scenes.find((s)=>s.id===c.sceneId);const source=media.find((m)=>m.id===c.sourceId)?.analysis;
    return Boolean(s && s.sourceHash===source?.sourceHash && s.reason && s.quote===source?.sentences.filter((v)=>c.sentenceIds?.includes(v.id)).map((v)=>v.text).join('') && plan.editorial!.script.beats[i]?.sceneId===c.sceneId);
  }), '原话、源时间码、选择理由、脚本顺序与实际方案比对');
  if (plan.motions?.length) add('绘制动效合成', manifest.drawingEngine==='GSAP/HyperFrames' && JSON.stringify(manifest.motions)===JSON.stringify(plan.motions), `实际合成${manifest.motions?.length||0}段GSAP透明绘制层，关键时刻参与抽帧审查`);
  const wantsCaptions = (Boolean(plan.lesson)||/字幕|subtitle|caption/i.test(prompt)) && !/不要.{0,8}字幕|去掉字幕|关闭字幕|no captions|without subtitles/i.test(prompt);
  add('字幕执行', !wantsCaptions || manifest.captions > 0, `实际渲染指令包含${manifest.captions}条字幕，${manifest.overlays}条叠字`);
  const noEmphasis = /不要.{0,6}(?:叠字|覆盖层|关键词)|去掉.{0,6}(?:叠字|覆盖层|关键词)/.test(prompt);
  const wantsEmphasis = /叠字|覆盖层|关键词/.test(prompt) && !noEmphasis;
  const quotedEmphasis = /(?:叠字|关键词|覆盖层)[：:\s]*[“「"]([^”」"]+)[”」"]/.exec(prompt)?.[1];
  add('覆盖层执行', !wantsEmphasis || Boolean(manifest.overlays > 0 && (!quotedEmphasis || plan.overlays?.some((o) => o.text.includes(quotedEmphasis)))), quotedEmphasis ? `要求叠字「${quotedEmphasis}」，渲染${manifest.overlays}条` : `渲染${manifest.overlays}条叠字`);
  if (quotedEmphasis && /覆盖.{0,6}(?:对比|比较)(?:段落)?/.test(prompt)) {
    const offsets = timelineOffsets(plan);
    const spans = plan.clips.flatMap((c,i) => {
      if (c.purpose !== 'comparison') return [];
      const selected = media.find((m) => m.id === c.sourceId)?.analysis?.sentences.filter((s) => c.sentenceIds?.includes(s.id)) || [];
      return selected.length ? [{start: offsets[i]+selected[0].start-c.start,end: offsets[i]+selected.at(-1)!.end-c.start}] : [];
    });
    add('对比关键词覆盖', spans.length > 0 && spans.every((s) => plan.overlays?.some((o) => o.text.includes(quotedEmphasis) && o.start <= s.start + 0.03 && o.end >= s.end - 0.03)), '关键词事件须覆盖所有标为comparison的完整原句');
  }
  const wantsZoom = /推镜|缩放|zoom/i.test(prompt) && !/不要.{0,6}(?:推镜|缩放)|no zoom/i.test(prompt);
  add('推镜执行', !wantsZoom || plan.clips.some((c) => (c.zoom || 1) > 1), '检查渲染方案的逐片段缩放');
  const wantsFade = /淡入淡出|叠化|crossfade/i.test(prompt) && !/不要.{0,6}(?:淡入淡出|叠化)/.test(prompt);
  add('转场执行', !wantsFade || plan.clips.length < 2 || plan.clips.some((c) => c.transition?.kind === 'fade'), '检查实际渲染方案的入场叠化');
  add('响度归一化执行', !(plan.audio?.normalize||/响度|音量均衡|音量统一|normalize/i.test(prompt)) || manifest.audioNormalization?.mode==='segment-two-pass+mix-two-pass', manifest.audioNormalization?.mode==='segment-two-pass+mix-two-pass'?'渲染记录包含逐段和混音两遍测量/处理参数，仍须实测输出一致性':'未取得逐段两遍处理记录，不能只凭normalize配置判定通过');
  const expected = captionsFromTranscript(plan, media);
  if(plan.lesson){
    const r=plan.lesson;
    const tolerance=r.explicitDuration?Math.max(2,r.requestedSeconds*.05):Math.max(10,r.requestedSeconds*.15);
    add('教学目标时长',Math.abs(probe.duration-r.requestedSeconds)<=tolerance,`目标${r.requestedSeconds}秒，实际${probe.duration.toFixed(3)}秒`);
    if(r.pacing){
      const characters=plan.clips.reduce((n,c)=>n+compactSpeech(media.find(m=>m.id===c.sourceId)?.analysis?.transcript||'').length,0);
      const actual=lessonPacingCheck(characters,probe.duration-lessonPadding(plan.clips.length,r.pacing),r.pacing);
      add('旁白语速执行',Boolean(r.voice?.charactersPerSecond)&&actual.passed,actual.detail+' 根据实际编码时长和分镜转写核对。');
      try{const gaps=await inspectLessonSpeechGaps(file,r.pacing.maxPauseSeconds);add('旁白停顿节奏',gaps.length===0,`停顿上限${r.pacing.maxPauseSeconds}秒；实际超限区间${JSON.stringify(gaps)}`);}catch{add('旁白停顿节奏',false,'实际成片停顿测量失败，不能视为节奏通过');}
    }
    add('教学事实与来源',Boolean(r.factReview&&!r.factReview.needsRepair&&r.factReview.score>=80)&&r.chapters.every(c=>c.claims.length>0&&c.claims.every(cl=>(cl.basis==='calculation'?Boolean(cl.explanation):cl.referenceIds.length>0)&&cl.referenceIds.every(id=>r.references.some(ref=>ref.id===id&&['search-cited','public-page','primary-page','primary-record','primary-paper','news-page'].includes(ref.verification))))),`独立脚本事实审查${r.factReview?.score??'未完成'}/100；文献事实核对来源，数学定义与课堂演算独立核算`);
    if(r.hotResearch)add('热点来源与时效',newsFreshAtOriginalRequest(r,requestedAt),`资料截止${r.hotResearch.asOf}；新闻窗口${r.hotResearch.windowHours}小时；检查发布日期与真实正文，榜单热度不能替代事实`);
    add('教学HTML分镜执行',r.chapters.length>0&&r.chapters.every((c,i)=>{const m=media.find(m=>m.id===c.mediaId),g=m?.generation;return Boolean(c.id===plan.clips[i]?.sceneId&&g?.workflowId===r.workflowId&&g.htmlHash===c.htmlHash&&g.audioHash===c.audioHash&&g.referenceHash===r.voice?.anchorHash);}),`实际${r.chapters.length}段HTML/GSAP分镜；核对画面、声音哈希及统一参考`);
    add('教学旁白与动画时间码',r.chapters.every(c=>(c.speechMatch??0)>=.86&&c.cues?.length===c.visual.items.length&&c.cues.every(q=>q.start>=0&&q.end>q.start&&q.end<(c.duration??0))), '字幕和重点动画来自生成音频的真实转写匹配，未用计划文案替代转写');
    add('教学概念递进',r.chapters.every((c,i)=>i===0||c.prerequisites.length>0&&c.prerequisites.every(id=>r.chapters.slice(0,i).some(p=>p.id===id))),'后章前置知识指向先前章节；实际讲解效果另经音频与图解审查');
  }
  if(plan.reconstruction){
    const r=plan.reconstruction;
    add('用户目标时长',Math.abs(probe.duration-r.requestedSeconds)<=2,`用户${r.requestedSeconds}秒，实际${probe.duration.toFixed(3)}秒；不能通过修改方案目标绕过`);
    add('原声与新增分镜来源',r.beats.every((b,i)=>b.mediaId===plan.clips[i]?.sourceId&&b.id===plan.clips[i]?.sceneId&&Boolean(b.mode==='original'?b.evidence?.quote===b.line:media.find(m=>m.id===b.mediaId)?.generation?.referenceHash===r.voiceReference?.audioHash)), '原话有真实源时间码，新增台词有用户声音参考与媒体哈希');
    add('联网补充引用',r.beats.filter(b=>b.mode==='generated').every(b=>b.referenceIds.length>0&&b.referenceIds.every(id=>r.references.some(ref=>ref.id===id&&ref.verification==='search-cited'))), '引用来自实际联网搜索；引用关联不代表全文事实核查');
    const htmlBeats=r.beats.filter(b=>b.visual==='html');
    add('HTML分镜执行',htmlBeats.length>0&&htmlBeats.every(b=>Boolean(b.htmlHash&&media.find(m=>m.id===b.mediaId)?.generation?.htmlHash===b.htmlHash&&plan.clips.some(c=>c.sceneId===b.id&&c.sourceId===b.mediaId))), `实际${htmlBeats.length}段HTML；逐镜核对HTML哈希、生成媒体与成片时间线，零段不能视为通过`);
  }
  const compact = (text: string) => text.replace(/[\s，。！？、；：,.!?;:]/g, '');
  add('字幕原话', !wantsCaptions || (expected.length > 0 && compact(expected.map((s) => s.text).join('')) === compact((plan.captions || []).map((s) => s.text).join(''))), wantsCaptions ? '字幕与选中原声逐字稿比对' : '本次未要求字幕');
  add('字幕时间映射', !wantsCaptions || (expected.length === plan.captions?.length && expected.every((s, i) => Math.abs(s.start - plan.captions![i].start) < 0.03 && Math.abs(s.end - plan.captions![i].end) < 0.03)), '字幕时间与源字词到成片的映射比对，源时间仍为模型估计');
  add('完整句子', !plan.fineCut || plan.clips.every((clip) => {
    const analysis = media.find((m) => m.id === clip.sourceId)?.analysis;
    if (!analysis?.sentences.length) return true;
    return Boolean(clip.sentenceIds?.length && clip.sentenceIds.every((id) => analysis.sentences.some((s) => s.id === id && s.complete && s.start >= clip.start - 0.03 && s.end <= clip.end + 0.03)));
  }), '精剪片段必须覆盖所选完整原句');
  const loudnessLog = await runFFmpeg(['-hide_banner', '-nostats', '-i', file, '-vn', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
  const loudnessMatch = /\{\s*"input_i"[\s\S]*?\}/.exec(loudnessLog);
  const loudness = loudnessMatch ? JSON.parse(loudnessMatch[0]) as { input_i: string; input_tp: string } : undefined;
  const originalSpeech = plan.clips.some((c) => media.find((m) => m.id === c.sourceId)?.analysis?.sentences.length);
  add('人声响度', !originalSpeech || Boolean(loudness && Number(loudness.input_i) >= -30 && Number(loudness.input_tp) <= 0), loudness ? `综合响度${loudness.input_i} LUFS，峰值${loudness.input_tp} dBTP` : '无法测得响度');
  const limitations = ['源字词时间码为模型估计，未做独立强制对齐。'];
  let audio:RenderReview['audio'];
  if(originalSpeech||plan.reconstruction||/音色|声音|人声|音量|voice/i.test(prompt)){
    try {audio=await inspectAudioLevels(file,plan);audio.userReportedMismatch=hasRejectedVoice(plan,media,prompt);checks.push(...soundChecks(audio));}
    catch {add('声音实测完成度',false,'逐段音量实测失败，不能视为声音一致性通过');}
  }
  if(plan.reconstruction)limitations.push(...plan.reconstruction.limitations);
  if(plan.lesson)limitations.push(...plan.lesson.limitations);
  let semantic: RenderReview['semantic'];
  const visualRetentionRequirements=extractVisualRetentionRequirements(prompt);
  const newsCandidate=plan.lesson?.hotResearch?createNewsPublicationCandidate(plan,media,requestedAt):undefined;
  let newsPublication:RenderReview['newsPublication'];
  let newsDateDetail='ch1：缺少与已核验来源、实际HTML和分镜绑定的报道日期标注。';
  let newsSourceMatches=false;
  if(newsCandidate)try{
    const sourceFile=path.join(path.dirname(path.dirname(file)),'media',newsCandidate.sourceId);
    newsSourceMatches=createHash('sha256').update(await readFile(sourceFile)).digest('hex')===newsCandidate.sourceHash;
    newsDateDetail=newsSourceMatches?`${newsCandidate.chapterId}：抽帧中未确认可读的“${newsCandidate.label}”，只修复日期画面并保留已核验旁白。`:`${newsCandidate.chapterId}：实际分镜文件与报道日期证据哈希不符。`;
  }catch{newsDateDetail=`${newsCandidate?.chapterId||'ch1'}：无法读取实际日期分镜文件，不能只凭元数据通过。`;}
  const config = await getModelConfig('understanding');
  if (!config) {limitations.push('未配置音频理解模型，未进行成片音频和抽帧语义审查。');if(audio)add('声音审听完成度',false,'未配置模型，音色一致性未经审听');}
  else {
    const temp = path.join(path.dirname(file), `review-${randomUUID()}`); await mkdir(temp);
    try {
      if(audio){
        let referenceFile:string|undefined;const r=plan.reconstruction?.voiceReference;
        if(r){const source=media.find(m=>m.id===r.sourceId);const candidate=path.join(path.dirname(path.dirname(file)),'media',r.sourceId);
          if(source?.analysis?.sourceHash===r.sourceHash)try{await access(candidate);if(createHash('sha256').update(await readFile(candidate)).digest('hex')===r.sourceHash)referenceFile=candidate;}catch{}
        }
        try {
          audio.voice=await inspectVoice(file,plan,referenceFile,temp,config,publish,metric=>requests.push(metric));
          const generatedIds=plan.reconstruction?.beats.filter(b=>b.mode==='generated').map(b=>b.id)||[];
          const concern=audio.userReportedMismatch?'用户已明确指出音色不似；仍使用被拒绝的合成音频，模型判断不能覆盖该反馈，需重新生成对应声音。':'';
          if(generatedIds.length)add('参考音色相似度',!audio.userReportedMismatch&&Boolean(referenceFile)&&audio.voice.segments.filter(s=>generatedIds.includes(s.id)).every(s=>s.status==='passed'),`${concern}${referenceFile?'实际原声参考对照':'没有可验证的原声参考'}；模型辅助结果：${audio.voice.segments.filter(s=>generatedIds.includes(s.id)).map(s=>`${s.id}[${s.status}] ${s.detail}`).join('；')}`);
          add('段落音色一致性',!audio.userReportedMismatch&&audio.voice.consistency.status==='passed',`${concern}${audio.voice.consistency.status}：${audio.voice.consistency.detail}；定性听辨，不是声纹认证`);
        }catch(error){add('声音审听完成度',false,`音色对照审听重试后未完成：${error instanceof Error?error.message:'请求失败'}；不能因相同参考哈希或音量统一默认通过`);}
        limitations.push(plan.lesson?'教学旁白为合成声音；音色一致性由模型对实际分段做定性听辨，非声纹认证。':'音色由模型对真实参考音与成片分段做定性听辨，非声纹身份认证；听辨串匹配音量，实际响度以未改动的成片测量为准。');
      }
      const audition = await reviewAudio(file, path.join(temp, 'audio.mp3'), publish);
      const outputFrames: Array<{time:number;image:{ type: string; image_url?: { url: string }; text?: string }}> = [];
      const offsets=timelineOffsets(plan);
      const sampling=reviewFrameSampling(plan,media),times=sampling.times;
      limitations.push(...sampling.limitations);
      for (const time of times) {
        const image = path.join(temp, `${time}.jpg`);
        await runFFmpeg(['-v', 'error', '-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-vf', plan.lesson?'scale=960:-2':visualRetentionRequirements.length?VISUAL_RETENTION_FRAME_SCALE:'scale=540:-2', image]);
        outputFrames.push({time,image:{ type: 'image_url', image_url: { url: publish ? await publish(image, 'image/jpeg') : `data:image/jpeg;base64,${(await readFile(image)).toString('base64')}` } }});
      }
      const retentionSources=visualRetentionRequirements.length&&plan.editorial?await sampleVisualRetentionSources(file,plan,media,temp,times):undefined;
      const sourceFrames:Array<{frame:VisualRetentionSourceFrame;image:{type:string;image_url:{url:string}}}>=[];
      for(const source of retentionSources?.frames||[]){
        sourceFrames.push({frame:source,image:{type:'image_url',image_url:{url:publish?await publish(source.image,'image/jpeg'):`data:image/jpeg;base64,${(await readFile(source.image)).toString('base64')}`}}});
      }
      const frames=reviewFrameMessages(plan,outputFrames,retentionSources?sourceFrames:undefined);
      if(retentionSources)limitations.push('视觉保留审查同次请求使用最多2段原素材各4张真实对照帧，实际源SHA、同刻映射和末尾见证：'+JSON.stringify(retentionSources.frames.map(({image,...evidence})=>evidence))+(retentionSources.truncated?'；未覆盖源/片段：'+JSON.stringify(retentionSources.uncoveredClips)+'，不能声称已完整覆盖。':'；有界抽样不证明全源视频已完整观看。'));
      const sourceInstruction=(retentionSources?'实际原素材仅供对照已有画面内容，不是成片证据。实际选入源范围：'+JSON.stringify(retentionSources.selectedRanges)+'；mappedOutputTime与sourceTime明确绑定的原帧紧随其真实同刻成片帧，方向或形态变化只在同一对图中比较；末尾见证没有同刻成片对应，只能支持选片覆盖观察，不能拿异时帧推断箭头变向。必须核对所要求的已有画面是否真正进入成片，不得把原源帧当作成片已保留。'+(retentionSources.truncated?'未观察到的源/片段保持未验证：'+JSON.stringify(retentionSources.uncoveredClips):''):'')+(plan.lesson?' 取样时点的计划依据（不是动画、字幕可见或实际音频正确的证明）：'+JSON.stringify(sampling.coverage)+'；取样限制：'+JSON.stringify(sampling.limitations):'');
      const result = await requestSemanticReview(config, [{ role: 'system', content: (await loadEditingSkill('qingjian-render-review'))+(plan.lesson&&!plan.lesson.hotResearch?'\n'+await loadEditingSkill('qingjian-teaching-video'):'')+(plan.lesson?.hotResearch?'\n'+newsRenderAcceptance(prompt,requestedAt):'')+SEMANTIC_EVIDENCE_REVIEW_INSTRUCTION }, { role: 'user', content: [
        { type: 'input_audio', input_audio: audition }, ...frames,
        { type: 'text', text: `这是成片的完整音频以及${times.length}张标有时间的抽帧，含各分镜和绘制动画早期/稳定阶段。用户要求：${prompt}。${plan.lesson?.hotResearch?"本片是简短新闻图解，按新闻快讯核验版本、日期、不确定性和播报节奏；不要求课堂式定义、推导或完整编年史。收尾可以用核心结论与行动提醒，不必逐条重复前文全部案例；可选背景与更丰富镜头放入suggestions，真实错读、错数、不可读图解、用户明确要求的音乐缺失仍为缺陷。":""}实际混音输入：${JSON.stringify({original:true,bgm:manifest.bgm,narration:manifest.narration})}；只有实际输入为true才表示有该音轨，未启用的音量参数不意味着加了音乐或配音。实际方案：${JSON.stringify(plan)}。${plan.avatars?.length?"作者形象为独立透明序列帧，严查是否显示整张网格、透明背景是否破坏、人物是否遮挡主图解或字幕、身份是否前后稳定；状态动画不需要同步口型。":""}真实剪切边界(成片秒)：${JSON.stringify(timelineOffsets(plan).slice(1))}。音频剪切只发生在这些边界附近；位于一个连续源片段内部的字幕短语切换不是硬切。原素材的口误或停顿可单独评价，不能捏造成新增剪切。${plan.lesson?.hotResearch?'本片是从新闻主题制作的图解短片，全部旁白为同一合成声音。逐章核对实际发音、数字与版本、新闻日期、字幕拼写和图解的对象及因果；用来源与实际音视频定位缺陷。图解可以是面向普通观众的明确示意，不要求课堂定义或数学推导。':plan.lesson?'这是从主题制作的教学视频，全部旁白为同一合成声音。每条实际缺陷必须注明对应章节ID（如ch7）及具体修复要求；全局问题标明global，避免返修漏掉其他章节。仅实际听到的残句、错读、不可读图解或核心概念错误要求返修；额外推导或可选背景建议不能当作错误。检查定义、公式与参数、数值例子、曲线坐标、年代、任务差异、前置概念和应用是否讲清楚；图解应解释概念，不能只重复字幕。所有章节已完整渲染，早期抽帧未出现后续节点不等于最终遗漏。检查教学节奏和朗读英文字母的准确性。':'原声与新增分镜已按mode标记；新增台词是获授权的参考声音合成，不是源录音。审查图形能否解释因果、SOP与知识库而非只重复字幕；示意成果标注示意，不能当作实测。注意合成音色与原音差异。'}${NUMERIC_VISUAL_REVIEW_INSTRUCTION}${visualRetentionReviewInstruction(visualRetentionRequirements)}${sourceInstruction}所选源原话：${JSON.stringify(expected)}。用户原始指令才是必须满足的风格约束。不能把程序绘制推断成必须黑白、无彩色或不允许装饰；未遮挡内容、未与明确风格冲突的配色和装饰偏好属于suggestions。每张成片图前的章节和字幕事件仅为真实方案参照，不是像素识字或声音核验结果；计划active或gap都不能代替实际所见所听。字幕时序、停留或漏显的finding必须注明本次实际抽帧秒数、对应章节、逐字可见字幕（无字幕就明确写无字幕）和证据能支持的范围，不能从单帧扩成该章全程或全片。处于两条计划字幕之间的短暂空隙、下一条尚未开始或抽样未确认，本身不能证明遗漏、旧字幕停留或音画脱节；若像素或实际听辨确实与计划不同仍须如实报告，不按计划自动通过。字幕遗漏须核对实际画面和完整音频，不能仅凭ASR或方案中的参考文案断言真实漏字；若只是不同抽帧的短语切换，或无法听清是否漏字，说明不确定性，不能编造精确听辨结论。只据真实音频和这些抽帧评审，无法观察的部分不要编造。评分必须严格：80分表示可发布但有改进空间，90分以上须接近专业成片。不要只罗列优点。保留原声不代表必须保留重录残句，选句中缺少谓语的半句或重复同一观点需要返修。检查标签是否拥挤、孤字换行、仅重复字幕，以及明显的近远景突跳。严审观点、论据、结论，跳句是否导致逻辑断裂，动效标签是否有信息用途、是否遮脸/字幕。输出JSON（下列仅为完整字段结构示例，评分、状态及观察占位值不可照抄；按实际证据填写，保留原始评分）：${JSON.stringify(reviewJsonOutputExample(visualRetentionRequirements,newsCandidate,times[0]))}。findings只列尚存且需返修的实际缺陷；没有实际缺陷时必须返回空数组[]，核验通过、正常动效或无错字等肯定观察应省略，不能填入缺陷列表。真实缺陷仍必须逐条注明章节、实际证据和修复要求，不能为了空列表而隐瞒。findings和suggestions须区分：更多历史节点、额外推导、镜头创意等可选扩展放入suggestions，实际错读、漏字、不可读画面或核心概念错误放入findings。needsRepair只用于实际缺陷或低于80分；任何实际缺陷仍必须返修，不得把错误降为建议。细微标点、语气词差异不判错；抽帧不能证明完整观看。字幕按短语分行，单帧不显示下一行不等于遗漏或硬切原音。只有听到原话被截断或实际漏字才能报告。抽帧无法验证完整推镜或每处转场，应记为未验证，不能凭此判失败。不要给未经音频核实的精确词时间码。${newsCandidate?` 另须返回newsPublication:{visible:boolean,chapterId:string,quote:string,frameTime:number}：只据本次首章真实抽帧读取报道日期。chapterId应为${newsCandidate.chapterId}，frameTime必须是上述实际抽帧秒数；quote逐字抄录可读的“报道日期”行，仅含该日期及北京时间标记，不含其他示意说明。期望来源标记为“${newsCandidate.label}”，但不能从方案或期望文字推定画面可见。没有清楚看到、不可读、被遮挡或日期不符时visible=false并如实填写实际所见；不自报哈希、HTML检查或证明通过。`:""}` },
      ] }],metric=>requests.push(metric),Boolean(newsCandidate),{frameTimes:times,visualRetentionRequirements,visualRetentionSources:retentionSources,chapters:plan.clips.map((clip,index)=>({id:clip.sceneId||plan.lesson?.chapters[index]?.id||clip.sourceId,start:offsets[index],end:offsets[index]+clip.end-clip.start}))});
      if(result.dispositionAttempts.length)limitations.push('语义审查模型原始处置（原分和flag保留，不等同验收结果）：'+JSON.stringify(result.dispositionAttempts));
      if(result.retentionAttempts?.length)limitations.push('原始视觉保留逐项评分及模型抽帧观察保留为审计，未提分：'+JSON.stringify(result.retentionAttempts));
      if(result.protocolDiagnostics?.length)limitations.push('语义审查协议阶段诊断（不含模型正文）：'+JSON.stringify(result.protocolDiagnostics));
      if(result.numericVisualChecks?.length)limitations.push('数字图解为模型对本次绑定抽帧的观测，不是机器直接像素计数：'+JSON.stringify(result.numericVisualChecks));
      if(result.evidenceAttempts?.length)limitations.push('原始自相同拼写指控及评分保留为审查诊断，未提升原分：'+JSON.stringify(result.evidenceAttempts));
      semantic = { ...(result.visualRetentionChecks?{visualRetentionChecks:result.visualRetentionChecks}:{}),score: result.score, findings: result.findings.slice(0, 10).map((f) => f.slice(0, 500)),suggestions:result.suggestions.slice(0,10).map(f=>f.slice(0,500)) };
      if(newsCandidate&&newsSourceMatches){
        const first=plan.clips[0];
        const frameEvidence=newsPublicationFrameEvidence(result.newsPublication,newsCandidate,times,{start:offsets[0],end:offsets[0]+first.end-first.start});
        if(frameEvidence){
          const proof={...newsCandidate,frameVerified:true as const,frameEvidence,renderedSha256:createHash('sha256').update(await readFile(file)).digest('hex')};
          const failures=proof.renderedSha256!==sampledMovieSha256?['实际成片在抽帧审查期间改变，不能把旧抽帧证据绑定到新文件。']:validateNewsPublicationProof(plan,media,proof,proof.renderedSha256,requestedAt);
          if(!failures.length)newsPublication=proof;
          else newsDateDetail=`${newsCandidate.chapterId}：${failures.join('；')}`;
        }
      }
      add('成片语义审查', !result.needsRepair && result.score >= 80, result.findings.join('；').slice(0, 1200) || (result.needsRepair||result.score<80?'模型原始评分未达标或审查结论未确认；保留原分，需要复核，不能视为通过。':`完整音频和${times.length}张抽帧未发现需返修的问题`));
      limitations.push(`语义审查覆盖完整音频和${times.length}张关键抽帧，未逐帧审阅整片。`);
    } catch (error) {
      const dispositions=semanticReviewDispositionAttempts(error);
      if(dispositions?.length)limitations.push('语义审查中断前模型原始处置（原分和flag保留，未自动通过）：'+JSON.stringify(dispositions));
      if(error instanceof VisualRetentionReviewError&&error.attempts)limitations.push('视觉保留协议原始评分与失败记录：'+JSON.stringify(error.attempts));
      const protocolDiagnostics=semanticReviewProtocolDiagnostics(error);
      if(protocolDiagnostics?.length)limitations.push('语义审查协议阶段诊断（不含模型正文）：'+JSON.stringify(protocolDiagnostics));
      limitations.push(`成片语义审查未完成（${error instanceof Error ? (/^HTTP \d+$/.test(error.message) ? error.message : error.name) : '模型或网络错误'}），需要人工复核。`);
      const reason = error instanceof Error && (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message)) ? '审查服务请求超时' : error instanceof Error && /^HTTP \d+$/.test(error.message) ? `审查服务${error.message}` : '审查服务未返回有效结果';
      add('成片语义审查', false, `${reason}，未完成，不能视为通过`);
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  if(newsCandidate&&newsSourceMatches&&!semantic)newsDateDetail=`${newsCandidate.chapterId}：报道日期实际抽帧审查未完成，保留现有成片重试审查，不能推定画面缺失或重新合成媒体。`;
  if(plan.lesson?.hotResearch)add('新闻报道日期可见',Boolean(newsPublication),newsPublication?`${newsPublication.chapterId}：真实HTML可见检查及成片${newsPublication.frameEvidence.frameTime}秒抽帧确认“${newsPublication.frameEvidence.quote}”；已绑定来源、分镜、方案及成片哈希。`:newsDateDetail);
  const score = semantic ? Math.round(Math.min(semantic.score, checks.filter((c)=>c.passed).length/checks.length*100)) : 0;
  const review: RenderReview = { status: checks.every((c) => c.passed) && Boolean(semantic) ? 'passed' : 'needs-review', score, checks, semantic, audio, ...(newsPublication?{newsPublication}:{}), transport:{mode:publish?'hosted':'inline',requests}, limitations, createdAt: new Date().toISOString() };
  await writeFile(file.replace(/\.mp4$/, '.review.json'), JSON.stringify(review, null, 2), { mode: 0o600 });
  return review;
}
