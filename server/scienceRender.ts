import {assertScienceReceipt} from './scienceWorkspace';
import {currentTaskExecution} from './taskRuntime';
import type { Page } from 'playwright';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { onJobAbort, spawnForJob, throwIfJobCancelled } from './jobExecution';
import type { LoadedVideoTemplate } from './videoTemplates';
import { templateSelection } from './videoTemplates';
import type { ScienceScene } from './scienceScene';
import type { ResearchReference } from '../shared/types';
import { archiveTemplateProject } from './templateArchive';
import { runFFmpeg } from './core';
import { assertAnimationMotion, measureEncodedAnimation } from './animationMotion';
import type { AnimationMotion } from '../shared/animationMotion';

const sha = (b:Buffer|string) => createHash('sha256').update(b).digest('hex');
export { scienceHtml } from './scienceHtml';
import { scienceHtml } from './scienceHtml';
async function scienceBrowser() {
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  const explicit=process.env.QINGJIAN_CHROMIUM_PATH||process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  if(explicit){await access(explicit);return {puppeteer,executablePath:explicit};}
  for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    const installed=await browsers.getInstalledBrowsers({cacheDir}).catch(()=>[]);
    const match=installed.filter((b:any)=>b.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(b.browser)).sort((a:any,b:any)=>b.buildId.localeCompare(a.buildId,undefined,{numeric:true}))[0];
    if(match){await access(match.executablePath);return {puppeteer,executablePath:match.executablePath};}
  }
  throw new Error('模板渲染需要已安装的 Chromium，请配置 QINGJIAN_CHROMIUM_PATH。');
}

export async function openSciencePage(template: LoadedVideoTemplate, config: ScienceScene): Promise<{page:Page;close:()=>Promise<void>}> {
  throwIfJobCancelled();
  const {puppeteer,executablePath}=await scienceBrowser();
  const browser=await puppeteer.launch({headless:true,executablePath,protocolTimeout:45000,args:['--disable-dev-shm-usage','--disable-background-networking','--disable-extensions',...(process.env.QINGJIAN_RENDER_NO_SANDBOX==='1'?['--no-sandbox']:[])]});
  const kill=()=>{browser.process()?.kill('SIGKILL');};
  const timer=setTimeout(kill,Math.max(180000,config.duration*12000));
  const unbind=onJobAbort(kill);
  const close=async()=>{unbind();clearTimeout(timer);const guard=setTimeout(kill,1500);try{await browser.close();}finally{clearTimeout(guard);}};
  try {
    const host=await browser.newPage();await host.setViewport({width:1080,height:1920,deviceScaleFactor:1});
    await host.setRequestInterception(true);host.on('request',(request:any)=>{void request.abort();});
    const errors:string[]=[];host.on('pageerror',(e:Error)=>errors.push(e.message));
    await host.setContent(await scienceHtml(template,config),{waitUntil:'domcontentloaded',timeout:15000});
    const frame=await host.waitForSelector('#stage');const page=await frame.contentFrame();
    if(!page)throw new Error('动画隔离页面未启动。');
    await page.waitForFunction(()=>Boolean((window as any).science||(window as any).__sceneError),{timeout:10000});
    const sceneError=await page.evaluate(()=>(window as any).__sceneError);
    if(sceneError)throw new Error('场景执行错误：'+sceneError);
    await page.evaluate(()=>document.fonts.ready);
    const textIssues=await scienceNodeTextIssues(page as Page);
    if(textIssues.length)throw new Error(textIssues.join('\n')+'\n请一次修复所有列出的节点宽度或文本，以及对应的结果断言。');
    if(errors.length)throw new Error(errors.join(';'));
    return {page:page as Page,close};
  } catch(error) {await close();throw error;}
}

async function scienceNodeTextIssues(page:Page):Promise<string[]> {
  return page.evaluate(()=>{
    const s=(window as any).science,issues:string[]=[];
    if(!s)return issues;
    if(s.config.program)return issues;
    const c=document.querySelector('canvas')!.getContext('2d')!;
    c.font='400 22px "Animated CJK", "Noto Sans CJK SC", "Hiragino Sans GB", "PingFang SC", "Microsoft YaHei", sans-serif';
    for(const [index,p] of s.config.panels.entries())for(const node of p.nodes){
      const variants=[node.text,...p.steps.flatMap((step:any)=>step.changes.filter((change:any)=>change.nodeId===node.id&&typeof change.text==='string').map((change:any)=>change.text))];
      let width=0,longest='';for(const text of variants){const measured=c.measureText(text).width;if(measured>width){width=measured;longest=text;}}
      if(width>node.w*400-8)issues.push(`面板${index+1}节点${node.id}文字过宽：${longest}；w至少${((width+8)/400+.005).toFixed(3)}，或精简文字（w上限0.8，并同步调整x避免越界）。`);
    }
    return issues.slice(0,24);
  });
}

