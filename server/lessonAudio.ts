import { probeAudio, runFFmpeg } from './core';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LessonPacing, LessonPresentation } from '../src/types';

export async function preserveLessonSpeechTake(file:string){
  const bytes=await readFile(file),hash=createHash('sha256').update(bytes).digest('hex');
  const directory=path.join(path.dirname(file),'takes'),archived=path.join(directory,hash+'.mp3');
  await mkdir(directory,{recursive:true});
  try{await writeFile(archived,bytes,{flag:'wx',mode:0o600});}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(!(await readFile(archived)).equals(bytes))throw new Error('原始旁白留档损坏，保留现有文件并停止覆盖。');
  }
  return {hash,file:archived};
}

export function lessonVoiceStyle(pacing:LessonPacing,presentation?:LessonPresentation):string{
  const mood=presentation?.mood==='urgent'?'严肃新闻播报，带紧张迫切感，重音鲜明但不喊叫，台词清楚完整。':'';
  return `${mood}单人普通话，中性的成年男声，声音清晰、稳定自然，${pacing.mode==='brisk'?'短视频播报节奏，紧凑连贯，不作慢速课堂朗读':pacing.mode==='deliberate'?'耐心讲解，关键概念清楚':'自然讲解，句子连贯'}。语速每秒约${pacing.targetCharactersPerSecond}个中文字（每分钟约${Math.round(pacing.targetCharactersPerSecond*60)}字，不含标点）。逗号只作短停顿，句间停顿不超过${pacing.maxPauseSeconds}秒，不逐字拖长，不拉长句尾，不为凑时长增加空白。只朗读台词；不要音乐、音效、额外开场白，不朗读标点符号。术语读音：铰链读jiǎo liàn，交叉熵读jiāo chā shāng；术语说明不属于台词，不能朗读说明。`;
}

export function lessonPacingCheck(characters:number,seconds:number,pacing:LessonPacing):{passed:boolean;charactersPerSecond:number;detail:string}{
  const rate=seconds>0?characters/seconds:NaN;
  const passed=Number.isFinite(rate)&&rate>=pacing.minCharactersPerSecond&&rate<=pacing.maxCharactersPerSecond;
  const deviation=Number.isFinite(rate)&&!passed?(rate<pacing.minCharactersPerSecond?`低于下限${(pacing.minCharactersPerSecond-rate).toPrecision(3)}`:`高于上限${(rate-pacing.maxCharactersPerSecond).toPrecision(3)}`)+'字/秒；':'';
  return {passed,charactersPerSecond:+rate.toFixed(3),detail:`实际每秒${Number.isFinite(rate)?rate.toFixed(3):'未知'}字，规划每秒${pacing.targetCharactersPerSecond}字，允许${pacing.minCharactersPerSecond}–${pacing.maxCharactersPerSecond}字；${deviation}实际${characters}字/${seconds}秒，字数不含标点，音频时长包含自然停顿。`};
}

// Preserve the actual, already-audited waveform across recovery. Tiny timing
// differences after a retake do not justify invalidating every chapter's ASR.
export function lessonTempo(rawSeconds:number,targetSeconds:number,padding:number,previous:number|undefined,rawCacheValid:boolean,explicitDuration=true):number{
  if(!Number.isFinite(rawSeconds)||rawSeconds<=0||targetSeconds<=padding)throw new Error('旁白时长预算无效。');
  if(rawCacheValid&&previous!==undefined&&Number.isFinite(previous)&&previous>=.8&&previous<=1.25&&Math.abs(rawSeconds/previous+padding-targetSeconds)<=Math.max(.5,targetSeconds*.02))return previous;
  const tempo=+(rawSeconds/(targetSeconds-padding)).toFixed(5);
  // A default duration is a planning budget. Prefer a slightly longer complete
  // take at the same safe tempo over re-recording the whole voice unnecessarily.
  if(!explicitDuration&&tempo>1.25&&rawSeconds/1.25+padding<=targetSeconds*1.2)return 1.25;
  return tempo;
}

// Trim only low-energy silence touching the file edges. Keep a margin around
// the detected speech and preserve internal pauses for separate safe editing.
export async function prepareLessonSpeech(file:string,output:string):Promise<{leadingTrim:number;trailingTrim:number;duration:number}>{
  const duration=await probeAudio(file);
  const log=await runFFmpeg(['-hide_banner','-nostats','-i',file,'-vn','-af','silencedetect=noise=-55dB:d=0.04','-f','null','-']);
  const gaps:Array<{start:number;end:number}>=[];let start:number|undefined;
  for(const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)){
    if(match[1]==='start')start=Number(match[2]);
    else if(start!==undefined){gaps.push({start,end:Number(match[2])});start=undefined;}
  }
  const first=gaps[0],last=gaps.at(-1),margin=.12;
  const begin=first&&first.start<=.02?Math.max(0,first.end-margin):0;
  const end=last&&last.end>=duration-.04?Math.min(duration,last.start+margin):duration;
  if(end-begin<1)throw new Error('旁白首尾处理后不足1秒，不能继续制作。');
  await runFFmpeg(['-v','error','-y','-i',file,'-vn','-af',`atrim=start=${begin}:end=${end},asetpts=PTS-STARTPTS`,'-ar','48000','-ac','1','-c:a','pcm_s16le',output]);
  return {leadingTrim:+begin.toFixed(3),trailingTrim:+(duration-end).toFixed(3),duration:await probeAudio(output)};
}

