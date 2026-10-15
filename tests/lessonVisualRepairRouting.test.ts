import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {LessonReport,AudioAnalysis,MediaItem,RenderReview,WorkflowEvent} from '../shared/types';
import {lessonRepairPlan} from '../server/visualRecovery';
import {lessonSettings,validateLesson,alignLessonSpeech} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {validatePlan} from '../server/core';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {withModelSnapshot} from '../server/modelContext';

const actual=JSON.parse(await readFile(new URL('./fixtures/p19-visual-repair-routing.json',import.meta.url),'utf8')) as {report:LessonReport;review:RenderReview};
const rejection=(findings:string[]):RenderReview=>({...structuredClone(actual.review),semantic:{score:72,findings,suggestions:[]}});

test('all four actual P19 rendering findings preserve the verified script rather than returning it to factual repair',()=>{
  const before=structuredClone(actual),plan=lessonRepairPlan(actual.report,actual.review);
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.scriptChapterIds,[]);assert.deepEqual(plan.visualChapterIds,['chapter-1','chapter-2']);assert.deepEqual(plan.unknownFindings,[]);
  assert.equal(plan.visualFindings['chapter-1'].length,2);assert.equal(plan.visualFindings['chapter-2'].length,2);
  assert.deepEqual(actual,before,'routing cannot modify the original score, review, script or sources');assert.equal(actual.review.score,72);
});

test('diagram counts, isolated labels, spelling and crossing paths are visual defects within their exact chapter',()=>{
  for(const finding of [
    'chapter-2：实际画面标签「top-4」标注4个，模型观察该抽帧仅3个（三条从路由器指向专家的红线）；画面数量与标注不一致，请重绘图解。',
    'chapter-2：示意图顶部写top-4，但只画出三条专家路径，图解数量不一致。',
    'chapter-2：标签文字存在孤字换行，最后一个字单字成行。',
    'chapter-2：分镜中的来源标签有渲染拼写错误，需要按已核验来源名称重画。',
    'chapter-2：示意图连线交叉错乱，图解可读性缺陷。',
  ]){const plan=lessonRepairPlan(actual.report,rejection([finding]));assert.equal(plan.kind,'visual',finding);assert.deepEqual(plan.visualChapterIds,['chapter-2']);assert.deepEqual(plan.scriptChapterIds,[]);}
});

test('a scoped displayed number error needs a literal correct current narration and cannot excuse source or speech faults',()=>{
  const report=structuredClone(actual.report);report.chapters[1].narration='总参数约二百四十亿，只有少量专家参与。';
  const visual='chapter-2：旁白原句“总参数约二百四十亿”与来源一致，但画面数据错误，把总参数画成二百亿。';
  assert.equal(lessonRepairPlan(report,rejection([visual])).kind,'visual');
  for(const finding of [
    visual.replace('总参数约二百四十亿”','总参数约二百五十亿”'),
    'chapter-2：画面数据错误，总参数的来源尚不明确，不能判断旁白是否准确。',
    visual+'来源未核验。',
    visual+'另有事实错误。',
    'chapter-2：旁白原句“总参数约二百四十亿”与来源矛盾，画面数据错误。',
    'chapter-2：数据错误，柱状图错误。',
  ]){assert.equal(lessonRepairPlan(report,rejection([finding])).kind,'script',finding);}
  assert.notEqual(lessonRepairPlan(report,rejection(['chapter-2：字幕漏字，标签也有孤字换行。'])).kind,'visual','a speech/caption failure cannot preserve the failed voice through a visual-only route');
});

test('unknown and genuine factual findings still fail closed, with mixed repair scoped away from good narration',()=>{
  for(const finding of ['chapter-2：本章需要进一步确认。','chapter-2：来源未核验，标签有渲染拼写错误。','chapter-2：来源尚不明确，标签有渲染拼写错误。','chapter-2：证据未知，示意图连线交叉。','chapter-2：旁白与来源不符，完成状态错误，连线也交叉错乱。'])assert.equal(lessonRepairPlan(actual.report,rejection([finding])).kind,'script',finding);
  const plan=lessonRepairPlan(actual.report,rejection([actual.review.semantic!.findings[1],'chapter-2：旁白与来源不符，完成状态错误。']));
  assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.visualChapterIds,['chapter-1']);
});

