import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonPacing,lessonSettings,spokenLessonText,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {lessonVoiceStyle} from '../server/lessonAudio';
import {lessonSpeechBinding,lessonSpeechProcessingHash,pendingLessonSpeechTempo,readLessonSpeechProof} from '../server/lessonSpeechProof';
import {hashBytes} from '../server/narrativeScenes';
import {probeAudio,runFFmpeg} from '../server/core';
import {withModelSnapshot} from '../server/modelContext';
import {TextTransportError} from '../server/executionErrors';
import type {AudioAnalysis,LessonChapter,LessonReport,WorkflowEvent} from '../shared/types';

// Real generated PCM/MP3 and real SDK tool execution test cache/byte identity.
// Controlled ASR and sine waves do not establish audible speech or media quality.
const prompt='制作45秒横屏知识图解视频，解释误差如何评分';
const STOP=new Error('Controlled stop before visual generation');
const config={id:'controlled-text',name:'Controlled text',kind:'text' as const,provider:'ark',baseUrl:'https://provider.example.invalid',modelId:'controlled-model',enabled:true,apiKey:'controlled-no-live-credential'};
const audioConfig={...config,kind:'audio' as const,baseUrl:'https://openspeech.bytedance.com',modelId:'seed-audio-1.0'};
function analysis(chapter:LessonChapter,bytes:Buffer,duration:number):AudioAnalysis{
 const chars=[...chapter.narration];return {status:'ready',modelId:'controlled-asr',sourceHash:hashBytes(bytes),duration,transcript:chapter.narration,pauses:[],warnings:[],timing:'model-estimated',createdAt:'',sentences:[{id:'s',start:0,end:duration,text:chapter.narration,complete:true,words:chars.map((text,i)=>({text,start:duration*i/chars.length,end:duration*(i+1)/chars.length}))}]};
}
const causedBy=(error:unknown,target:unknown):boolean=>error===target||Boolean(error&&typeof error==='object'&&'cause'in error&&causedBy(error.cause,target));
async function fixture(){
 const directory=await mkdtemp(path.join(tmpdir(),'qingjian-frozen-wave-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
 const references=[{id:'r1',title:'Controlled source',url:'https://source.example.org/controlled',verification:'primary-page' as const,excerpt:'Controlled fixture, not factual acceptance.'}];
 const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'ch'+(i+1),title:'误差评分'+i,role:i===0?'hook':i===1?'foundation':'recap',goal:'理解误差与评分',prerequisites:i?['ch'+i]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
 const report=validateLesson({workflowId:'frozen-wave-fixture',...lessonSettings(prompt),title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters,references,limitations:[],presentation:lessonPresentation(prompt),factReview:{score:94,needsRepair:false,findings:[]}},prompt);
 const tone=path.join(directory,'initial.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=14.56','-ar','48000','-ac','1',tone]);
 const anchor=await readFile(tone),anchorHash=hashBytes(anchor),pacing=lessonPacing(prompt),voiceStyle=lessonVoiceStyle(pacing,lessonPresentation(prompt));
 await writeFile(path.join(work,'voice-anchor.mp3'),anchor);await writeFile(path.join(work,'voice-anchor.json'),JSON.stringify({seedKey:hashBytes(JSON.stringify({model:audioConfig.modelId,revision:0,voiceStyle,anchorLine:'接下来，我们从一个简单的例子开始，把问题讲清楚。'})),hash:anchorHash}));
 report.voice={mode:'preset',modelId:audioConfig.modelId,anchorHash,revision:0,tempo:1};
 const rawKey=(chapter:LessonChapter,revision=0)=>hashBytes(JSON.stringify({line:spokenLessonText(chapter.narration),model:audioConfig.modelId,anchorHash,voiceRevision:0,chapterRevision:revision,voiceStyle}));
 for(const chapter of chapters){const dir=path.join(work,chapter.id);await mkdir(dir);await copyFile(tone,path.join(dir,'raw-speech.mp3'));await writeFile(path.join(dir,'raw-speech.json'),JSON.stringify({key:rawKey(chapter),hash:anchorHash}));}
 const checkpoint={fingerprint:hashBytes(JSON.stringify({version:1,owner:'controlled-owner',prompt,export:true})),phase:'narration',requestedAt:Date.now(),rendererHash:lessonRendererHash(),report,research:{summary:'Controlled prior research',queries:[],references},voiceRevision:0,chapterVoiceRevisions:{},factRepairHistory:{version:1,entries:[]},renders:0};
 await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
 const events:WorkflowEvent[]=[],asr:string[]=[];let scenes=0;
 const options={prompt,config,audioConfig,media:[],dataDir:directory,mediaDir:directory,ownerId:'controlled-owner',checkpointKey:'case',export:true,register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async(next:WorkflowEvent[])=>{events.splice(0,events.length,...structuredClone(next));},stage:async(label:string)=>{if(label==='绘制公式、曲线与教学分镜'){scenes++;throw STOP;}},analyze:async(_item:any,file:string)=>{const id=path.basename(path.dirname(file));asr.push(id);const latest=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));return analysis(latest.report.chapters.find((c:LessonChapter)=>c.id===id),await readFile(file),await probeAudio(file));},render:async()=>{throw new Error('Unexpected render');},review:async()=>{throw new Error('Unexpected media review');}};
 const bootstrap=async()=>{await assert.rejects(runLessonWorkflow(options),e=>causedBy(e,STOP));assert.deepEqual(asr.sort(),['ch1','ch2','ch3']);asr.length=0;return JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));};
 const hashes=async()=>Object.fromEntries(await Promise.all(chapters.map(async c=>[c.id,hashBytes(await readFile(path.join(work,c.id,'speech.mp3')))])));
 return{directory,work,options,report,rawKey,pacing,events,asr,bootstrap,hashes,scenes:()=>scenes};
}
async function controlled(run:(f:Awaited<ReturnType<typeof fixture>>)=>Promise<void>){const original=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('Unexpected external provider request');};const f=await fixture();try{await withModelSnapshot({text:config,understanding:null,audio:null,image:null},()=>run(f));}finally{globalThis.fetch=original;await rm(f.directory,{recursive:true,force:true});}}
function toolResponse(chapter:LessonChapter){return new Response(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'controlled-revise',type:'function',function:{name:'revise_lesson_script',arguments:JSON.stringify({chapters:[chapter]})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});}
async function partial(f:Awaited<ReturnType<typeof fixture>>,seconds=16){
 const saved=JSON.parse(await readFile(path.join(f.work,'checkpoint.json'),'utf8'));saved.phase='script';saved.feedback=saved.repairRequirements='ch2：改写本章的受控示例，其他章节不变。';saved.report.factReview={score:75,needsRepair:true,findings:[saved.feedback]};await writeFile(path.join(f.work,'checkpoint.json'),JSON.stringify(saved));
 const chapter={...saved.report.chapters[1],narration:'误差变大损失越高。'.repeat(6)+'实际比较仍要核对条件。'};
 const retake=path.join(f.directory,'retake.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i',`sine=frequency=660:sample_rate=48000:duration=${seconds}`,'-ar','48000','-ac','1',retake]);const bytes=await readFile(retake);let text=0,tts=0,planningStop=false;
 globalThis.fetch=async(url,init)=>{if(new URL(String(url)).host==='openspeech.bytedance.com'){tts++;return Response.json({code:0,audio:bytes.toString('base64'),duration:seconds});}assert.ok(String(url).startsWith(config.baseUrl));const body=JSON.parse(String(init?.body));if(body.stream){text++;assert.equal(text,1);assert.equal(body.tool_choice.function.name,'revise_lesson_script');return toolResponse(chapter);}return Response.json({choices:[{message:{content:JSON.stringify({score:94,needsRepair:false,findings:[]})}}]});};
 const before=f.events.length;
 await assert.rejects(runLessonWorkflow({...f.options,stage:async label=>{if(seconds>20&&tts&&label==='规划 · 定向返修教学章节'){planningStop=true;throw STOP;}await f.options.stage(label);}}));
 assert.equal(tts,1);assert.equal(text,1);return {events:f.events.slice(before),saved:JSON.parse(await readFile(path.join(f.work,'checkpoint.json'),'utf8')),planningStop};
}

