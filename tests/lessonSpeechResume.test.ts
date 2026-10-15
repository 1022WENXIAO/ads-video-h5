import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,copyFile,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonPacing,lessonSettings,spokenLessonText,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {lessonVoiceStyle,prepareLessonSpeech,tightenNewsSpeechSilence} from '../server/lessonAudio';
import {hashBytes} from '../server/narrativeScenes';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import {probeAudio,runFFmpeg} from '../server/core';
import {sourcePronunciationHints,sourcePronunciationPrompt} from '../server/lessonPronunciation';
import {TextTransportError} from '../server/executionErrors';
import type {AudioAnalysis,LessonChapter,WorkflowEvent} from '../src/types';

const STOP=new Error('Controlled stop before next stage; no provider acceptance');
const prompt='制作45秒竖屏知识图解视频，解释误差如何评分';
const config={id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture-not-a-secret',modelId:'fixture'};
const audioConfig={...config,kind:'audio' as const,baseUrl:'https://openspeech.bytedance.com',modelId:'seed-audio-1.0'};
function analysis(chapter:LessonChapter,bytes:Buffer,text=chapter.narration,duration=15):AudioAnalysis{
  const chars=[...text];return{status:'ready',modelId:'fixture',sourceHash:hashBytes(bytes),duration,transcript:text,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',start:0,end:duration,text,complete:true,words:chars.map((text,i)=>({text,start:duration*i/chars.length,end:duration*(i+1)/chars.length}))}]};
}
async function seed(directory:string,phase='narration',rendererHash='old-renderer'){
  const work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=[{id:'r1',title:'Controlled source',url:'https://arxiv.org/abs/1708.02001',verification:'primary-page' as const,excerpt:'Controlled fixture for recovery, not factual or audio acceptance.'}];
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,title:'误差评分'+i,role:i===0?'hook':i===1?'foundation':'recap',goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
  const report=validateLesson({workflowId:'resume-fixture',...lessonSettings(prompt),title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters,references,limitations:[],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:audioConfig.modelId,anchorHash:'fixture-anchor',revision:0,tempo:1},factReview:{score:92,needsRepair:false,findings:[]}},prompt);
  const requestedAt=Date.parse('2026-10-14T21:59:27.865Z'),checkpoint={fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase,rendererHash,requestedAt,research:{summary:'Controlled already-verified research',queries:[],references},report};
  const originals=new Map<string,string>();
  for(const chapter of report.chapters){
    const dir=path.join(work,chapter.id);await mkdir(dir,{recursive:true});const bytes=Buffer.from('CONTROLLED saved speech '+chapter.id);
    await writeFile(path.join(dir,'speech.mp3'),bytes);await writeFile(path.join(dir,'speech-analysis.json'),JSON.stringify(analysis(chapter,bytes)));
    for(const name of ['raw-speech.mp3','raw-speech.json']){const file=path.join(dir,name),value='CONTROLLED original '+chapter.id+' '+name;await writeFile(file,value);originals.set(file,hashBytes(value));}
  }
  const save=()=>writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));await save();
  const events:WorkflowEvent[]=[],stages:string[]=[];
  const o={prompt,config,audioConfig,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:true,
    analyze:async()=>{throw new Error('Unexpected recognition');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async(updates:WorkflowEvent[])=>{events.splice(0,events.length,...updates);},
    stage:async(stage:string)=>{stages.push(stage);throw STOP;},render:async()=>{throw new Error('Unexpected render');},review:async()=>{throw new Error('Unexpected review');}};
  return{work,checkpoint,o,events,stages,originals,save};
}
async function noProviders<T>(action:()=>Promise<T>){const original=globalThis.fetch;let submissions=0;globalThis.fetch=async()=>{submissions++;throw new Error('Recovery must not submit a provider request');};try{return await action();}finally{globalThis.fetch=original;assert.equal(submissions,0);}}
async function seedAudio(s:Awaited<ReturnType<typeof seed>>,directory:string,pending=false,realAnchor?:Buffer){
  const pacing=lessonPacing(prompt),voiceStyle=lessonVoiceStyle(pacing,lessonPresentation(prompt));
  const anchor=realAnchor||Buffer.from('CONTROLLED existing voice anchor'),anchorHash=hashBytes(anchor),anchorLine='接下来，我们从一个简单的例子开始，把问题讲清楚。';
  await writeFile(path.join(s.work,'voice-anchor.mp3'),anchor);await writeFile(path.join(s.work,'voice-anchor.json'),JSON.stringify({seedKey:hashBytes(JSON.stringify({model:audioConfig.modelId,revision:0,voiceStyle,anchorLine})),hash:anchorHash}));
  s.checkpoint.report.voice={...s.checkpoint.report.voice!,anchorHash};
  const tone=path.join(directory,'controlled-tone.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',tone]);
  const hashes=new Map<string,string>();
  const rawKey=(chapter:LessonChapter,voiceRevision=0,chapterRevision=0)=>hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:audioConfig.modelId,anchorHash,voiceRevision,chapterRevision,voiceStyle}));
  for(const chapter of s.checkpoint.report.chapters){
    const dir=path.join(s.work,chapter.id),raw=path.join(dir,'raw-speech.mp3'),edge=path.join(dir,'edge-speech.wav'),prepared=path.join(dir,'prepared-speech.wav'),tempo=path.join(dir,'tempo-speech.wav'),paced=path.join(dir,'paced-speech.wav'),file=path.join(dir,'speech.mp3');
    await copyFile(tone,raw);await writeFile(path.join(dir,'raw-speech.json'),JSON.stringify({key:rawKey(chapter),hash:hashBytes(await readFile(raw))}));
    await prepareLessonSpeech(raw,edge);await tightenNewsSpeechSilence(edge,prepared,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',prepared,'-af','atempo=1','-ar','48000','-ac','1','-c:a','pcm_s16le',tempo]);await tightenNewsSpeechSilence(tempo,paced,pacing.maxPauseSeconds);await runFFmpeg(['-v','error','-y','-i',paced,'-ar','48000','-ac','1',file]);
    const bytes=await readFile(file),duration=await probeAudio(file),heard=pending&&chapter.id==='c1'?chapter.narration.replace('损失','损'):chapter.narration;
    await writeFile(path.join(dir,'speech-analysis.json'),JSON.stringify(analysis(chapter,bytes,heard,duration)));await writeFile(path.join(dir,'analysis-key.json'),JSON.stringify({hash:hashBytes(bytes),id:'cached-'+chapter.id}));hashes.set(chapter.id,hashBytes(bytes));
  }
  await s.save();return{hashes,rawKey};
}

