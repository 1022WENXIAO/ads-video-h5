import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {alignLessonSpeech,lessonPacing,lessonSettings,spokenLessonText,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {lessonVoiceStyle,prepareLessonSpeech,tightenNewsSpeechSilence} from '../server/lessonAudio';
import {hashBytes} from '../server/narrativeScenes';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import {probeAudio,runFFmpeg} from '../server/core';
import type {AudioAnalysis,LessonChapter,WorkflowEvent} from '../src/types';

// Replay the actual P13 clock wording in a controlled narration-stage fixture.
// Sine waves and stub ASR exercise recovery/state/hash contracts only: they do
// not establish audible speech, news truth, or a completed accepted movie.
const prompt='制作45秒竖屏知识图解视频，解释服务状态中的事件时间';
const STOP=new Error('Controlled stop at next stage; no full-video acceptance');
const config={id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture-not-a-secret',modelId:'fixture'};
const audioConfig={...config,kind:'audio' as const,baseUrl:'https://openspeech.bytedance.com',modelId:'seed-audio-1.0'};
const clockNarration='PANews援引官方状态页称，八点十一分起部分中断，涉及对话、V4 Pro API和V4.1 Flash API。九点零八更新为原因已查明，恢复进行中。';

function heard(chapter:LessonChapter,bytes:Buffer,text:string,duration:number):AudioAnalysis{
  const chars=[...text];
  return{status:'ready',modelId:'controlled-asr',sourceHash:hashBytes(bytes),duration,transcript:text,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',start:0,end:duration,text,complete:true,words:chars.map((text,i)=>({text,start:duration*i/chars.length,end:duration*(i+1)/chars.length}))}]};
}
function causedBy(error:unknown,target:unknown):boolean{
  const seen=new Set<unknown>();let next=error;
  while(next&&typeof next==='object'&&!seen.has(next)){if(next===target)return true;seen.add(next);next=(next as Error).cause;}
  return false;
}
async function fixture(directory:string){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=[{id:'r1',title:'Controlled state source',url:'https://example.invalid/status',verification:'primary-page' as const,excerpt:'Controlled recovery fixture, not fresh news evidence.'}];
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'ch'+(i+1),title:i===1?'哪些服务受影响':'时间解释'+i,role:i===0?'hook':i===1?'foundation':'recap',goal:'区分事件时间与观察时间',prerequisites:i?['ch'+i]:[],narration:i===1?clockNarration:'误差变大损失越高。'.repeat(7),reason:'先定义再比较',referenceIds:['r1'],claims:[{text:'区分事件时间与观察时间',referenceIds:['r1']}],visual:i===1?{kind:'timeline',takeaway:'08:11异常，09:08查明原因',items:[{label:'08:11 部分中断',detail:'Web及API受影响',cue:'八点十一分起部分中断'},{label:'09:08 原因已查明',detail:'恢复工作进行中',cue:'九点零八'}]}:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
  const report=validateLesson({workflowId:'clock-recovery-fixture',...lessonSettings(prompt),title:'状态页中的时间',audience:'初学者',objectives:['区分观察与事件时间','读懂时钟'],arc:'先记录，再看状态更新，最后核对边界',chapters,references,limitations:['Controlled state recovery only.'],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:audioConfig.modelId,anchorHash:'pending',revision:0,tempo:1},factReview:{score:92,needsRepair:false,findings:[]}},prompt);
  const tone=path.join(directory,'controlled-tone.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',tone]);
  const anchor=await readFile(tone),anchorHash=hashBytes(anchor),pacing=lessonPacing(prompt),voiceStyle=lessonVoiceStyle(pacing,lessonPresentation(prompt)),anchorLine='接下来，我们从一个简单的例子开始，把问题讲清楚。';
  await writeFile(path.join(work,'voice-anchor.mp3'),anchor);await writeFile(path.join(work,'voice-anchor.json'),JSON.stringify({seedKey:hashBytes(JSON.stringify({model:audioConfig.modelId,revision:0,voiceStyle,anchorLine})),hash:anchorHash}));report.voice!.anchorHash=anchorHash;
  const edge=path.join(directory,'edge.wav'),prepared=path.join(directory,'prepared.wav'),tempo=path.join(directory,'tempo.wav'),paced=path.join(directory,'paced.wav'),adjusted=path.join(directory,'speech.mp3');
  await prepareLessonSpeech(tone,edge);await tightenNewsSpeechSilence(edge,prepared,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',prepared,'-af','atempo=1','-ar','48000','-ac','1','-c:a','pcm_s16le',tempo]);await tightenNewsSpeechSilence(tempo,paced,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',paced,'-ar','48000','-ac','1',adjusted]);
  const bytes=await readFile(adjusted),duration=await probeAudio(adjusted),speechHash=hashBytes(bytes),rawHash=hashBytes(anchor);
  for(const chapter of report.chapters){
    const dir=path.join(work,chapter.id);await mkdir(dir);await copyFile(tone,path.join(dir,'raw-speech.mp3'));await copyFile(adjusted,path.join(dir,'speech.mp3'));
    await writeFile(path.join(dir,'raw-speech.json'),JSON.stringify({key:hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:audioConfig.modelId,anchorHash,voiceRevision:0,chapterRevision:0,voiceStyle})),hash:rawHash}));
    if(chapter.id!=='ch2')await writeFile(path.join(dir,'speech-analysis.json'),JSON.stringify(heard(chapter,bytes,chapter.narration,duration)));
    await writeFile(path.join(dir,'analysis-key.json'),JSON.stringify({hash:speechHash,id:'cached-'+chapter.id}));
  }
  const checkpoint={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'narration',rendererHash:lessonRendererHash(),requestedAt:Date.now(),research:{summary:'Controlled prior research; no discovery in this test.',queries:[],references},report,voiceRevision:0,chapterVoiceRevisions:{}};
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
  const events:WorkflowEvent[]=[],stages:string[]=[];
  const options={prompt,config,audioConfig,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,
    analyze:async()=>{throw new Error('Unexpected recognition');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async(value:WorkflowEvent[])=>{events.splice(0,events.length,...value);},
    stage:async(stage:string)=>{stages.push(stage);if(stage==='绘制公式、曲线与教学分镜'||stage==='规划 · 定向返修教学章节')throw STOP;},
    render:async()=>{throw new Error('Unexpected final render');},review:async()=>{throw new Error('Unexpected final review');}};
  return{work,report,options,events,stages,rawHash,speechHash};
}

