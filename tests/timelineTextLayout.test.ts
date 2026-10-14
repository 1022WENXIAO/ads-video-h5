import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import type { EditPlan } from '../src/types';
import { addOccupancyFrame,boxesOverlap,createTimelineTextLayout,decodeSourceOccupancy,isObservedBlank,prepareTimelineTextLayout,wrapLayoutText,type SourceOccupancy } from '../server/timelineTextLayout';
import { createAss } from '../server/renderTimeline';
import { drawingScene } from '../server/motionDrawing';
import { runFFmpeg } from '../server/core';

const actualPlan=JSON.parse(await readFile(new URL('./fixtures/p8-motion-plan.json',import.meta.url),'utf8')) as EditPlan;
const empty=(width=960,height=540):SourceOccupancy=>({width,height,occupied:new Uint8Array(width*height),frames:1,certain:true});
const rect=(x:number,y:number,width:number,height:number)=>({x,y,width,height,fontSize:24,lines:['probe']});

test('actual P8 source frames retain all original chart labels and reserve disjoint complete caption/motion boxes',async()=>{
  const state=empty();state.frames=0;
  for(const name of ['p8-motion-source-observation.png','p8-motion-source-comparison.png']){
    const png=PNG.sync.read(await readFile(new URL('./fixtures/'+name,import.meta.url)));assert.equal(png.width,state.width);assert.equal(png.height,state.height);
    const rgb=new Uint8Array(png.width*png.height*3);for(let i=0;i<png.width*png.height;i++)rgb.set(png.data.subarray(i*4,i*4+3),i*3);addOccupancyFrame(state,rgb);
  }
  const original=JSON.stringify(actualPlan),layout=createTimelineTextLayout(actualPlan,960,540,state);
  assert.equal(layout.method,'observed-blank','programmatic source real blank regions can be used without shrinking the source');
  for(const box of [...layout.captions,...layout.motions])assert.ok(isObservedBlank(box,state,960,540));
  for(const caption of layout.captions)for(const motion of layout.motions)assert.equal(boxesOverlap(caption,motion),false);
  layout.captions.forEach((box,index)=>{assert.equal(box.fontSize,32);assert.equal(box.lines.join(''),actualPlan.captions![index].text.replace(/\n/g,''));});
  layout.motions.forEach((box,index)=>{assert.equal(box.fontSize,24);assert.equal(box.lines.join(''),actualPlan.motions![index].label.replace(/\n/g,''));assert.ok(box.y+box.height<80);const html=drawingScene(actualPlan,index,960,540,layout);assert.ok(html.includes(`left:${box.x}px;top:${box.y}px;width:${box.width}px;height:${box.height}px`));assert.ok(html.includes('scale:.94'));assert.ok(!html.includes('back.out'));});
  const ass=createAss(actualPlan,layout);assert.match(ass,/^Style: subtitle,[^,\n]+,32,/m);assert.match(ass,/\\an5\\pos\(/);assert.equal(JSON.stringify(actualPlan),original,'no change to original requested words, source clips or plan');
  // These were occupied by the P8 overlay, and remain protected even if a
  // particular final frame has no visible caption at that instant.
  assert.equal(isObservedBlank(rect(520,389,180,28),state,960,540),false,'source same-start/same-timing annotation');
  assert.equal(isObservedBlank(rect(140,407,100,28),state,960,540),false,'source position-record annotation');
});

test('unknown or occupied source uses complete-frame contain rails and never hides text to manufacture blank space',()=>{
  const state=empty();state.occupied.fill(1);const layout=createTimelineTextLayout(actualPlan,960,540,state);
  assert.equal(layout.method,'contain-rails');const fit=layout.sourceFit!;assert.ok(fit.width>0&&fit.height>540*.45);assert.ok(Math.abs(fit.width/fit.height-960/540)<.01);
  assert.ok(fit.x>=0&&fit.y>=0&&fit.x+fit.width<=960&&fit.y+fit.height<=540);
  for(const box of [...layout.captions,...layout.motions]){assert.equal(boxesOverlap(box,rect(fit.x,fit.y,fit.width,fit.height),0),false);assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=960&&box.y+box.height<=540);}
  assert.equal(layout.captions.length,actualPlan.captions!.length);assert.equal(layout.motions.length,actualPlan.motions!.length);
  const uncertain={...empty(),certain:false,reason:'nonuniform'};assert.equal(createTimelineTextLayout(actualPlan,960,540,uncertain).method,'contain-rails');
  assert.equal(isObservedBlank(rect(-10,0,30,30),empty(),960,540),false);
  assert.throws(()=>createTimelineTextLayout({...actualPlan,captions:[{start:0,end:20,text:'全部文字都应保留'.repeat(200),style:'subtitle',animation:'none'}]},960,540,uncertain),/不会删字或裁剪/);
});

