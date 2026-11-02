import express from 'express';
import {createServer} from 'node:http';
import {writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createCreativePreviews} from './creativePreview';
import {onJobAbort,throwIfJobCancelled} from './jobExecution';
import {observePlayer,assertVisualMovement} from './defoldVisual';
import {artifactDigest} from './artifactIntegrity';
import type {CreativeBuild} from '../shared/creativeProject';
export async function inspectDefold(build:CreativeBuild,directory:string){
 if(!build.artifactHash||build.artifactHash!==await artifactDigest(build.directory))throw Error('构建产物已变化，请重新编译和验收。');
 await mkdir(directory,{recursive:true});const app=express(),previews=createCreativePreviews();previews.mount(app);const url=previews.issue(build.directory,build.entry,build.artifactHash);
 app.get('/',(_q,r)=>r.type('html').send(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#09121f}iframe{width:960px;height:700px;border:0}</style><iframe id="game" sandbox="allow-scripts allow-pointer-lock" src="${url}"></iframe>`));
 const server=createServer(app);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+(server.address() as any).port;
 const req=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json')), {default:puppeteer}=await import(req.resolve('puppeteer-core'));
 const executablePath=process.env.QINGJIAN_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const browser=await puppeteer.launch({executablePath,headless:true,protocolTimeout:45000,args:['--enable-unsafe-swiftshader','--use-angle=swiftshader','--disable-dev-shm-usage']}),kill=()=>browser.process()?.kill('SIGKILL'),unhook=onJobAbort(kill),timer=setTimeout(kill,90000);
 const logs:string[]=[],requests:string[]=[];let page:any,rejectFatal:(error:Error)=>void=()=>{};const fatal=new Promise<never>((_r,reject)=>{rejectFatal=reject;});void fatal.catch(()=>{});try{
  page=await browser.newPage();await page.setViewport({width:1000,height:760});page.on('console',(m:any)=>{const text=m.text();logs.push(text);if(/ERROR:SCRIPT|ERROR:GAMESYS|Aborted\(/.test(text))rejectFatal(Error(text));});page.on('pageerror',(e:Error)=>{logs.push('ERROR: '+e.message);rejectFatal(e);});page.on('requestfailed',(r:any)=>requests.push(r.url()+': '+r.failure()?.errorText));page.on('response',(r:any)=>{if(r.status()>=400)requests.push(r.status()+' '+r.url());});
  await page.setRequestInterception(true);page.on('request',(q:any)=>{if(q.url().startsWith(origin)||q.url().startsWith('blob:')||q.url().startsWith('data:'))void q.continue();else void q.abort();});
  await page.goto(origin,{waitUntil:'domcontentloaded'});const element=await page.$('#game'),frame=await element!.contentFrame();
  await Promise.race([frame.waitForFunction(()=>Boolean((window as any).__QJ_GAME_STATE?.time>.1),{timeout:45000}),fatal]);
  const state=()=>frame.evaluate(()=>(window as any).__QJ_GAME_STATE);await frame.click('canvas');await page.keyboard.down('r');await new Promise(r=>setTimeout(r,150));await page.keyboard.up('r');await new Promise(r=>setTimeout(r,100));const before=await state();const canvas=await frame.$('canvas');const visibleBefore=observePlayer(await canvas.screenshot());
  await frame.click('canvas');await page.keyboard.down('ArrowRight');await new Promise(r=>setTimeout(r,400));await page.keyboard.up('ArrowRight');const after=await state();const visibleAfter=observePlayer(await canvas.screenshot());
  const screenshots=[] as string[];for(let i=0;i<3;i++){throwIfJobCancelled();await new Promise(r=>setTimeout(r,350));const file=path.join(directory,`preview-${i}.jpg`);await element!.screenshot({path:file,type:'jpeg',quality:85});screenshots.push(file);}
  await page.keyboard.down('r');await new Promise(r=>setTimeout(r,150));await page.keyboard.up('r');await new Promise(r=>setTimeout(r,200));const restarted=await state();const visualMovement=assertVisualMovement(visibleBefore,visibleAfter,observePlayer(await canvas.screenshot()));
  const errors=logs.filter(v=>/ERROR:|SCRIPT ERROR|Lua error/i.test(v));if(errors.length)throw Error('Defold运行错误：'+errors.slice(-6).join('\n'));
  if(!(after.inputs>before.inputs)||after.x===before.x||!(restarted.restarts>before.restarts))throw Error('试玩没有验证到输入响应、移动和重启：'+JSON.stringify({before,after,restarted})+'。请保留__QJ_GAME_STATE桥接并修复真实游戏逻辑。');
  const report={technicalPassed:true,projectHash:build.projectHash,engine:'defold',engineVersion:build.engineVersion,artifactHash:build.artifactHash,environmentHash:build.environmentHash,visualMovement,loaded:true,inputResponsive:true,restartPassed:true,before,after,restarted,screenshots,logs:logs.slice(-30),userAccepted:false};await writeFile(path.join(directory,'inspection.json'),JSON.stringify(report,null,2));return report;
 }catch(error){const message=error instanceof Error?error.message:String(error);await writeFile(path.join(directory,'runtime-failure.json'),JSON.stringify({message,logs:logs.slice(-40),requests},null,2));try{await page?.screenshot({path:path.join(directory,'failure.png')});}catch{}throw Error(message+'\n运行日志：'+logs.slice(-18).join('\n')+'\n资源请求：'+requests.slice(-12).join('\n'));}finally{unhook();clearTimeout(timer);await browser.close().catch(kill);await new Promise<void>(r=>server.close(()=>r()));}
}
