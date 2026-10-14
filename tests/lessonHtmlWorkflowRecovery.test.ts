import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {validatePlan} from '../server/core';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import type {LessonChapter,AudioAnalysis,WorkflowEvent,RenderReview} from '../src/types';
const config=()=>({id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',enabled:true,apiKey:'test-private-credential',modelId:'fixture'});
const fixture=JSON.parse(await readFile(new URL('./fixtures/html-layout-card-overlap.json',import.meta.url),'utf8'));
function options(directory:string,prompt:string,index=0,progress:((events:WorkflowEvent[])=>Promise<void>)=async()=>{}){
  return {prompt,config:config(index),audioConfig:null,media:[],dataDir:directory,mediaDir:directory,ownerId:'fixture-owner',checkpointKey:'case',export:false,progress,analyze:async()=>{throw new Error('Unexpected audio analysis');},register:async()=>{},persist:async()=>{},saveDraft:async()=>{},render:async()=>{throw new Error('Unexpected render');},review:async()=>{throw new Error('Unexpected movie review');}};
}
async function seedRendered(directory:string,phase='review'){
  const prompt='制作45秒竖屏知识图解视频，解释误差如何评分',work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const references=[{id:'r1',title:'Controlled primary source',url:'https://arxiv.org/abs/1708.02001',verification:'primary-page' as const,excerpt:'Controlled fixture: error magnitude and score.'}];
  const chapters:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,role:i===0?'hook':i===1?'foundation':'recap',title:'误差评分'+i,goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]},mediaId:'media-'+i,duration:15}));
  for(const c of chapters){c.audioHash='audio-'+c.id;c.htmlHash='html-'+c.id;c.speechMatch=1;c.cues=c.visual.items.map((item,i)=>({text:item.cue,start:1+i*3,end:3+i*3}));}
  const report=validateLesson({workflowId:'resume-fixture',...lessonSettings(prompt),title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters,references,limitations:[],presentation:lessonPresentation(prompt),voice:{mode:'preset',modelId:'seed-audio-1.0',anchorHash:'fixture-anchor',revision:0,tempo:1},factReview:{score:92,needsRepair:false,findings:[]}},prompt);
  const media=chapters.map(c=>({id:c.mediaId!,kind:'video' as const,name:c.title,mimeType:'video/mp4',url:'',createdAt:'',duration:15,generation:{workflowId:report.workflowId,beatId:c.id,mode:'generated' as const,lineHash:createHash('sha256').update(c.narration).digest('hex'),audioHash:c.audioHash!,htmlHash:c.htmlHash!,referenceHash:'fixture-anchor'},analysis:{status:'ready',duration:15,modelId:'fixture',sourceHash:'fixture',timing:'model-estimated',createdAt:'',transcript:c.narration,pauses:[],warnings:[],sentences:[{id:'s',start:0,end:15,text:c.narration,complete:true,words:[{text:c.narration,start:0,end:15}]}]} as AudioAnalysis}));
  const plan=validatePlan({lesson:report,format:'9:16',targetSeconds:45,summary:'误差评分',clips:chapters.map((c,i)=>({sceneId:c.id,sourceId:c.mediaId!,start:0,end:15,purpose:i===0?'hook':i===2?'conclusion':'argument'}))},media);
  const file=path.join(directory,'rendered-fixture.mp4');await writeFile(file,'CONTROLLED HASH FIXTURE — this is not actual video acceptance');
  const rendered={id:'movie-fixture',file},renderedHash=createHash('sha256').update(await readFile(file)).digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner:'fixture-owner',prompt,export:true})).digest('hex');
  const checkpoint={fingerprint,phase,research:{summary:'受控研究夹具',queries:[],references},researchRounds:2,report,plan,rendered,renderedHash,renders:1};
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
  const o={...options(directory,prompt),export:true,media,audioConfig:{...config(),kind:'audio' as const,modelId:'seed-audio-1.0'}};
  return {o,checkpoint,work};
}