export async function inspectScienceLayout(page:Page) {
  const inspected=await page.evaluate(()=>{
    const {renderer,config,panelRects,authored,createMotionMeter}=(window as any).science;
    let placements=0;const issues=new Map<string,string>();const issue=(key:string,message:string)=>{if(issues.size<24&&!issues.has(key))issues.set(key,message);};const rects=panelRects(config.panels.length);
    let checkResults:Array<{panel?:number;name:string;passed:boolean;detail?:string}>=[];
    if(config.program){
      const checks=authored.checkModels(config);
      if(!Array.isArray(checks)||checks.length<config.panels.length||checks.length>64||checks.some((c:any)=>!c||typeof c.name!=='string'||!c.name||c.passed!==true))throw new Error('场景模型检查未通过：'+JSON.stringify(checks).slice(0,2000));
      checkResults=checks;
    }else for(let i=0;i<config.panels.length;i++)for(const check of config.panels[i].checks){
      const state=authored.stateAt(authored.stepTime(config,config.panels[i],check.step)+1e-7,i,config),node=state.nodes.find((n:any)=>n.id===check.nodeId);
      if(!node||['text','visible','active'].some(k=>check[k]!==undefined&&check[k]!==node[k]))throw new Error('结果断言失败：'+check.name);
      checkResults.push({panel:i+1,name:check.name,passed:true});
    }
    const sample=document.createElement('canvas');sample.width=230;sample.height=262;
    const sampleContext=sample.getContext('2d',{willReadFrequently:true})!;
    const meter=config.program?createMotionMeter(rects):null;
    for(let f=0;f<=config.duration*30;f++){
      const result=renderer.draw(f/30,{captureBounds:true});
      for(const b of result.textBounds){
        const p=b.panel<0?{x:0,y:220,w:1080,h:1480}:rects[b.panel];
        if(b.x<p.x-.1||b.y<p.y-.1||b.x+b.w>p.x+p.w+.1||b.y+b.h>p.y+p.h+.1)issue(`outside-${b.panel}-${b.text}`,`文字超出边界，面板${b.panel+1}，${f/30}s：${b.text}`);
        if(b.scaleX>.001&&Math.abs(b.scaleX-b.scaleY)>b.scaleX*.02)issue('aspect-'+b.text,'文字发生非等比缩放：'+b.text);
        if(config.program&&b.region==='body'){
          if(b.y<p.y+94||b.y+b.h>p.y+p.h-34)issue(`region-${b.panel}-${b.text}`,`正文占用标题/底部步骤区，面板${b.panel+1}，${f/30}s：${b.text}。请使用rect.body布局，四图正文约410×365，六图约410×187。`);
          if(b.size*b.scaleX<18)issue(`size-${b.panel}-${b.text}`,`正文文字过小，面板${b.panel+1}：${b.text}，有效字号${(b.size*b.scaleX).toFixed(1)}。至少18px，关键文字22px以上；空间不足时减少面板或删减文字。`);
        }
        placements++;
      }
      if(meter&&f<config.duration*30){sampleContext.drawImage(document.querySelector('canvas')!,80,500,920,1045,0,0,230,262);meter.push(sampleContext.getImageData(0,0,230,262).data);}
    }
    if(issues.size)throw new Error([...issues.values()].join("\n")+"\n请一次修复所有问题；不要把高于rect.body的画面裁剪隐藏。");
    const pixels=(t:number)=>{renderer.draw(t);return document.querySelector('canvas')!.toDataURL();};
    const first=pixels(0),middle=pixels(config.duration*.37);pixels(config.duration*.72);
    if(pixels(config.duration*.37)!==middle||pixels(config.duration)!==first)throw new Error('时间定位或循环非确定性。');
    const reduced=(at:number)=>{renderer.draw(at);sampleContext.drawImage(document.querySelector('canvas')!,0,0,1080,1920,0,0,230,262);return sampleContext.getImageData(0,0,230,262).data;};
    const start=reduced(0),last=reduced(config.duration-1/30);let seam=0,seamCount=0;
    for(let k=0;k<start.length;k+=4)for(let ch=0;ch<3;ch++){seam+=Math.abs(start[k+ch]-last[k+ch]);seamCount++;}
    if(seam/seamCount>=2)throw new Error('预览循环接缝变化超过阈值：'+(seam/seamCount).toFixed(2));
    return {framesChecked:config.duration*30+1,textPlacementsChecked:placements,normalGlyphAspect:true,loopIdentical:true,seekDeterministic:true,checks:checkResults,motion:meter?meter.result() as AnimationMotion:null};
  });
  if(inspected.motion)assertAnimationMotion(inspected.motion);
  return inspected;
}

