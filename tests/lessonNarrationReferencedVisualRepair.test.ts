import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {LessonReport,AudioAnalysis,MediaItem,RenderReview,WorkflowEvent} from '../shared/types';
import {lessonRepairPlan,lessonVisualBrief} from '../server/visualRecovery';
import {lessonSettings,validateLesson,alignLessonSpeech} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {validatePlan} from '../server/core';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {withModelSnapshot} from '../server/modelContext';

const actual=JSON.parse(await readFile(new URL('./fixtures/p27-narration-referenced-visual-repair.json',import.meta.url),'utf8')) as {report:LessonReport;review:RenderReview};
const rejected=(findings:string[]):RenderReview=>({...structuredClone(actual.review),semantic:{...structuredClone(actual.review.semantic!),findings}});
const first=actual.review.semantic!.findings[0],second=actual.review.semantic!.findings[1];

test('actual P27 animation and irrelevant-label findings redraw chapter 1 without rewriting a quoted verified narration',()=>{
  const before=structuredClone(actual),plan=lessonRepairPlan(actual.report,actual.review);
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.visualChapterIds,['chapter-1']);assert.deepEqual(plan.scriptChapterIds,[]);assert.deepEqual(plan.visualFindings['chapter-1'],actual.review.semantic!.findings);assert.deepEqual(plan.layoutChapterIds,[]);
  assert.deepEqual(actual,before);assert.equal(actual.review.score,82,'historical score is never promoted by routing');
  assert.equal(lessonRepairPlan(actual.report,rejected([first])).kind,'visual');
  assert.equal(lessonRepairPlan(actual.report,rejected([second])).kind,'script','an unquoted reference to this narration is not an independent authorization');
  assert.equal(lessonRepairPlan(actual.report,rejected([second,second])).kind,'script','duplicated vague review text cannot manufacture evidence');
});

test('same-review timing context supports synonymous visual phrasing only within the actually quoted chapter',()=>{
  const anchor='chapter-1：步骤标签没有按旁白“外卖剩菜、苹果皮香蕉皮”“汤水沥进下水口”逐步点亮，动画时序脱节。';
  const companion='chapter-1：画面标签与本旁白的当前讲解不对应，无关分类流程是多余动效。';
  assert.equal(lessonRepairPlan(actual.report,rejected([anchor,companion])).kind,'visual');
  assert.equal(lessonRepairPlan(actual.report,rejected([companion])).kind,'script');
  const different=lessonRepairPlan(actual.report,rejected([anchor,companion.replaceAll('chapter-1','chapter-2')]));
  assert.equal(different.kind,'script');assert.deepEqual(different.scriptChapterIds,['chapter-2']);assert.deepEqual(different.visualChapterIds,['chapter-1']);
});

test('source, actual speech, subtitle errors and different quoted words cannot use the visual comparison route',()=>{
  for(const fault of [
    '来源引用错误，正文没有支持这条说法。',
    '旁白实际说错了数字。',
    '旁白实际说“少量清汤沥进下水口”，与当前稿不同。',
    '字幕漏掉了句首的观字。',
    '字幕多了他字。',
    '字幕显示错误，少了否定词。',
    '字幕不是原话。',
    '原声有发音错误。',
  ]){
    const finding=first+' '+fault,plan=lessonRepairPlan(actual.report,rejected([finding,second]));
    assert.equal(plan.kind,'script',fault);assert.ok(plan.scriptChapterIds.includes('chapter-1'),fault);
  }
  const different=first.replace('汤水沥进下水口','汤水倒进厨余桶');
  assert.equal(lessonRepairPlan(actual.report,rejected([different,second])).kind,'script');
  assert.equal(lessonRepairPlan(actual.report,rejected(['chapter-1：画面与旁白内容有问题，需要处理。'])).kind,'script');
});

