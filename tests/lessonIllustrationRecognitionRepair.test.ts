import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {LessonReport,RenderReview,WorkflowEvent,AudioAnalysis,MediaItem} from '../shared/types';
import {lessonRepairPlan} from '../server/visualRecovery';
import {createLessonLayoutRepairProofs} from '../server/lessonLayoutRepair';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonSettings,validateLesson,alignLessonSpeech} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {validatePlan} from '../server/core';
import {hashBytes} from '../server/narrativeScenes';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';

const actual=JSON.parse(await readFile(new URL('./fixtures/p37-knowledge-illustration-routing.json',import.meta.url),'utf8'));
const prompt='制作30秒竖屏知识图解视频，解释运动鞋轻微异味和通风干燥的关系';
const config={id:'controlled',name:'controlled',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',modelId:'controlled',apiKey:'controlled-only',enabled:true};
// Only the chapter IDs/titles/narration and findings are actual projections.
// Other report fields and all media below are controlled routing scaffolding.
function report():LessonReport{
  return validateLesson({workflowId:'controlled-recognition',...lessonSettings(prompt),title:actual.title,audience:'初学者',objectives:['理解潮气和异味的关系','知道先通风干燥的顺序'],arc:'先提出问题，再解释关系，最后回顾做法',
    chapters:actual.chapters.map((chapter:any,i:number)=>({...chapter,role:i===0?'hook':i===2?'recap':'foundation',goal:'理解本章关系',reason:'用已有来源解释简单场景',prerequisites:i?['chapter-'+i]:[],referenceIds:['controlled-source'],claims:[{text:'鞋子再次穿着前应完全干透。',basis:'source',referenceIds:['controlled-source']}],visual:{kind:'concept',takeaway:'先干透再穿',items:[{label:'干燥',detail:'让潮气散开',cue:chapter.narration.slice(0,4)},{label:'再穿',detail:'完全干透后再穿',cue:chapter.narration.slice(-5,-1)}]}})),
    references:[{id:'controlled-source',title:'Controlled source scaffold',url:'https://example.invalid/source',retrievedAt:'2026-10-16T14:11:36.421Z',verification:'primary-page',excerpt:'鞋子再次穿着前应完全干透。'}],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:'controlled-anchor',revision:0,tempo:1},limitations:['Controlled routing state; not playable media, factual verification or media acceptance.'],factReview:{...actual.acceptedFacts,suggestions:[],adjudication:{modelId:'controlled',primaryScore:92,primaryNeedsRepair:false,primaryFindings:[]}}},prompt);
}
function rejected(findings:string[],score=85):RenderReview{
  return {status:'needs-review',score,checks:[{name:'成片语义审查',passed:false,detail:findings.join('；')}],semantic:{score,findings:[...findings],suggestions:[]},limitations:['Projected actual findings; other checks are controlled.'],createdAt:''};
}

test('actual first review rewrites the content chapter and independently redraws the unrecognizable illustration',()=>{
  const input=report(),review=rejected(actual.firstReview.findings),before=structuredClone({input,review});
  const plan=lessonRepairPlan(input,review);
  assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.visualChapterIds,['chapter-3']);assert.deepEqual(plan.layoutChapterIds,[]);
  assert.deepEqual(plan.scriptFindings,[actual.firstReview.findings[0]]);assert.deepEqual(plan.visualFindings,{'chapter-3':[actual.firstReview.findings[1]]});
  assert.deepEqual({input,review},before,'classification never edits the original words, scores or findings');
  assert.equal(actual.firstReview.score,85);assert.equal(actual.secondReview.score,88);
});