test('real SDK partial rewrite changes only pending TTS/ASR and preserves frozen MP3 bytes and timestamps',async()=>controlled(async f=>{
 await f.bootstrap();const original=await f.hashes(),before=await stat(path.join(f.work,'ch1/speech.mp3'));
 const result=await partial(f);assert.deepEqual(f.asr,['ch2']);assert.equal(result.saved.phase,'scenes');assert.equal(result.saved.report.factReview.needsRepair,false);assert.equal(result.saved.voiceRevision,0);assert.equal(result.saved.renders,0);
 const now=await f.hashes();assert.equal(now.ch1,original.ch1);assert.equal(now.ch3,original.ch3);assert.notEqual(now.ch2,original.ch2);assert.equal((await stat(path.join(f.work,'ch1/speech.mp3'))).mtimeMs,before.mtimeMs);
 for(const id of ['ch1','ch3']){assert.ok(result.events.some(e=>e.tool==='reuse_verified_narration'&&e.status==='succeeded'&&(e.input as any).chapterId===id));assert.equal(result.events.some(e=>['prepare_speech_edges','tighten_speech_gaps','transcribe_chapter','synthesize_chapter'].includes(e.tool)&&(e.input as any)?.chapterId===id),false);}
 for(const id of ['ch1','ch2','ch3']){const a=JSON.parse(await readFile(path.join(f.work,id,'speech-analysis.json'),'utf8'));assert.equal(a.sourceHash,now[id]);assert.ok((await probeAudio(path.join(f.work,id,'speech.mp3')))>10);}
}));

