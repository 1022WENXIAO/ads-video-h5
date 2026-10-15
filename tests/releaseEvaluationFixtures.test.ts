import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureReleaseEvaluationFixtures, releaseEvaluationFixtureContent, releaseEvaluationFixtureContext, releaseFixtureCues, releaseFixtureStoryboard, RELEASE_FIXTURE_CAPTION_ZONE, RELEASE_FIXTURE_VERSION } from '../server/releaseEvaluationFixtures';
import { createEvaluations, evaluationFileHash } from '../server/evaluations';
import { runFFmpeg } from '../server/core';
import type { ModelConfig } from '../server/modelRegistry';
import { PNG } from 'pngjs';

test('controlled diagrams describe actual source capabilities and carry synchronized explanatory objects',()=>{
  const context=releaseEvaluationFixtureContext();
  assert.match(context,/观察→解释→证据/);assert.match(context,/条件一致→比较→结论/);assert.match(context,/没有真人/);
  for(let i=0;i<2;i++) {
    const story=releaseFixtureStoryboard(i,18);
    assert(story.objects.length>=12);assert.match(story.ass,/\\move\(/);assert.doesNotMatch(story.ass,/testsrc|smpte|colorbar/i);
    assert(story.labels.includes('程序示意 · 非真实现场'));
    assert.deepEqual(story.cues.map(c=>c.name),i?['条件一致','比较','结论']:['观察','解释','证据']);
  }
  const timing=releaseFixtureCues(1,18,[{text:'保持比较条件一致',start:2,end:4},{text:'再看差异',start:4.3,end:5.2},{text:'结论应当由证据支持',start:10.3,end:12}],.3);
  assert.equal(timing.method,'reused-recognized-word-timing');assert.equal(timing.cues[1].start,4);assert.equal(timing.cues[2].start,10);
});

test('editing-case capabilities distinguish reference speech from actual visual labels without asserting ASR completeness',()=>{
  const content=releaseEvaluationFixtureContent(),context=releaseEvaluationFixtureContext();
  assert.equal(content.length,2);
  assert.equal(content[0].spoken.script,'观察一个现象时，先记录看到了什么，再提出可能的解释。这段画面是程序绘制的示意，不是真实现场。把观察和推测分开，可以让表达更清楚，也让后续核验有明确的方向。');
  assert.equal(content[1].spoken.script,'比较两个方案时，要先保持比较条件一致，再看差异来自哪里。这段画面也是程序绘制的示意。结论应当由证据支持，暂时没有把握的部分，需要保留限制，不能把猜测说成事实。');
  assert.match(content[0].spoken.script,/可能的解释/);
  assert.doesNotMatch(content[0].spoken.script,/重复观[察测]|候选原因/);
  assert.deepEqual(content[0].visual.visualOnlyConcepts,['重复观察（重复观测）']);
  assert(content[0].visual.labels.includes('重复观察，核验解释'));
  assert(content[1].visual.labels.includes('未知部分保留限制'));
  for(const source of content){
    assert.equal(source.spoken.provenance,'synthesis-script-not-current-file-asr');
    assert(!('complete' in source.spoken),'the intended script must not manufacture recognized complete-sentence evidence');
    const actual=releaseFixtureStoryboard(source.source-1,18);
    for(const label of source.visual.labels)assert(actual.labels.includes(label),`capability label ${label} must really be drawn`);
  }
  assert.match(context,/不是本次素材已经通过ASR的完整句证明/);
  assert.match(context,/不能当成原声台词/);
  assert.match(context,/原话“可能的解释”表达同一意思/);
  assert.match(context,/不要强制选入特定台词、末句或每个阶段的完整句/);
  assert.doesNotMatch(context,/配有完整普通话原声/);
});
test('essential diagram conclusions and limitations stay outside the final subtitle band',()=>{
  const essential=[['观察 ≠ 推测','重复观察，核验解释'],['证据支持的结论','未知部分保留限制']];
  for(let index=0;index<2;index++){
    const story=releaseFixtureStoryboard(index,18);
    for(const value of essential[index]){
      const labels=story.labelBounds.filter(label=>label.text===value);assert(labels.length>0,value);
      for(const label of labels){assert(label.y+label.height<=RELEASE_FIXTURE_CAPTION_ZONE.top||label.y>=RELEASE_FIXTURE_CAPTION_ZONE.bottom,`${value} overlaps the final caption band`);assert(story.ass.includes(`\\pos(${label.x},${label.y})`),'metadata must describe actual rendered ASS position');}
    }
  }
});

test('controlled editing sources validate actual cached files and repair corruption without resynthesizing speech', {timeout:60000}, async t => {
  const dir = await mkdtemp(path.join(tmpdir(),'qingjian-release-fixtures-')); t.after(() => rm(dir,{recursive:true,force:true}));
  // Deterministic audio fixture substitutes only the paid provider in this unit test.
  const speech = path.join(dir,'speech.mp3'); await runFFmpeg(['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=300:sample_rate=48000','-t','13','-c:a','libmp3lame',speech]);
  const bytes = await readFile(speech); let synthesisCalls = 0;
  const audioConfig: ModelConfig = {id:'test-audio',name:'audio',provider:'fixture',kind:'audio',modelId:'seed-audio-1.0',baseUrl:'https://example.com',apiKey:'PRIVATE',enabled:true};
  const dependencies = {audioConfig,generateSpeech:async () => {synthesisCalls++;return {bytes,mimeType:'audio/mpeg'};}};
  const evaluations = createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async () => ({text:null,audio:null,image:null,understanding:null}),execute:async () => {throw new Error('not an execution test');},stop:async () => {},artifactFile:() => undefined});
  await evaluations.init();
  const initial = await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies);
  assert.equal(initial.length,2); assert.equal(synthesisCalls,2); assert.notEqual(initial[0].sha256,initial[1].sha256);
  assert(initial.every(f=>f.name.startsWith(RELEASE_FIXTURE_VERSION)));
  const storyboard=JSON.parse(await readFile(path.join(dir,'evaluations/controlled-fixtures',RELEASE_FIXTURE_VERSION,'1.storyboard.json'),'utf8'));
  assert(storyboard.diagramObjects.includes('rolling-ball'));assert(storyboard.diagramObjects.includes('candidate-push'));assert(storyboard.labels.includes('观察 ≠ 推测'));
  assert.equal(storyboard.videoHash,initial[0].sha256);assert.equal(storyboard.timingMethod,'text-position-estimate-no-new-asr');
  const extract=async(seconds:number,name:string)=>{const frame=path.join(dir,name+'.png');await runFFmpeg(['-v','error','-y','-ss',String(seconds),'-i',path.join(dir,'evaluations/fixtures',initial[0].id),'-frames:v','1',frame]);return PNG.sync.read(await readFile(frame));};
  const early=await extract(.2,'early'),later=await extract(1.8,'later');
  let changed=0,ink=0;
  for(let y=205;y<390;y++)for(let x=65;x<435;x++) {
    const at=(y*early.width+x)*4;
    if(Math.abs(early.data[at]-later.data[at])+Math.abs(early.data[at+1]-later.data[at+1])+Math.abs(early.data[at+2]-later.data[at+2])>50)changed++;
    if(early.data[at]<180&&early.data[at+1]<210)ink++;
  }
  assert(changed>500,'actual decoded object region must move, independently of title/label changes');
  assert(ink>1500,'actual decoded picture must contain the ramp, moving ball and observed positions');
  assert.deepEqual(await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies),initial);
  const firstFile = path.join(dir,'evaluations/fixtures',initial[0].id); await writeFile(firstFile,'corrupt cached movie');
  const repaired = await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies);
  assert.notEqual(repaired[0].id,initial[0].id); assert.equal(repaired[1].id,initial[1].id); assert.equal(synthesisCalls,2);
  assert.equal(await evaluationFileHash(path.join(dir,'evaluations/fixtures',repaired[0].id)),repaired[0].sha256);
  assert.deepEqual(await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies),repaired);
  assert.equal(evaluations.catalog().fixtures.length,3);
  await rm(path.join(dir,'evaluations/fixtures',repaired[1].id));
  const missingRepaired = await ensureReleaseEvaluationFixtures(evaluations,dir,dependencies);
  assert.notEqual(missingRepaired[1].id,repaired[1].id); assert.equal(missingRepaired[0].id,repaired[0].id); assert.equal(synthesisCalls,2);
});