test('recognition wording is visual only when it describes the depiction, with mixed speech/source/caption faults still conservative',()=>{
  for(const finding of [actual.firstReview.findings[1],
    '第三章：插图的轮廓缺少对象特征，观众无法辨认为运动鞋。',
    'chapter-3：图形只剩半圆轮廓，新手认不出它表示运动鞋。',
    'chapter-3：示意图中的实体轮廓不清晰，观众不易明确识别。',
  ]){const plan=lessonRepairPlan(report(),rejected([finding]));assert.equal(plan.kind,'visual',finding);assert.deepEqual(plan.visualChapterIds,['chapter-3']);assert.deepEqual(plan.layoutChapterIds,[]);}
  for(const fault of ['旁白漏字。','字幕缺字。','来源引用错误。','公式错误。','事实错误。','旁白与来源不符。']){
    const plan=lessonRepairPlan(report(),rejected([actual.firstReview.findings[1]+fault]));assert.equal(plan.kind,'script',fault);assert.deepEqual(plan.visualChapterIds,[]);
  }
  for(const finding of ['chapter-3：讲解的机制难以识别，需要修改内容。','chapter-3：本章需要进一步确认。'])assert.equal(lessonRepairPlan(report(),rejected([finding])).kind,'script');
  const unverified=report();unverified.factReview!.needsRepair=true;assert.equal(lessonRepairPlan(unverified,rejected([actual.firstReview.findings[1]])).kind,'script');
});

test('the final actual orphan already uses the existing layout route; two reviews are not the same repeated finding',()=>{
  const review=rejected(actual.secondReview.findings,88),plan=lessonRepairPlan(report(),review);
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.visualChapterIds,['chapter-1']);assert.deepEqual(plan.layoutChapterIds,['chapter-1']);
  assert.deepEqual(Object.keys(createLessonLayoutRepairProofs(report(),review,'a'.repeat(64),'b'.repeat(64))),['chapter-1']);
  assert.equal(actual.firstReview.findings.some((finding:string)=>finding.includes('孤字')),false);assert.equal(actual.secondReview.findings.length,1);
  assert.deepEqual(actual.observedRepair.rewriteChapters,['chapter-2','chapter-3']);assert.deepEqual(actual.observedFinal.visualFeedback,{});
  assert.equal(actual.observedFinal.chapter1HtmlHashBefore,actual.observedFinal.chapter1HtmlHashAfter);
});

async function seed(directory:string,renders:number){
  const work=path.join(directory,'lesson-workflows/case'),mediaDir=path.join(directory,'media');await mkdir(work,{recursive:true});await mkdir(mediaDir);
  const input=report(),media:MediaItem[]=[],immutable:Record<string,{hash:string;mtimeMs:number}>={};
  for(const [i,chapter] of input.chapters.entries()){
    const project=path.join(work,chapter.id);await mkdir(project);const bytes=Buffer.from('CONTROLLED verified waveform '+chapter.id),scene=Buffer.from('CONTROLLED existing scene '+chapter.id),duration=10;
    const analysis:AudioAnalysis={status:'ready',modelId:'controlled',sourceHash:hashBytes(bytes),duration,transcript:chapter.narration,sentences:[{id:'s',start:0,end:duration,text:chapter.narration,complete:true,words:[...chapter.narration].map((text,n,chars)=>({text,start:duration*n/chars.length,end:duration*(n+1)/chars.length}))}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''};
    const aligned=alignLessonSpeech(chapter,analysis);chapter.cues=aligned.cues;chapter.speechMatch=aligned.similarity;
    chapter.mediaId='scene-'+i;chapter.duration=duration;chapter.audioHash=hashBytes(bytes);chapter.htmlHash=hashBytes('controlled old HTML '+chapter.id);
    const sceneFile=path.join(mediaDir,chapter.mediaId);await writeFile(sceneFile,scene);
    media.push({id:chapter.mediaId,kind:'video',name:chapter.title,mimeType:'video/mp4',url:'',createdAt:'',origin:'generated',hasAudio:true,duration,generation:{workflowId:input.workflowId,beatId:chapter.id,mode:'generated',lineHash:hashBytes(chapter.narration),audioHash:chapter.audioHash,htmlHash:chapter.htmlHash,referenceHash:'controlled-anchor'},analysis:{...analysis,sourceHash:hashBytes(scene)}});
    for(const [name,value]of [['speech.mp3',bytes],['speech-analysis.json',Buffer.from(JSON.stringify(analysis))]] as const){const file=path.join(project,name);await writeFile(file,value);immutable[file]={hash:hashBytes(value),mtimeMs:(await stat(file)).mtimeMs};}
  }
  const plan=validatePlan({lesson:input,format:input.format,targetSeconds:30,summary:'Controlled existing candidate',clips:input.chapters.map((chapter,i)=>({sceneId:chapter.id,sourceId:chapter.mediaId!,start:0,end:10,purpose:i===0?'hook':i===2?'conclusion':'argument'}))},media);
  const file=path.join(directory,'existing.mp4');await writeFile(file,'CONTROLLED candidate identity, not playable media');const script=path.join(work,'script.json');await writeFile(script,JSON.stringify(input));immutable[script]={hash:hashBytes(await readFile(script)),mtimeMs:(await stat(script)).mtimeMs};immutable[file]={hash:hashBytes(await readFile(file)),mtimeMs:(await stat(file)).mtimeMs};
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'controlled-owner',prompt,export:true})),requestedAt:Date.parse('2026-10-16T14:10:36.903Z'),rendererHash:lessonRendererHash(),phase:'review',research:{summary:'Controlled accepted research',queries:[],references:input.references},report:input,plan,rendered:{id:'controlled-candidate',file},renderedHash:hashBytes(await readFile(file)),renders}));
  return {work,mediaDir,media,input,file,immutable};
}

