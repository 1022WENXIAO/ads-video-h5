import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { EvaluationFixture } from '../shared/evaluationTypes';
import type { Evaluations } from './evaluations';
import { evaluationFileHash, EvaluationError } from './evaluations';
import { getModelConfig, type ModelConfig } from './modelRegistry';
import { generateAudio } from './providers';
import { probeVideo, runFFmpeg } from './core';
import { prepareLessonSpeech } from './lessonAudio';
import { throwIfJobCancelled } from './jobExecution';

export const RELEASE_FIXTURE_VERSION = 'controlled-semantic-v3';
/** Reserved for the final 960×540 editing subtitles, including their outline. */
export const RELEASE_FIXTURE_CAPTION_ZONE = { top: 400, bottom: 480 } as const;
const fixtureVersion = RELEASE_FIXTURE_VERSION;
// The spoken content is unchanged. An illustration upgrade must not buy the
// same two speech clips again, including on an already-provisioned server.
const speechCacheVersion = 'controlled-spoken-v1';
const lines = [
  '观察一个现象时，先记录看到了什么，再提出可能的解释。这段画面是程序绘制的示意，不是真实现场。把观察和推测分开，可以让表达更清楚，也让后续核验有明确的方向。',
  '比较两个方案时，要先保持比较条件一致，再看差异来自哪里。这段画面也是程序绘制的示意。结论应当由证据支持，暂时没有把握的部分，需要保留限制，不能把猜测说成事实。',
];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function releaseEvaluationFixtureContext() {
  return '两段素材均为横屏动态图解，配有完整普通话原声，明确标注程序示意、非真实现场。第一段以小球运动、观测轨迹、候选原因和重复观测展示“观察→解释→证据”，强调把观察和推测分开；第二段以同条件双轨道、小车对比和证据边界展示“条件一致→比较→结论”，强调保留不确定限制。可以做这两种方法的说明、对照或重点精剪；没有真人、品牌产品、实景、采访或具体新闻事件画面，不应要求不存在的内容。';
}

type WordTiming = { text: string; start: number; end: number };
interface FixtureCue { name: string; phrase: string; start: number }
const cuePhrases = [['先记录','可能的解释','后续核验'],['保持比较条件一致','再看差异','结论应当由证据支持']];
const cueNames = [['观察','解释','证据'],['条件一致','比较','结论']];
export function releaseFixtureCues(index: number, duration: number, words: WordTiming[] = [], leadingTrim = 0): { method: string; cues: FixtureCue[] } {
  const compact = (value: string) => value.replace(/[\s，。；！？、,.!?;]/g,'');
  const spoken = compact(lines[index]), recognized = words.flatMap(word => [...compact(word.text)].map(text => ({...word,text}))), recognizedText = recognized.map(w => w.text).join('');
  let aligned = true;
  const cues = cuePhrases[index].map((phrase,i) => {
    const at = recognizedText.indexOf(phrase), textAt = spoken.indexOf(phrase);
    if (at < 0) aligned = false;
    const start = i === 0 ? 0 : at >= 0 ? Math.max(0,recognized[at].start - leadingTrim) : Math.max(.4,duration * textAt / spoken.length);
    return {name:cueNames[index][i],phrase,start:+Math.min(duration-.5,start).toFixed(3)};
  });
  return {method:aligned ? 'reused-recognized-word-timing' : 'text-position-estimate-no-new-asr',cues};
}

const assTime = (seconds: number) => { const n=Math.round(seconds*100); return `${Math.floor(n/360000)}:${String(Math.floor(n/6000)%60).padStart(2,'0')}:${String(Math.floor(n/100)%60).padStart(2,'0')}.${String(n%100).padStart(2,'0')}`; };
const assText = (value: string) => value.replace(/[{}\\]/g,'').replace(/\n/g,'\\N');
const assColor = (value: string) => value.replace('#','').match(/../g)!.reverse().join('').toUpperCase();
const filterPath = (value: string) => value.replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"'\\''");

/** Real moving objects, measured tracks and causal/comparison diagrams. Labels
 * explain the geometry; they do not substitute a generic text card for it. */