test('explicit citation and source-date faults cannot hide behind unrelated rendering defects',()=>{
  for(const finding of [
    'chapter-2：来源引用错误，CSDN正文未提及该型号，图解连线交叉。',
    'chapter-1：报道日期与实际来源矛盾，标签孤字换行。',
    'chapter-2：该模型的引用归属错误，分镜标签有拼写错误。',
    'chapter-2：图解连线交叉，而且来源引用错误。',
  ]){const plan=lessonRepairPlan(actual.report,rejection([finding]));assert.equal(plan.kind,'script',finding);assert.deepEqual(plan.visualChapterIds,[]);}
  const visual=lessonRepairPlan(actual.report,rejection(['chapter-2：画面来源标签拼写错误，将已核验来源名ShShell渲染为ShShel，需要重画标签。']));assert.equal(visual.kind,'visual');assert.deepEqual(visual.visualChapterIds,['chapter-2']);assert.deepEqual(visual.scriptChapterIds,[]);
  const mixed=lessonRepairPlan(actual.report,rejection([actual.review.semantic!.findings[1],'chapter-2：来源引用错误，CSDN正文未提及该型号，图解连线交叉。']));assert.equal(mixed.kind,'script');assert.deepEqual(mixed.scriptChapterIds,['chapter-2']);assert.deepEqual(mixed.visualChapterIds,['chapter-1']);
});

const prompt='制作45秒竖屏知识图解视频，快节奏解释模型容量和专家路由';
const config={id:'controlled',name:'controlled',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',modelId:'controlled-model',apiKey:'controlled-only',enabled:true};
const canonical=(value:unknown)=>JSON.parse(JSON.stringify(value));
async function seed(directory:string){
  const work=path.join(directory,'lesson-workflows/case'),mediaDir=path.join(directory,'media');await mkdir(work,{recursive:true});await mkdir(mediaDir);
  const input=structuredClone(actual.report);for(const chapter of input.chapters)for(const key of ['mediaId','duration','audioHash','htmlHash','speechMatch','cues'] as const)delete chapter[key];
  const report=validateLesson({...input,...lessonSettings(prompt),workflowId:'controlled-p19-visual-routing',limitations:['Controlled checkpoint identity fixture, not playable media or media acceptance.'],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:'controlled-anchor',revision:0,tempo:1}},prompt);
  const media:MediaItem[]=[],hashes:Record<string,string>={},durations=[17.34,12.06,15.97];
  let unchangedScene:any;
  for(const [index,chapter] of report.chapters.entries()){
    const dir=path.join(work,chapter.id);await mkdir(dir);const audio=Buffer.from('CONTROLLED original verified waveform '+chapter.id),scene=Buffer.from('CONTROLLED existing scene bytes '+chapter.id),duration=durations[index];
    const analysis:AudioAnalysis={status:'ready',modelId:'controlled',sourceHash:hashBytes(audio),duration,transcript:chapter.narration,sentences:[{id:'s',start:0,end:duration,text:chapter.narration,complete:true,words:[...chapter.narration].map((text,i,chars)=>({text,start:duration*i/chars.length,end:duration*(i+1)/chars.length}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
    const aligned=alignLessonSpeech(chapter,analysis);chapter.cues=aligned.cues;chapter.speechMatch=aligned.similarity;
    chapter.mediaId='old-scene-'+index;chapter.duration=duration;chapter.audioHash=hashBytes(audio);chapter.htmlHash=hashBytes('controlled old HTML '+chapter.id);
    for(const [name,bytes]of [['raw-speech.mp3',audio],['speech.mp3',audio],['speech-analysis.json',Buffer.from(JSON.stringify(analysis))]] as const){const filename=path.join(dir,name);await writeFile(filename,bytes);hashes[filename]=hashBytes(bytes);}
    const file=path.join(mediaDir,chapter.mediaId);await writeFile(file,scene);hashes[file]=hashBytes(scene);
    const sceneAnalysis={...structuredClone(analysis),sourceHash:hashBytes(scene)};
    media.push({id:chapter.mediaId,kind:'video',name:chapter.title,mimeType:'video/mp4',url:'',createdAt:'',origin:'generated',hasAudio:true,duration,analysis:sceneAnalysis,generation:{workflowId:report.workflowId,beatId:chapter.id,mode:'generated',lineHash:hashBytes(chapter.narration),audioHash:chapter.audioHash,htmlHash:chapter.htmlHash,referenceHash:report.voice!.anchorHash}});
    if(index===2)unchangedScene={chapter:structuredClone(chapter),source:{file:path.join(dir,'speech.mp3'),analysis},result:{file,duration,audioHash:chapter.audioHash,htmlHash:chapter.htmlHash,analysis:sceneAnalysis}};
  }
  // Existing unchanged chapter's actual cache file is hash-bound. No new
  // author/scene callback should run for it when chapters 1 and 2 are redrawn.
  const {chapter,source,result}=unchangedScene,rendererHash=lessonRendererHash();
  const contextHash=hashBytes(JSON.stringify({version:1,rendererHash,prompt,title:chapter.title,narration:chapter.narration,visual:chapter.visual,reason:chapter.reason,cues:chapter.cues,audioHash:hashBytes(await readFile(source.file)),analysis:source.analysis,format:report.format,references:report.references}));
  await writeFile(path.join(work,chapter.id,'html-recovery.json'),JSON.stringify({version:1,contextHash,attempts:1,failed:[],completed:{result,fileHash:result.analysis.sourceHash}}));
  const plan=validatePlan({lesson:report,format:report.format,targetSeconds:45,summary:'Controlled existing candidate',clips:report.chapters.map((c,index)=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:c.duration!,purpose:index===0?'hook':index===2?'conclusion':'argument',transition:index?{kind:'fade',duration:.18}:{kind:'cut',duration:0}})),audio:{originalVolume:1,narrationVolume:0,bgmVolume:0,normalize:true}},media),file=path.join(directory,'candidate-1.mp4');await writeFile(file,'CONTROLLED original candidate bytes, not playable media');
  const script=Buffer.from(JSON.stringify(report,null,2));await writeFile(path.join(work,'script.json'),script);
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'review',rendererHash,research:{summary:'Controlled previously verified public source projection.',queries:[],references:report.references},report,plan,rendered:{id:'candidate-1',file},renderedHash:hashBytes(await readFile(file)),renders:1}));
  return{work,mediaDir,media,report,hashes,script,file};
}

