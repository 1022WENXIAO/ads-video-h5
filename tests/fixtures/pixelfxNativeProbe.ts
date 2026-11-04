import express from 'express';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {createCreativePreviews} from '../../server/creativePreview';
import type {CreativeBuild} from '../../shared/creativeProject';

function difference(a:Buffer,b:Buffer,rect:{x:number;y:number;w:number;h:number}){
 const one=PNG.sync.read(a),two=PNG.sync.read(b);let changed=0,sum=0,count=0;
 for(let y=rect.y;y<rect.y+rect.h;y++)for(let x=rect.x;x<rect.x+rect.w;x++){let pixel=0;for(let c=0;c<3;c++)pixel+=Math.abs(one.data[(y*one.width+x)*4+c]-two.data[(y*two.width+x)*4+c]);sum+=pixel;count++;if(pixel>40)changed++;}
 return {changedPixels:changed,meanChannelDelta:sum/(count*3),rect};
}
export async function observePixelGame(build:CreativeBuild,directory:string,record=false){
 await mkdir(directory,{recursive:true});const app=express(),previews=createCreativePreviews();previews.mount(app);
 const url=previews.issue(build.directory,build.entry,build.artifactHash);
 app.get('/',(_q,r)=>r.type('html').send(`<style>body{margin:0}iframe{border:0;width:960px;height:700px}</style><iframe id="game" sandbox="allow-scripts allow-pointer-lock" src="${url}"></iframe>`));
 const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as any).port;
 const req=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json')),{default:puppeteer}=await import(req.resolve('puppeteer-core'));
 const browser=await puppeteer.launch({executablePath:process.env.QINGJIAN_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage();await page.setViewport({width:960,height:640});const errors:string[]=[];
  page.on('pageerror',(e:Error)=>errors.push(e.message));page.on('console',(m:any)=>{if(/ERROR:SCRIPT|ERROR:GAMESYS/.test(m.text()))errors.push(m.text());});
  await page.setRequestInterception(true);page.on('request',(q:any)=>void(q.url().startsWith(origin)||/^(blob|data):/.test(q.url())?q.continue():q.abort()));
  await page.goto(origin);const frame=await(await page.$('#game'))!.contentFrame();assert(frame);
  const press=async(key:string)=>{await page.keyboard.down(key);await new Promise(r=>setTimeout(r,120));await page.keyboard.up(key);};
  await frame.waitForFunction(()=>Boolean((window as any).__QJ_PIXELFX_STATE?.plays>=3),{timeout:45000});await frame.click('canvas');
  await press('r');await new Promise(r=>setTimeout(r,700));
  const canvas=await frame.$('canvas');assert(canvas);const active=await canvas.screenshot(),stateA=await frame.evaluate(()=>(window as any).__QJ_PIXELFX_STATE);
  await new Promise(r=>setTimeout(r,400));const later=await canvas.screenshot(),stateB=await frame.evaluate(()=>(window as any).__QJ_PIXELFX_STATE);
  await press('Space');await frame.waitForFunction(()=>Object.keys((window as any).__QJ_PIXELFX_STATE?.active||{waiting:true}).length===0,{timeout:5000});const disabled=await canvas.screenshot();
  const visible=difference(active,disabled,{x:45,y:235,w:155,h:275}),motion=difference(active,later,{x:45,y:235,w:155,h:275});
  assert(visible.changedPixels>250 && visible.meanChannelDelta>1,'Imported native pixels must be visible against the same scene with effects disabled');
  assert(motion.changedPixels>80 && motion.meanChannelDelta>.1,'Native pixels must actually animate rather than displaying a still frame');
  assert(stateA.active.some((x:any)=>x.name==='flame'));assert.notDeepEqual(stateA.active,stateB.active);assert.deepEqual(errors,[]);
  await Promise.all([writeFile(path.join(directory,'effects-active.png'),active),writeFile(path.join(directory,'effects-later.png'),later),writeFile(path.join(directory,'effects-disabled.png'),disabled)]);
  if(record){
   await press('Space');await press('r');
   const recorder=await page.screencast({path:path.join(directory,'pixelfx-game.webm'),fps:30,ffmpegPath:req('ffmpeg-static')});
   await page.keyboard.down('ArrowRight');await new Promise(r=>setTimeout(r,900));await page.keyboard.up('ArrowRight');await page.keyboard.down('ArrowLeft');await new Promise(r=>setTimeout(r,1400));await page.keyboard.up('ArrowLeft');await new Promise(r=>setTimeout(r,6000));await recorder.stop();
  }
  const report={passed:true,observer:'native canvas pixels; effect-enabled versus disabled; independently sampled motion',visible,motion,stateA,stateB,errors,userAccepted:false};await writeFile(path.join(directory,'pixel-observation.json'),JSON.stringify(report,null,2));return report;
 }finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
}
