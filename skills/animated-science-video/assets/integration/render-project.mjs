// The authored module is read as text and executed only in the browser iframe.
import {mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';import {existsSync} from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';import puppeteer from 'puppeteer-core';
import {buildPreview} from './build-preview.mjs';
const {html,config}=await buildPreview(),flag=process.argv.indexOf('--out'),out=path.resolve(flag>=0?process.argv[flag+1]:'output'),file=path.join(out,'video.mp4'),frames=path.join(out,'frames');
if(existsSync(file))throw Error('Output exists; choose a new --out directory');await mkdir(frames,{recursive:true});
const executablePath=process.env.QINGJIAN_CHROMIUM_PATH||['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(existsSync);if(!executablePath)throw Error('Set QINGJIAN_CHROMIUM_PATH to an installed Chromium');await access(executablePath);
const ffmpeg=process.env.ANIMATED_VIDEO_FFMPEG||'ffmpeg';
async function ff(args){await new Promise((resolve,reject)=>{const child=spawn(ffmpeg,['-nostdin','-v','error',...args],{stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',b=>error=(error+b).slice(-4000));const timer=setTimeout(()=>child.kill('SIGKILL'),300000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error(error||'FFmpeg failed'));});});}
const browser=await puppeteer.launch({executablePath,headless:true,protocolTimeout:45000}),guard=setTimeout(()=>browser.process()?.kill('SIGKILL'),600000);
try{const host=await browser.newPage();await host.setRequestInterception(true);host.on('request',r=>r.abort());await host.setContent(html);const frame=await(await host.$('#stage')).contentFrame();await frame.waitForFunction(()=>window.science||window.__sceneError);const error=await frame.evaluate(()=>window.__sceneError);if(error)throw Error(error);
 const snapshot=async t=>Buffer.from(await frame.evaluate(t=>{window.science.renderer.draw(t);return document.querySelector('canvas').toDataURL('image/png').split(',')[1];},t),'base64');
 for(let f=0;f<config.duration*30;f++)await writeFile(path.join(frames,`frame-${String(f).padStart(5,'0')}.png`),await snapshot(f/30));await writeFile(path.join(out,'poster.png'),await snapshot(config.duration-.8));
 const args=['-framerate','30','-i',path.join(frames,'frame-%05d.png')];
 const bgm=path.join(out,'bgm-finite.wav'),silent=path.join(out,'video-silent.mp4');
 if(config.bgm)await ff(['-stream_loop','-1','-i','bgm.wav','-t',String(config.duration),'-c:a','pcm_s16le',bgm]);
 args.push('-map','0:v:0','-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','4','-frames:v',String(config.duration*30),'-t',String(config.duration),'-movflags','+faststart',config.bgm?silent:file);await ff(args);
 if(config.bgm)try{await ff(['-i',silent,'-i',bgm,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-af','volume=-3dB','-t',String(config.duration),'-movflags','+faststart',file]);}finally{await rm(silent,{force:true});}
 console.log(JSON.stringify({file,frames:config.duration*30,sha256:createHash('sha256').update(await readFile(file)).digest('hex'),userAccepted:false}));
}finally{clearTimeout(guard);await browser.close();await rm(frames,{recursive:true,force:true});}
