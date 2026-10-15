import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AudioAnalysis,LessonChapter,WorkflowEvent} from '../src/types';
import {alignLessonSpeech,correctLessonTranscript,lessonPacing,lessonSettings,spokenLessonText,validateLesson} from '../server/lessonSpec';
import {NarrationVerificationError,verifyNarrationSpeech} from '../server/narrationAnalysisRecovery';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {lessonVoiceStyle,prepareLessonSpeech,tightenNewsSpeechSilence} from '../server/lessonAudio';
import {hashBytes} from '../server/narrativeScenes';
import {probeAudio,runFFmpeg} from '../server/core';

const actual=JSON.parse(await readFile(new URL('./fixtures/p24-generated-narration-extra-han.json',import.meta.url),'utf8')) as {provenance:{rawAnalysisSha256:string};chapter:LessonChapter;analysis:AudioAnalysis};
const heard=(text:string,duration=9.7,bytes=Buffer.from('controlled-audio')):AudioAnalysis=>({status:'ready',modelId:'controlled-asr',sourceHash:hashBytes(bytes),duration,transcript:text,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',text,complete:true,start:0,end:duration,words:[...text].map((text,i,all)=>({text,start:duration*i/all.length,end:duration*(i+1)/all.length}))}]});

test('actual extra 他 remains in raw ASR and cannot receive generated speech verification behind a 98% match',()=>{
  assert.equal(hashBytes(JSON.stringify(actual.analysis,null,2)),actual.provenance.rawAnalysisSha256,'the minimal fixture retains the complete actual original ASR payload');
  const before=structuredClone(actual),corrected=correctLessonTranscript(actual.chapter,actual.analysis);
  assert.throws(()=>verifyNarrationSpeech(actual.chapter.id,()=>alignLessonSpeech(actual.chapter,corrected)),error=>error instanceof NarrationVerificationError&&error.kind==='speech'&&/额外字词「他」/.test(error.message));
  assert.equal(corrected.transcript,actual.analysis.transcript);assert.deepEqual(actual,before);
  assert.equal(actual.analysis.sentences[0].words[3].text,'他');assert.equal(actual.analysis.sentences[0].words[3].start,.66);assert.equal(actual.analysis.sentences[0].words[3].end,.8);
});

test('single extra negations, pronouns, classifiers and other content characters never become script-filled captions',()=>{
  for(const glyph of ['不','无','未','他','她','斤']){
    const text=glyph==='斤'?actual.chapter.narration.replace('六十克','六十斤克'):actual.chapter.narration.replace('核心变化是','核心变化是'+glyph),raw=heard(text),before=structuredClone(raw);
    assert.throws(()=>alignLessonSpeech(actual.chapter,raw),/额外字词/,glyph);assert.deepEqual(raw,before);
  }
});

test('correct speech and established equivalent numeral spellings still pass; omissions and wrong values/units remain rejected',()=>{
  const chapter=actual.chapter;
  assert.equal(alignLessonSpeech(chapter,heard(chapter.narration)).similarity,1);
  assert.doesNotThrow(()=>alignLessonSpeech(chapter,heard(chapter.narration.replace('六十克','60克'))));
  for(const text of [chapter.narration.replace('三十七','三十八'),chapter.narration.replace('六十克','六十斤'),chapter.narration.replace('七点九','七点八'),chapter.narration.replace('核心变化','核心变')])assert.throws(()=>alignLessonSpeech(chapter,heard(text)),/数字|单位|小数|未完整匹配汉字|额外字词/);
  const negative={...chapter,narration:chapter.narration.replace('核心变化是','核心变化不是')};
  assert.throws(()=>alignLessonSpeech(negative,heard(chapter.narration)),/未完整匹配汉字「不」/);
});

const prompt='制作40秒竖屏知识图解视频，说明事件记录中的证据边界';
const STOP=new Error('Controlled stop before drawing; no actual speech or full-media acceptance');
const config={id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture-not-a-secret',modelId:'fixture'};
const audioConfig={...config,kind:'audio' as const,baseUrl:'https://openspeech.bytedance.com',modelId:'seed-audio-1.0'};

// Real FFmpeg/cache state, controlled sine/ASR/HTTP only. This does not claim
// audible news speech or provider acceptance. The one initial take is seeded.
async function recoveryFixture(directory:string){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=[{id:'r1',title:'Controlled source',url:'https://example.invalid/record',verification:'primary-page' as const,excerpt:'Controlled state recovery only; no fresh news research.'}];
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>i===1?{...structuredClone(actual.chapter),id:'ch2',prerequisites:['ch1'],referenceIds:['r1'],claims:[{text:'记录事件与调查边界',referenceIds:['r1'],basis:'source'}]}:{id:'ch'+(i+1),title:'证据边界'+i,role:i===0?'hook':'recap',goal:'比较证据和解释',prerequisites:i?['ch2']:[],narration:'误差变大，损失越高。'.repeat(6),reason:'先定义，再比较',referenceIds:['r1'],claims:[{text:'示意记录',referenceIds:['r1'],basis:'source'}],visual:{kind:'concept',takeaway:'比较误差与损失',items:[{label:'误差',detail:'预测偏差',cue:'误差变大'},{label:'损失',detail:'衡量偏差',cue:'损失越高'}]}});
  const report=validateLesson({workflowId:'controlled-extra-han',...lessonSettings(prompt),title:'证据记录',audience:'初学者',objectives:['区分事实与推测','识别调查结论的边界'],arc:'先记录，再比较，最后看边界',chapters,references,limitations:['Controlled recovery fixture only.'],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:audioConfig.modelId,anchorHash:'pending',revision:0,tempo:1},factReview:{score:92,needsRepair:false,findings:[]}},prompt);
  const tone=path.join(directory,'initial.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=12.88','-ar','48000','-ac','1',tone]);
  const initial=await readFile(tone),anchorHash=hashBytes(initial),pacing=lessonPacing(prompt),voiceStyle=lessonVoiceStyle(pacing,lessonPresentation(prompt)),anchorLine='接下来，我们从一个简单的例子开始，把问题讲清楚。';
  await writeFile(path.join(work,'voice-anchor.mp3'),initial);await writeFile(path.join(work,'voice-anchor.json'),JSON.stringify({seedKey:hashBytes(JSON.stringify({model:audioConfig.modelId,revision:0,voiceStyle,anchorLine})),hash:anchorHash}));report.voice!.anchorHash=anchorHash;
  const edge=path.join(directory,'edge.wav'),prepared=path.join(directory,'prepared.wav'),tempo=path.join(directory,'tempo.wav'),paced=path.join(directory,'paced.wav'),adjusted=path.join(directory,'speech.mp3');
  await prepareLessonSpeech(tone,edge);await tightenNewsSpeechSilence(edge,prepared,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',prepared,'-af','atempo=1','-ar','48000','-ac','1','-c:a','pcm_s16le',tempo]);await tightenNewsSpeechSilence(tempo,paced,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',paced,'-ar','48000','-ac','1',adjusted]);
  const bytes=await readFile(adjusted),duration=await probeAudio(adjusted),speechHash=hashBytes(bytes);
  for(const chapter of report.chapters){const dir=path.join(work,chapter.id);await mkdir(dir);await copyFile(tone,path.join(dir,'raw-speech.mp3'));await copyFile(adjusted,path.join(dir,'speech.mp3'));await writeFile(path.join(dir,'raw-speech.json'),JSON.stringify({key:hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:audioConfig.modelId,anchorHash,voiceRevision:0,chapterRevision:0,voiceStyle})),hash:anchorHash}));if(chapter.id!=='ch2')await writeFile(path.join(dir,'speech-analysis.json'),JSON.stringify(heard(chapter.narration,duration,bytes)));await writeFile(path.join(dir,'analysis-key.json'),JSON.stringify({hash:speechHash,id:'cached-'+chapter.id}));}
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'narration',rendererHash:lessonRendererHash(),requestedAt:Date.now(),research:{summary:'Controlled prior research.',queries:[],references},report,voiceRevision:0,chapterVoiceRevisions:{}}));
  const events:WorkflowEvent[]=[];
  const options={prompt,config,audioConfig,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,analyze:async()=>{throw new Error('Unexpected ASR');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async(value:WorkflowEvent[])=>{events.splice(0,events.length,...value);},stage:async(value:string)=>{if(value==='绘制公式、曲线与教学分镜'||value==='规划 · 定向返修教学章节')throw STOP;},render:async()=>{throw new Error('Unexpected render');},review:async()=>{throw new Error('Unexpected review');}};
  return{work,report,options,events,speechHash};
}