test('all frozen chapters resume with zero TTS, ASR, preparation or changed audio bytes',async()=>controlled(async f=>{
 const saved=await f.bootstrap(),original=await f.hashes();saved.phase='narration';await writeFile(path.join(f.work,'checkpoint.json'),JSON.stringify(saved));const count=f.events.length;
 await assert.rejects(runLessonWorkflow(f.options),e=>causedBy(e,STOP));assert.deepEqual(f.asr,[]);assert.deepEqual(await f.hashes(),original);
 const events=f.events.slice(count);assert.equal(events.filter(e=>e.tool==='reuse_verified_narration').length,3);assert.equal(events.some(e=>['prepare_speech_edges','tighten_speech_gaps','transcribe_chapter','synthesize_chapter'].includes(e.tool)),false);
}));

test('pending timing outside safe range scopes repair to pending chapter without invalidating frozen voice',async()=>controlled(async f=>{
 await f.bootstrap();const original=await f.hashes(),result=await partial(f,40);assert.equal(result.planningStop,true);assert.equal(result.saved.phase,'script');assert.match(result.saved.repairRequirements,/ch2：.*0\.8–1\.25/);assert.doesNotMatch(result.saved.repairRequirements,/ch1|ch3|全片/);assert.equal(result.saved.voiceRevision,0);assert.deepEqual(f.asr,[]);
 const now=await f.hashes();assert.equal(now.ch1,original.ch1);assert.equal(now.ch3,original.ch3);assert.equal(result.saved.renders,0);
}));

