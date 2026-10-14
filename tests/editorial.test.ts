import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import { selectScenes,splitSceneSelections,validateScript } from '../server/editorialWorkflow';
import { excludesBgm } from '../server/intents';
import { validateCaptionBreaks } from '../server/audioUnderstanding';
import { validatePlan,renderPlan,runFFmpeg,probeVideo } from '../server/core';
import type {MediaItem,EditPlan,NarrativeScript} from '../src/types';

const source:MediaItem={id:'source',name:'source.mp4',kind:'video',mimeType:'video/mp4',duration:6,url:'',createdAt:'',analysis:{status:'ready',modelId:'test',sourceHash:'immutable',duration:6,transcript:'问题方法结论',sentences:[{id:'s1',start:.1,end:1.5,text:'问题',complete:true,words:[{text:'问题',start:.1,end:1.5}]},{id:'s2',start:2,end:3,text:'方法',complete:true,words:[{text:'方法',start:2,end:3}]},{id:'s3',start:4,end:5.5,text:'结论',complete:true,words:[{text:'结论',start:4,end:5.5}]}],pauses:[],warnings:[],timing:'model-estimated',createdAt:''}};
const selected=selectScenes([{sourceId:'source',sentenceIds:['s1'],reason:'用完整问题建立叙事入口',purpose:'hook'},{sourceId:'source',sentenceIds:['s3'],reason:'以原话结论收束观点',purpose:'conclusion'}],[source]);
const script:NarrativeScript={premise:'解决问题',audience:'新手',arc:'问题后接结论，素材缺少支撑论据',style:'克制原声',beats:selected.map((s)=>({sceneId:s.id,intent:s.reason,graphic:'none',label:''}))};
test('negative music requests do not silently add preset BGM',()=>{
  for(const text of ['保留原声，不加背景音乐','不要生成配音或背景音乐','不用BGM','without background music','no BGM'])assert.ok(excludesBgm(text));
  assert.equal(excludesBgm('加入背景音乐'),false);
});
test('caption boundaries cover every word and reject omitted tails, repeats and out-of-range indices',()=>{
  assert.deepEqual(validateCaptionBreaks([2,5,8],9),[2,5,8]);
  for(const raw of [[2,5],[2,2,8],[2,10,8],[],['8']])assert.throws(()=>validateCaptionBreaks(raw,9),/覆盖/);
});
test('scene evidence is hydrated from original audio and skipped sentences cannot be hidden inside a shot',()=>{
  assert.equal(selected[0].quote,'问题');assert.equal(selected[0].start,.1);assert.equal(selected[0].sourceHash,'immutable');
  assert.throws(()=>selectScenes([{sourceId:'source',sentenceIds:['s1','s3'],reason:'偷偷跳过中间句子',purpose:'argument'}],[source]),/连续/);
  const split=selectScenes(splitSceneSelections([{sourceId:'source',sentenceIds:['s1','s3'],reason:'跳过中间重录并保留完整观点',purpose:'argument'}],[source]),[source]);
  assert.equal(split.length,2);assert.deepEqual(split.map((s)=>[s.quote,s.start,s.end]),[['问题',.1,1.5],['结论',4,5.5]]);
  assert.throws(()=>splitSceneSelections([{sourceId:'source',sentenceIds:['s3','s1'],reason:'倒序',purpose:'argument'}],[source]),/顺序/);
  assert.throws(()=>selectScenes([{sourceId:'source',sentenceIds:['unknown'],reason:'无法验证的原话',purpose:'hook'}],[source]),/原话/);
  assert.throws(()=>validateScript({...script,beats:[script.beats[0],script.beats[0]]},selected),/分镜/);
});
test('render contract refuses altered quote, source hash, narrative ordering or an unrelated drawing',()=>{
  const plan:EditPlan={format:'9:16',summary:'主题',targetSeconds:0,fineCut:true,clips:selected.map((s)=>({sceneId:s.id,sourceId:s.sourceId,start:s.start,end:s.end,sentenceIds:s.sentenceIds,purpose:s.purpose})),editorial:{scenes:selected,script}};
  assert.doesNotThrow(()=>validatePlan(plan,[source]));
  assert.throws(()=>validatePlan({...plan,editorial:{...plan.editorial!,scenes:selected.map((s)=>({...s,quote:'伪造'}))}},[source]),/原话/);
  assert.throws(()=>validatePlan({...plan,editorial:{...plan.editorial!,script:{...script,beats:[...script.beats].reverse()}}},[source]),/顺序/);
  assert.throws(()=>validatePlan({...plan,motions:[{sceneId:'not-selected',kind:'circle',label:'信息',zone:'top',start:0,end:2}]},[source]),/绘制动效/);
});
test('GSAP drawing alpha layer is rendered and composited while preserving the footage and audio',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-drawing-test-'));await mkdir(path.join(dir,'out'));
  try{
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=270x480:r=30','-f','lavfi','-i','sine=frequency=400:sample_rate=44100','-t','3','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-f','mp4',path.join(dir,'source')]);
    const media=[{...source,duration:3,analysis:undefined}];
    const plan=validatePlan({format:'9:16',summary:'圈注测试',targetSeconds:0,clips:[{sceneId:'scene-1',sourceId:'source',start:0,end:3}],motions:[{sceneId:'scene-1',kind:'circle',label:'保持原声',zone:'top',start:.15,end:2.9}]},media);
    const output=await renderPlan(plan,media,dir,path.join(dir,'out'));
    const manifest=JSON.parse(await readFile(output.file.replace('.mp4','.render.json'),'utf8'));
    assert.equal(manifest.drawingEngine,'GSAP/HyperFrames');assert.equal(manifest.motions.length,1);assert.ok((await probeVideo(output.file)).hasAudio);
    const bounds=manifest.textLayout.motions[0];
    assert.ok([bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite));
    const left=Math.max(0,Math.floor(bounds.x/2)*2),top=Math.max(0,Math.floor(bounds.y/2)*2),right=Math.min(manifest.width,Math.ceil((bounds.x+bounds.width)/2)*2),bottom=Math.min(manifest.height,Math.ceil((bounds.y+bounds.height)/2)*2);
    assert.ok(right>left&&bottom>top,'sample the actual rendered motion box');
    for(const t of [.22,1.4])await runFFmpeg(['-v','error','-y','-ss',String(t),'-i',output.file,'-frames:v','1','-vf',`crop=${right-left}:${bottom-top}:${left}:${top}`,'-f','rawvideo','-pix_fmt','rgb24',path.join(dir,`${t}.rgb`)]);
    assert.notDeepEqual(await readFile(path.join(dir,'0.22.rgb')),await readFile(path.join(dir,'1.4.rgb')),'the actual motion region must visibly change during the alpha animation');
    await runFFmpeg(['-v','error','-y','-ss','1.4','-i',output.file,'-frames:v','1','-vf','crop=2:2:0:800','-f','rawvideo','-pix_fmt','rgb24',path.join(dir,'background.rgb')]);
    const pixel=await readFile(path.join(dir,'background.rgb'));assert.ok(pixel[2]>180&&pixel[0]<30,'transparent layer must retain blue footage outside drawing');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('bounded workers drain in-flight work before failure and keep deterministic result order',async()=>{
  const {mapLimited}=await import('../server/taskPool');let inFlight=0;let maximum=0;let completed=0;
  await assert.rejects(mapLimited([0,1,2,3],2,async(n)=>{inFlight++;maximum=Math.max(maximum,inFlight);try{if(n===0)throw new Error('failed');await new Promise((r)=>setTimeout(r,10));completed++;return n;}finally{inFlight--;}}),/failed/);
  assert.equal(inFlight,0);assert.ok(maximum<=2);assert.equal(completed,1);
  assert.deepEqual(await mapLimited([1,2,3],2,async(n)=>n*2),[2,4,6]);
});