export function releaseFixtureStoryboard(index: number, duration: number, cues = releaseFixtureCues(index,duration).cues) {
  const ink='#19364a', muted='#657888', blue='#238aaf', amber='#c96c37', green='#41816a', pale='#e6eef1', background='#f9f7f1';
  const font=process.env.QINGJIAN_SUBTITLE_FONT || (process.platform==='darwin'?'PingFang SC':'Noto Sans CJK SC');
  if (!/^[\w \u4e00-\u9fff-]{1,80}$/.test(font)) throw new EvaluationError('受控素材字体配置无效。');
  const events: string[] = [], labels: string[] = [], objects: string[] = [];
  const labelBounds: Array<{ text: string; x: number; y: number; height: number }> = [];
  const event = (start: number, end: number, content: string, layer=0) => events.push(`Dialogue: ${layer},${assTime(start)},${assTime(end)},base,,0,0,0,,${content}`);
  const text = (value: string,x:number,y:number,size=25,color=ink,start=0,end=duration) => {labels.push(value);labelBounds.push({text:value,x,y,height:size*1.2});event(start,end,`{\\an7\\pos(${x},${y})\\fs${size}\\c&H${assColor(color)}&\\bord0\\shad0}${assText(value)}`,5);};
  const shape = (name:string,x:number,y:number,geometry:string,color:string,start=0,end=duration,animation='',border=0,outline=color) => {objects.push(name);event(start,end,`{\\an7${animation || `\\pos(${x},${y})`}\\p1\\c&H${assColor(color)}&\\bord${border}\\3c&H${assColor(outline)}&\\shad0}${geometry}`,2);};
  const rect = (name:string,x:number,y:number,w:number,h:number,color:string,start=0,end=duration) => shape(name,x,y,`m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`,color,start,end);
  const circlePath = (r:number) => `m ${r*2} ${r} b ${r*2} ${r*.448} ${r*1.552} 0 ${r} 0 b ${r*.448} 0 0 ${r*.448} 0 ${r} b 0 ${r*1.552} ${r*.448} ${r*2} ${r} ${r*2} b ${r*1.552} ${r*2} ${r*2} ${r*1.552} ${r*2} ${r}`;
  const circle = (name:string,x:number,y:number,r:number,color:string,start=0,end=duration,animation='',border=0,outline=color) => shape(name,x-r,y-r,circlePath(r),color,start,end,animation,border,outline);
  const arrow = (name:string,x:number,y:number,w:number,color:string,start=0,end=duration) => shape(name,x,y,`m 0 5 l ${w-12} 5 ${w-12} 0 ${w} 10 ${w-12} 20 ${w-12} 15 0 15`,color,start,end);
  const check = (x:number,y:number,start:number,end=duration) => shape('evidence-check',x,y,'m 0 13 l 7 6 17 16 37 0 43 7 17 28',green,start,end);
  text(index ? '公平比较，结论才有依据' : '先观察，再解释',40,24,34);
  text('程序示意 · 非真实现场',676,36,18,muted);
  const stepX = [72,340,620];
  cues.forEach((cue,i) => {
    rect('process-step-background',stepX[i]-24,96,228,48,pale);
    text(cue.name,stepX[i],105,25,muted);
    if (i<2) arrow('process-connector',stepX[i]+220,110,36,muted);
    const end=cues[i+1]?.start??duration;
    rect('active-process-step',stepX[i]-24,96,228,48,i===0?blue:i===1?amber:green,cue.start,end);
    text(cue.name,stepX[i],105,25,'#ffffff',cue.start,end);
  });
  if (!index) {
    text('看到的运动',68,174,25,blue); text('可能的解释',567,174,25,amber);
    // A physical-looking ramp and ball positions carry the observation.
    shape('inclined-ramp',65,247,'m 0 0 l 355 108 355 128 0 20','#b3c1c8');
    rect('floor',60,393,375,5,ink);
    for(let i=0;i<3;i++) {
      const x=105+i*122,y=244+i*37;
      circle('observed-position',x,y,11,background,0,duration,'',2,blue);
      text(String(i+1),x-5,y+23,19,muted);
    }
    const cycle=Math.max(2,Math.min(4.5,duration/4));
    for(let begin=0;begin<duration;begin+=cycle) {
      const end=Math.min(duration,begin+cycle);
      circle('rolling-ball',0,0,16,blue,begin,end,`\\move(84,223,328,297,0,${Math.round((end-begin)*1000)})`);
    }
    text('位置记录',151,411,22,blue);
    // Two alternative causes remain explicitly uncertain until checked.
    shape('candidate-slope',579,237,'m 0 50 l 88 50 0 0','#dce5e8');
    arrow('candidate-cause-arrow',688,251,48,amber);
    circle('candidate-result',766,261,14,amber);
    text('斜坡？',585,302,21,amber);
    for(let i=0;i<3;i++)arrow('candidate-push',584,337+i*12,78,amber);
    circle('pushed-object',709,352,14,amber);
    text('外力？',757,335,21,amber);
    rect('observation-inference-separator',480,178,2,255,'#c6d2d8');
    text('观察 ≠ 推测',360,68,22,ink);
    const verify=cues[2].start;
    for(let i=0;i<3;i++) {
      circle('repeated-evidence-point',590+i*80,397,8,green,verify);
      if(i<2)rect('repeat-connection',598+i*80,395,64,4,green,verify);
    }
    check(814,365,verify);text('重复观察，核验解释',567,68,21,green,verify);
  } else {
    // Equal tracks and clocks make the shared comparison conditions visible.
    text('方案 A',108,176,26,blue); text('方案 B',557,176,26,amber);
    rect('track-A',82,351,340,5,ink); rect('track-B',531,351,340,5,ink);
    for(const offset of [82,531]) {
      rect('same-start-marker',offset+18,259,3,95,muted);
      for(let i=0;i<5;i++)rect('equal-distance-tick',offset+20+i*72,354,2,12,muted);
      circle('same-clock',offset+285,219,22,background,0,duration,'',2,muted);
      rect('clock-hand',offset+284,202,3,17,muted);
      rect('clock-hand',offset+285,217,13,3,muted);
      text('相同起点 · 相同计时',offset,384,21,muted);
    }
    const car=(name:string,offset:number,color:string,travel:number) => {
      const start=cues[1].start,end=Math.min(duration,start+4.5);
      const body='m 0 18 l 8 18 19 0 63 0 77 18 87 18 87 40 0 40';
      shape(`${name}-body`,offset+20,299,body,color,0,start);
      for(const x of [18,68])circle(`${name}-wheel`,offset+20+x,342,10,ink,0,start);
      shape(`${name}-body-moving`,0,0,body,color,start,end,`\\move(${offset+20},299,${offset+travel},299)`);
      for(const x of [18,68])circle(`${name}-wheel-moving`,0,0,10,ink,start,end,`\\move(${offset+20+x-10},332,${offset+travel+x-10},332)`);
      shape(`${name}-body-arrived`,offset+travel,299,body,color,end,duration);
      for(const x of [18,68])circle(`${name}-wheel-arrived`,offset+travel+x,342,10,ink,end,duration);
    };
    car('cart-A',82,blue,166);car('cart-B',531,amber,210);
    text('同一条件',397,174,23,ink);
    arrow('A-measured-travel',106,281,192,blue,cues[1].start);
    arrow('B-measured-travel',555,281,236,amber,cues[1].start);
    const conclusion=cues[2].start;
    check(240,67,conclusion); text('证据支持的结论',292,68,22,green,conclusion);
    circle('uncertainty-boundary',650,80,14,background,conclusion,duration,'',2,amber);
    text('?',644,67,22,amber,conclusion);text('未知部分保留限制',682,68,22,amber,conclusion);
    text('差异仅为方法示意，不代表实际产品性能',235,486,18,muted);
  }
  const ass=`[Script Info]\nScriptType: v4.00+\nPlayResX: 960\nPlayResY: 540\nWrapStyle: 2\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: base,${font},25,&H004A3619,&H004A3619,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${events.join('\n')}\n`;
  return {ass,labels:[...new Set(labels)],labelBounds,objects:[...new Set(objects)],cues,background};
}

