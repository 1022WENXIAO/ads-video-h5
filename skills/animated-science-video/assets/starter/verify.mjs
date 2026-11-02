import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {ffmpeg,sha256} from './runtime.mjs';
const argv=process.argv.slice(2),cfgPath=path.resolve(argv.find(v=>v.endsWith('.json'))||'configs/compression.json'),cfg=JSON.parse(fs.readFileSync(cfgPath));
const out=path.resolve(argv.includes('--out')?argv[argv.indexOf('--out')+1]:'output/'+cfg.scene),render=JSON.parse(fs.readFileSync(path.join(out,'render.json'))),file=path.join(out,render.file);
function ff(args){const r=spawnSync(ffmpeg(),['-nostdin',...args],{maxBuffer:256*1024*1024});if(r.status!==0)throw Error(r.stderr?.toString()||r.error?.message);return r}
const md5=ff(['-v','error','-i',file,'-map','0:v:0','-f','framemd5','-']).stdout.toString(),frameCount=md5.split('\n').filter(l=>l&&!l.startsWith('#')).length;
if(frameCount!==cfg.duration*(cfg.fps||30))throw Error('Decoded frame count mismatch');
const metadata=ff(['-hide_banner','-i',file,'-f','null','-']).stderr.toString();if(!metadata.includes('1080x1920')||!metadata.includes('h264')||cfg.bgm&&!metadata.includes('aac'))throw Error('Codec/dimensions mismatch');
const fps=cfg.fps||30,last=frameCount-1,ns=[...new Set([0,Math.round(fps*2),Math.round(fps*4),Math.round(fps*6),Math.round(fps*8),Math.round(fps*10),Math.round(fps*cfg.duration*.84),last].filter(n=>n<frameCount))].sort((a,b)=>a-b);
const raw=ff(['-v','error','-i',file,'-vf',`select='${ns.map(n=>`eq(n,${n})`).join('+')}'`,'-fps_mode','passthrough','-pix_fmt','rgb24','-f','rawvideo','-']).stdout,frameBytes=1080*1920*3;
if(raw.length!==ns.length*frameBytes)throw Error('Sample frame decode mismatch');
const frames=ns.map((_,i)=>raw.subarray(i*frameBytes,(i+1)*frameBytes));
const layout=JSON.parse(fs.readFileSync(path.join(out,'layout.json'))),motion=[];
for(const [i,r] of layout.panels.entries()){
 let maxDelta=0;for(let k=1;k<frames.length-1;k++){let s=0,n=0;for(let y=Math.ceil(r.y+110);y<r.y+r.h-35;y+=3)for(let x=r.x+20;x<r.x+r.w-20;x+=3){const p=(y*1080+x)*3;for(let c=0;c<3;c++){s+=Math.abs(frames[k][p+c]-frames[k-1][p+c]);n++}}maxDelta=Math.max(maxDelta,s/n)}
 motion.push({panel:i+1,bodyPixelDelta:maxDelta,passed:maxDelta>.3});
}if(motion.some(m=>!m.passed))throw Error('A panel has insufficient measured motion');
let seam=0;for(let k=0;k<frameBytes;k+=7)seam+=Math.abs(frames[0][k]-frames.at(-1)[k]);seam/=Math.ceil(frameBytes/7);if(seam>=2)throw Error('Visible loop seam exceeds tolerance');
let audio=null;if(cfg.bgm){
 const actual=ff(['-v','error','-i',file,'-map','0:a:0','-ac','1','-ar','48000','-f','f32le','-']).stdout;
 const bgm=path.resolve(path.dirname(cfgPath),cfg.bgm);if(await sha256(fs.readFileSync(bgm))!==render.bgmSha256)throw Error('BGM source changed');
 const expected=ff(['-v','error','-stream_loop','-1','-i',bgm,'-t',String(cfg.duration),'-af',`volume=${cfg.bgmGainDb??-3}dB`,'-ac','1','-ar','48000','-f','f32le','-']).stdout;
 const n=Math.min(actual.length,expected.length)/4;let sx=0,sy=0,sxx=0,syy=0,sxy=0;
 for(let k=0;k<n;k++){const a=actual.readFloatLE(k*4),b=expected.readFloatLE(k*4);sx+=a;sy+=b;sxx+=a*a;syy+=b*b;sxy+=a*b}
 const corr=(n*sxy-sx*sy)/Math.sqrt((n*sxx-sx*sx)*(n*syy-sy*sy));
 const stereo=ff(['-v','error','-i',file,'-map','0:a:0','-ac','2','-ar','48000','-f','f32le','-']).stdout;let peak=0;for(let k=0;k<stereo.length;k+=4)peak=Math.max(peak,Math.abs(stereo.readFloatLE(k)));
 if(corr<=.985||peak>=1||actual.length/4/48000<cfg.duration-.03)throw Error('BGM correlation, peak or duration failed');audio={bgmCorrelation:corr,peak,seconds:actual.length/4/48000};
}
const hash=await sha256(fs.readFileSync(file));if(hash!==render.sha256)throw Error('Video source changed since rendering');
const report={passed:true,sha256:hash,decodedFrames:frameCount,width:1080,height:1920,bodyMotion:motion,loopSeamMeanAbsoluteError:seam,audio,userAccepted:false,subjectiveAudioListening:'not_claimed'};
fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