for(const [phase,renderer] of [['narration','old-renderer'],['scenes','old-renderer'],['scenes','current'],['narration','current']])test(`partial ${phase}/${renderer} checkpoint resumes narration and preserves facts/raw audio`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-resume-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,phase,renderer==='current'?lessonRendererHash():renderer);
    await rm(path.join(s.work,'c1/speech-analysis.json'));
    await assert.rejects(runLessonWorkflow(s.o),error=>error===STOP);
    assert.deepEqual(s.stages,['制作统一教学旁白']);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));
    assert.equal(saved.phase,'narration');assert.deepEqual(saved.report.factReview,s.checkpoint.report.factReview);assert.deepEqual(saved.research,s.checkpoint.research);assert.equal(saved.requestedAt,s.checkpoint.requestedAt);
    if(renderer==='old-renderer'){
      const recovery=s.events.find(e=>e.tool==='renderer_rebuild'&&e.status==='succeeded')!;
      assert.deepEqual((recovery.output as any).verifiedChapters,['c0','c2']);assert.deepEqual((recovery.output as any).pendingChapters.map((p:any)=>p.chapterId),['c1']);assert.equal((recovery.output as any).nextTool,'synthesize_narration');
    }
    for(const[file,hash]of s.originals)assert.equal(hashBytes(await readFile(file)),hash);
    assert.equal(s.events.some(e=>['synthesize_chapter','transcribe_chapter','revise_lesson_script'].includes(e.tool)),false);
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('actual P9 omitted 程 transcript becomes pending speech verification instead of failing renderer rebuild',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-resume-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,'done'),chapter=s.checkpoint.report.chapters[1];
    // Public words retained from the sealed P9 raw/recheck record; synthetic
    // waveform below makes this a recovery regression, not listening proof.
    chapter.narration='订阅用户可在Gemini应用使用，开发者通过API和AI Studio调用。它面向编程、代理、数学和科学任务；输入、思考与输出共享一百万Token窗口，思考分三档。';
    chapter.visual.items=[{label:'入口',detail:'开发者调用',cue:'开发者通过API'},{label:'任务',detail:'编程与代理',cue:'它面向编程'}];
    const file=path.join(s.work,'c1/speech.mp3'),raw=await readFile(file),heard='订阅用户可在Gemini应用使用开发者通过API和AIStudio调用它面向编代理数学和科学任务输入思考与输出共享一百万Token窗口思考分三档';
    await writeFile(path.join(s.work,'c1/speech-analysis.json'),JSON.stringify(analysis(chapter,raw,heard)));await s.save();
    await assert.rejects(runLessonWorkflow(s.o),error=>error===STOP);assert.deepEqual(s.stages,['制作统一教学旁白']);
    const recovery=s.events.find(e=>e.tool==='renderer_rebuild'&&e.status==='succeeded')!;
    assert.match((recovery.output as any).pendingChapters[0].reason,/未完整匹配汉字「程」/);
    assert.deepEqual((recovery.output as any).verifiedChapters,['c0','c2']);assert.equal(hashBytes(await readFile(file)),hashBytes(raw));
    assert.equal(JSON.parse(await readFile(path.join(s.work,'c1/speech-analysis.json'),'utf8')).transcript,heard);
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('all currently verified chapters go directly to scenes after renderer update',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-resume-'));
  try{await noProviders(async()=>{const s=await seed(directory,'scenes');await assert.rejects(runLessonWorkflow(s.o),e=>e===STOP);assert.deepEqual(s.stages,['绘制公式、曲线与教学分镜']);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'scenes');});}finally{await rm(directory,{recursive:true,force:true});}
});