for(const secondPassed of [true,false])test(`actual P19 visual repair redraws only affected scenes without TTS/ASR/script changes; second review ${secondPassed?'passes':'remains failed'}`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-p19-visual-route-')),savedFetch=globalThis.fetch,s=await seed(directory),before=canonical(s.report),events:WorkflowEvent[]=[],authored:string[]=[],produced:string[]=[],drafts:LessonReport[]=[];let calls=0,asr=0,renders=0,reviews=0;
  globalThis.fetch=async()=>{calls++;throw new Error('Visual repair cannot make a provider request');};
  try{
    const result=await withModelSnapshot({text:config,understanding:null,audio:{...config,kind:'audio',modelId:'seed-audio-1.0'},image:null},()=>runLessonWorkflow({prompt,config,audioConfig:{...config,kind:'audio',modelId:'seed-audio-1.0'},media:s.media,dataDir:directory,mediaDir:s.mediaDir,ownerId:'fixture-owner',checkpointKey:'case',export:true,stage:async()=>{},progress:async updates=>{events.splice(0,events.length,...updates);},register:async()=>{},persist:async()=>{},saveDraft:async draft=>{drafts.push(structuredClone(draft));},analyze:async()=>{asr++;throw new Error('No new ASR');},
      authorVisual:async(_config,beat)=>{authored.push(beat.id);assert.ok(['chapter-1','chapter-2'].includes(beat.id));const brief=JSON.parse(beat.visualBrief||'{}');assert.equal(brief.audienceContent.narration,before.chapters.find((c:any)=>c.id===beat.id).narration);return{title:'模型与专家',nodes:[{id:'one',kind:'card',x:60,y:280,w:260,h:120,text:'模型容量',tone:'blue',fontSize:24,highlight:false},{id:'two',kind:'card',x:380,y:280,w:260,h:120,text:'少量专家',tone:'ink',fontSize:24,highlight:false},{id:'link',kind:'line',x:320,y:340,w:60,h:0,text:'',tone:'ink',fontSize:24,highlight:false}]};},
      produceScene:async chapter=>{produced.push(chapter.id);assert.ok(['chapter-1','chapter-2'].includes(chapter.id));const index=s.report.chapters.findIndex(c=>c.id===chapter.id),old=s.media.find(m=>m.id==='old-scene-'+index)!,file=path.join(s.work,chapter.id,'new-scene.mp4'),bytes=Buffer.from('CONTROLLED redraw of '+chapter.id);await writeFile(file,bytes);return{file,duration:old.duration!,audioHash:old.generation!.audioHash,htmlHash:hashBytes('controlled corrected HTML '+chapter.id),analysis:{...structuredClone(old.analysis!),sourceHash:hashBytes(bytes)}};},
      render:async plan=>{renders++;assert.equal(renders,1,'only one reserved post-review render');assert.deepEqual(plan.lesson!.chapters.map(c=>({id:c.id,narration:c.narration,claims:c.claims,referenceIds:c.referenceIds})),before.chapters.map((c:any)=>({id:c.id,narration:c.narration,claims:c.claims,referenceIds:c.referenceIds})));const file=path.join(directory,'candidate-2.mp4');await writeFile(file,'CONTROLLED fresh candidate bytes, not media QA');return{id:'candidate-2',file};},
      review:async file=>{reviews++;assert.equal(file,path.join(directory,reviews===1?'candidate-1.mp4':'candidate-2.mp4'));if(reviews===1)return structuredClone(actual.review);return{status:secondPassed?'passed':'needs-review',score:secondPassed?92:75,checks:[{name:'成片语义审查',passed:secondPassed,detail:secondPassed?'Controlled independent callback after rerender':'chapter-2：连线仍有交叉错乱。'}],semantic:{score:secondPassed?92:75,findings:secondPassed?[]:['chapter-2：连线仍有交叉错乱。'],suggestions:[]},limitations:['Controlled callback; this test establishes routing and immutable identity only, not actual media acceptance.'],createdAt:''};},
    }));
    assert.equal(calls,0);assert.equal(asr,0);assert.equal(renders,1);assert.equal(reviews,2);assert.deepEqual(authored,['chapter-1','chapter-2']);assert.deepEqual(produced,['chapter-1','chapter-2']);assert.equal(result.rendered?.id,'candidate-2');assert.equal(result.review?.status,secondPassed?'passed':'needs-review');
    assert.equal(events.some(e=>['revise_lesson_script','review_lesson_script','synthesize_narration','synthesize_chapter','transcribe_chapter'].includes(e.tool)),false);
    const repair=events.find(e=>e.tool==='repair_lesson')?.output as any;assert.deepEqual(repair.details.redrawChapters,['chapter-1','chapter-2']);assert.equal(repair.details.preservedScript,true);assert.equal(repair.details.preservedAudio,true);
    const cp=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(cp.renders,2);assert.equal(cp.voiceRevision,0);assert.deepEqual(cp.chapterVoiceRevisions,{});assert.deepEqual(cp.report.factReview,before.factReview);assert.deepEqual(cp.report.references,before.references);
    for(const draft of drafts)assert.deepEqual(draft.chapters.map(c=>({narration:c.narration,claims:c.claims,referenceIds:c.referenceIds})),before.chapters.map((c:any)=>({narration:c.narration,claims:c.claims,referenceIds:c.referenceIds})));
    assert.deepEqual(await readFile(path.join(s.work,'script.json')),s.script);for(const [file,hash]of Object.entries(s.hashes))assert.equal(hashBytes(await readFile(file)),hash);
    assert.equal(hashBytes(await readFile(s.file)),hashBytes(Buffer.from('CONTROLLED original candidate bytes, not playable media')));assert.equal(actual.review.score,72);
  }finally{globalThis.fetch=savedFetch;await rm(directory,{recursive:true,force:true});}
});