test('current fact approval and complete unique sound evidence are required for the additional route',()=>{
  for(const mutate of [
    (report:LessonReport,review:RenderReview)=>{report.factReview!.needsRepair=true;},
    (report:LessonReport,review:RenderReview)=>{report.factReview!.score=79;},
    (report:LessonReport,review:RenderReview)=>{report.factReview!.findings=['当前事实尚有争议'];},
    (report:LessonReport,review:RenderReview)=>{review.checks=review.checks.filter(c=>c.name!=='字幕原话');},
    (report:LessonReport,review:RenderReview)=>{review.checks.push({...review.checks.find(c=>c.name==='完整句子')!});},
    (report:LessonReport,review:RenderReview)=>{delete review.audio;},
    (report:LessonReport,review:RenderReview)=>{review.audio!.userReportedMismatch=true;},
    (report:LessonReport,review:RenderReview)=>{review.audio!.voice!.segments[0].status='uncertain';},
    (report:LessonReport,review:RenderReview)=>{review.audio!.segments[0].id='unknown-chapter';},
  ]){const report=structuredClone(actual.report),review=structuredClone(actual.review);mutate(report,review);assert.notEqual(lessonRepairPlan(report,review).kind,'visual');}
  const review=structuredClone(actual.review);review.checks.find(c=>c.name==='段内音量稳定性')!.passed=false;
  assert.deepEqual(lessonRepairPlan(actual.report,review).visualChapterIds,[]);
});

test('the visual brief preserves the narration and treats feedback as a defect allegation rather than new audience content',()=>{
  const brief=lessonVisualBrief(actual.report,actual.report.chapters[0],'只讲厨余沥水',first);
  assert.equal(brief.audienceContent.narration,actual.report.chapters[0].narration);
  assert.deepEqual(brief.audienceContent.claims,actual.report.chapters[0].claims);
  assert.match(brief.internalDesignInstructions.rules.join('\n'),/不得凭空增加动作、分类步骤/);
  assert.match(brief.internalDesignInstructions.rules.join('\n'),/不能作为新事实/);
  assert.doesNotMatch(JSON.stringify(brief.audienceContent),/步骤标签全部为灰色线稿/);
});

const prompt='从零做30秒竖屏知识图解，说明厨余垃圾为什么先沥水，不扩成垃圾分类大全。';
const config={id:'controlled',name:'controlled',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',modelId:'controlled-model',apiKey:'controlled-only',enabled:true};
const canonical=(value:unknown)=>JSON.parse(JSON.stringify(value));
async function seed(directory:string){
  const work=path.join(directory,'lesson-workflows/case'),mediaDir=path.join(directory,'media');await mkdir(work,{recursive:true});await mkdir(mediaDir);
  const report=validateLesson({...structuredClone(actual.report),...lessonSettings(prompt),presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:'controlled-anchor',revision:0,tempo:1}},prompt);
  const media:MediaItem[]=[],identity:Record<string,{hash:string;mtimeMs:number}>={},durations=[9.34,11.66,9.62],rendererHash=lessonRendererHash();
  for(const [index,chapter]of report.chapters.entries()){
    const dir=path.join(work,chapter.id);await mkdir(dir);const audio=Buffer.from('CONTROLLED verified waveform identity '+chapter.id),scene=Buffer.from('CONTROLLED existing scene identity '+chapter.id),duration=durations[index];
    const analysis:AudioAnalysis={status:'ready',modelId:'controlled',sourceHash:hashBytes(audio),duration,transcript:chapter.narration,sentences:[{id:'s',start:0,end:duration,text:chapter.narration,complete:true,words:[...chapter.narration].map((text,i,chars)=>({text,start:duration*i/chars.length,end:duration*(i+1)/chars.length}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
    const aligned=alignLessonSpeech(chapter,analysis);chapter.cues=aligned.cues;chapter.speechMatch=aligned.similarity;chapter.mediaId='old-scene-'+index;chapter.duration=duration;chapter.audioHash=hashBytes(audio);chapter.htmlHash=hashBytes('controlled old HTML '+chapter.id);
    for(const[name,bytes]of [['raw-speech.mp3',audio],['speech.mp3',audio],['speech-analysis.json',Buffer.from(JSON.stringify(analysis))]]as const){const file=path.join(dir,name);await writeFile(file,bytes);identity[file]={hash:hashBytes(bytes),mtimeMs:(await stat(file)).mtimeMs};}
    const file=path.join(mediaDir,chapter.mediaId);await writeFile(file,scene);const sceneAnalysis={...structuredClone(analysis),sourceHash:hashBytes(scene)};
    media.push({id:chapter.mediaId,kind:'video',name:chapter.title,mimeType:'video/mp4',url:'',createdAt:'',origin:'generated',hasAudio:true,duration,analysis:sceneAnalysis,generation:{workflowId:report.workflowId,beatId:chapter.id,mode:'generated',lineHash:hashBytes(chapter.narration),audioHash:chapter.audioHash,htmlHash:chapter.htmlHash,referenceHash:report.voice!.anchorHash}});
    if(index){
      const contextHash=hashBytes(JSON.stringify({version:1,rendererHash,prompt,title:chapter.title,narration:chapter.narration,visual:chapter.visual,reason:chapter.reason,cues:chapter.cues,audioHash:hashBytes(audio),analysis,format:report.format,references:report.references}));
      await writeFile(path.join(dir,'html-recovery.json'),JSON.stringify({version:1,contextHash,attempts:1,failed:[],completed:{result:{file,duration,audioHash:chapter.audioHash,htmlHash:chapter.htmlHash,analysis:sceneAnalysis},fileHash:sceneAnalysis.sourceHash}}));
    }
  }
  const plan=validatePlan({lesson:report,format:report.format,targetSeconds:30,summary:'Controlled existing candidate',clips:report.chapters.map((c,index)=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:c.duration!,purpose:index===0?'hook':index===2?'conclusion':'argument',transition:index?{kind:'fade',duration:.25}:{kind:'cut',duration:0}})),audio:{originalVolume:1,narrationVolume:0,bgmVolume:0,normalize:true}},media);
  const file=path.join(directory,'candidate-1.mp4');await writeFile(file,'CONTROLLED original candidate identity; not playable media');const script=Buffer.from(JSON.stringify(report,null,2));await writeFile(path.join(work,'script.json'),script);
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})),phase:'review',rendererHash,research:{summary:'Controlled previously verified public source projection.',queries:[],references:report.references},report,plan,rendered:{id:'candidate-1',file},renderedHash:hashBytes(await readFile(file)),renders:1}));
  return {work,mediaDir,media,report,identity,script,scriptMtimeMs:(await stat(path.join(work,'script.json'))).mtimeMs,file};
}