test('P13 wrong clock gets one independent recheck of the identical waveform without any new TTS',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-clock-recheck-')),originalFetch=globalThis.fetch;let requests=0;
  try{
    globalThis.fetch=async()=>{requests++;throw new Error('No provider request allowed');};
    const s=await fixture(directory),chapter=s.report.chapters[1],hashes:string[]=[],ids:string[]=[];let recognitions=0;
    const wrong=heard(chapter,await readFile(path.join(s.work,'ch2/speech.mp3')),clockNarration.replace('八点十一分','八点十分'),14.6);
    assert.throws(()=>alignLessonSpeech(chapter,wrong),/时钟/,'08:10 remains a rejected clock, even when the rest matches');
    await assert.rejects(runLessonWorkflow({...s.options,analyze:async(item:any,file:string)=>{
      recognitions++;assert.equal(path.basename(path.dirname(file)),'ch2');const bytes=await readFile(file);hashes.push(hashBytes(bytes));ids.push(item.id);
      return heard(chapter,bytes,recognitions===1?clockNarration.replace('八点十一分','八点十分'):clockNarration,await probeAudio(file));
    }}),error=>error===STOP);
    assert.equal(recognitions,2);assert.deepEqual(hashes,[s.speechHash,s.speechHash]);assert.notEqual(ids[0],ids[1]);assert.equal(requests,0);
    assert.equal(s.events.filter(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor').length,0);
    assert.equal(s.events.filter(e=>e.tool==='verify_chapter_speech'&&e.status==='failed').length,1);assert.equal(s.events.filter(e=>e.tool==='verify_chapter_speech'&&e.status==='succeeded').length,1);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'scenes');assert.equal(saved.voiceRevision,0);assert.deepEqual(saved.chapterVoiceRevisions,{});
    for(const id of ['ch1','ch2','ch3'])assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),s.speechHash);
    assert.equal(saved.report.chapters[1].speechMatch,1);assert.equal(saved.report.factReview.needsRepair,false);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('persistent wrong clock stays rejected and exhausts only the existing one-retake budget before script repair',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-clock-bounded-')),originalFetch=globalThis.fetch;
  try{
    const s=await fixture(directory),chapter=s.report.chapters[1],next=path.join(directory,'controlled-retake.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',next]);const nextBytes=await readFile(next);let requests=0,recognitions=0;const hashes:string[]=[];
    globalThis.fetch=async(url,init)=>{requests++;assert.equal(requests,1,'only one existing controlled retake is allowed');assert.equal(new URL(String(url)).host,'openspeech.bytedance.com');assert.match(String(init?.body),/上次核验发现/);return Response.json({code:0,audio:nextBytes.toString('base64'),duration:14.56});};
    await assert.rejects(runLessonWorkflow({...s.options,analyze:async(_item:any,file:string)=>{recognitions++;const bytes=await readFile(file);hashes.push(hashBytes(bytes));return heard(chapter,bytes,clockNarration.replace('八点十一分','八点十分'),await probeAudio(file));}}));
    assert.equal(requests,1);assert.equal(recognitions,4);assert.deepEqual(hashes.slice(0,2),[s.speechHash,s.speechHash]);assert.equal(hashes[2],hashes[3]);assert.notEqual(hashes[2],s.speechHash);
    assert.equal(s.events.filter(e=>e.tool==='synthesize_chapter').length,1);assert.equal(s.events.filter(e=>e.tool==='verify_chapter_speech'&&e.status==='failed').length,4);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'script');assert.match(saved.feedback,/有限复听和重录/);assert.match(saved.feedback,/定向改写/);assert.equal(saved.voiceRevision,0);assert.deepEqual(saved.chapterVoiceRevisions,{});
    for(const id of ['ch1','ch3'])assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),s.speechHash);
    for(const hash of [s.rawHash,hashBytes(nextBytes)])assert.equal(hashBytes(await readFile(path.join(s.work,'ch2/takes',hash+'.mp3'))),hash);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