test('full-frame decode catches content entering a previously blank zone at the end instead of relying on a single snapshot',{timeout:30000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-text-occupancy-'));
  try{
    const file=path.join(dir,'late-label.mp4');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=960x540:r=30:d=1.4','-vf',"drawbox=x=350:y=10:w=260:h=60:color=0x222222:t=fill:enable='gte(t,1)'",'-c:v','libx264','-threads','1',file]);
    const state=await decodeSourceOccupancy(file,1.4);assert.ok(state.frames>=40);assert.equal(state.certain,true);assert.equal(isObservedBlank(rect(400,20,100,30),state,960,540),false);assert.equal(isObservedBlank(rect(400,200,100,30),state,960,540),true);
    const none=await decodeSourceOccupancy('/not-read-for-long-videos',91);assert.equal(none.certain,false);assert.equal(none.frames,0);
    await assert.rejects(()=>decodeSourceOccupancy(path.join(dir,'missing.mp4'),1),/检测失败/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('line wrapping retains every character and dedicated lesson/news subtitle geometry is unchanged',async()=>{
  const value='WWWWWWW完整中文与emoji🙂以及所有数字2500、-600';assert.equal(wrapLayoutText(value,24,180).join(''),value);
  const plan={...actualPlan,lesson:{} as EditPlan['lesson']};assert.equal(await prepareTimelineTextLayout(plan,1280,720,'not-read'),undefined);assert.match(createAss(plan),/^Style: subtitle,[^,\n]+,34,/m);
  assert.equal(await prepareTimelineTextLayout({...actualPlan,reconstruction:{} as EditPlan['reconstruction']},960,540,'not-read'),undefined);
});

test('actual loaded Chromium fonts keep wide Latin Chinese numbers and all animation glyphs inside the reserved box',{timeout:30000},async()=>{
  const {createRequire}=await import('node:module'),{homedir}=await import('node:os');
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(!executablePath)for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){const found=(await browsers.getInstalledBrowsers({cacheDir})).find((item:any)=>item.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(item.browser));if(found){executablePath=found.executablePath;break;}}
  assert.ok(executablePath,'uses the already installed production renderer browser without downloads');
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  try{
    const page=await browser.newPage();await page.setViewport({width:960,height:540});
    const gsap=await readFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),'utf8'),{motionLibrary}=await import('../server/htmlEffects');
    for(const label of ['WWWWWWWWWWWWWWWWWWWWWWWW宽字符2500、-600','保留全部文字包括完整中文、英文WWW和🙂表情'] ){
      const plan={...actualPlan,motions:[{sceneId:'actual',kind:'circle',label,zone:'bottom',start:0,end:2}]} as EditPlan;
      const layout=createTimelineTextLayout(plan,960,540,empty()),box=layout.motions[0],html=drawingScene(plan,0,960,540,layout).replace(/^<template[^>]*>/,'').replace(/<\/template>$/,'');
      await page.setContent(`<style>body{margin:0}</style><script>${gsap};window.__timelines={};${motionLibrary}</script>${html}`);await page.evaluate(()=>document.fonts.ready);
      for(const time of [0,.1,.3,.8,1.99]){
        const result=await page.evaluate((time:number)=>{(window as any).__timelines['drawing-0'].pause().seek(time,false);const label=document.querySelector('#label-0')!,box=document.querySelector('#box-0')!,r=document.createRange();r.selectNodeContents(label);const a=r.getBoundingClientRect(),b=box.getBoundingClientRect();return {text:label.textContent,font:getComputedStyle(label).fontSize,glyph:{left:a.left,right:a.right,top:a.top,bottom:a.bottom},box:{left:b.left,right:b.right,top:b.top,bottom:b.bottom}};},time);
        assert.equal(result.text!.replace(/\n/g,''),label);assert.equal(result.font,'24px');assert.ok(result.glyph.left>=result.box.left&&result.glyph.right<=result.box.right&&result.glyph.top>=result.box.top&&result.glyph.bottom<=result.box.bottom,JSON.stringify({time,...result}));
      }
      assert.ok(box.width<=960&&box.height<=540);
    }
  }finally{await browser.close();}
});

test('actual unknown-scene render keeps all four source borders inside contain rails with caption and motion text preserved',{timeout:90000},async()=>{
  const {renderTimeline}=await import('../server/renderTimeline'),{mkdir}=await import('node:fs/promises');
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-text-rails-'));
  try{
    const mediaDir=path.join(dir,'media'),out=path.join(dir,'exports');await mkdir(mediaDir);await mkdir(out);
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','testsrc2=s=960x540:r=30:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-vf','drawbox=x=0:y=0:w=960:h=540:color=red:t=8','-c:v','libx264','-threads','1','-c:a','aac','-f','mp4',path.join(mediaDir,'source')]);
    const plan={format:'16:9',targetSeconds:1,summary:'Geometry-only controlled fixture; not an Agent acceptance score',clips:[{sourceId:'source',sceneId:'scene',start:0,end:1,purpose:'context'}],audio:{originalVolume:1,bgmVolume:0,narrationVolume:0,normalize:false},captions:[{start:0,end:1,text:'完整原画面与字幕',style:'subtitle',animation:'none'}],motions:[{sceneId:'scene',kind:'underline',label:'全部关键词保留',zone:'bottom',start:0,end:1}]} as EditPlan;
    const result=await renderTimeline(plan,[{id:'source',kind:'video',duration:1} as any],mediaDir,out);
    const manifest=JSON.parse(await readFile(result.file.replace('.mp4','.render.json'),'utf8'));assert.equal(manifest.textLayout.method,'contain-rails');
    const pngFile=path.join(dir,'result.png');await runFFmpeg(['-v','error','-y','-ss','0.5','-i',result.file,'-frames:v','1',pngFile]);
    const png=PNG.sync.read(await readFile(pngFile)),fit=manifest.textLayout.sourceFit;
    for(const [x,y] of [[fit.x+2,fit.y+2],[fit.x+fit.width-3,fit.y+2],[fit.x+2,fit.y+fit.height-3],[fit.x+fit.width-3,fit.y+fit.height-3]]){const at=(y*png.width+x)*4;assert.ok(png.data[at]>150&&png.data[at+1]<90&&png.data[at+2]<90,'the original red border remains visible at every source corner; no crop');}
    assert.equal(manifest.textLayout.captions[0].lines.join(''),plan.captions![0].text);assert.equal(manifest.textLayout.motions[0].lines.join(''),plan.motions![0].label);
    await runFFmpeg(['-v','error','-i',result.file,'-f','null','-']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('source-frame analysis preserves job cancellation rather than converting it to a safe-layout claim',async()=>{
  const {runWithJobSignal,JobCancelledError}=await import('../server/jobExecution');const controller=new AbortController();controller.abort();
  await assert.rejects(runWithJobSignal(controller.signal,()=>decodeSourceOccupancy('never-read',1)),JobCancelledError);
});