for(const secondPassed of [true,false])test(`P27 visual-only SDK workflow preserves script and all waveform bytes and reserves exactly one rerender; second review ${secondPassed?'passes':'fails'} (state-only controlled callbacks)`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-p27-narration-visual-')),savedFetch=globalThis.fetch,s=await seed(directory),before=canonical(s.report),events:WorkflowEvent[]=[],authored:string[]=[],produced:string[]=[];
  let calls=0,asr=0,renders=0,reviews=0;
  globalThis.fetch=async()=>{calls++;throw new Error('Visual repair cannot invoke a provider');};
  try{
    const result=await withModelSnapshot({text:config,understanding:null,audio:{...config,kind:'audio',modelId:'seed-audio-1.0'},image:null},()=>runLessonWorkflow({prompt,config,audioConfig:{...config,kind:'audio',modelId:'seed-audio-1.0'},media:s.media,dataDir:directory,mediaDir:s.mediaDir,ownerId:'fixture-owner',checkpointKey:'case',export:true,stage:async()=>{},progress:async updates=>{events.splice(0,events.length,...updates);},register:async()=>{},persist:async()=>{},saveDraft:async draft=>{assert.deepEqual(draft.chapters.map(c=>({narration:c.narration,claims:c.claims,referenceIds:c.referenceIds})),before.chapters.map((c:any)=>({narration:c.narration,claims:c.claims,referenceIds:c.referenceIds})));},analyze:async()=>{asr++;throw new Error('No new ASR');},
      authorVisual:async(_config,beat)=>{authored.push(beat.id);assert.equal(beat.id,'chapter-1');const brief=JSON.parse(beat.visualBrief||'{}');assert.equal(brief.audienceContent.narration,before.chapters[0].narration);assert.equal(brief.internalDesignInstructions.reviewFeedback,actual.review.semantic!.findings.join('\n'));return{title:'厨余先沥水',nodes:[{id:'one',kind:'card',x:60,y:280,w:260,h:120,text:'外卖剩菜',tone:'blue',fontSize:24,highlight:false},{id:'two',kind:'card',x:380,y:280,w:260,h:120,text:'固体残渣投放',tone:'ink',fontSize:24,highlight:false},{id:'link',kind:'line',x:320,y:340,w:60,h:0,text:'',tone:'ink',fontSize:24,highlight:false}]};},
      produceScene:async chapter=>{produced.push(chapter.id);assert.equal(chapter.id,'chapter-1');const old=s.media[0],file=path.join(s.work,chapter.id,'new-scene.mp4'),bytes=Buffer.from('CONTROLLED redraw of '+chapter.id);await writeFile(file,bytes);return{file,duration:old.duration!,audioHash:old.generation!.audioHash,htmlHash:hashBytes('controlled corrected HTML'),analysis:{...structuredClone(old.analysis!),sourceHash:hashBytes(bytes)}};},
      render:async plan=>{assert.equal(++renders,1,'only the existing one reserved post-review render');assert.deepEqual(plan.lesson!.chapters.map(c=>({id:c.id,narration:c.narration,visual:c.visual,claims:c.claims,referenceIds:c.referenceIds})),before.chapters.map((c:any)=>({id:c.id,narration:c.narration,visual:c.visual,claims:c.claims,referenceIds:c.referenceIds})));const file=path.join(directory,'candidate-2.mp4');await writeFile(file,'CONTROLLED new candidate identity; not media QA');return{id:'candidate-2',file};},
      review:async file=>{reviews++;assert.equal(file,path.join(directory,reviews===1?'candidate-1.mp4':'candidate-2.mp4'));if(reviews===1)return structuredClone(actual.review);return {...rejected(secondPassed?[]:[first]),status:secondPassed?'passed':'needs-review',score:secondPassed?92:81,checks:actual.review.checks.map(c=>c.name==='成片语义审查'?{...c,passed:secondPassed,detail:secondPassed?'Controlled fresh review callback':first}:c),semantic:{score:secondPassed?92:81,findings:secondPassed?[]:[first],suggestions:[]},limitations:['Controlled callback proves routing and immutable identity only, not media quality.']};},
    }));
    assert.equal(calls,0);assert.equal(asr,0);assert.equal(renders,1);assert.equal(reviews,2);assert.deepEqual(authored,['chapter-1']);assert.deepEqual(produced,['chapter-1']);assert.equal(result.review?.status,secondPassed?'passed':'needs-review');
    assert.equal(events.some(e=>['revise_lesson_script','review_lesson_script','synthesize_narration','synthesize_chapter','transcribe_chapter'].includes(e.tool)),false);
    const repair=events.find(e=>e.tool==='repair_lesson')!.output as any;assert.deepEqual(repair.details.redrawChapters,['chapter-1']);assert.equal(repair.details.preservedAudio,true);assert.equal(repair.details.preservedScript,true);
    const cp=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.equal(cp.renders,2);assert.equal(cp.voiceRevision,0);assert.deepEqual(cp.chapterVoiceRevisions,{});assert.deepEqual(cp.report.factReview,before.factReview);assert.deepEqual(cp.report.references,before.references);
    if(!secondPassed){assert.equal(cp.best.rendered.id,'candidate-1');assert.equal(cp.best.review.score,82,'a lower second rejection must retain the original best candidate and score');assert.equal(cp.review.score,81,'the new failed review remains recorded');}
    assert.deepEqual(await readFile(path.join(s.work,'script.json')),s.script);
    assert.equal((await stat(path.join(s.work,'script.json'))).mtimeMs,s.scriptMtimeMs);
    for(const[file,identity]of Object.entries(s.identity)){assert.equal(hashBytes(await readFile(file)),identity.hash);assert.equal((await stat(file)).mtimeMs,identity.mtimeMs);}
    assert.equal(hashBytes(await readFile(s.file)),hashBytes(Buffer.from('CONTROLLED original candidate identity; not playable media')));assert.equal(actual.review.score,82);
  }finally{globalThis.fetch=savedFetch;await rm(directory,{recursive:true,force:true});}
});