test('renderer updates preserve an existing required script repair and recheck whole-track pacing',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-resume-'));
  try{await noProviders(async()=>{
    for(const phase of ['script','scenes','fact-review','budget']){
      const s=await seed(path.join(directory,phase),phase);
      if(phase==='scenes')for(const chapter of s.checkpoint.report.chapters){const bytes=await readFile(path.join(s.work,chapter.id,'speech.mp3'));await writeFile(path.join(s.work,chapter.id,'speech-analysis.json'),JSON.stringify(analysis(chapter,bytes,chapter.narration,1)));}
      let nextTool='';s.o.progress=async(events)=>{const restored=events.find(e=>e.tool==='renderer_rebuild'&&e.status==='succeeded');if(restored){nextTool=(restored.output as any).nextTool;throw STOP;}};
      await assert.rejects(runLessonWorkflow(s.o),e=>e===STOP);
      const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,phase==='scenes'?'script':phase);assert.equal(saved.report.factReview.needsRepair,false);
      assert.equal(nextTool,phase==='fact-review'?'review_lesson_script':phase==='budget'?'plan_lesson_budget':'revise_lesson_script');
      if(phase==='scenes')assert.match(saved.feedback,/实际每秒56\.000字.*高于上限/);
    }
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('speech restore keeps filesystem denial and cancellation terminal before any narration submission',{skip:process.getuid?.()===0?'chmod denial requires an unprivileged test process':false},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-resume-'));
  try{await noProviders(async()=>{
    const s=await seed(directory),file=path.join(s.work,'c1/speech-analysis.json');await chmod(file,0);
    try{await assert.rejects(runLessonWorkflow(s.o),(e:any)=>e.code==='EACCES');assert.deepEqual(s.stages,[]);}finally{await chmod(file,0o600);}
    const controller=new AbortController();s.o.progress=async(events)=>{if(events.some(e=>e.tool==='renderer_rebuild'&&e.status==='running'))controller.abort();};
    await assert.rejects(runWithJobSignal(controller.signal,()=>runLessonWorkflow(s.o)),JobCancelledError);assert.deepEqual(s.stages,[]);
  });}finally{await rm(directory,{recursive:true,force:true});}
});

for(const revision of ['global','chapter'])for(const renderer of ['current','old-renderer'])test(`pending ${revision} voice revision stays in narration with ${renderer} even when old words/hash pass`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-revision-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,'narration',renderer==='current'?lessonRendererHash():renderer);
    Object.assign(s.checkpoint,revision==='global'?{voiceRevision:1}:{chapterVoiceRevisions:{c1:1}});await s.save();
    await assert.rejects(runLessonWorkflow(s.o),e=>e===STOP);assert.deepEqual(s.stages,['制作统一教学旁白']);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'narration');assert.equal(saved.report.voice.revision,0);assert.deepEqual(saved.report.factReview,s.checkpoint.report.factReview);
    if(renderer==='old-renderer'){const restored=s.events.find(e=>e.tool==='renderer_rebuild'&&e.status==='succeeded')!;assert.deepEqual((restored.output as any).verifiedChapters,['c0','c1','c2']);assert.equal((restored.output as any).nextTool,'synthesize_narration');}
  });}finally{await rm(directory,{recursive:true,force:true});}
});