for(const exhausted of [false,true])test(`controlled workflow ${exhausted?'keeps the second-render orphan failed without a third render':'persists chapter-3 drawing feedback while only chapter-2 enters script repair'}`,async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-recognition-route-')),oldFetch=globalThis.fetch,controller=new AbortController(),events:WorkflowEvent[]=[];let requests=0,mediaCalls=0,reviews=0;
  try{
    const s=await seed(directory,exhausted?2:1),before=structuredClone(s.input);
    globalThis.fetch=async()=>{requests++;throw new Error('No provider requests in this controlled state test');};
    const run=()=>runLessonWorkflow({prompt,config,audioConfig:{...config,kind:'audio',modelId:'seed-audio-1.0'},media:s.media,dataDir:directory,mediaDir:s.mediaDir,ownerId:'controlled-owner',checkpointKey:'case',export:true,
      register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async value=>{events.splice(0,events.length,...value);if(!exhausted&&value.some(e=>e.tool==='repair_lesson'&&e.status==='succeeded'))controller.abort();},
      analyze:async()=>{mediaCalls++;throw new Error('No ASR');},authorVisual:async()=>{mediaCalls++;throw new Error('No drawing');},produceScene:async()=>{mediaCalls++;throw new Error('No scene');},render:async()=>{mediaCalls++;throw new Error('No extra render');},
      review:async file=>{assert.equal(file,s.file);reviews++;return rejected(exhausted?actual.secondReview.findings:actual.firstReview.findings,exhausted?88:85);},
    });
    if(exhausted){const result=await run();assert.equal(result.review?.status,'needs-review');assert.equal(result.review?.score,88);}else await assert.rejects(runWithJobSignal(controller.signal,run),JobCancelledError);
    assert.equal(requests,0);assert.equal(mediaCalls,0);assert.equal(reviews,1);
    const saved=JSON.parse(await readFile(path.join(s.work,'checkpoint.json'),'utf8'));assert.deepEqual(saved.report.chapters,before.chapters);assert.equal(saved.renders,exhausted?2:1);assert.deepEqual(saved.chapterVoiceRevisions,{});assert.equal(saved.voiceRevision,0);
    if(exhausted){assert.equal(saved.phase,'done');assert.equal(events.some(e=>e.tool==='repair_lesson'),false);assert.deepEqual(saved.visualFeedback,{});}
    else {assert.equal(saved.phase,'script');assert.deepEqual(saved.visualFeedback,{'chapter-3':actual.firstReview.findings[1]});assert.deepEqual(saved.layoutRepairProofs,{});assert.match(saved.repairRequirements,/chapter-2/);assert.doesNotMatch(saved.repairRequirements,/chapter-3|鞋状插画/);const output=events.find(e=>e.tool==='repair_lesson')!.output as any;assert.deepEqual(output.details.rewriteChapters,['chapter-2']);assert.deepEqual(output.details.redrawChapters,['chapter-3']);}
    for(const [file,binding]of Object.entries(s.immutable)){assert.equal(hashBytes(await readFile(file)),binding.hash);assert.equal((await stat(file)).mtimeMs,binding.mtimeMs);}
  }finally{globalThis.fetch=oldFetch;await rm(directory,{recursive:true,force:true});}
});
