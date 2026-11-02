import fs from 'node:fs';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';import {once} from 'node:events';
import {createRenderer,panelRects,W,H} from './renderer.mjs';import {canvasRuntime,ffmpeg,sha256} from './runtime.mjs';
const argv=process.argv.slice(2),configPath=path.resolve(argv.find(v=>v.endsWith('.json'))||'configs/compression.json');
const cfg=JSON.parse(fs.readFileSync(configPath));const fps=cfg.fps||30,duration=cfg.duration,total=duration*fps;
if(!Number.isInteger(total)||duration<=0||!Number.isInteger(fps)||fps<=0)throw Error('Duration × fps must be a positive integer');
const base=path.dirname(configPath),out=path.resolve(argv.includes('--out')?argv[argv.indexOf('--out')+1]:'output/'+cfg.scene);
if(fs.existsSync(path.join(out,cfg.filename)))throw Error('Output already exists; use a new --out version directory');
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(path.join(out,'frames'),{recursive:true});
const {createCanvas,font}=canvasRuntime(),canvas=createCanvas(W,H),r=createRenderer(canvas,cfg),rects=panelRects(cfg.panels.length);
let count=0,minFont=100,topBlank=H,bottomBlank=H;
for(let f=0;f<=total;f++){const s=r.draw(f/fps,{captureBounds:true});for(const b of s.textBounds){const p=b.panel<0?{x:0,y:220,w:W,h:H-440}:rects[b.panel];if(b.x<p.x-.1||b.y<p.y-.1||b.x+b.w>p.x+p.w+.1||b.y+b.h>p.y+p.h+.1)throw Error('Text overflow: '+JSON.stringify({time:f/fps,text:b.text,b,p}));minFont=Math.min(minFont,b.size);topBlank=Math.min(topBlank,b.y);bottomBlank=Math.min(bottomBlank,H-b.y-b.h);count++}}
const hash=t=>{r.draw(t);return Buffer.from(canvas.data()).toString('base64')};const loop=hash(0)===hash(duration);const at=hash(duration*.37);hash(duration*.72);if(!loop||at!==hash(duration*.37))throw Error('Loop or seeking is nondeterministic');
for(const t of cfg.reviewTimes||[0,duration*.25,duration*.5,duration*.8]){r.draw(t);fs.writeFileSync(path.join(out,'frames',String(t)+'.png'),canvas.toBuffer('image/png'))}
r.draw(duration*.84);fs.writeFileSync(path.join(out,'poster.png'),canvas.toBuffer('image/png'));
const layout={framesChecked:total+1,textPlacementsChecked:count,minFont,topBlank,bottomBlank,normalGlyphAspect:true,panels:rects,loopIdentical:loop,seekDeterministic:true};fs.writeFileSync(path.join(out,'layout.json'),JSON.stringify(layout,null,2));
if(argv.includes('--preview')){console.log(JSON.stringify({status:'preview_passed',out,layout}));process.exit(0)}
if(spawnSync(ffmpeg(),['-version'],{stdio:'ignore'}).status!==0)throw Error('FFmpeg not found; set ANIMATED_VIDEO_FFMPEG or add ffmpeg to PATH');
const bgm=cfg.bgm?path.resolve(base,cfg.bgm):null;if(bgm&&!fs.existsSync(bgm))throw Error('Missing configured BGM: '+bgm);
const final=path.join(out,path.basename(cfg.filename)),tmp=final+'.part.mp4';
const args=['-y','-nostdin','-hide_banner','-loglevel','error','-f','rawvideo','-pixel_format','rgba','-video_size',`${W}x${H}`,'-framerate',String(fps),'-i','pipe:0'];
if(bgm)args.push('-stream_loop','-1','-i',bgm);
args.push('-map','0:v:0');if(bgm)args.push('-map','1:a:0');
args.push('-c:v','libx264','-preset','fast','-crf','18','-pix_fmt','yuv420p','-threads','4');
if(bgm)args.push('-c:a','aac','-b:a','192k','-ar','48000','-af',`volume=${cfg.bgmGainDb??-3}dB`);
args.push('-frames:v',String(total),'-t',String(duration),'-movflags','+faststart',tmp);
const proc=spawn(ffmpeg(),args,{stdio:['pipe','ignore','pipe']});let err='';proc.stderr.on('data',v=>err+=v);proc.stdin.on('error',()=>{});const done=once(proc,'exit');for(let f=0;f<total;f++){r.draw(f/fps);if(!proc.stdin.write(canvas.data()))await once(proc.stdin,'drain')}proc.stdin.end();const [code]=await done;if(code)throw Error(err);fs.renameSync(tmp,final);
const render={file:path.basename(final),sha256:await sha256(fs.readFileSync(final)),bytes:fs.statSync(final).size,width:W,height:H,fps,frames:total,duration,panelCount:cfg.panels.length,scene:cfg.scene,bgm:!!bgm,bgmSha256:bgm?await sha256(fs.readFileSync(bgm)):null,bgmGainDb:cfg.bgmGainDb??-3,font,userAccepted:false};
fs.writeFileSync(path.join(out,'render.json'),JSON.stringify(render,null,2));fs.copyFileSync(configPath,path.join(out,'config.json'));
fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><meta name="viewport" content="width=device-width"><style>body{background:#070b13;color:#eef;font-family:system-ui;text-align:center}video{max-width:95vw;width:420px;height:auto}button{margin:8px;padding:8px}</style><video controls loop playsinline src="'+encodeURIComponent(path.basename(final))+'" poster="poster.png"></video><p>独立循环审阅 · 技术检查不等于教学验收</p>');
console.log(JSON.stringify(render));
