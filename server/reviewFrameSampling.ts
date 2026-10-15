import { createHash } from 'node:crypto';
import type { EditPlan, MediaItem, LessonChapter, TimelineText } from '../shared/types';
import { captionsFromTranscript, timelineOffsets } from './timeline';

type Window = { kind:'cue'|'cue-caption-late'; cueIndex:number; start:number; end:number; time:number; selected?:boolean };
type ChapterCoverage = {
  clipIndex:number; chapterId:string|null; proofBound:boolean; stableStart:number; stableEnd:number;
  windows:Window[]; sampledTimes:number[];
};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const finite=(n:number)=>Number.isFinite(n);
const key=(c:Pick<TimelineText,'start'|'end'|'text'>)=>JSON.stringify([+c.start.toFixed(3),+c.end.toFixed(3),c.text]);

/** These bindings authorize time selection only. They do not establish that a
 * caption, focus border or other planned drawing really appeared in the movie. */
function boundChapter(plan:EditPlan,chapter:LessonChapter|undefined,source:MediaItem|undefined):boolean {
  const report=plan.lesson,g=source?.generation,a=source?.analysis;
  return Boolean(report&&chapter&&source&&g&&a?.status==='ready'&&a.sourceHash
    &&chapter.mediaId===source.id&&g.workflowId===report.workflowId&&g.beatId===chapter.id&&g.mode==='generated'
    &&g.lineHash===hash(chapter.narration)&&chapter.audioHash&&g.audioHash===chapter.audioHash
    &&chapter.htmlHash&&g.htmlHash===chapter.htmlHash&&report.voice?.anchorHash&&g.referenceHash===report.voice.anchorHash
    &&finite(chapter.speechMatch!)&&chapter.speechMatch!>=.86&&chapter.cues?.length===chapter.visual.items.length
    &&chapter.cues.length>0&&chapter.cues.every((cue,i)=>cue.text===chapter.visual.items[i].cue
      &&finite(cue.start)&&finite(cue.end)&&cue.start>=0&&cue.end>cue.start)
    &&a.sentences.length>0&&a.sentences.every(s=>s.words.length>0&&s.words.every(w=>finite(w.start)&&finite(w.end)&&w.start>=0&&w.end>w.start)));
}