test('semantic visual upgrades reuse unchanged v1 paid speech caches', {timeout:30000}, async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-release-fixture-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const oldDir=path.join(dir,'evaluations/controlled-fixtures/controlled-spoken-v1');await mkdir(oldDir,{recursive:true});
  const audio=path.join(dir,'speech.mp3');await runFFmpeg(['-v','error','-f','lavfi','-i','sine=frequency=400:sample_rate=48000','-t','13','-c:a','libmp3lame',audio]);
  const bytes=await readFile(audio);await Promise.all([1,2].map(i=>writeFile(path.join(oldDir,`${i}.audio`),bytes)));
  const evaluations=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>({text:null,audio:null,image:null,understanding:null}),execute:async()=>{throw new Error('not executed');},stop:async()=>{},artifactFile:()=>undefined});await evaluations.init();
  const audioConfig:ModelConfig={id:'test-audio',name:'audio',provider:'fixture',kind:'audio',modelId:'seed-audio-1.0',baseUrl:'https://example.com',apiKey:'PRIVATE',enabled:true};
  const fixtures=await ensureReleaseEvaluationFixtures(evaluations,dir,{audioConfig,generateSpeech:async()=>{throw new Error('An illustration upgrade must not purchase new speech');}});
  assert.equal(fixtures.length,2);assert(fixtures.every(f=>f.name.startsWith(RELEASE_FIXTURE_VERSION)));
  const first=JSON.parse(await readFile(path.join(dir,'evaluations/controlled-fixtures',RELEASE_FIXTURE_VERSION,'1.storyboard.json'),'utf8'));
  const second=JSON.parse(await readFile(path.join(dir,'evaluations/controlled-fixtures',RELEASE_FIXTURE_VERSION,'2.storyboard.json'),'utf8'));
  assert(first.diagramObjects.includes('rolling-ball'));assert(second.diagramObjects.includes('cart-A-body-moving'));assert(second.diagramObjects.includes('cart-B-body-moving'));
});