test('one initial take plus same-wave independent recheck succeeds with no extra TTS and writes a new raw-bound proof',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-extra-han-recheck-')),originalFetch=globalThis.fetch;let requests=0;
  try{
    globalThis.fetch=async()=>{requests++;throw new Error('No external provider');};const f=await recoveryFixture(dir),chapter=f.report.chapters[1],hashes:string[]=[],ids:string[]=[];let recognitions=0;
    await assert.rejects(runLessonWorkflow({...f.options,analyze:async(item:any,file:string)=>{recognitions++;const bytes=await readFile(file);hashes.push(hashBytes(bytes));ids.push(item.id);return heard(recognitions===1?chapter.narration.replace('核心变化是','核心变化是他'):chapter.narration,await probeAudio(file),bytes);}}),error=>error===STOP);
    assert.equal(recognitions,2);assert.equal(requests,0);assert.deepEqual(hashes,[f.speechHash,f.speechHash]);assert.notEqual(ids[0],ids[1]);assert.equal(f.events.some(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor'),false);
    const work=path.join(f.work,'ch2'),proof=JSON.parse(await readFile(path.join(work,'speech-proof.json'),'utf8')),raw=await readFile(path.join(work,'speech-analysis-raw.json')),recheck=await readFile(path.join(work,'speech-analysis-recheck.json')),selected=await readFile(path.join(work,'speech-verified-raw-'+proof.rawAnalysisHash+'.json'));
    assert.match(JSON.parse(raw.toString()).transcript,/是他警方/);assert.doesNotMatch(JSON.parse(recheck.toString()).transcript,/是他警方/);assert.equal(hashBytes(recheck),proof.rawAnalysisHash);assert.deepEqual(selected,recheck);assert.equal(proof.processedHash,f.speechHash);assert.equal(hashBytes(await readFile(path.join(work,'speech.mp3'))),f.speechHash);
    const saved=JSON.parse(await readFile(path.join(f.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'scenes');assert.equal(saved.report.chapters[1].narration,chapter.narration);assert.equal(saved.voiceRevision,0);
  }finally{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});

test('persistent single extra Han stays rejected after both same-wave checks and only the existing one controlled retake',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-extra-han-persistent-')),originalFetch=globalThis.fetch;
  try{
    const f=await recoveryFixture(dir),next=path.join(dir,'retake.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=12.88','-ar','48000','-ac','1',next]);const bytes=await readFile(next);let requests=0,recognitions=0;const hashes:string[]=[];
    globalThis.fetch=async(url,init)=>{requests++;assert.equal(requests,1);assert.equal(new URL(String(url)).host,'openspeech.bytedance.com');assert.match(String(init?.body),/上次核验发现/);return Response.json({code:0,audio:bytes.toString('base64'),duration:12.88});};
    await assert.rejects(runLessonWorkflow({...f.options,analyze:async(_item:any,file:string)=>{recognitions++;const current=await readFile(file);hashes.push(hashBytes(current));return heard(f.report.chapters[1].narration.replace('核心变化是','核心变化是他'),await probeAudio(file),current);}}));
    assert.equal(recognitions,4);assert.equal(requests,1);assert.deepEqual(hashes.slice(0,2),[f.speechHash,f.speechHash]);assert.equal(hashes[2],hashes[3]);assert.notEqual(hashes[2],f.speechHash);assert.equal(f.events.filter(e=>e.tool==='verify_chapter_speech'&&e.status==='failed').length,4);
    await assert.rejects(readFile(path.join(f.work,'ch2/speech-proof.json')),{code:'ENOENT'});const saved=JSON.parse(await readFile(path.join(f.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'script');assert.equal(saved.voiceRevision,0);assert.equal(saved.report.chapters[1].narration,f.report.chapters[1].narration);
    for(const id of ['ch1','ch3'])assert.equal(hashBytes(await readFile(path.join(f.work,id,'speech.mp3'))),f.speechHash);
  }finally{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});