// Generated narration can shorten only the near-silent centers inside a gap
// rejected by the unchanged pacing detector. The -40dB interval alone never
// authorizes a cut: a separate -65dB interval and both speech margins are needed.
// Keep the original take and transcribe/align the edited waveform afterwards.
export async function tightenNewsSpeechSilence(file:string,output:string,maxPauseSeconds:number){
  if(!Number.isFinite(maxPauseSeconds)||maxPauseSeconds<.3||maxPauseSeconds>4)throw new Error('旁白停顿上限无效。');
  const beforeSeconds=await probeAudio(file);
  const rejected=await inspectLessonSpeechGaps(file,maxPauseSeconds);
  // Measure cut coordinates on the untouched waveform. Loudnorm may shift
  // detector timestamps through its lookahead; normalized gaps only nominate
  // candidates, never supply the actual cut boundaries.
  const log=rejected.length?await runFFmpeg(['-hide_banner','-nostats','-i',file,'-vn','-af','silencedetect=noise=-65dB:d=0.25','-f','null','-']):'';
  const nearSilence:Array<{start:number;end:number}>=[];let start:number|undefined;
  // Remove only the excess plus a small detector margin, rather than making
  // every pause half as long and accumulating unnecessary duration loss.
  const keptPause=Math.max(.3,maxPauseSeconds-Math.min(.1,maxPauseSeconds*.1));
  for(const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)){
    if(match[1]==='start')start=Number(match[2]);
    else if(start!==undefined){
      const end=Number(match[2]);
      if(start>.12&&end<beforeSeconds-.12)nearSilence.push({start,end});
      start=undefined;
    }
  }
  const cuts:Array<{start:number;end:number}>=[],margin=.12;
  for(const gap of rejected){
    let remaining=gap.end-gap.start-keptPause;
    for(const silent of nearSilence){
      const left=Math.max(gap.start,silent.start)+margin,right=Math.min(gap.end,silent.end)-margin;
      const removed=Math.min(remaining,right-left);
      if(removed<=.02)continue;
      const center=(left+right)/2;
      const cut={start:+(center-removed/2).toFixed(4),end:+(center+removed/2).toFixed(4)};
      cuts.push(cut);remaining-=cut.end-cut.start;
    }
  }
  cuts.sort((a,b)=>a.start-b.start);
  if(!cuts.length)await copyFile(file,output);
  else{
    const points=[0,...cuts.flatMap(c=>[c.start,c.end]),beforeSeconds];
    const spans=Array.from({length:cuts.length+1},(_,i)=>`[0:a]atrim=start=${points[i*2]}:end=${points[i*2+1]},asetpts=PTS-STARTPTS[s${i}]`);
    const filter=spans.join(';')+';'+spans.map((_,i)=>`[s${i}]`).join('')+`concat=n=${spans.length}:v=0:a=1[out]`;
    await runFFmpeg(['-v','error','-y','-i',file,'-filter_complex',filter,'-map','[out]','-ar','48000','-ac','1','-c:a','pcm_s16le',output]);
  }
  return {cuts,silenceNoiseDb:-65,protectedMarginSeconds:margin,removedSeconds:+cuts.reduce((n,c)=>n+c.end-c.start,0).toFixed(3),beforeSeconds,duration:await probeAudio(output)};
}

// Inspect a level-normalized copy in the filter graph; keep the real file
// intact. Low energy alone never authorizes a speech cut or a passing result.
export async function inspectLessonSpeechGaps(file:string,maxPauseSeconds=4):Promise<Array<{start:number;end:number}>>{
  if(!Number.isFinite(maxPauseSeconds)||maxPauseSeconds<.3||maxPauseSeconds>4)throw new Error('旁白停顿上限无效。');
  const log=await runFFmpeg(['-hide_banner','-nostats','-i',file,'-vn','-af',`loudnorm=I=-16:TP=-1.5:LRA=7,silencedetect=noise=-40dB:d=${maxPauseSeconds}`,'-f','null','-']);
  const gaps:Array<{start:number;end:number}>=[];let start:number|undefined;
  for(const match of log.matchAll(/silence_(start|end):\s*([\d.]+)/g)){
    if(match[1]==='start')start=Number(match[2]);
    else if(start!==undefined){const end=Number(match[2]);if(end-start>=maxPauseSeconds-.02)gaps.push({start:+start.toFixed(3),end:+end.toFixed(3)});start=undefined;}
  }
  return gaps;
}
