import { spawnForJob as spawn } from './jobExecution';
import { createRequire } from 'node:module';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { EditPlan } from '../src/types';
import { motionLibrary } from './htmlEffects';
import { createTimelineTextLayout, type TimelineTextLayout } from './timelineTextLayout';

const escape=(s:string)=>s.replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function drawingComposition(plan:EditPlan,width:number,height:number):string {
  const markup=(plan.motions||[]).map((m,i)=>`<div id="motion-${i}" class="clip" data-composition-id="drawing-${i}" data-composition-src="./compositions/drawing-${i}.html" data-start="${m.start}" data-duration="${m.end-m.start}" data-track-index="${i}"></div>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;background:transparent;overflow:hidden}#root{position:relative;width:${width}px;height:${height}px;background:transparent}#root > .clip{position:absolute;inset:0}</style><script src="./gsap.min.js"></script><script>window.__timelines={};${motionLibrary}</script></head><body><main id="root" data-composition-id="main" data-start="0" data-duration="${plan.targetSeconds}" data-width="${width}" data-height="${height}">${markup}</main><script>window.__timelines.main=gsap.timeline({paused:true});</script></body></html>`;
}
function legacyDrawingScene(plan:EditPlan,i:number,width:number,height:number):string {
  const m=plan.motions![i];const duration=m.end-m.start;
  const labelUnits=[...m.label].reduce((n,c)=>n+(/[\u0000-\u007f]/.test(c)?.5:1),0);
  const fontSize=Math.min(Math.round(width/19),Math.floor((width*.86-32)/Math.max(1,labelUnits)));
  const radius=Math.min(198,Math.max(70,(labelUnits*fontSize+56)/(width*.86/420)/2));
  const shape=m.kind==='circle'?`<ellipse cx="210" cy="58" rx="${radius.toFixed(1)}" ry="44"/>`:m.kind==='arrow'?'<path d="M36 88 Q155 117 344 87 M316 70 L350 87 L317 105"/>':m.kind==='steps'?'<path d="M24 109 L135 109 L135 101 L254 101 L254 92 L394 92 M380 82 L394 92 L380 102"/>':'<path d="M20 91 Q180 100 400 87"/>';
  const top=height*(m.zone==='top'?.06:.62);
  return `<template id="drawing-${i}-template"><section data-composition-id="drawing-${i}" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}"><style>@font-face{font-family:"PingFang SC";src:local("PingFang SC"),local("Hiragino Sans GB")}@font-face{font-family:"Noto Sans CJK SC";src:local("Noto Sans CJK SC")} [data-composition-id="drawing-${i}"]{position:relative;width:${width}px;height:${height}px;font-family:"PingFang SC","Noto Sans CJK SC",Arial,sans-serif;color:#252935} [data-composition-id="drawing-${i}"] .scene-content{box-sizing:border-box;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;padding:${top+height*.052}px 7% 0;gap:4px}#label-${i}{box-sizing:border-box;font-size:${fontSize}px;font-weight:800;background:#fffdfa;border-radius:12px;padding:10px 16px;max-width:100%;text-align:center;line-height:1.2;box-shadow:0 3px 14px #25293522}#stroke-${i}{position:absolute;top:${top}px;left:7%;width:86%;height:16%;overflow:visible;pointer-events:none}#stroke-${i} path,#stroke-${i} ellipse{fill:none;stroke:#fb7353;stroke-width:5;stroke-linecap:round;stroke-linejoin:round}</style><div class="scene-content"><div id="label-${i}" class="clip" data-start="0" data-duration="${duration}" data-track-index="0">${escape(m.label)}</div></div><svg id="stroke-${i}" class="clip" data-start="0" data-duration="${duration}" data-track-index="1" viewBox="0 0 420 120" aria-hidden="true">${shape}</svg><script>{const tl=gsap.timeline({paused:true});QJMotion.keywordPunch(tl,'#label-${i}',0);QJMotion.drawStroke(tl,'#stroke-${i} path,#stroke-${i} ellipse',.18,.7);tl.fromTo('#stroke-${i}',{y:5},{y:0,duration:.5,ease:'sine.out'},.1);window.__timelines['drawing-${i}']=tl;}</script></section></template>`;
}
export function drawingScene(plan:EditPlan,i:number,width:number,height:number,layout?:TimelineTextLayout):string {
  if(plan.lesson||plan.reconstruction)return legacyDrawingScene(plan,i,width,height);
  const motion=plan.motions![i],duration=motion.end-motion.start,b=(layout||createTimelineTextLayout(plan,width,height)).motions[i];
  const stroke=motion.kind==='circle'?'<ellipse cx="50" cy="50" rx="47" ry="46"/>':motion.kind==='arrow'?'<path d="M5 83 L94 83 M87 72 L94 83 L87 94"/>':motion.kind==='steps'?'<path d="M5 90 L34 90 L34 84 L65 84 L65 78 L94 78 M88 71 L94 78 L88 85"/>':'<path d="M5 86 Q45 95 95 86"/>';
  return `<template id="drawing-${i}-template"><section data-composition-id="drawing-${i}" data-width="${width}" data-height="${height}" data-start="0" data-duration="${duration}"><style>[data-composition-id="drawing-${i}"]{position:relative;width:${width}px;height:${height}px;color:#252935;font-family:"PingFang SC","Noto Sans CJK SC",Arial,sans-serif}#box-${i}{box-sizing:border-box;position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;overflow:hidden;padding:6px 12px 8px}#label-${i}{box-sizing:border-box;position:relative;z-index:1;width:100%;font-size:${b.fontSize}px;font-weight:800;background:#fffdfa;border-radius:8px;text-align:center;line-height:1.25;white-space:pre;transform-origin:center center}#stroke-${i}{position:absolute;inset:0;width:100%;height:100%;overflow:hidden;pointer-events:none}#stroke-${i} path,#stroke-${i} ellipse{fill:none;stroke:#fb7353;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke}</style><div id="box-${i}"><div id="label-${i}" class="clip" data-start="0" data-duration="${duration}" data-track-index="0">${b.lines.map(escape).join('\n')}</div><svg id="stroke-${i}" class="clip" data-start="0" data-duration="${duration}" data-track-index="1" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${stroke}</svg></div><script>{const tl=gsap.timeline({paused:true});tl.fromTo('#label-${i}',{scale:.94,opacity:0},{scale:1,opacity:1,duration:.35,ease:'power2.out'},0);QJMotion.drawStroke(tl,'#stroke-${i} path,#stroke-${i} ellipse',.18,.7);window.__timelines['drawing-${i}']=tl;}</script></section></template>`;
}
export async function writeDrawingProject(plan:EditPlan,width:number,height:number,project:string,layout?:TimelineTextLayout) {
  await mkdir(path.join(project,'compositions'),{recursive:true});await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
  await writeFile(path.join(project,'index.html'),drawingComposition(plan,width,height));
  for(let i=0;i<(plan.motions?.length||0);i++)await writeFile(path.join(project,'compositions',`drawing-${i}.html`),drawingScene(plan,i,width,height,layout));
}
export async function renderDrawings(plan:EditPlan,width:number,height:number,workDir:string,layout?:TimelineTextLayout):Promise<string|undefined> {
  if(!plan.motions?.length)return;
  const project=path.join(workDir,'drawings');await writeDrawingProject(plan,width,height,project,layout);
  const root=process.cwd();
  const output=path.join(workDir,'drawings.webm');
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(path.join(root,'node_modules/.bin/hyperframes'),['render',project,'-o',output,'--format','webm','--fps','30','--quality','draft','--workers','1'],{cwd:root,env:{...process.env,HYPERFRAMES_FFMPEG_PATH:ffmpegPath||undefined,HYPERFRAMES_FFPROBE_PATH:createRequire(import.meta.url)('ffprobe-static').path},stdio:['ignore','pipe','pipe']});
    let log='';const append=(b:Buffer)=>{log=(log+b.toString()).slice(-1500);};child.stdout.on('data',append);child.stderr.on('data',append);const timer=setTimeout(()=>child.kill('SIGKILL'),360000);child.on('error',(e)=>{clearTimeout(timer);reject(e);});child.on('close',(code)=>{clearTimeout(timer);code===0?resolve():reject(new Error(`绘制动效渲染失败：${log.slice(-600)}`));});
  });return output;
}