const causedBy=(error:unknown,expected:unknown):boolean=>error===expected||Boolean(error&&typeof error==='object'&&'cause'in error&&causedBy(error.cause,expected));
const causedByName=(error:unknown,name:string):boolean=>error instanceof Error&&(error.name===name||causedByName(error.cause,name));
for(const hinted of [false,true])test(`source pronunciation ${hinted?'matched':'new'} cache policy is applied to the actual resumed synthesis`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-pronunciation-resume-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,'narration',lessonRendererHash()),chapter=s.checkpoint.report.chapters[1];
    chapter.narration='杨源𬸚𬸦记录于研究中。'+chapter.narration;
    s.checkpoint.report.references[0].title='受控发音来源：杨源𬸚𬸦（yuè zhuó）';
    s.checkpoint.report.references[0].excerpt='受控来源只供离线恢复测试：杨源𬸚𬸦（yuè zhuó），误差影响评分。';
    s.checkpoint.research.references=s.checkpoint.report.references;
    const {hashes}=await seedAudio(s,directory),hints=sourcePronunciationHints(chapter,s.checkpoint.report.references),pronunciation=sourcePronunciationPrompt(hints);
    assert.deepEqual(hints,[{term:'𬸚𬸦',pinyin:'yuè zhuó',referenceIds:['r1']}]);
    const metadata=path.join(s.work,'c1/raw-speech.json'),before=JSON.parse(await readFile(metadata,'utf8'));
    const currentKey=hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:audioConfig.modelId,anchorHash:s.checkpoint.report.voice!.anchorHash,voiceRevision:0,chapterRevision:0,voiceStyle:lessonVoiceStyle(lessonPacing(prompt),lessonPresentation(prompt)),pronunciation}));
    assert.notEqual(currentKey,before.key);
    if(hinted)await writeFile(metadata,JSON.stringify({...before,key:currentKey,pronunciationHints:hints}));
    const progress=s.o.progress,o={...s.o,stage:async(stage:string)=>{s.stages.push(stage);if(stage==='绘制公式、曲线与教学分镜')throw STOP;},progress:async(events:WorkflowEvent[])=>{await progress(events);if(!hinted&&events.some(e=>e.tool==='synthesize_chapter'&&e.status==='running'))throw STOP;}};
    await assert.rejects(runLessonWorkflow(o),error=>causedBy(error,STOP));
    const submissions=s.events.filter(e=>e.tool==='synthesize_chapter');
    if(hinted){assert.equal(submissions.length,0);assert.equal(s.events.some(e=>e.tool==='transcribe_chapter'),false);const saved=JSON.parse(await readFile(metadata,'utf8'));assert.equal(saved.key,currentKey);assert.deepEqual(saved.pronunciationHints,hints);}
    else{assert.equal(submissions.length,1);assert.equal((submissions[0].input as any).chapterId,'c1');assert.deepEqual((submissions[0].input as any).pronunciationHints,hints);assert.equal(s.events.some(e=>e.tool==='transcribe_chapter'),false);}
    for(const id of ['c0','c2'])assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),hashes.get(id));
    assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,hinted?'scenes':'narration');
  });}finally{await rm(directory,{recursive:true,force:true});}
});
for(const revision of ['global','chapter'])test(`cached ${revision} repair is checked against the current synthesis key before reusing final speech`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-revision-audio-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,'narration',lessonRendererHash());await seedAudio(s,directory);
    Object.assign(s.checkpoint,revision==='global'?{voiceRevision:1}:{chapterVoiceRevisions:{c1:1}});await s.save();
    const expected=revision==='global'?'synthesize_voice_anchor':'synthesize_chapter',progress=s.o.progress;
    const o={...s.o,stage:async(stage:string)=>{s.stages.push(stage);},progress:async(events:WorkflowEvent[])=>{await progress(events);if(events.some(e=>e.tool===expected&&e.status==='running'))throw STOP;}};
    await assert.rejects(runLessonWorkflow(o),error=>causedBy(error,STOP));assert.deepEqual(s.stages,['制作统一教学旁白']);
    const submissions=s.events.filter(e=>e.tool===expected);assert.equal(submissions.length,1);
    if(revision==='chapter')assert.equal((submissions[0].input as any).chapterId,'c1');
    assert.equal(s.events.some(e=>e.tool==='transcribe_chapter'),false);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'narration');
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('current raw metadata with an old final waveform finishes that take and recognizes only the changed chapter',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-final-pending-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,'narration','old-renderer'),{hashes,rawKey}=await seedAudio(s,directory),chapter=s.checkpoint.report.chapters[1];
    Object.assign(s.checkpoint,{chapterVoiceRevisions:{c1:1}});
    const raw=path.join(s.work,'c1/raw-speech.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',raw]);
    await writeFile(path.join(s.work,'c1/raw-speech.json'),JSON.stringify({key:rawKey(chapter,0,1),hash:hashBytes(await readFile(raw))}));await s.save();
    let recognitions=0;
    const o={...s.o,stage:async(stage:string)=>{s.stages.push(stage);if(stage==='绘制公式、曲线与教学分镜')throw STOP;},analyze:async(item:any,file:string)=>{
      recognitions++;assert.equal(path.basename(path.dirname(file)),'c1');assert.notEqual(item.id,'cached-c1');const bytes=await readFile(file);assert.notEqual(hashBytes(bytes),hashes.get('c1'));return analysis(chapter,bytes,chapter.narration,await probeAudio(file));
    }};
    await assert.rejects(runLessonWorkflow(o),e=>e===STOP);assert.equal(recognitions,1);assert.deepEqual(s.stages,['制作统一教学旁白','绘制公式、曲线与教学分镜']);assert.equal(s.events.some(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor'),false);
    for(const id of ['c0','c2'])assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),hashes.get(id));
    const final=JSON.parse(await readFile(path.join(s.work,'c1/speech-analysis.json'),'utf8'));assert.equal(final.sourceHash,hashBytes(await readFile(path.join(s.work,'c1/speech.mp3'))));assert.notEqual(final.sourceHash,hashes.get('c1'));
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('narration stopped after all valid ASR writes still executes the pipeline without duplicate synthesis or recognition',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-all-ready-'));
  try{await noProviders(async()=>{
    const s=await seed(directory,'narration',lessonRendererHash()),{hashes}=await seedAudio(s,directory);
    const o={...s.o,stage:async(stage:string)=>{s.stages.push(stage);if(stage==='绘制公式、曲线与教学分镜')throw STOP;}};
    await assert.rejects(runLessonWorkflow(o),e=>e===STOP);assert.deepEqual(s.stages,['制作统一教学旁白','绘制公式、曲线与教学分镜']);
    assert.equal(s.events.some(e=>['synthesize_chapter','synthesize_voice_anchor','transcribe_chapter'].includes(e.tool)),false);
    assert.equal(s.events.filter(e=>e.tool==='verify_narration_pacing'&&e.status==='succeeded').length,1);
    for(const[id,hash]of hashes)assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),hash);
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('resumed narration reuses verified chapters and independently rechecks only the unchanged pending waveform',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-speech-resume-audio-'));
  try{await noProviders(async()=>{
    const s=await seed(directory),{hashes}=await seedAudio(s,directory,true);
    if(process.getuid?.()!==0){
      const meta=path.join(s.work,'c1/raw-speech.json');await chmod(meta,0);
      try{await assert.rejects(runLessonWorkflow({...s.o,stage:async()=>{}}),(error:any)=>{let current=error;while(current&&current.code!=='EACCES')current=current.cause;return current?.code==='EACCES';});}finally{await chmod(meta,0o600);}
      assert.equal(s.events.some(e=>e.tool==='synthesize_chapter'),false);
    }
    let deniedRecognitions=0;
    const denied=Object.assign(new Error('ASR HTTP 401'),{status:401});
    await assert.rejects(runLessonWorkflow({...s.o,stage:async()=>{},analyze:async()=>{deniedRecognitions++;throw denied;}}),(error:any)=>{
      let current=error;while(current&&current!==denied)current=current.cause;return current===denied;
    });
    assert.equal(deniedRecognitions,1);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'narration');
    assert.equal(s.events.some(e=>e.tool==='synthesize_chapter'),false);s.stages.length=0;
    let recognitions=0;const ids:string[]=[];
    const o={...s.o,stage:async(stage:string)=>{s.stages.push(stage);if(stage==='绘制公式、曲线与教学分镜')throw STOP;},analyze:async(item:any,file:string)=>{
      recognitions++;ids.push(item.id);assert.equal(path.basename(path.dirname(file)),'c1');assert.equal(hashBytes(await readFile(file)),hashes.get('c1'));
      const chapter=s.checkpoint.report.chapters[1];return analysis(chapter,await readFile(file),recognitions===1?chapter.narration.replace('损失','损'):chapter.narration,await probeAudio(file));
    }};
    await assert.rejects(runLessonWorkflow(o),e=>e===STOP);assert.equal(recognitions,2);assert.equal(ids[0],'cached-c1');assert.notEqual(ids[1],ids[0]);
    assert.deepEqual(s.stages,['制作统一教学旁白','绘制公式、曲线与教学分镜']);assert.equal(s.events.filter(e=>e.tool==='synthesize_chapter').length,0);assert.equal(s.events.filter(e=>e.tool==='verify_chapter_speech'&&e.status==='failed').length,1);assert.equal(s.events.filter(e=>e.tool==='verify_chapter_speech'&&e.status==='succeeded').length,1);
    for(const[id,hash]of hashes)assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),hash);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'scenes');assert.equal(saved.report.factReview.needsRepair,false);
  });}finally{await rm(directory,{recursive:true,force:true});}
});

