import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Artifact, MediaItem } from '../src/types';
import type { EvaluationCase, EvaluationRun } from '../src/evaluationTypes';
import { initialEvaluationCases } from '../server/evaluationCases';
import { evaluationCaseHash, evaluationSummary, scoreEvaluation, selectedSpeech } from '../server/evaluationScoring';
import { createEvaluations, evaluationUploadName, validateEvaluationCase, type EvaluationOutcome } from '../server/evaluations';
import { frozenModel, withModelSnapshot, type ModelSnapshot } from '../server/modelContext';
import { privateEvaluationStorage } from '../server/evaluationIsolation';
import type { createOssStorage } from '../server/ossStorage';
import { runFFmpeg } from '../server/core';
import { planHash } from '../server/renderTimeline';

const models: ModelSnapshot = Object.fromEntries(['text','audio','understanding','image'].map(kind => [kind, { id: kind, name: kind, modelId: kind+'-model', kind, provider: 'test', baseUrl: 'https://example.com', enabled: true, apiKey: 'TEST-PRIVATE-CREDENTIAL' }])) as ModelSnapshot;
const sample = () => ({ ...initialEvaluationCases()[6], expectation: { ...initialEvaluationCases()[6].expectation, seconds: 10, toleranceSeconds: 2 }, fixtureIds: ['one','two'] });
function output(): EvaluationOutcome {
  const media: MediaItem[] = ['one','two'].map(id => ({ id, ownerId: 'test', name: id, kind: 'video', mimeType: 'video/mp4', url: '', createdAt: '', analysis: { status: 'ready', modelId: 'test', sourceHash: id, duration: 10, transcript: '范围外不能用于关键词覆盖实际原话', sentences: [{ id: 's', start: 1, end: 8, text: '范围外不能用于关键词覆盖实际原话', complete: true, words: [{ start: 1, end: 2, text: '实际原话' }, { start: 7, end: 8, text: '范围外' }] }], pauses: [], timing: 'model-estimated', warnings: [], createdAt: '' } }));
  const artifact: Artifact = { id: 'artifact', kind: 'video', sessionId: '', messageId: '', name: 'video', url: '', downloadUrl: '', createdAt: '', version: 1, format: '9:16', duration: 10, hasNarration: false, plan: { summary: 'unit test fixture', format: '9:16', targetSeconds: 10, clips: [{ sourceId: 'one', start: 0, end: 5 }, { sourceId: 'two', start: 0, end: 5 }], captions: [{ start: 0, end: 4, text: '实际原话', style: 'subtitle' }] }, review: { status: 'passed', score: 90, checks: ['字幕执行','字幕原话','字幕时间映射','画幅与音轨','完整句子','声音峰值与削波'].map(name => ({ name, passed: true, detail: 'test fixture' })), limitations: [], createdAt: '' } };
  artifact.planHash = planHash(artifact.plan!);
  return { artifact, media, sourceIds: ['one','two'], file: '', workflow: [] };
}
test('seed corpus covers all three capabilities and validates multi-turn regression cases', () => {
  const cases = initialEvaluationCases();
  assert.equal(cases.length,31);
  assert.deepEqual([...new Set(cases.map(c => c.category))].sort(),['hot-news','knowledge','multi-video']);
  for (const c of cases) assert.doesNotThrow(() => validateEvaluationCase(c));
  assert(cases.some(c => c.category === 'hot-news' && c.messages.length === 2));
  assert(cases.some(c => c.category === 'multi-video' && c.messages.length === 2));
  assert(cases.some(c => c.id === 'news-spoken-llm' && c.messages[0].includes('今天发生') && c.messages[0].includes('为什么选')));
  assert.throws(() => validateEvaluationCase({ ...sample(), expectation: { ...sample().expectation, minSources: 1 } }));
  assert.throws(() => validateEvaluationCase({ ...sample(), messages: [''] }));
  assert.throws(() => validateEvaluationCase({ ...sample(), fixtureIds: ['one','one'] }));
});
test('upgrade adds missing regression cases while preserving edits, disabled cases and historical snapshots',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-upgrade-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const old=initialEvaluationCases().slice(0,9);old[0]={...old[0],enabled:false,name:'我的自定义名称',version:7,messages:['保留用户编辑的指令']};
  const file=path.join(dir,'evaluations/index.json');await mkdir(path.dirname(file),{recursive:true});
  const history={id:'old-run',name:'old',status:'completed',createdAt:'',maxCaseSeconds:60,snapshot:{revision:null,implementationHash:'old',skillHash:'old',rubricVersion:'old',models:[]},results:[{id:'old-result',case:structuredClone(old[0]),caseHash:'old-hash',repeat:1,fixtures:[],status:'failed',jobIds:[]}]};
  await writeFile(file,JSON.stringify({version:1,cases:old,fixtures:[],runs:[history]}));
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>output(),stop:async()=>{},artifactFile:()=>undefined});
  await manager.init();assert.equal(manager.catalog().cases.length,31);assert.deepEqual(manager.catalog().cases[0],old[0]);
  assert.deepEqual(manager.get('old-run'),history);await manager.init();assert.equal(manager.catalog().cases.length,31);
  assert.equal(manager.catalog().cases.filter(c=>c.id==='news-fable-original').length,1);
});
test('multipart video filenames preserve Chinese, ASCII and genuine Latin-1 names', () => {
  const name='AI图像片段一.mp4';
  assert.equal(evaluationUploadName(Buffer.from(name,'utf8').toString('latin1')),name);
  assert.equal(evaluationUploadName(name),name);
  assert.equal(evaluationUploadName('café.mp4'),'café.mp4');
  assert.equal(evaluationUploadName('ascii.mp4'),'ascii.mp4');
});
test('quality gates retain failed reviews and refuse missing video manifests or fake sources', () => {
  const o = output(), test = sample();
  assert.equal(scoreEvaluation(test,o.artifact,o.media,o.sourceIds,10,true).passed,true);
  assert.equal(scoreEvaluation(test,o.artifact,o.media,o.sourceIds,10,false).passed,false);
  o.artifact.review!.status = 'needs-review'; o.artifact.review!.score = 76;
  const scored = scoreEvaluation(test,o.artifact,o.media,o.sourceIds,10,true);
  assert.equal(scored.passed,false);
  assert.equal(scored.checks.find(c => c.id==='quality')?.passed,false);
  o.artifact.review!.status='passed';o.artifact.review!.checks.push({ name: '遗漏内容', passed: false, detail: 'actual missing information' });
  assert.equal(scoreEvaluation(test,o.artifact,o.media,o.sourceIds,10,true).passed,false);
  o.artifact.plan!.clips[1].sourceId='unrelated-user-material';
  assert.equal(scoreEvaluation(test,o.artifact,o.media,o.sourceIds,10,true).checks.find(c=>c.id==='sources')?.passed,false);
});
test('keyword coverage uses the selected audio ranges rather than unused transcript content', () => {
  const o = output();
  assert(!selectedSpeech(o.artifact,o.media).includes('范围外'));
  assert.equal(scoreEvaluation({ ...sample(), expectation: { ...sample().expectation, requiredWords: ['范围外'] } },o.artifact,o.media,o.sourceIds,10,true).checks.find(c=>c.id==='content')?.passed,false);
});
test('an explicit complete-speech instruction requires a real sentence-boundary check', () => {
  const o=output();o.artifact.review!.checks=o.artifact.review!.checks.filter(c=>c.name!=='完整句子');
  assert.equal(scoreEvaluation(sample(),o.artifact,o.media,o.sourceIds,10,true).checks.find(c=>c.id==='original')?.passed,false);
});
test('case fingerprints change with instructions and material hashes, but not display-name changes', () => {
  const c = sample(), fixtures = [{ id:'one', name:'sample', bytes:1, duration:10, hasAudio:true, sha256:'original', createdAt:'' }];
  assert.equal(evaluationCaseHash(c,fixtures),evaluationCaseHash({ ...c, name:'renamed' },fixtures));
  assert.notEqual(evaluationCaseHash(c,fixtures),evaluationCaseHash({ ...c, messages:['new prompt'] },fixtures));
  assert.notEqual(evaluationCaseHash(c,fixtures),evaluationCaseHash(c,[{ ...fixtures[0], sha256:'changed' }]));
});
test('completion and pass rates keep failed and cancelled cases in the denominator', () => {
  const run = { results: [{ status:'passed', case:sample(), score:100, artifact:output().artifact }, { status:'failed', case:sample() }, { status:'cancelled', case:sample() }] } as unknown as EvaluationRun;
  const summary=evaluationSummary(run);
  assert.equal(summary.averageScore,100);
  assert.equal(summary.completionRate,1/3);assert.equal(summary.passRate,1/3);assert.equal(summary.failed,1);assert.equal(summary.cancelled,1);
});
test('frozen models are isolated by execution and preserve explicit missing configurations', async () => {
  assert.equal(frozenModel('text'),undefined);
  await Promise.all(['a','b'].map(async id => withModelSnapshot({ ...models, text: { ...models.text!, id }, image:null },async () => {
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(frozenModel('text')?.id,id);assert.equal(frozenModel('text','other'),null);assert.equal(frozenModel('image'),null);
  })));
  assert.equal(frozenModel('text'),undefined);
});
test('evaluation storage never uploads private test media to the public bucket', async () => {
  const calls:string[]=[];
  const storage = { bucket:'test', key:()=>'', publicUrl:()=>{calls.push('public');return 'url';}, put:async()=>{calls.push('put');}, ensure:async()=>{calls.push('ensure');}, remove:async()=>{calls.push('remove');}, exists:async()=>{calls.push('exists');return true;} } as NonNullable<ReturnType<typeof createOssStorage>>;
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-private-')), file=path.join(dir,'media');
  try {
    await writeFile(file,'real-local-file');const privateStore=privateEvaluationStorage(storage)!;
    assert.equal(privateStore.publicUrl('evaluation:run:case','media','id'),null);
    await privateStore.put('evaluation:run:case','media','id',file,'video/mp4');await privateStore.ensure('evaluation:run:case','media','id',file);await privateStore.remove('evaluation:run:case','media','id');
    assert.equal(await privateStore.exists('evaluation:run:case','media','id'),false);assert.deepEqual(calls,[]);
    await privateStore.put('normal-user','media','id',file,'video/mp4');assert.deepEqual(calls,['put']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('real-media evaluation stores immutable cases, disjoint scores, and no model credentials', { timeout:20000 }, async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const video=path.join(dir,'video.mp4');
  await runFFmpeg(['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=white:s=64x96:r=10','-f','lavfi','-i','sine=frequency=300:sample_rate=48000','-t','10','-c:v','libx264','-c:a','aac',video]);
  const o=output();o.file=video;await writeFile(video.replace('.mp4','.render.json'),JSON.stringify({planHash:o.artifact.planHash}));
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async(_c,ctx)=>{await ctx.progress({jobs:[{id:'actual-test-job',status:'succeeded',workflow:[]}]});return o;},stop:async()=>{},artifactFile:()=>video});
  await manager.init();const f1=await manager.saveFixture(video,'one.mp4'),f2=await manager.saveFixture(video,'two.mp4');
  const c=await manager.upsert({...sample(),id:undefined,fixtureIds:[f1.id,f2.id]});
  const run=await manager.start({caseIds:[c.id],repeats:1});
  await assert.rejects(manager.start({caseIds:[c.id]}),/已有评测/);
  await manager.upsert({...c,name:'edited later',messages:['another prompt']},c.id);
  let final=manager.get(run.id);const deadline=Date.now()+5000;
  while(final.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));final=manager.get(run.id);}
  assert.equal(final.status,'completed');assert.equal(final.results[0].status,'passed');assert.equal(final.results[0].case.name,c.name);assert.deepEqual(final.results[0].case.messages,c.messages);
  assert.equal(final.results[0].artifact?.actualDuration,10);assert.equal(final.results[0].artifact?.sha256.length,64);assert.equal(manager.videoFile(run.id,final.results[0].id),video);
  o.artifact.plan!.summary='mutated outside the evaluator after completion';
  assert.equal(manager.get(run.id).results[0].artifact?.plan?.summary,'unit test fixture');
  const before=final.results[0].score;
  await manager.humanReview(run.id,final.results[0].id,{score:50,note:'Human review differs'});
  assert.equal(manager.get(run.id).results[0].score,before);assert.equal(manager.get(run.id).results[0].humanReview?.score,50);
  assert(!(await readFile(path.join(dir,'evaluations/index.json'),'utf8')).includes('TEST-PRIVATE-CREDENTIAL'));
  assert.throws(()=>manager.videoFile(run.id,'other-case'),/尚无/);
});
test('restart marks unfinished runs interrupted and stops their actual jobs instead of replaying stale snapshots', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const stopped:string[]=[];
  const options={dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>output(),stop:async(id:string)=>{stopped.push(id);},artifactFile:()=>undefined};
  const manager=createEvaluations(options);await manager.init();
  const run={id:'interrupted',name:'test',status:'running',createdAt:'',maxCaseSeconds:60,snapshot:{revision:null,implementationHash:'old',skillHash:'old',rubricVersion:'old',models:[]},results:[{id:'r',case:sample(),caseHash:'hash',fixtures:[],repeat:1,status:'running',jobIds:['job']}]};
  await writeFile(path.join(dir,'evaluations/index.json'),JSON.stringify({version:1,cases:initialEvaluationCases(),fixtures:[],runs:[run]}));
  const restarted=createEvaluations(options);await restarted.init();assert.deepEqual(stopped,['interrupted']);assert.equal(restarted.get('interrupted').status,'interrupted');assert.equal(restarted.get('interrupted').results[0].status,'interrupted');
});
test('missing video bindings block a run before any agent call', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-preflight-'));t.after(()=>rm(dir,{recursive:true,force:true}));let called=false;
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>{called=true;return output();},stop:async()=>{},artifactFile:()=>undefined});
  await manager.init();await assert.rejects(manager.start({caseIds:['edit-original-20']}),/绑定/);assert.equal(called,false);
});
test('stopping cancels the active and queued cases even if execution returns during the stop', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let entered!:()=>void, release!:()=>void, calls=0;
  const executing=new Promise<void>(resolve=>{entered=resolve;}), finished=new Promise<void>(resolve=>{release=resolve;});
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>{calls++;entered();await finished;return output();},stop:async()=>{release();},artifactFile:()=>undefined});
  await manager.init();const run=await manager.start({caseIds:['knowledge-cross-45','knowledge-rag-60']});await executing;
  await manager.stop(run.id);
  let final=manager.get(run.id);const deadline=Date.now()+3000;
  while(final.status==='stopping'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));final=manager.get(run.id);}
  assert.equal(final.status,'cancelled');assert.equal(calls,1);assert.deepEqual(final.results.map(r=>r.status),['cancelled','cancelled']);
  assert(final.results.every(r=>r.artifact===undefined&&r.score===undefined));assert.equal(evaluationSummary(final).cancelled,2);
});
test('failed cases retain trace and redacted errors while the batch continues', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-errors-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async(_test,context)=>{
    calls++;await context.progress({jobs:[{id:`job-${calls}`,status:'failed',stage:'真实工具失败',workflow:[{callId:`event-${calls}`,tool:'research',status:'failed',stage:'资料检索失败',at:''}]}]});
    throw new Error(`call ${calls}: TEST-PRIVATE-CREDENTIAL Bearer secret-token`);
  },stop:async()=>{},artifactFile:()=>undefined});
  await manager.init();const run=await manager.start({caseIds:['knowledge-cross-45','knowledge-rag-60']});
  let final=manager.get(run.id);const deadline=Date.now()+3000;
  while(final.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));final=manager.get(run.id);}
  assert.equal(final.status,'completed');assert.equal(calls,2);assert(final.results.every(r=>r.status==='failed'&&r.workflow?.length===1&&r.jobIds.length===1));
  const report=await readFile(path.join(dir,'evaluations/index.json'),'utf8');assert(!report.includes('TEST-PRIVATE-CREDENTIAL'));assert(!report.includes('secret-token'));assert.equal(evaluationSummary(final).passRate,0);
});
test('a failed initial record write does not start jobs or leave a phantom active run', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-write-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>{calls++;throw new Error('test job failure');},stop:async()=>{},artifactFile:()=>undefined});
  await manager.init();const file=path.join(dir,'evaluations/index.json'),backup=file+'.backup';
  await rename(file,backup);await mkdir(file);
  await assert.rejects(manager.start({caseIds:['knowledge-cross-45']}));assert.equal(calls,0);assert.equal(manager.list().length,0);
  await rm(file,{recursive:true});await rename(backup,file);
  const run=await manager.start({caseIds:['knowledge-cross-45']});
  let final=manager.get(run.id);const deadline=Date.now()+3000;
  while(final.status==='running'&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,20));final=manager.get(run.id);}
  assert.equal(calls,1);assert.equal(final.status,'completed');assert.equal(final.results[0].status,'failed');
});
test('manual evaluations cannot overlap a release case-generation reservation', async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-reservation-'));t.after(()=>rm(dir,{recursive:true,force:true}));let calls=0;
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>{calls++;throw new Error('fixture execution');},stop:async()=>{},artifactFile:()=>undefined});
  await manager.init();assert.equal(await manager.reserve('release-owner'),true);assert.equal(await manager.reserve('other-release'),false);
  await assert.rejects(manager.start({caseIds:['knowledge-cross-45']}),/生成用例/);assert.equal(calls,0);
  await manager.release('other-release');await assert.rejects(manager.start({caseIds:['knowledge-cross-45']}),/生成用例/);
  await manager.release('release-owner');const run=await manager.start({caseIds:['knowledge-cross-45']});assert.equal(await manager.reserve('release-owner'),false);
  const deadline=Date.now()+3000;while(manager.get(run.id).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(calls,1);
});
test('a truncated MP4 with readable metadata and a valid manifest still fails the full playback gate', {timeout:20000}, async t => {
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-eval-corrupt-media-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const video=path.join(dir,'truncated.mp4');
  await runFFmpeg(['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=s=160x96:r=20','-f','lavfi','-i','sine=frequency=300:sample_rate=48000','-t','10','-c:v','libx264','-c:a','aac','-movflags','+faststart',video]);
  const bytes=await readFile(video);await writeFile(video,bytes.subarray(0,Math.floor(bytes.length*.65)));
  const o=output();o.file=video;await writeFile(video.replace('.mp4','.render.json'),JSON.stringify({planHash:o.artifact.planHash}));
  const manager=createEvaluations({dataDir:dir,implementation:{revision:null,implementationHash:'code',skillHash:'skill'},models:async()=>models,execute:async()=>o,stop:async()=>{},artifactFile:()=>video});
  await manager.init();const run=await manager.start({caseIds:['knowledge-cross-45']});
  const deadline=Date.now()+5000;while(manager.get(run.id).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  const result=manager.get(run.id).results[0];assert.equal(result.status,'failed');assert.equal(result.artifact,undefined);assert(result.error);assert.equal(result.score,undefined);
});
