import { pathToFileURL } from 'node:url';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { spawnForJob, throwIfJobCancelled } from './jobExecution';
import type { LoadedVideoTemplate } from './videoTemplates';
import type { AnimationMotion } from '../shared/animationMotion';

export function animationMotionIssues(m:AnimationMotion):string[]{
  const issues:string[]=[];
  if(m.meanChangedAreaPct<.3)issues.push(`主体平均变化面积${m.meanChangedAreaPct.toFixed(3)}%，至少0.30%`);
  if(m.medianChangedAreaPct<.18)issues.push(`主体变化面积中位数${m.medianChangedAreaPct.toFixed(3)}%，至少0.18%`);
  if(m.activeFramePct<75)issues.push(`持续活动帧${m.activeFramePct.toFixed(1)}%，至少75%`);
  if(m.longestStillSeconds>1.2)issues.push(`连续近静止${m.longestStillSeconds.toFixed(2)}秒，最多1.2秒`);
  for(const p of m.panels){
    if(p.meanChangedAreaPct<.18||p.activeFramePct<50)issues.push(`图${p.panel}主体活动不足（均值${p.meanChangedAreaPct.toFixed(3)}%，活动帧${p.activeFramePct.toFixed(1)}%），要求均值≥0.18%且活动帧≥50%`);
  }
  return issues;
}
export function assertAnimationMotion(m:AnimationMotion){const issues=animationMotionIssues(m);if(issues.length)throw new Error('动效未达到对标基线：'+issues.join('；')+'。请增加主体的数据流、重排或状态演化，保持结果可读。');}

export async function measureEncodedAnimation(file:string,template:LoadedVideoTemplate,panelCount:number):Promise<AnimationMotion>{
  const {createMotionMeter}=await import(pathToFileURL(path.join(template.directory,'assets/integration/motion-metrics.mjs')).href);
  const rows=Math.ceil(panelCount/2),h=(1045-(rows-1)*25)/rows;
  const rects=Array.from({length:panelCount},(_,i)=>({x:80+i%2*470,y:500+Math.floor(i/2)*(h+25),w:450,h}));
  const meter=createMotionMeter(rects,{stride:3}),frameBytes=230*262*3;
  const child=spawnForJob(ffmpeg||'ffmpeg',['-nostdin','-v','error','-i',file,'-an','-vf','crop=920:1045:80:500,scale=230:262','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{stdio:['ignore','pipe','pipe']});
  let error='',pending=Buffer.alloc(0);child.stderr!.on('data',(b:Buffer)=>{error=(error+b.toString()).slice(-4000);});
  const done=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(error||'连续帧运动检查失败。')));});void done.catch(()=>{});
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  try{
    for await(const chunk of child.stdout!){throwIfJobCancelled();pending=Buffer.concat([pending,chunk]);while(pending.length>=frameBytes){meter.push(pending.subarray(0,frameBytes));pending=pending.subarray(frameBytes);}}
    await done;if(pending.length)throw new Error('运动检查发现不完整视频帧。');return meter.result();
  }finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
}