test('accepted word retake survives ASR transport failure and resumes the same new waveform without another TTS',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-confirmed-retake-')),originalFetch=globalThis.fetch;
  try{
    const newFile=path.join(directory,'new-take.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',newFile]);
    const newBytes=await readFile(newFile),s=await seed(directory,'narration',lessonRendererHash()),{hashes,rawKey}=await seedAudio(s,directory,true,newBytes),chapter=s.checkpoint.report.chapters[1];
    const rawFile=path.join(s.work,'c1/raw-speech.mp3'),metadata=path.join(s.work,'c1/raw-speech.json'),oldRawHash=hashBytes(await readFile(rawFile));
    let submissions=0,recognitions=0,newAdjustedHash='';
    globalThis.fetch=async(url,request)=>{submissions++;assert.equal(new URL(String(url)).host,'openspeech.bytedance.com');assert.equal(request?.method,'POST');assert.match(String(request?.body),/上次核验发现/);return Response.json({code:0,audio:newBytes.toString('base64'),duration:14.56});};
    const transport=new TextTransportError(3,new Error('Connection error'));
    const o={...s.o,stage:async(stage:string)=>{s.stages.push(stage);if(stage==='绘制公式、曲线与教学分镜')throw STOP;},analyze:async(_item:any,file:string)=>{
      recognitions++;assert.equal(path.basename(path.dirname(file)),'c1');const bytes=await readFile(file),hash=hashBytes(bytes);
      if(recognitions<=2){assert.equal(hash,hashes.get('c1'));return analysis(chapter,bytes,chapter.narration.replace('损失','损'),await probeAudio(file));}
      newAdjustedHash=hash;assert.notEqual(hash,hashes.get('c1'));throw transport;
    }};
    await assert.rejects(runLessonWorkflow(o),error=>causedBy(error,transport)&&causedByName(error,'NarrationAnalysisError'));
    assert.equal(submissions,1);assert.equal(recognitions,3);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'narration');
    const saved=JSON.parse(await readFile(metadata,'utf8'));assert.equal(saved.key,rawKey(chapter));assert.equal(saved.hash,hashBytes(newBytes));assert.equal(hashBytes(await readFile(rawFile)),saved.hash);assert.notEqual(saved.hash,oldRawHash);
    for(const hash of [oldRawHash,saved.hash])assert.equal(hashBytes(await readFile(path.join(s.work,'c1/takes',hash+'.mp3'))),hash);
    for(const id of ['c0','c2'])assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),hashes.get(id));
    let resumedRecognitions=0;const earlierEvents=s.events.length;submissions=0;globalThis.fetch=async()=>{submissions++;throw new Error('Confirmed retake must never be resubmitted');};s.stages.length=0;
    await assert.rejects(runLessonWorkflow({...o,analyze:async(_item:any,file:string)=>{
      resumedRecognitions++;assert.equal(path.basename(path.dirname(file)),'c1');const bytes=await readFile(file);assert.equal(hashBytes(bytes),newAdjustedHash);return analysis(chapter,bytes,chapter.narration,await probeAudio(file));
    }}),error=>causedBy(error,STOP));
    assert.equal(submissions,0);assert.equal(resumedRecognitions,1);assert.equal(s.events.slice(earlierEvents).some(e=>e.tool==='synthesize_chapter'),false);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'scenes');
    assert.equal(hashBytes(await readFile(rawFile)),saved.hash);assert.equal(hashBytes(await readFile(path.join(s.work,'c1/speech.mp3'))),newAdjustedHash);
    const accepted=JSON.parse(await readFile(path.join(s.work,'c1/speech-analysis.json'),'utf8'));assert.equal(accepted.sourceHash,newAdjustedHash);assert.equal(accepted.transcript,chapter.narration);
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('accepted gap retake persists its key, source hints and actual bytes before a preparation interruption',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-confirmed-gap-retake-')),originalFetch=globalThis.fetch;
  try{
    const newFile=path.join(directory,'new-take.mp3'),gapFile=path.join(directory,'controlled-gap.wav');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',newFile]);
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','aevalsrc=if(between(t\\,5\\,6.4)\\,0\\,0.1*sin(2*PI*440*t)):s=48000:d=14.56','-ar','48000','-ac','1',gapFile]);
    const newBytes=await readFile(newFile),s=await seed(directory,'narration',lessonRendererHash()),chapter=s.checkpoint.report.chapters[1];
    chapter.narration='杨源𬸚𬸦记录于研究中。'+chapter.narration;
    s.checkpoint.report.references[0].title='受控发音来源：杨源𬸚𬸦（yuè zhuó）';s.checkpoint.report.references[0].excerpt='受控来源只供离线恢复测试：杨源𬸚𬸦（yuè zhuó）。';s.checkpoint.research.references=s.checkpoint.report.references;
    const {hashes}=await seedAudio(s,directory,false,newBytes),hints=sourcePronunciationHints(chapter,s.checkpoint.report.references),pronunciation=sourcePronunciationPrompt(hints),metadata=path.join(s.work,'c1/raw-speech.json'),rawFile=path.join(s.work,'c1/raw-speech.mp3');
    const expectedKey=hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:audioConfig.modelId,anchorHash:s.checkpoint.report.voice!.anchorHash,voiceRevision:0,chapterRevision:0,voiceStyle:lessonVoiceStyle(lessonPacing(prompt),lessonPresentation(prompt)),pronunciation}));
    const before=JSON.parse(await readFile(metadata,'utf8'));await writeFile(metadata,JSON.stringify({...before,key:expectedKey,pronunciationHints:hints}));
    let submissions=0,injected=false;globalThis.fetch=async(_url,request)=>{submissions++;assert.match(String(request?.body),/重录|连续完整地朗读/);return Response.json({code:0,audio:newBytes.toString('base64'),duration:14.56});};
    const progress=s.o.progress,o={...s.o,stage:async(stage:string)=>{if(stage==='绘制公式、曲线与教学分镜')throw STOP;},progress:async(events:WorkflowEvent[])=>{
      await progress(events);
      // Controlled fault after the real repair operation, so the unchanged
      // real gap detector must require a retake. No synthetic listening claim.
      if(!injected&&events.some(e=>e.tool==='tighten_speech_gaps'&&e.status==='succeeded'&&(e.input as any).chapterId==='c1'&&!(e.input as any).stage)){injected=true;await copyFile(gapFile,path.join(s.work,'c1/prepared-speech.wav'));}
      if(submissions&&events.some(e=>e.tool==='prepare_speech_edges'&&e.status==='running'&&(e.input as any).chapterId==='c1'))throw STOP;
    }};
    await assert.rejects(runLessonWorkflow(o),error=>causedBy(error,STOP));assert.equal(injected,true);assert.equal(submissions,1);
    const saved=JSON.parse(await readFile(metadata,'utf8'));assert.equal(saved.key,expectedKey);assert.equal(saved.hash,hashBytes(newBytes));assert.deepEqual(saved.pronunciationHints,hints);assert.equal(hashBytes(await readFile(rawFile)),saved.hash);
    assert.equal(hashBytes(await readFile(path.join(s.work,'c1/takes',saved.hash+'.mp3'))),saved.hash);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'narration');
    const earlierEvents=s.events.length;let recognitions=0;submissions=0;globalThis.fetch=async()=>{submissions++;throw new Error('Confirmed gap retake must not be resubmitted');};
    await assert.rejects(runLessonWorkflow({...o,progress,analyze:async(_item:any,file:string)=>{recognitions++;assert.equal(path.basename(path.dirname(file)),'c1');const bytes=await readFile(file);return analysis(chapter,bytes,chapter.narration,await probeAudio(file));}}),error=>causedBy(error,STOP));
    assert.equal(submissions,0);assert.equal(recognitions,1);assert.equal(s.events.slice(earlierEvents).some(e=>e.tool==='synthesize_chapter'),false);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'scenes');
    for(const id of ['c0','c2'])assert.equal(hashBytes(await readFile(path.join(s.work,id,'speech.mp3'))),hashes.get(id));
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