async function recognizedFixtureWords(evaluations: Evaluations,dataDir:string,index:number): Promise<WordTiming[]> {
  const hashes=new Set(evaluations.catalog().fixtures.filter(f=>f.name===`${speechCacheVersion}-${index+1}.mp4`).map(f=>f.sha256));
  if(!hashes.size)return [];
  try {
    const state=JSON.parse(await readFile(path.join(dataDir,'app-state.json'),'utf8'));
    const item=(state.media||[]).find((m:{name?:string;analysis?:{sourceHash?:string;sentences?:Array<{words?:WordTiming[]}>}})=>m.name===`${speechCacheVersion}-${index+1}.mp4`&&m.analysis?.sourceHash&&hashes.has(m.analysis.sourceHash));
    const words=item?.analysis?.sentences?.flatMap((s:{words?:WordTiming[]})=>s.words||[])||[];
    return words.filter((w:WordTiming)=>typeof w.text==='string'&&Number.isFinite(w.start)&&Number.isFinite(w.end)&&w.end>w.start);
  } catch {return [];}
}

/** Persistent real MP4s and real synthesized speech, never fake analyses or passing artifacts. */
export async function ensureReleaseEvaluationFixtures(evaluations: Evaluations, dataDir: string, dependencies: { audioConfig?: ModelConfig; generateSpeech?: typeof generateAudio } = {}): Promise<EvaluationFixture[]> {
  const candidates = evaluations.catalog().fixtures.filter(f => f.name.startsWith(`${fixtureVersion}-`) && f.hasAudio && f.duration >= 12);
  const existing: EvaluationFixture[] = [];
  for (const fixture of candidates) {
    throwIfJobCancelled();
    try {
      // Catalog metadata cannot establish that a cached source still exists.
      const source = path.join(dataDir, 'evaluations', 'fixtures', fixture.id);
      if ((await stat(source)).size !== fixture.bytes || await evaluationFileHash(source) !== fixture.sha256) continue;
      const probe = await probeVideo(source);
      if (probe.hasAudio && probe.duration >= 12 && !existing.some(f => f.name === fixture.name)) existing.push(fixture);
    } catch { throwIfJobCancelled(); /* Missing, unreadable or corrupt cached movies must be rebuilt. */ }
  }
  if (['1','2'].every(n => existing.some(f => f.name === `${fixtureVersion}-${n}.mp4`))) return ['1','2'].map(n => existing.find(f => f.name === `${fixtureVersion}-${n}.mp4`)!);
  const audioConfig = dependencies.audioConfig || await getModelConfig('audio');
  if (!audioConfig) throw new EvaluationError('自动剪辑验收缺少受控视频素材且配音模型未配置，无法创建真实原声素材。');
  const directory = path.join(dataDir, 'evaluations', 'controlled-fixtures', fixtureVersion), speechDirectory=path.join(dataDir,'evaluations','controlled-fixtures',speechCacheVersion);
  await Promise.all([mkdir(directory,{recursive:true}),mkdir(speechDirectory,{recursive:true})]);
  const fixtures: EvaluationFixture[] = [];
  for (let i = 0; i < 2; i++) {
    throwIfJobCancelled();
    const name = `${fixtureVersion}-${i + 1}.mp4`, bound = existing.find(f => f.name === name);
    if (bound) { fixtures.push(bound); continue; }
    const speech = path.join(speechDirectory, `${i + 1}.audio`), video = path.join(directory, name);
    let bytes: Buffer;
    try { bytes = await readFile(speech); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const reference = i ? await readFile(path.join(speechDirectory, '1.audio')) : undefined;
      bytes = (await (dependencies.generateSpeech || generateAudio)(`${reference ? '使用@Audio1相同说话者、音色和录音环境。' : ''}生成清晰自然的普通话讲解，只朗读台词，不要背景音乐。台词：${lines[i]}`, audioConfig, reference)).bytes;
      const temporary = `${speech}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary,speech);
    }
    throwIfJobCancelled();
    const prepared=path.join(directory,`${i+1}.wav`), preparation=await prepareLessonSpeech(speech,prepared);
    const timing=releaseFixtureCues(i,preparation.duration,await recognizedFixtureWords(evaluations,dataDir,i),preparation.leadingTrim);
    const story=releaseFixtureStoryboard(i,preparation.duration,timing.cues), assFile=path.join(directory,`${i+1}.ass`);
    await writeFile(assFile,story.ass,{mode:0o600});
    const fonts=process.env.QINGJIAN_FONTS_DIR || (process.platform==='darwin'?'/System/Library/Fonts':'/usr/share/fonts');
    await runFFmpeg(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i',`color=c=${story.background}:size=960x540:rate=24`,'-i',prepared,'-map','0:v:0','-map','1:a:0','-vf',`ass=filename='${filterPath(assFile)}':fontsdir='${filterPath(fonts)}'`,'-c:v','libx264','-threads','2','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-t',String(preparation.duration),'-movflags','+faststart',video]);
    const probe = await probeVideo(video);
    if (!probe.hasAudio || probe.duration < 12) throw new EvaluationError('受控剪辑素材的真实音轨或时长不足，不能跳过剪辑验收。');
    await runFFmpeg(['-hide_banner','-v','error','-xerror','-i',video,'-f','null','-']);
    const fixture=await evaluations.saveFixture(video,name);
    await writeFile(path.join(directory,`${i+1}.storyboard.json`),JSON.stringify({version:fixtureVersion,narration:lines[i],narrationHash:hash(lines[i]),audioHash:hash(bytes),preparedAudioHash:await evaluationFileHash(prepared),leadingTrim:preparation.leadingTrim,trailingTrim:preparation.trailingTrim,duration:probe.duration,timingMethod:timing.method,cues:story.cues,labels:story.labels,labelBounds:story.labelBounds,captionZone:RELEASE_FIXTURE_CAPTION_ZONE,diagramObjects:story.objects,assHash:hash(story.ass),videoHash:fixture.sha256,fixtureId:fixture.id}),{mode:0o600});
    fixtures.push(fixture);
  }
  return fixtures;
}