for(const kind of ['authorization','filesystem','cancel'] as const)test(`recognition ${kind} failure never becomes clock repair or a media retake`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-clock-technical-')),originalFetch=globalThis.fetch;let requests=0;
  try{
    const s=await fixture(directory),controller=new AbortController();let recognitions=0;
    const failure=kind==='authorization'?Object.assign(new Error('ASR数字匹配失败 HTTP 401'),{status:401}):kind==='filesystem'?Object.assign(new Error('ASR数字匹配缓存读取失败'),{code:'EACCES'}):new JobCancelledError();
    globalThis.fetch=async()=>{requests++;throw new Error('A technical failure cannot submit media');};
    await assert.rejects(runWithJobSignal(controller.signal,()=>runLessonWorkflow({...s.options,analyze:async()=>{recognitions++;if(kind==='cancel')controller.abort();throw failure;}})),error=>kind==='cancel'?error instanceof JobCancelledError:causedBy(error,failure));
    assert.equal(recognitions,1);assert.equal(requests,0);assert.equal(s.events.some(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor'||e.tool==='verify_chapter_speech'),false);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'narration');assert.equal(saved.voiceRevision,0);assert.equal(hashBytes(await readFile(path.join(s.work,'ch2/raw-speech.mp3'))),s.rawHash);
    assert.equal(hashBytes(await readFile(path.join(s.work,'ch2/speech.mp3'))),s.speechHash);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