export function reviewFrameSampling(plan:EditPlan,media:readonly MediaItem[]){
  const frameLimit=plan.lesson?24:18,limitations:string[]=[],coverage:ChapterCoverage[]=[];
  const duration=plan.targetSeconds,offsets=timelineOffsets(plan);
  const end=duration-.05;
  const round=(time:number)=>+time.toFixed(3);
  const valid=(time:number)=>finite(time)&&time>=0&&time<=end;
  const unique=(values:number[])=>[...new Set(values.filter(valid).map(round).filter(valid))].sort((a,b)=>a-b);
  if(!finite(duration)||duration<=.05)return {times:[] as number[],frameLimit,coverage,limitations:['抽帧计划时长无效，未生成有意义的取样覆盖。']};
  const global=[.02,.2,.5,.8,.98].map(r=>Math.min(end,duration*r));
  const motion=(plan.motions||[]).flatMap(m=>[m.start+.22,Math.min(m.end-.1,m.start+1.1)]);
  const legacy=unique([...global,...(plan.editorial||plan.reconstruction?plan.clips.map((c,i)=>offsets[i]+(c.end-c.start)/2):[]),...motion].map(t=>Math.min(end,t)));
  if(!plan.lesson){
    const times=legacy.length<=frameLimit?legacy:Array.from({length:frameLimit},(_,i)=>legacy[Math.round(i*(legacy.length-1)/(frameLimit-1))]);
    if(legacy.length>times.length)limitations.push(`普通剪辑取样上限${frameLimit}帧，未覆盖全部${legacy.length}个候选时点。`);
    return {times,frameLimit,coverage,limitations};
  }
  const lead=plan.lesson.pacing?.leadSeconds;
  // Scene analysis already includes lead; generated captions are output-clock
  // events. Only raw chapter cues below receive the one lead translation.
  let derived=new Set<string>();
  try{derived=new Set(captionsFromTranscript(plan,[...media]).map(key));}
  catch{limitations.push('当前选中ASR字幕事件无法重建，仅使用cue/原关键时点；未据未绑定字幕增加短语覆盖。');}
  const captions=(plan.captions||[]).filter(c=>c.style==='subtitle'&&finite(c.start)&&finite(c.end)&&c.end>c.start&&derived.has(key(c)));
  const edges:number[][]=[],primary:Window[][]=[],late:Window[][]=[];
  for(const [index,clip] of plan.clips.entries()){
    const start=offsets[index],finish=start+clip.end-clip.start;
    const previousEnd=index?offsets[index-1]+plan.clips[index-1].end-plan.clips[index-1].start:start;
    const nextStart=index+1<plan.clips.length?offsets[index+1]:finish;
    // Actual crossfade overlaps have two source images. Do not assign a cue
    // observation to either chapter inside that mixed interval.
    const stableStart=Math.max(start,previousEnd)+.04,stableEnd=Math.min(finish,nextStart,end)-.04;
    const chapters=plan.lesson.chapters.filter(c=>c.id===clip.sceneId),sources=media.filter(m=>m.id===clip.sourceId);
    const chapter=chapters.length===1?chapters[0]:undefined,source=sources.length===1?sources[0]:undefined;
    const proofBound=finite(lead!)&&lead!>=0&&boundChapter(plan,chapter,source);
    const entry:ChapterCoverage={clipIndex:index,chapterId:chapter?.id||null,proofBound,stableStart,stableEnd,windows:[],sampledTimes:[]};coverage.push(entry);
    const inside=(time:number)=>Math.min(stableEnd,Math.max(stableStart,time));
    if(!finite(stableStart)||!finite(stableEnd)||stableEnd<stableStart){edges.push([]);primary.push([]);late.push([]);limitations.push(`片段${index+1}没有避开转场的稳定取样区间。`);continue;}
    const span=finish-start;
    const lastCue=Math.max(0,...(chapter?.cues||[]).filter(c=>finite(c.end)).map(c=>c.end+(proofBound?lead!:0)+1-clip.start));
    edges.push([inside(start+Math.min(2.5,span*.2)),inside(start+Math.min(span-.2,Math.max(span*.7,lastCue)))]);
    const first:Window[]=[],extra:Window[]=[];
    if(proofBound)for(const [cueIndex,cue] of chapter!.cues!.entries()){
      const cueStart=start+cue.start+lead!-clip.start,cueEnd=start+cue.end+lead!-clip.start;
      const from=Math.max(cueStart,stableStart),to=Math.min(cueEnd,stableEnd);
      if(to<=from){limitations.push(`章节${chapter!.id} cue${cueIndex+1}在选片或转场稳定区外，未据此取样。`);continue;}
      const candidates=captions.filter(c=>c.start>=start&&c.end<=finish&&c.end>from&&c.start<to)
        .sort((a,b)=>(Math.min(b.end,to)-Math.max(b.start,from))-(Math.min(a.end,to)-Math.max(a.start,from))||a.start-b.start);
      const caption=candidates[0];
      const windowStart=caption?Math.max(caption.start,stableStart):from,windowEnd=caption?Math.min(caption.end,stableEnd):to;
      // A grouped phrase may cover several drawing focus nodes. Its middle
      // and later stable portion complement the aligned cue rather than
      // assuming the first cue is the only animation in the phrase.
      const time=inside(caption?Math.min(windowEnd-Math.min(.02,(windowEnd-windowStart)/4),Math.max(windowStart+(windowEnd-windowStart)*.45,from+Math.min(.2,(to-from)*.2))):(from+to)/2);
      first.push({kind:'cue',cueIndex,start:windowStart,end:windowEnd,time:round(time)});
      if(caption&&windowEnd>cueEnd+.3){
        const later=round(inside(windowStart+(windowEnd-windowStart)*5/6));
        if(later>time+.3)extra.push({kind:'cue-caption-late',cueIndex,start:windowStart,end:windowEnd,time:later});
      }
    }
    else limitations.push(`片段${index+1}缺少唯一且匹配当前稿的语音/cue生成绑定，仅使用早期/末尾与原关键时点；未证明动态节点覆盖。`);
    first.sort((a,b)=>a.time-b.time);extra.sort((a,b)=>a.time-b.time);
    primary.push(first);late.push(extra);entry.windows=[...first,...extra];
  }
  const selected=new Set<number>();
  const add=(time:number)=>{if(selected.size<frameLimit&&valid(time)&&valid(round(time)))selected.add(round(time));};
  const fair=(groups:readonly (readonly number[])[])=>{for(let row=0;row<Math.max(0,...groups.map(g=>g.length));row++)for(const group of groups)if(group[row]!==undefined)add(group[row]);};
  // One early point per chapter before spending the cap on extra points in a
  // single chapter. Then preserve movie endpoints, one cue, and chapter tails.
  fair(edges.map(e=>e.slice(0,1)));add(global[0]);add(global[4]);
  fair(primary.map(w=>w.slice(0,1).map(w=>w.time)));fair(edges.map(e=>e.slice(1)));
  fair(primary.map(w=>w.slice(1).map(w=>w.time)));fair(late.map(w=>w.map(w=>w.time)));
  for(const time of [...global,...motion,...legacy])add(time);
  const times=[...selected].sort((a,b)=>a-b);
  for(const entry of coverage){
    entry.sampledTimes=times.filter(t=>t>=entry.stableStart&&t<=entry.stableEnd);
    for(const window of entry.windows)window.selected=selected.has(window.time);
    const missed=entry.windows.filter(w=>!w.selected);
    if(missed.length)limitations.push(`章节${entry.chapterId||entry.clipIndex+1}受${frameLimit}帧上限限制，未覆盖${missed.length}个cue/字幕候选窗口：${missed.map(w=>`${w.kind}#${w.cueIndex+1}@${w.time}`).join('、')}；不能据缺帧断言节点缺失。`);
    if(!entry.sampledTimes.length)limitations.push(`片段${entry.clipIndex+1}未获得稳定区间样本，不能声称章节画面已覆盖。`);
  }
  return {times,frameLimit,coverage,limitations};
}
