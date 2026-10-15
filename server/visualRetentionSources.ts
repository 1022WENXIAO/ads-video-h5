import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan, MediaItem } from '../shared/types';
import { MAX_MEDIA_UPLOAD_BYTES } from '../shared/uploadLimits';
import { runFFmpeg } from './core';
import { throwIfJobCancelled } from './jobExecution';
import { timelineOffsets } from './timeline';
export const VISUAL_RETENTION_FRAME_SCALE='scale=960:960:force_original_aspect_ratio=decrease';
export interface VisualRetentionSourceFrame { sourceId:string; sourceName:string; sourceHash:string; sourceTime:number; image:string; purpose?:'mapped'|'tail'|'overview';mappedOutputTime?:number;clipIndex?:number }
export interface VisualRetentionSourceSamples { frames:VisualRetentionSourceFrame[]; selectedRanges:Array<{sourceId:string;start:number;end:number}>; truncated:boolean;uncoveredClips?:Array<{sourceId:string;clipIndex:number;reason:'source-budget'|'mapped-frame-budget'|'no-unmixed-review-frame'}> }
type SourceSample=Pick<VisualRetentionSourceFrame,'sourceTime'|'purpose'|'mappedOutputTime'|'clipIndex'>;

/** Only actual, already sampled final-frame times can authorize a paired
 * source timestamp. A fade belongs to two sources and is not a clean pair. */
export function mappedVisualRetentionSamples(plan:EditPlan,sourceId:string,duration:number,frameTimes:readonly number[]):{samples:SourceSample[];uncoveredClips:NonNullable<VisualRetentionSourceSamples['uncoveredClips']>}{
  if(!frameTimes.length||frameTimes.length>32||frameTimes.some(t=>!Number.isFinite(t)||t<0)||new Set(frameTimes).size!==frameTimes.length)throw new Error('视觉保留同刻对照必须使用本次有界且唯一的真实成片抽帧时间。');
  const offsets=timelineOffsets(plan),ends=plan.clips.map((c,i)=>offsets[i]+c.end-c.start);
  if(offsets.some(t=>!Number.isFinite(t))||plan.clips.some(c=>!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<=c.start)||frameTimes.some(t=>t>=ends.at(-1)!))throw new Error('视觉保留同刻对照的实际选片范围或成片时间无效。');
  const uniqueClip=new Map<number,number>();
  for(const time of frameTimes){const active=plan.clips.flatMap((_,i)=>time>=offsets[i]&&time<ends[i]?[i]:[]);if(active.length===1)uniqueClip.set(time,active[0]);}
  const clips=plan.clips.flatMap((clip,index)=>clip.sourceId===sourceId?[{clip,index}]:[]),uncoveredClips:NonNullable<VisualRetentionSourceSamples['uncoveredClips']>=[];
  const eligible:Array<{index:number;times:number[]}>=[];
  for(const {clip,index}of clips){
    if(clip.end>duration+.001)throw new Error('视觉保留同刻对照选片超过实际登记源时长。');
    const stableStart=offsets[index]+(clip.transition?.kind==='fade'?clip.transition.duration:0),stableEnd=plan.clips[index+1]?.transition?.kind==='fade'?offsets[index+1]:ends[index];
    // Final output is 30 fps. Seeking just before a cut can return its next
    // frame; one-frame clearance also excludes the edge of each mixed fade.
    const times=frameTimes.filter(t=>uniqueClip.get(t)===index&&t>stableStart+.04&&t<stableEnd-.04).sort((a,b)=>Math.abs(a-(stableStart+stableEnd)/2)-Math.abs(b-(stableStart+stableEnd)/2)||a-b);
    if(!times.length)uncoveredClips.push({sourceId,clipIndex:index,reason:'no-unmixed-review-frame'});
    else if(eligible.length>=3)uncoveredClips.push({sourceId,clipIndex:index,reason:'mapped-frame-budget'});
    else eligible.push({index,times});
  }
  const chosen=eligible.map(c=>({index:c.index,time:c.times[0]}));
  while(chosen.length<3){const remaining=eligible.flatMap(c=>c.times.filter(time=>!chosen.some(p=>p.time===time)).map(time=>({index:c.index,time}))).sort((a,b)=>Math.min(...chosen.map(p=>Math.abs(b.time-p.time)))-Math.min(...chosen.map(p=>Math.abs(a.time-p.time)))||a.time-b.time);if(!remaining.length)break;chosen.push(remaining[0]);}
  const samples:SourceSample[]=chosen.sort((a,b)=>a.time-b.time).map(({index,time})=>({purpose:'mapped',clipIndex:index,mappedOutputTime:time,sourceTime:+(plan.clips[index].start+time-offsets[index]).toFixed(6)}));
  samples.push({purpose:'tail',sourceTime:+Math.max(0,Math.min(duration-.02,duration*.98)).toFixed(3)});
  return{samples,uncoveredClips};
}

interface ReviewImage {type:string;image_url?:{url:string};text?:string}
/** Insert each source image immediately after its existing matching output
 * image, never duplicating output images or presenting a tail as a pair. */
