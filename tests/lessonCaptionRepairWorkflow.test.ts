import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {hashBytes} from '../server/narrativeScenes';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {validatePlan} from '../server/core';
import {withModelSnapshot} from '../server/modelContext';
import type {AudioAnalysis,EditPlan,LessonReport,MediaItem,RenderReview,WorkflowEvent} from '../shared/types';

const prompt='制作45秒横屏知识图解视频，解释服务接口和信息核验';
const config={id:'controlled-text',name:'controlled text',kind:'text' as const,provider:'ark',baseUrl:'https://provider.example.invalid',modelId:'controlled-model',apiKey:'controlled-only',enabled:true};
const audioConfig={...config,kind:'audio' as const};
const finding='chapter-2：字幕以“v四点一”逐字排版，型号的规范书写应为“V4.1”，应作字幕正字和格式修复。';
function review(passed:boolean):RenderReview{return{status:passed?'passed':'needs-review',score:passed?94:88,checks:[{name:'成片语义审查',passed,detail:passed?'Controlled callback accepted only the corrected state':finding}],semantic:{score:passed?94:88,findings:passed?[]:[finding]},limitations:['Controlled review callback; this test does not claim actual media quality.'],createdAt:''};}

async function seed(directory:string,wrongVersion=false){
  const fixture=JSON.parse(await readFile(new URL('./fixtures/p15-model-caption.json',import.meta.url),'utf8')),work=path.join(directory,'lesson-workflows/case'),mediaDir=path.join(directory,'media');await mkdir(work,{recursive:true});await mkdir(mediaDir);
  const references=fixture.references.map((ref:any)=>({...ref,url:ref.id==='ref-1'?'https://m.huanqiu.com/article/4TcSj6f5JG1':'https://www.nfnews.com/content/LozBqMl5on.html'}));
  const chapter2=structuredClone(fixture.chapter);chapter2.reason='保留已核验的接口说明和来源。';chapter2.visual.items[2].detail='正式名DeepSeek V4.1 Flash API';
  const chapters=Array.from({length:3},(_,i)=>i===1?chapter2:{id:'chapter-'+(i+1),title:'信息核验'+i,role:i===0?'hook' as const:'recap' as const,goal:'先核对来源再给出结论',prerequisites:i?['chapter-2']:[],narration:'误差变大损失越高。'.repeat(7),reason:'受控恢复夹具',referenceIds:['ref-1'],claims:[{text:'服务接口出现异常',referenceIds:['ref-1'],basis:'source' as const}],visual:{kind:'concept' as const,takeaway:'保留完整来源和证据边界',items:[{label:'核验',detail:'比较实际证据',cue:'误差变大'},{label:'结论',detail:'先核验后判断',cue:'损失越高'}]}});
  const report=validateLesson({workflowId:'controlled-caption-recovery',...lessonSettings(prompt),title:'服务与核验',audience:'普通观众',objectives:['理解接口','理解核验'],arc:'核验接口与边界',chapters,references,limitations:[],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'controlled-audio',anchorHash:'controlled-anchor',revision:0,tempo:1},factReview:{score:94,needsRepair:false,findings:[]}},prompt);
  const rawFiles=new Map<string,Buffer>(),media:MediaItem[]=[];
  // Real P15 transcribed words/timestamps, with controlled file bytes for
  // checkpoint identity. Neither these bytes nor callbacks establish media QA.
  for(const [i,chapter] of report.chapters.entries()){
    const id='controlled-source-'+i,bytes=Buffer.from('CONTROLLED existing scene bytes '+id),speech=Buffer.from('CONTROLLED original voice bytes '+chapter.id),rawHash=hashBytes(speech),duration=i===1?fixture.captioned.duration+.9:14;
    const analysis:AudioAnalysis=i===1?structuredClone(fixture.captioned):{status:'ready',modelId:'controlled-analysis',sourceHash:'',duration,transcript:chapter.narration,sentences:[{id:'s',start:0,end:duration,text:chapter.narration,complete:true,words:[...chapter.narration].map((text,j,chars)=>({text,start:duration*j/chars.length,end:duration*(j+1)/chars.length}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
    if(i===1&&wrongVersion){analysis.transcript=analysis.transcript.replace('v四点一','v四点二');for(const sentence of analysis.sentences){sentence.text=sentence.text.replace('v四点一','v四点二');const text=sentence.words.map(word=>word.text).join(''),at=text.indexOf('v四点一')+3;let offset=0;if(at>=3)for(const word of sentence.words){if(offset<=at&&at<offset+word.text.length)word.text=word.text.slice(0,at-offset)+'二'+word.text.slice(at-offset+1);offset+=word.text.length;}}}
    analysis.sourceHash=hashBytes(bytes);chapter.mediaId=id;chapter.duration=duration;chapter.audioHash=rawHash;chapter.htmlHash='controlled-html-'+i;chapter.speechMatch=1;chapter.cues=chapter.visual.items.map(item=>({text:item.cue,start:0,end:duration}));
    const item:MediaItem={id,kind:'video',name:chapter.title,mimeType:'video/mp4',duration,url:'',createdAt:'',hasAudio:true,origin:'generated',analysis,generation:{workflowId:report.workflowId,beatId:chapter.id,mode:'generated',lineHash:hashBytes(chapter.narration),audioHash:rawHash,htmlHash:chapter.htmlHash,referenceHash:report.voice!.anchorHash}};
    media.push(item);await writeFile(path.join(mediaDir,id),bytes);const dir=path.join(work,chapter.id);await mkdir(dir);
    const rawAnalysis=i===1?{...structuredClone(fixture.raw),sourceHash:rawHash}:structuredClone(analysis);
    for(const [name,content]of [['raw-speech.mp3',speech],['speech.mp3',speech],['speech-analysis.json',Buffer.from(JSON.stringify(rawAnalysis))]] as const){const file=path.join(dir,name);await writeFile(file,content);rawFiles.set(file,content);}
  }
  const plan=validatePlan({lesson:report,format:report.format,targetSeconds:45,summary:'Controlled existing candidate',clips:report.chapters.map(chapter=>({sceneId:chapter.id,sourceId:chapter.mediaId!,start:0,end:chapter.duration!,purpose:'argument'})),audio:{originalVolume:1,narrationVolume:0,bgmVolume:0,normalize:true}},media),file=path.join(directory,'candidate-1.mp4');await writeFile(file,'CONTROLLED original candidate bytes; not media acceptance');
  const scriptBytes=Buffer.from(JSON.stringify(report,null,2));await writeFile(path.join(work,'script.json'),scriptBytes);
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'review',rendererHash:lessonRendererHash(),report,research:{summary:'Controlled already-verified source projection',queries:[],references:report.references},plan,rendered:{id:'candidate-1',file},renderedHash:hashBytes(await readFile(file)),renders:1}));
  return{work,mediaDir,report,plan,file,media,rawFiles,scriptBytes};
}

test('P15 same-value model spelling rerenders captions with original script, source bytes, voice and word timing',async()=>{
  const {runLessonWorkflow}=await import('../server/lessonWorkflow'),directory=await mkdtemp(path.join(tmpdir(),'qingjian-caption-workflow-')),s=await seed(directory),originalFetch=globalThis.fetch,originalMedia=structuredClone(s.media),events:WorkflowEvent[]=[],drafts:LessonReport[]=[],newMedia:MediaItem[]=[];let fetches=0,renders=0,reviews=0,asr=0;
  globalThis.fetch=async()=>{fetches++;throw new Error('Caption identity recovery must not call a provider');};
  try{
    const result=await withModelSnapshot({text:config,understanding:null,audio:audioConfig,image:null},()=>runLessonWorkflow({prompt,config,audioConfig,media:s.media,dataDir:directory,mediaDir:s.mediaDir,ownerId:'fixture-owner',checkpointKey:'case',export:true,stage:async()=>{},progress:async updates=>{events.splice(0,events.length,...updates);},register:async item=>{newMedia.push(structuredClone(item));},persist:async()=>{},saveDraft:async draft=>{drafts.push(structuredClone(draft));},analyze:async()=>{asr++;throw new Error('Unexpected ASR');},render:async plan=>{renders++;assert.ok(plan.captions?.some(caption=>caption.text.includes('V4.1')));assert.ok(!plan.captions?.some(caption=>caption.text.includes('v四点一')));const file=path.join(directory,'candidate-2.mp4');await writeFile(file,'CONTROLLED new caption candidate bytes');return{id:'candidate-2',file};},review:async(file: string,_plan:EditPlan)=>{reviews++;assert.equal(file,path.join(directory,reviews===1?'candidate-1.mp4':'candidate-2.mp4'));return review(reviews===2);}}));
    assert.equal(result.rendered?.id,'candidate-2');assert.equal(result.review?.status,'passed');assert.equal(renders,1);assert.equal(reviews,2);assert.equal(fetches,0);assert.equal(asr,0);assert.equal(newMedia.length,1);
    assert.deepEqual(events.map(event=>event.tool),['review_lesson','repair_lesson','render_lesson','review_lesson']);
    assert.deepEqual(await readFile(path.join(s.work,'script.json')),s.scriptBytes);for(const [file,bytes]of s.rawFiles)assert.deepEqual(await readFile(file),bytes);
    for(const item of originalMedia){assert.deepEqual(s.media.find(candidate=>candidate.id===item.id),item);assert.equal(hashBytes(await readFile(path.join(s.mediaDir,item.id))),item.analysis!.sourceHash);}
    const previous=originalMedia[1],corrected=newMedia[0];assert.equal(corrected.generation!.audioHash,previous.generation!.audioHash);assert.equal(corrected.analysis!.sourceHash,previous.analysis!.sourceHash);assert.equal(corrected.analysis!.duration,previous.analysis!.duration);assert.deepEqual(corrected.analysis!.captionBreaks,previous.analysis!.captionBreaks);assert.deepEqual(corrected.analysis!.sentences.map(sentence=>({start:sentence.start,end:sentence.end,complete:sentence.complete,words:sentence.words.map(word=>({start:word.start,end:word.end}))})),previous.analysis!.sentences.map(sentence=>({start:sentence.start,end:sentence.end,complete:sentence.complete,words:sentence.words.map(word=>({start:word.start,end:word.end}))})));
    for(const draft of drafts)assert.deepEqual(draft.chapters.map(chapter=>({narration:chapter.narration,visual:chapter.visual,claims:chapter.claims})),s.report.chapters.map(chapter=>({narration:chapter.narration,visual:chapter.visual,claims:chapter.claims})));assert.ok(drafts.every(draft=>!JSON.stringify(draft.chapters.map(chapter=>chapter.visual)).includes('字幕规范显示')));
    const checkpoint=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(checkpoint.renders,2);assert.equal(checkpoint.voiceRevision,0);assert.deepEqual(checkpoint.chapterVoiceRevisions,{});
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});

test('a different heard version cannot use the caption-only rerender shortcut or rewrite its source analysis',async()=>{
  const {runLessonWorkflow}=await import('../server/lessonWorkflow'),directory=await mkdtemp(path.join(tmpdir(),'qingjian-caption-wrong-version-')),s=await seed(directory,true),originalFetch=globalThis.fetch,before=structuredClone(s.media),STOP=new Error('controlled stop before script decision');let fetches=0,renders=0,reviews=0,registrations=0;
  globalThis.fetch=async()=>{fetches++;throw new Error('unexpected provider');};
  try{
    await assert.rejects(withModelSnapshot({text:config,understanding:null,audio:audioConfig,image:null},()=>runLessonWorkflow({prompt,config,audioConfig,media:s.media,dataDir:directory,mediaDir:s.mediaDir,ownerId:'fixture-owner',checkpointKey:'case',export:true,stage:async stage=>{if(stage.includes('定向返修')||stage==='制作统一教学旁白')throw STOP;},progress:async()=>{},register:async()=>{registrations++;},persist:async()=>{},saveDraft:async()=>{},analyze:async()=>{throw new Error('unexpected ASR');},render:async()=>{renders++;throw new Error('unexpected rerender');},review:async()=>{reviews++;return review(false);}})),error=>error===STOP||error instanceof Error&&error.message.includes('controlled stop before script decision'));
    assert.equal(fetches,0);assert.equal(renders,0);assert.equal(registrations,0);assert.equal(reviews,1);assert.deepEqual(s.media,before);for(const [file,bytes]of s.rawFiles)assert.deepEqual(await readFile(file),bytes);assert.deepEqual(await readFile(path.join(s.work,'script.json')),s.scriptBytes);
    const checkpoint=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(checkpoint.renders,1);assert.equal(checkpoint.phase,'narration','a different heard value uses the existing speech repair route');assert.equal(checkpoint.voiceRevision,0);assert.deepEqual(checkpoint.chapterVoiceRevisions,{'chapter-2':1});
  }finally{globalThis.fetch=originalFetch;await rm(directory,{recursive:true,force:true});}
});