for(const fault of ['missing-audio','metadata-io'])test(`retake ${fault} cannot mark unconfirmed or unsaved bytes complete`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-retake-incomplete-')),originalFetch=globalThis.fetch;
  try{
    const newFile=path.join(directory,'new-take.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=660:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',newFile]);
    const bytes=await readFile(newFile),s=await seed(directory,'narration',lessonRendererHash());await seedAudio(s,directory,true,bytes);
    const chapter=s.checkpoint.report.chapters[1],rawFile=path.join(s.work,'c1/raw-speech.mp3'),metadata=path.join(s.work,'c1/raw-speech.json'),oldBytes=await readFile(rawFile),oldMeta=await readFile(metadata);
    let submissions=0,recognitions=0,blocked=false;globalThis.fetch=async()=>{submissions++;return Response.json(fault==='missing-audio'?{code:0}:{code:0,audio:bytes.toString('base64'),duration:14.56});};
    const progress=s.o.progress,o={...s.o,stage:async()=>{},progress:async(events:WorkflowEvent[])=>{
      await progress(events);if(fault==='metadata-io'&&!blocked&&events.some(e=>e.tool==='synthesize_chapter'&&e.status==='running'&&(e.input as any).chapterId==='c1')){blocked=true;await rm(metadata);await mkdir(metadata);}
    },analyze:async(_item:any,file:string)=>{recognitions++;return analysis(chapter,await readFile(file),chapter.narration.replace('损失','损'),await probeAudio(file));}};
    await assert.rejects(runLessonWorkflow(o),fault==='metadata-io'?(error:any)=>{let current=error;while(current&&current.code!=='EISDIR')current=current.cause;return current?.code==='EISDIR';}:/音频|地址|URL/);
    assert.equal(submissions,1);assert.equal(recognitions,2);assert.equal(JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8')).phase,'narration');
    if(fault==='missing-audio'){assert.deepEqual(await readFile(rawFile),oldBytes);assert.deepEqual(await readFile(metadata),oldMeta);}
    else{assert.deepEqual(await readFile(rawFile),bytes);submissions=0;await assert.rejects(runLessonWorkflow(o),(error:any)=>{let current=error;while(current&&current.code!=='EISDIR')current=current.cause;return current?.code==='EISDIR';});assert.equal(submissions,0);}
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