export function pairedVisualRetentionMessages(outputs:Array<{time:number;image:ReviewImage}>,sources:Array<{frame:VisualRetentionSourceFrame;image:ReviewImage}>):ReviewImage[]{
  const times=outputs.map(o=>o.time);
  if(new Set(times).size!==times.length)throw new Error('视觉保留成片抽帧身份重复，不能绑定同刻对照。');
  for(const {frame}of sources)if(frame.mappedOutputTime!==undefined&&(frame.purpose!=='mapped'||!Number.isInteger(frame.clipIndex)||!times.includes(frame.mappedOutputTime)))throw new Error('视觉保留同刻源帧未绑定本次真实成片抽帧。');
  const sourceParts=({frame,image}:typeof sources[number]):ReviewImage[]=>[{type:'text',text:frame.purpose==='mapped'?`同刻原素材对照 sourceId=${frame.sourceId}；源时间 sourceTime=${frame.sourceTime} 秒；对应上方成片 mappedOutputTime=${frame.mappedOutputTime} 秒；clipIndex=${frame.clipIndex}。这是原素材帧，不是成片帧，不得把 sourceTime 填入成片 frameTimes；方向或形态只能与这一对同刻图比较。`:`原素材末尾/背景见证 sourceId=${frame.sourceId}；源时间 sourceTime=${frame.sourceTime} 秒；没有对应的成片同刻帧。不是成片，不得用此时间填成片 frameTimes，不能用异时见证判断成片改变了箭头方向。`},image];
  return[...outputs.flatMap(o=>[{type:'text',text:`成片时间 ${o.time} 秒`},o.image,...sources.filter(s=>s.frame.mappedOutputTime===o.time).flatMap(sourceParts)]),...sources.filter(s=>s.frame.mappedOutputTime===undefined).flatMap(sourceParts)];
}
const hashFile=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file)) {throwIfJobCancelled();hash.update(chunk);}return hash.digest('hex');};
/** At most eight actual original-source images, not a full original-video scan.
 * Source images never enter the final-frame evidence namespace. */
export async function sampleVisualRetentionSources(movie:string,plan:EditPlan,media:MediaItem[],temp:string,actualReviewTimes?:readonly number[]):Promise<VisualRetentionSourceSamples>{
  throwIfJobCancelled();
  const ids=[...new Set(plan.clips.map(clip=>clip.sourceId))];
  const candidates=ids.map(id=>media.find(m=>m.id===id)).filter((m):m is MediaItem=>Boolean(m?.kind==='video'));
  if(!candidates.length)throw new Error('视觉保留审查缺少可读取的原素材。');
  if(actualReviewTimes&&ids.some(id=>{const matches=media.filter(m=>m.id===id);return matches.length!==1||matches[0].kind!=='video';}))throw new Error('视觉保留同刻对照原视频未唯一登记，不能推定来源身份。');
  const root=await realpath(path.join(path.dirname(path.dirname(movie)),'media')),frames:VisualRetentionSourceFrame[]=[],uncoveredClips:NonNullable<VisualRetentionSourceSamples['uncoveredClips']>=[];
  for(const [index,source] of candidates.slice(0,2).entries()){
    throwIfJobCancelled();
    if(!/^[A-Za-z0-9_-]{1,120}$/.test(source.id)||!Number.isFinite(source.duration)||!source.duration||source.duration<0)throw new Error('视觉保留审查原素材标识或实际时长无效。');
    const file=await realpath(path.join(root,source.id)),meta=await stat(file);
    if(!file.startsWith(root+path.sep)||!meta.isFile()||meta.size<=0||meta.size>MAX_MEDIA_UPLOAD_BYTES)throw new Error('视觉保留审查原素材路径或大小越界。');
    const before=await hashFile(file);
    if(!source.analysis?.sourceHash||!/^[a-f0-9]{64}$/.test(source.analysis.sourceHash)||source.analysis.sourceHash!==before)throw new Error('视觉保留审查原素材与已分析字节不符。');
    const mapped=actualReviewTimes?mappedVisualRetentionSamples(plan,source.id,source.duration,actualReviewTimes):undefined;
    if(mapped)uncoveredClips.push(...mapped.uncoveredClips);
    const samples:SourceSample[]=mapped?.samples||[.2,.5,.8,.98].map((ratio,i)=>({purpose:i===3?'tail':'overview',sourceTime:+Math.max(0,Math.min(source.duration!-.02,source.duration!*ratio)).toFixed(3)}));
    for(const [i,sample] of samples.entries()){
      throwIfJobCancelled();
      const {sourceTime}=sample,image=path.join(temp,`retention-source-${index}-${i}.jpg`);
      await runFFmpeg(['-v','error','-y','-ss',String(sourceTime),'-i',file,'-frames:v','1','-vf',VISUAL_RETENTION_FRAME_SCALE,image],30_000);
      throwIfJobCancelled();
      const imageMeta=await stat(image);if(!imageMeta.size||imageMeta.size>2*1024*1024)throw new Error('视觉保留审查原素材抽帧未形成有界有效图像。');
      frames.push({sourceId:source.id,sourceName:source.name,sourceHash:before,...sample,image});
    }
    if(await hashFile(file)!==before)throw new Error('视觉保留审查期间原素材改变，不能绑定旧抽帧。');
  }
  if(actualReviewTimes)for(const [clipIndex,clip]of plan.clips.entries())if(candidates.slice(2).some(source=>source.id===clip.sourceId))uncoveredClips.push({sourceId:clip.sourceId,clipIndex,reason:'source-budget'});
  return {frames,selectedRanges:plan.clips.map(({sourceId,start,end})=>({sourceId,start,end})),truncated:candidates.length>2||uncoveredClips.length>0,...(actualReviewTimes?{uncoveredClips}:{})};
}