test('proof hash, audio, transcript, cue, raw voice revision and processing policy tampering cannot authorize reuse',async()=>controlled(async f=>{
 const saved=await f.bootstrap(),chapter=saved.report.chapters[0],dir=path.join(f.work,chapter.id),raw=await readFile(path.join(dir,'raw-speech.mp3')),binding=lessonSpeechBinding(chapter,f.rawKey(chapter),hashBytes(raw),f.pacing,saved.report.references,saved.report),proofFile=path.join(dir,'speech-proof.json'),proof=await readFile(proofFile);
 assert.ok(await readLessonSpeechProof(dir,binding));
 for(const altered of [{...binding,rawKey:f.rawKey(chapter,1)},{...binding,processingHash:'f'.repeat(64)},lessonSpeechBinding(chapter,binding.rawKey,binding.rawHash,f.pacing,saved.report.references,{requestedSeconds:46,explicitDuration:true}),lessonSpeechBinding(chapter,binding.rawKey,binding.rawHash,{...f.pacing,maxPauseSeconds:.75},saved.report.references,saved.report),lessonSpeechBinding({...chapter,visual:{...chapter.visual,items:chapter.visual.items.map((i:any,j:number)=>j?i:{...i,cue:'误差变大损失'})}},binding.rawKey,binding.rawHash,f.pacing,saved.report.references,saved.report)])assert.equal(await readLessonSpeechProof(dir,altered),undefined);
 for(const filename of ['speech.mp3','speech-analysis.json','raw-speech.mp3']){const file=path.join(dir,filename),original=await readFile(file);await writeFile(file,Buffer.concat([original,Buffer.from('tamper')]));assert.equal(await readLessonSpeechProof(dir,binding),undefined);await writeFile(file,original);}
 await writeFile(proofFile,JSON.stringify({...JSON.parse(proof.toString()),tempo:1.1}));assert.equal(await readLessonSpeechProof(dir,binding),undefined);await writeFile(proofFile,proof);assert.ok(await readLessonSpeechProof(dir,binding));
 assert.equal((await readdir(dir)).some(n=>n.startsWith('.speech-proof-')),false);
}));