async function capture(command:string,args:string[],maxBytes=4_000_000):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const child=spawnForJob(command,args,{stdio:['ignore','pipe','pipe']}),chunks:Buffer[]=[];let size=0,error='';
    child.stdout!.on('data',(b:Buffer)=>{size+=b.length;if(size>maxBytes){child.kill('SIGKILL');reject(new Error('媒体验证输出超过限制。'));}else chunks.push(b);});
    child.stderr!.on('data',(b:Buffer)=>{error=(error+b.toString()).slice(-4000);});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('媒体验证超时。'));},60000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks)):reject(new Error(error||'媒体验证失败。'));});
  });
}

export async function renderScienceVideo(o:{template:LoadedVideoTemplate;config:ScienceScene;references:ResearchReference[];directory:string;progress?:(frames:number,total:number)=>Promise<void>}) {
  const {template,config,directory}=o;
  if(config.program&&(config.program.selfCheck||currentTaskExecution()))assertScienceReceipt(config);
  await mkdir(directory,{recursive:true});const project=path.join(directory,'project');await mkdir(project);
  const [rendererBytes,sceneBytes,bgmBytes]=await Promise.all(['assets/integration/renderer.mjs','assets/integration/scene.mjs','assets/starter/audio/default-loop-16s.wav'].map(f=>readFile(path.join(template.directory,f))));
  await Promise.all([
    writeFile(path.join(project,'index.html'),await scienceHtml(template,config)),
    writeFile(path.join(project,'config.json'),JSON.stringify(config,null,2)),
    writeFile(path.join(project,'renderer.mjs'),rendererBytes),writeFile(path.join(project,'scene.mjs'),sceneBytes),
    writeFile(path.join(project,'references.json'),JSON.stringify(o.references,null,2)),
    cp(template.directory,path.join(project,'skill'),{recursive:true}),
    ...['motion-api.mjs','motion-metrics.mjs','reference-effects.mjs','project-builder.mjs','build-preview.mjs','preview.mjs','render-project.mjs','verify-project.mjs','module-builder.mjs'].map(f=>copyFile(path.join(template.directory,'assets/integration',f),path.join(project,f))),
    writeFile(path.join(project,'package.json'),JSON.stringify({name:'editable-science-animation',private:true,type:'module',scripts:{'build:preview':'node build-preview.mjs',preview:'node preview.mjs',render:'node render-project.mjs',verify:'node verify-project.mjs'},dependencies:{'puppeteer-core':'25.12.0','typescript':createRequire(import.meta.url)('typescript/package.json').version}},null,2)),
    ...(config.program?[writeFile(path.join(project,'scene.authored.js'),config.program.source),...(config.program.files||[]).map(async f=>{const file=path.resolve(project,'source',f.path);if(!file.startsWith(path.resolve(project,'source')+path.sep))throw Error('源码路径无效。');await mkdir(path.dirname(file),{recursive:true});await writeFile(file,f.content);})]:[]),
    writeFile(path.join(project,'制作说明.md'),'# 可编辑动态图工程 V2\n\nindex.html 可直接打开，播放并拖动查看当前版本。config.json 保存元数据；有source/目录时在其中编辑各模块及节点，build:preview会重新编译scene.authored.js；旧单文件工程直接编辑scene.authored.js；程序只在隔离浏览器内执行。\n\n编辑后：npm install（只安装固定版本puppeteer-core，不自动下载浏览器），npm run build:preview，npm run preview。\n\n重渲染需要现有Chromium、FFmpeg及中文字体。设置 QINGJIAN_CHROMIUM_PATH 为浏览器可执行文件，ANIMATED_VIDEO_FFMPEG 为FFmpeg路径（或已在PATH），运行 npm run render -- --out output/v2，再 npm run verify -- --out output/v2。渲染器拒绝覆盖已有视频，修改时使用新输出目录。生成的场景源码不会被Node导入或执行。\n\nmotion-api.mjs提供时间、缓动、轨迹、粒子、拖尾、辉光、矩阵、数值条和几何绘制接口；可在scene.authored.js中编写新函数。skill/保留原始制作资产与V2规则。references.json、layout.json、verification.json记录来源和本次检查；用户验收保持待确认。\n'),
    copyFile(path.join(template.directory,'assets/starter/audio/provenance.json'),path.join(project,'bgm-provenance.json')),
    ...(config.bgm?[writeFile(path.join(project,'bgm.wav'),bgmBytes)]:[]),
  ]);
  const view=await openSciencePage(template,config);
  const file=path.join(directory,'video.mp4'),cover=path.join(project,'poster.png');
  try {
    const layout=await inspectScienceLayout(view.page);await writeFile(path.join(project,'layout.json'),JSON.stringify(layout,null,2));
    const frame=async(t:number)=>Buffer.from(await view.page.evaluate(t=>{const s=(window as any).science;s.renderer.draw(t);return document.querySelector('canvas')!.toDataURL('image/png').split(',')[1];},t),'base64');
    const coverTimeSeconds=config.duration-.8;
    await writeFile(cover,await frame(coverTimeSeconds));
    const frames=path.join(directory,'frames');await mkdir(frames);
    for(let f=0;f<config.duration*30;f++){
      throwIfJobCancelled();await writeFile(path.join(frames,`frame-${String(f).padStart(5,'0')}.png`),await frame(f/30));
      if(f%30===0)await o.progress?.(f,config.duration*30);
    }
    // Bound the audio input before multiplexing. Some FFmpeg builds deadlock
    // shutting down an infinite demux loop after the video frame limit.
    const finiteBgm=path.join(directory,'bgm-finite.wav');
    if(config.bgm)await runFFmpeg(['-nostdin','-v','error','-stream_loop','-1','-i',path.join(project,'bgm.wav'),'-t',String(config.duration),'-c:a','pcm_s16le',finiteBgm],60000);
    const args=['-nostdin','-hide_banner','-loglevel','error','-framerate','30','-i',path.join(frames,'frame-%05d.png')];
    args.push('-map','0:v:0');
    args.push('-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','4','-frames:v',String(config.duration*30),'-t',String(config.duration));
    // FFmpeg 4.4 stops reading audio early when the video frame limit is reached.
    // Encode exact video frames first, then mux the complete finite soundtrack.
    const silentVideo=config.bgm?path.join(directory,'video-silent.mp4'):file;
    args.push('-movflags','+faststart',silentVideo);
    try{await runFFmpeg(args,Math.max(180000,config.duration*10000));}finally{await rm(frames,{recursive:true,force:true});}
    if(config.bgm)try{await runFFmpeg(['-nostdin','-v','error','-i',silentVideo,'-i',finiteBgm,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-af','volume=-3dB','-t',String(config.duration),'-movflags','+faststart',file],60000);}finally{await rm(silentVideo,{force:true});}
    const probePath=createRequire(import.meta.url)('ffprobe-static').path as string;
    const probe=JSON.parse((await capture(probePath,['-v','error','-count_frames','-show_streams','-show_format','-of','json',file])).toString());
    const video=probe.streams.find((s:any)=>s.codec_type==='video'),audio=probe.streams.find((s:any)=>s.codec_type==='audio');
    if(!video||video.codec_name!=='h264'||video.width!==1080||video.height!==1920||Number(video.nb_read_frames)!==config.duration*30||video.avg_frame_rate!=='30/1'||Math.abs(Number(video.duration)-config.duration)>.04||config.bgm&&(!audio||audio.codec_name!=='aac')||!config.bgm&&audio)throw new Error('成片帧数、画幅、时长或音轨校验未通过。');
    const motionV2=config.program?await measureEncodedAnimation(file,template,config.panels.length):null;
    if(motionV2)assertAnimationMotion(motionV2);
    const sampleFrames=[...new Set([0,60,120,180,240,Math.floor(config.duration*30*.84),config.duration*30-1].filter(f=>f<config.duration*30))].sort((a,b)=>a-b);
    // Passthrough must also work with Ubuntu 22.04's FFmpeg 4.4, which predates fps_mode.
    const sampled=await capture(ffmpeg||'ffmpeg',['-v','error','-i',file,'-vf',`select='${sampleFrames.map(f=>`eq(n,${f})`).join('+')}',scale=270:480`,'-vsync','0','-pix_fmt','rgb24','-f','rawvideo','-'],12_000_000);
    const frameBytes=270*480*3;if(sampled.length!==sampleFrames.length*frameBytes)throw new Error('抽帧解码数量不符。');
    const rows=Math.ceil(config.panels.length/2),panelH=(1045-(rows-1)*25)/rows;
    const motion=config.panels.map((_p,i)=>{
      const x=(80+i%2*470)/4,y=(500+Math.floor(i/2)*(panelH+25)+110)/4,bottom=(500+Math.floor(i/2)*(panelH+25)+panelH-35)/4;
      let maxDelta=0;
      for(let k=1;k<sampleFrames.length-1;k++){let sum=0,n=0;for(let yy=Math.ceil(y);yy<bottom;yy++)for(let xx=Math.ceil(x+5);xx<x+107;xx++){const p=(yy*270+xx)*3;for(let c=0;c<3;c++){sum+=Math.abs(sampled[k*frameBytes+p+c]-sampled[(k-1)*frameBytes+p+c]);n++;}}maxDelta=Math.max(maxDelta,sum/Math.max(1,n));}
      return {panel:i+1,bodyPixelDelta:maxDelta,passed:maxDelta>.3};
    });
    if(motion.some(m=>!m.passed))throw new Error('有面板的主体变化不足，请修改可见操作。');
    let seam=0,n=0;for(let i=0;i<frameBytes;i+=7){seam+=Math.abs(sampled[i]-sampled[(sampleFrames.length-1)*frameBytes+i]);n++;}seam/=n;
    if(seam>=2)throw new Error('循环衔接差异超过阈值。');
    let audioCheck:{correlation:number;peak:number;seconds:number}|null=null;
    if(config.bgm){
      const [actual,expected,stereo]=await Promise.all([
        capture(ffmpeg||'ffmpeg',['-v','error','-i',file,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-'],20_000_000),
        capture(ffmpeg||'ffmpeg',['-v','error','-i',finiteBgm,'-t',String(config.duration),'-af','volume=-3dB','-ac','1','-ar','48000','-f','f32le','-'],20_000_000),
        capture(ffmpeg||'ffmpeg',['-v','error','-i',file,'-map','0:a:0','-ac','2','-ar','48000','-f','f32le','-'],40_000_000),
      ]);
      const count=Math.min(actual.length,expected.length)/4;let sx=0,sy=0,sxx=0,syy=0,sxy=0,peak=0;
      for(let k=0;k<count;k++){const a=actual.readFloatLE(k*4),b=expected.readFloatLE(k*4);sx+=a;sy+=b;sxx+=a*a;syy+=b*b;sxy+=a*b;}
      for(let k=0;k<stereo.length;k+=4)peak=Math.max(peak,Math.abs(stereo.readFloatLE(k)));
      const correlation=(count*sxy-sx*sy)/Math.sqrt((count*sxx-sx*sx)*(count*syy-sy*sy));
      if(!Number.isFinite(correlation)||correlation<=.985||peak>=1||actual.length/4/48000<config.duration-.03)throw new Error('配乐相关性、峰值或时长检查未通过。');
      audioCheck={correlation,peak,seconds:actual.length/4/48000};
    }
    const verification={modelSelfCheck:config.program?.selfCheck||null,technicalPassed:true,userAccepted:false,width:1080,height:1920,fps:30,decodedFrames:Number(video.nb_read_frames),duration:Number(video.duration),hasNarration:false,hasBgm:config.bgm,animationMode:config.program?'code':'declarative',programSourceSha256:config.program?sha(config.program.source):null,motionV2,videoSha256:sha(await readFile(file)),coverTimeSeconds,coverSha256:sha(await readFile(cover)),skill:templateSelection(template),configSha256:sha(JSON.stringify(config)),sourceHashes:{renderer:sha(rendererBytes),scene:sha(sceneBytes),bgm:config.bgm?sha(bgmBytes):null},layout,bodyMotion:motion,loopSeamMeanAbsoluteError:seam,audio:audioCheck,limitations:['状态模型与结果为可复现教学示意，不代表真实模型推理或效果评测。','技术和运动覆盖率不等于用户视觉验收，需正常速度审阅机制表达与配乐。']};
    await writeFile(path.join(project,'verification.json'),JSON.stringify(verification,null,2));
    for(const name of ['authoring-review.json','self-checks']){try{await cp(path.join(directory,name),path.join(project,name),{recursive:true});}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
    const archive=path.join(directory,'project.zip');await archiveTemplateProject(project,archive);
    return {file,cover,archive,verification,config};
  } finally {await view.close();}
}
