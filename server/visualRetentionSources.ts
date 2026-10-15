import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { EditPlan, MediaItem } from '../shared/types';
import { MAX_MEDIA_UPLOAD_BYTES } from '../shared/uploadLimits';
import { runFFmpeg } from './core';
import { throwIfJobCancelled } from './jobExecution';
export interface VisualRetentionSourceFrame { sourceId:string; sourceName:string; sourceHash:string; sourceTime:number; image:string }
export interface VisualRetentionSourceSamples { frames:VisualRetentionSourceFrame[]; selectedRanges:Array<{sourceId:string;start:number;end:number}>; truncated:boolean }
const hashFile=async(file:string)=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file)) {throwIfJobCancelled();hash.update(chunk);}return hash.digest('hex');};
/** At most eight actual original-source images, not a full original-video scan.
 * Source images never enter the final-frame evidence namespace. */
export async function sampleVisualRetentionSources(movie:string,plan:EditPlan,media:MediaItem[],temp:string):Promise<VisualRetentionSourceSamples>{
  throwIfJobCancelled();
  const ids=[...new Set(plan.clips.map(clip=>clip.sourceId))];
  const candidates=ids.map(id=>media.find(m=>m.id===id)).filter((m):m is MediaItem=>Boolean(m?.kind==='video'));
  if(!candidates.length)throw new Error('视觉保留审查缺少可读取的原素材。');
  const root=await realpath(path.join(path.dirname(path.dirname(movie)),'media')),frames:VisualRetentionSourceFrame[]=[];
  for(const [index,source] of candidates.slice(0,2).entries()){
    throwIfJobCancelled();
    if(!/^[A-Za-z0-9_-]{1,120}$/.test(source.id)||!Number.isFinite(source.duration)||!source.duration||source.duration<0)throw new Error('视觉保留审查原素材标识或实际时长无效。');
    const file=await realpath(path.join(root,source.id)),meta=await stat(file);
    if(!file.startsWith(root+path.sep)||!meta.isFile()||meta.size<=0||meta.size>MAX_MEDIA_UPLOAD_BYTES)throw new Error('视觉保留审查原素材路径或大小越界。');
    const before=await hashFile(file);
    if(!source.analysis?.sourceHash||!/^[a-f0-9]{64}$/.test(source.analysis.sourceHash)||source.analysis.sourceHash!==before)throw new Error('视觉保留审查原素材与已分析字节不符。');
    for(const [i,ratio] of [.2,.5,.8,.98].entries()){
      throwIfJobCancelled();
      const sourceTime=+Math.max(0,Math.min(source.duration-.02,source.duration*ratio)).toFixed(3),image=path.join(temp,`retention-source-${index}-${i}.jpg`);
      await runFFmpeg(['-v','error','-y','-ss',String(sourceTime),'-i',file,'-frames:v','1','-vf','scale=540:-2',image],30_000);
      throwIfJobCancelled();
      const imageMeta=await stat(image);if(!imageMeta.size||imageMeta.size>2*1024*1024)throw new Error('视觉保留审查原素材抽帧未形成有界有效图像。');
      frames.push({sourceId:source.id,sourceName:source.name,sourceHash:before,sourceTime,image});
    }
    if(await hashFile(file)!==before)throw new Error('视觉保留审查期间原素材改变，不能绑定旧抽帧。');
  }
  return {frames,selectedRanges:plan.clips.map(({sourceId,start,end})=>({sourceId,start,end})),truncated:candidates.length>2};
}