for(const unsafe of [false,true])test('HTML workflow ' + (unsafe?'stops at scenes with persistent budgets and reuses checked chapters':'repairs the actual overlap without script, voice or ASR calls'),async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-layout-workflow-')),original=globalThis.fetch;
  const {o,checkpoint,work}=await seedRendered(directory,'scenes');
  Object.assign(checkpoint,{rendererHash:lessonRendererHash(),renders:0});
  const before=checkpoint.report.chapters.map(ch=>({id:ch.id,narration:ch.narration,claims:ch.claims,visual:ch.visual}));
  const speechHashes=new Map<string,string>();
  for(const chapter of checkpoint.report.chapters){
    const project=path.join(work,chapter.id);await mkdir(project,{recursive:true});const bytes=Buffer.from('CONTROLLED verified speech '+chapter.id);
    const analysis={...o.media.find(m=>m.id===chapter.mediaId)!.analysis!,sourceHash:hashBytes(bytes)};
    for(const sentence of analysis.sentences){const chars=[...sentence.text];sentence.words=chars.map((text,i)=>({text,start:15*i/chars.length,end:15*(i+1)/chars.length}));}
    await writeFile(path.join(project,'speech.mp3'),bytes);await writeFile(path.join(project,'speech-analysis.json'),JSON.stringify(analysis));speechHashes.set(path.join(project,'speech.mp3'),hashBytes(bytes));
  }
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify(checkpoint));
  const authors=new Map<string,number>(),productions=new Map<string,number>(),events:WorkflowEvent[]=[];
  const drawing=structuredClone(fixture.drawing) as HtmlDrawing;
  if(unsafe){const value=drawing.nodes.find(node=>node.id==='revenue_value')!;value.y=425;value.h=130;}
  globalThis.fetch=async()=>{throw new Error('Technical HTML recovery must not call script, TTS, or ASR providers');};
  const opts={...o,analyze:async()=>{throw new Error('Technical HTML recovery must not call ASR');},progress:async(updates:WorkflowEvent[])=>{events.splice(0,events.length,...updates);},
    authorVisual:async(_config:unknown,beat:{id:string})=>{authors.set(beat.id,(authors.get(beat.id)||0)+1);return structuredClone(drawing);},
    produceScene:async(chapter:LessonChapter,_i:number,_total:number,_format:unknown,speechFile:string,analysis:AudioAnalysis,project:string,_pacing:unknown,_presentation:unknown,_news:unknown,custom?:HtmlDrawing)=>{
      productions.set(chapter.id,(productions.get(chapter.id)||0)+1);
      if(chapter.id==='c2'&&(unsafe||custom!.nodes.find(node=>node.id==='revenue_card')!.text)){
        await writeFile(path.join(project,'check-report.json'),JSON.stringify(fixture.report));throw new Error('HTML check 未通过：captured revenue_card/revenue_value overlap');
      }
      const file=path.join(project,'scene-fixture.mp4'),bytes=Buffer.from('CONTROLLED scene '+chapter.id+' '+JSON.stringify(custom));await writeFile(file,bytes);
      return{file,duration:15,audioHash:hashBytes(await readFile(speechFile)),htmlHash:hashBytes(JSON.stringify(custom)),analysis:{...analysis,sourceHash:hashBytes(bytes)}};
    },render:async()=>{const file=path.join(directory,'movie-fixture.mp4');await writeFile(file,'CONTROLLED movie; not video acceptance');return{id:'controlled-movie',file};},
    review:async():Promise<RenderReview>=>({status:'passed',score:94,checks:[],semantic:{score:94,findings:[],suggestions:[]},limitations:[],createdAt:new Date().toISOString()})};
  try{
    if(unsafe){
      await assert.rejects(runLessonWorkflow(opts),/阶段scenes.*c2.*HTML布局/);
      const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.phase,'scenes');
      const authorsBefore=[...authors],productionsBefore=[...productions];
      await assert.rejects(runLessonWorkflow(opts),/阶段scenes.*c2.*HTML布局/);
      assert.deepEqual([...authors],authorsBefore);assert.deepEqual([...productions],productionsBefore);
      assert.deepEqual([...productions],[['c0',1],['c1',1],['c2',1]]);assert.equal(authors.get('c2'),2);
    }else{
      const result=await runLessonWorkflow(opts);assert.equal(result.review!.status,'passed');
      assert.deepEqual([...productions],[['c0',1],['c1',1],['c2',2]]);assert.deepEqual([...authors],[['c0',1],['c1',1],['c2',1]]);
    }
    const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));
    assert.deepEqual(saved.report.chapters.map((ch:LessonChapter)=>({id:ch.id,narration:ch.narration,claims:ch.claims,visual:ch.visual})),before);
    assert.equal(events.some(event=>['synthesize_narration','transcribe_chapter','revise_lesson_script'].includes(event.tool)),false);
    for(const[file,hash]of speechHashes)assert.equal(hashBytes(await readFile(file)),hash);
  }finally{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});}
});