test('missing legacy proof falls back to real processing and current same-byte ASR without duplicate TTS',async()=>controlled(async f=>{
 const saved=await f.bootstrap(),original=await f.hashes();for(const c of saved.report.chapters)await rm(path.join(f.work,c.id,'speech-proof.json'));saved.phase='narration';await writeFile(path.join(f.work,'checkpoint.json'),JSON.stringify(saved));const before=f.events.length;
 await assert.rejects(runLessonWorkflow(f.options),e=>causedBy(e,STOP));assert.deepEqual(await f.hashes(),original);assert.deepEqual(f.asr,[]);assert.equal(f.events.slice(before).some(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor'),false);assert.equal(f.events.slice(before).filter(e=>e.tool==='prepare_speech_edges').length,3);
}));

test('pending tempo preserves original safety, whole default allowance and confirmed same-wave retry tolerance',()=>{
 assert.equal(pendingLessonSpeechTempo(15,45,1,29,true),1);
 assert.equal(pendingLessonSpeechTempo(20,45,1,29,true),1.33333);
 assert.equal(pendingLessonSpeechTempo(20,45,1,29,false),1.25);
 assert.ok(Number.isNaN(pendingLessonSpeechTempo(2,45,1,45,false)));
 assert.ok(pendingLessonSpeechTempo(40,45,1,29,false)>1.25);
 assert.equal(pendingLessonSpeechTempo(14.56,45,1.3,29.184,true,1,true),1);
 assert.notEqual(pendingLessonSpeechTempo(14.56,45,1.3,29.184,true,1,false),1);
 assert.equal(lessonSpeechProcessingHash().length,64);
});

test('explicit chapter rerecord revision invalidates only that chapter proof and performs one controlled TTS/ASR',async()=>controlled(async f=>{
 const saved=await f.bootstrap(),original=await f.hashes();saved.phase='narration';saved.chapterVoiceRevisions={ch2:1};await writeFile(path.join(f.work,'checkpoint.json'),JSON.stringify(saved));
 const next=path.join(f.directory,'new-voice-take.mp3');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=16','-ar','48000','-ac','1',next]);const bytes=await readFile(next);let tts=0;
 globalThis.fetch=async url=>{assert.equal(new URL(String(url)).host,'openspeech.bytedance.com');tts++;return Response.json({code:0,audio:bytes.toString('base64'),duration:16});};
 await assert.rejects(runLessonWorkflow(f.options),e=>causedBy(e,STOP));assert.equal(tts,1);assert.deepEqual(f.asr,['ch2']);const now=await f.hashes();assert.equal(now.ch1,original.ch1);assert.equal(now.ch3,original.ch3);assert.notEqual(now.ch2,original.ch2);
 const after=JSON.parse(await readFile(path.join(f.work,'checkpoint.json'),'utf8'));assert.equal(after.voiceRevision,0);assert.deepEqual(after.chapterVoiceRevisions,{ch2:1});const metadata=JSON.parse(await readFile(path.join(f.work,'ch2/raw-speech.json'),'utf8'));assert.equal(metadata.key,f.rawKey(after.report.chapters[1],1));
}));

test('corrupt persisted proof is not trusted and uses bounded actual legacy processing of confirmed raw bytes',async()=>controlled(async f=>{
 const saved=await f.bootstrap(),original=await f.hashes(),file=path.join(f.work,'ch1/speech-proof.json');await writeFile(file,'{corrupt proof');saved.phase='narration';await writeFile(path.join(f.work,'checkpoint.json'),JSON.stringify(saved));const count=f.events.length;
 await assert.rejects(runLessonWorkflow(f.options),e=>causedBy(e,STOP));assert.deepEqual(await f.hashes(),original);assert.deepEqual(f.asr,[]);const events=f.events.slice(count);assert.equal(events.some(e=>e.tool==='reuse_verified_narration'&&(e.input as any).chapterId==='ch1'),false);assert.ok(events.some(e=>e.tool==='prepare_speech_edges'&&(e.input as any).chapterId==='ch1'));assert.equal(events.some(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor'),false);assert.equal(JSON.parse(await readFile(file,'utf8')).version,1);
}));


test('two proven frozen waves survive a pending ASR transport failure and resume the identical pending waveform',async()=>controlled(async f=>{
 const transport=new TextTransportError(3,new Error('Controlled connection error')),normal=f.options.analyze;let pendingHash='',pendingId='';
 await assert.rejects(runLessonWorkflow({...f.options,analyze:async(item:any,file:string)=>{if(path.basename(path.dirname(file))==='ch3'){pendingHash=hashBytes(await readFile(file));pendingId=item.id;throw transport;}return normal(item,file);}}),error=>causedBy(error,transport));
 assert.ok(pendingHash);for(const id of ['ch1','ch2'])assert.equal(JSON.parse(await readFile(path.join(f.work,id,'speech-proof.json'),'utf8')).version,1);await assert.rejects(readFile(path.join(f.work,'ch3/speech-proof.json')),/ENOENT/);
 const frozenTimes=await Promise.all(['ch1','ch2'].map(id=>stat(path.join(f.work,id,'speech.mp3')))),hashes=await f.hashes(),count=f.events.length;f.asr.length=0;
 await assert.rejects(runLessonWorkflow({...f.options,analyze:async(item:any,file:string)=>{assert.equal(path.basename(path.dirname(file)),'ch3');assert.equal(hashBytes(await readFile(file)),pendingHash);assert.equal(item.id,pendingId);return normal(item,file);}}),error=>causedBy(error,STOP));
 assert.deepEqual(f.asr,['ch3']);assert.deepEqual(await f.hashes(),hashes);assert.equal(JSON.parse(await readFile(path.join(f.work,'ch3/speech-analysis.json'),'utf8')).sourceHash,pendingHash);
 for(const [i,id] of ['ch1','ch2'].entries())assert.equal((await stat(path.join(f.work,id,'speech.mp3'))).mtimeMs,frozenTimes[i].mtimeMs);const events=f.events.slice(count);assert.equal(events.some(e=>e.tool==='synthesize_chapter'||e.tool==='synthesize_voice_anchor'),false);assert.equal(events.filter(e=>e.tool==='reuse_verified_narration').length,2);
}));
