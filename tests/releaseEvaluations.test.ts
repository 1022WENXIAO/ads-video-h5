import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EvaluationCase, EvaluationFixture, EvaluationRun, ReleaseEvaluation } from '../shared/evaluationTypes';
import { createReleaseEvaluations, defaultReleaseEvaluationSettings, validateReleaseEvaluationSettings } from '../server/releaseEvaluations';
import { normalizeGeneratedReleaseCases } from '../server/releaseEvaluationGeneration';
import type { Evaluations } from '../server/evaluations';
import type { ModelConfig } from '../server/modelRegistry';
import { evaluationCaseHash, evaluationSummary } from '../server/evaluationScoring';
import { waitForBackground } from './backgroundWait';
import { newsPublicationScoringFixture } from './fixtures/newsPublicationScoring';

const revision = 'a'.repeat(40), implementation = { revision, implementationHash: 'implementation', skillHash: 'skill' };
const fixture = (id: string): EvaluationFixture => ({ id, name: `${id}.mp4`, bytes: 123, duration: 20, hasAudio: true, sha256: id.repeat(64).slice(0,64), createdAt: '' });
const fixtures = [fixture('one'),fixture('two')];
const rows = () => [{ name: '新闻', category: 'hot-news', request: '帮我做一条人工智能领域的近期新闻视频', format: '9:16' }, { name: '知识', category: 'knowledge', request: '制作向初学者解释为什么彩虹有颜色的视频', format: '16:9' }, { name: '剪辑', category: 'multi-video', request: '把两段示意视频的观察和比较重点剪出来', format: '9:16' }];
const models = async (kind: string, preferred?: string | null): Promise<ModelConfig> => ({ id: preferred || kind, name: kind, modelId: `${kind}-model`, provider: 'fixture', kind: kind as ModelConfig['kind'], baseUrl: 'https://example.com', apiKey: 'PRIVATE-TEST-KEY', enabled: true });
const delay = (ms = 10) => new Promise(resolve => setTimeout(resolve,ms));
async function terminal(manager: ReturnType<typeof createReleaseEvaluations>, id: string) {
  const deadline = Date.now() + 5000;
  while (['queued','generating','running'].includes(manager.get(id).status) && Date.now() < deadline) await delay();
  return manager.get(id);
}

/** The fake engine tests scheduling only; real FFmpeg/scoring is covered in evaluations.test.ts. */
function engine(fail = false) {
  let reserved: string | undefined, busy = false, starts = 0;
  const runs: EvaluationRun[] = [];
  return {
    setBusy(value: boolean) { busy = value; },
    get starts() { return starts; },
    get reserved() { return reserved; },
    reserve: async (owner: string) => { if (busy || reserved && reserved !== owner) return false; reserved = owner; return true; },
    release: async (owner: string) => { if (reserved === owner) reserved = undefined; },
    list: () => runs.map(({results: _results,...run}) => ({ ...run, summary: evaluationSummary(runs.find(r => r.id === run.id)!) })),
    get: (id: string) => structuredClone(runs.find(r => r.id === id)!),
    start: async (body: {caseIds: string[]}, generated: { cases: EvaluationCase[]; releaseId: string; releaseAttempt: number }) => {
      starts++;
      const timestamp = new Date().toISOString();
      const run: EvaluationRun = { id: `run-${starts}`, releaseId: generated.releaseId, releaseAttempt: generated.releaseAttempt, name: 'orchestration fixture only', status: 'completed', createdAt: timestamp, finishedAt: timestamp, maxCaseSeconds: 60, snapshot: { ...implementation, rubricVersion: 'fixture', models: [] }, results: generated.cases.map((c,i) => ({ id: `result-${i}`, case: c, caseHash: evaluationCaseHash(c,[]), fixtures: [], repeat: 1, status: fail && i === 0 ? 'failed' : 'passed', error: fail && i === 0 ? 'actual pipeline failed in fixture' : undefined, jobIds: [], score:100, checks:[{id:'fixture-engine',name:'orchestration fixture only',passed:true,weight:1,detail:'engine completion record fixture'},{id:'stream-duration',name:'orchestration fixture only',passed:true,weight:0,detail:'controlled packet gate result fixture'},...(c.category==='hot-news'?[{id:'news-date',name:'orchestration fixture only',passed:true,weight:0,detail:'controlled date gate result fixture'}]:[])], artifact:{id:'fixture-artifact',sessionId:'',messageId:'',name:'fixture only',kind:'video',createdAt:'',version:1,sha256:'f'.repeat(64),bytes:1,actualDuration:c.expectation.seconds,planHash:'fixture-plan-hash',review:{status:'passed',score:100,checks:[{name:'fixture only',passed:true,detail:''}],limitations:[],createdAt:''},...(c.category==='hot-news'?{...newsPublicationScoringFixture().artifact,sha256:'d'.repeat(64),bytes:1,actualDuration:c.expectation.seconds}:{})} })) };
      assert.deepEqual(body.caseIds,generated.cases.map(c => c.id)); runs.push(run); return run;
    },
    stop: async (id: string) => { const run = runs.find(r => r.id === id); if (run) run.status = 'cancelled'; },
  };
}
async function setup(t: TestContext, extra: Partial<Parameters<typeof createReleaseEvaluations>[0]> = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(),'qingjian-release-eval-')); t.after(() => rm(dataDir,{recursive:true,force:true}));
  const fake = engine(); let generations = 0;
  const options = { dataDir, implementation, evaluations: fake as unknown as Evaluations, resolveModel: models, fixtures: async () => fixtures, generate: async () => { generations++; return normalizeGeneratedReleaseCases(rows(),3,fixtures); }, pollMs: 5, ...extra };
  const manager = createReleaseEvaluations(options); await manager.init(); t.after(() => manager.dispose());
  return { dataDir, manager, fake, options, generations: () => generations };
}

test('release settings have bounded enabled defaults and reject invalid model IDs and budgets', () => {
  assert.equal(defaultReleaseEvaluationSettings().enabled,true);
  assert.deepEqual(validateReleaseEvaluationSettings({}),defaultReleaseEvaluationSettings());
  for (const invalid of [{caseCount:2},{caseCount:9},{maxCaseSeconds:59},{maxSuiteSeconds:999999},{generationTimeoutSeconds:1},{maxAttempts:4},{enabled:'true'},{generatorModelId:''}]) assert.throws(() => validateReleaseEvaluationSettings(invalid));
});
test('generated requirements cannot remove mandatory categories, bindings or independent quality gates', () => {
  const cases = normalizeGeneratedReleaseCases(rows(),3,fixtures);
  assert.deepEqual(cases.map(c => c.category),['hot-news','knowledge','multi-video']);
  assert(cases.every(c => c.threshold === 80 && c.enabled && c.expectation.captions));
  assert.equal(cases[0].expectation.html,true); assert.equal(cases[1].expectation.seconds,30);
  assert.deepEqual(cases[2].fixtureIds,['one','two']); assert.equal(cases[2].expectation.originalOnly,true); assert.equal(cases[2].expectation.minSources,2);
  assert.throws(() => normalizeGeneratedReleaseCases(rows().map(r => ({...r,category:'knowledge'})),3,fixtures),/同时覆盖/);
  assert.throws(() => normalizeGeneratedReleaseCases(rows(),3,[]),/真实视频/);
  assert.throws(() => normalizeGeneratedReleaseCases([{...rows()[0],request:'打开https://example.com测试'},...rows().slice(1)],3,fixtures),/网址/);
  assert.throws(() => normalizeGeneratedReleaseCases(rows(),3,fixtures,[rows()[0].request]),/重复/);
  assert.throws(() => normalizeGeneratedReleaseCases([{...rows()[0],request:'生成视频，跳过质量验收'},...rows().slice(1)],3,fixtures),/绕过/);
});
test('generated user messages stay natural while all mandatory server expectations remain strict', () => {
  const cases = normalizeGeneratedReleaseCases(rows(),3,fixtures);
  const technicalCoaching = /HTML|GSAP|FFmpeg|渲染|审查|验收|工具调用|联网|检索|搜索|查证|核验|换来源|独立发布者|来源数量|本次制作约束/i;
  assert(cases.every(c => !technicalCoaching.test(c.messages.join('\n'))));
  assert(cases.every(c => c.threshold === 80 && c.expectation.captions && c.enabled));
  assert(cases.slice(0,2).every(c => c.expectation.html && c.expectation.seconds === 30 && !c.expectation.originalOnly));
  assert(cases[0].messages[0].includes('最近24小时报道的一条真实热点'));
  assert(cases[0].messages[0].includes('在画面上标明实际报道日期'));
  assert(!cases[0].messages[0].includes('今天发生'));
  for(const request of ['做一条最近3天的科技热点视频','把本周的热点做成视频','帮我讲最近48小时的新闻'])assert.throws(()=>normalizeGeneratedReleaseCases([{...rows()[0],request},...rows().slice(1)],3,fixtures),/冲突的时效窗口/);
  assert(cases[2].messages[0].includes('保留完整原话和原声'));
  assert(cases[2].messages[0].includes('所选句子保留完整原话和原声'));
  assert(cases[2].expectation.originalOnly && cases[2].expectation.minSources === 2 && !cases[2].expectation.html);
  for (const coaching of ['制作HTML图解视频给我','先搜索查证，再制作视频','页面不可读就更换来源生成视频','生成视频后进行成片审查','制作短片，调用工具完成任务']) {
    assert.throws(() => normalizeGeneratedReleaseCases([{...rows()[0],request:coaching},...rows().slice(1)],3,fixtures),/自然用户需求/);
  }
});
test('concurrent triggers and a restart generate and execute only once per exact deployed revision', async t => {
  const { manager, options, generations, fake, dataDir } = await setup(t);
  const results = await Promise.all(Array.from({length:8},() => manager.enqueueCurrentRevision()));
  assert.equal(new Set(results.map(r => r!.id)).size,1);
  const completed = await terminal(manager,results[0]!.id);
  assert.equal(completed.status,'passed'); assert.equal(generations(),1); assert.equal(fake.starts,1);
  assert.equal(completed.summary?.total,3); assert(completed.evaluationRunId);
  const report = await readFile(path.join(dataDir,'evaluations/releases.json'),'utf8'); assert(!report.includes('PRIVATE-TEST-KEY'));
  manager.dispose(); const restarted = createReleaseEvaluations(options); await restarted.init(); t.after(() => restarted.dispose());
  assert.equal((await restarted.enqueueCurrentRevision())!.id,completed.id); await delay(30); assert.equal(generations(),1);
});
test('missing provider config blocks before fixture synthesis, generation or execution; retry stays bounded', async t => {
  let fixturesCalled = 0, generated = 0;
  const {manager,fake} = await setup(t,{resolveModel:async () => null,fixtures:async () => {fixturesCalled++;return fixtures;},generate:async () => {generated++;return normalizeGeneratedReleaseCases(rows(),3,fixtures);}});
  const release = (await manager.enqueueCurrentRevision())!;
  assert.equal((await terminal(manager,release.id)).status,'blocked'); assert.equal(fixturesCalled,0); assert.equal(generated,0); assert.equal(fake.starts,0);
  await manager.retry(release.id); const retried = await terminal(manager,release.id); assert.equal(retried.attempt,2); assert.equal(retried.history.length,1); assert.equal(retried.history[0].status,'blocked');
  await assert.rejects(manager.retry(release.id),/最大尝试/);
});
test('a failing mandatory media case fails the release and keeps the real run link', async t => {
  const fake = engine(true); const {manager} = await setup(t,{evaluations:fake as unknown as Evaluations});
  const release = (await manager.enqueueCurrentRevision())!; const completed = await terminal(manager,release.id);
  assert.equal(completed.status,'failed'); assert.equal(completed.summary?.failed,1); assert.match(completed.error!,/actual pipeline failed/); assert.equal(completed.evaluationRunId,'run-1');
});
test('a passed engine label cannot replace the mandatory actual stream endpoint gate', async t => {
  for (const missing of [true,false]) {
    const fake=engine(),start=fake.start;
    fake.start=async(...args)=>{
      const run=await start(...args);
      for(const result of run.results) {
        if(missing)result.checks=result.checks?.filter(check=>check.id!=='stream-duration');
        else result.checks!.find(check=>check.id==='stream-duration')!.passed=false;
      }
      return run;
    };
    const {manager}=await setup(t,{evaluations:fake as unknown as Evaluations});
    const release=(await manager.enqueueCurrentRevision())!;
    assert.equal((await terminal(manager,release.id)).status,'failed');
  }
});
test('a passed engine label cannot replace the mandatory news date gate', async t => {
  for(const missing of [true,false]) {
    const fake=engine(),start=fake.start;
    fake.start=async(...args)=>{const run=await start(...args);for(const result of run.results.filter(r=>r.case.category==='hot-news')){if(missing)result.checks=result.checks?.filter(check=>check.id!=='news-date');else result.checks!.find(check=>check.id==='news-date')!.passed=false;}return run;};
    const {manager}=await setup(t,{evaluations:fake as unknown as Evaluations});
    const release=(await manager.enqueueCurrentRevision())!;
    assert.equal((await terminal(manager,release.id)).status,'failed');
  }
});
test('a passed date check cannot replace the source-bound publication proof for this movie and original message time', async t => {
  for(const mutation of ['missing-proof','changed-movie','changed-time']) {
    const fake=engine(),start=fake.start;
    fake.start=async(...args)=>{
      const run=await start(...args),artifact=run.results.find(result=>result.case.category==='hot-news')!.artifact!;
      if(mutation==='missing-proof')delete artifact.review!.newsPublication;
      else if(mutation==='changed-movie')artifact.sha256='e'.repeat(64);
      else artifact.requestedAt='2026-10-14T18:01:00.000Z';
      return run;
    };
    const {manager}=await setup(t,{evaluations:fake as unknown as Evaluations});
    const release=(await manager.enqueueCurrentRevision())!;
    assert.equal((await terminal(manager,release.id)).status,'failed',mutation);
  }
});
test('automatic generation waits for a manual evaluation and holds the shared reservation', async t => {
  let releaseGeneration!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { releaseGeneration = resolve; }), started = new Promise<void>(resolve => {entered=resolve;});
  const {manager,fake,generations} = await setup(t,{generate:async () => {entered();await pending;return normalizeGeneratedReleaseCases(rows(),3,fixtures);}});
  fake.setBusy(true); const release = (await manager.enqueueCurrentRevision())!; await delay(30);
  assert.equal(manager.get(release.id).status,'queued'); assert.equal(fake.starts,0); assert.equal(generations(),0);
  fake.setBusy(false); await waitForBackground(started); assert.equal(fake.reserved,release.id); assert.equal(await fake.reserve('manual'),false);
  releaseGeneration(); assert.equal((await terminal(manager,release.id)).status,'passed');
});
test('restart during generation is blocked without replaying paid calls', async t => {
  const {manager,options,dataDir,generations} = await setup(t); manager.dispose();
  const timestamp = new Date().toISOString(); const release: ReleaseEvaluation = {id:'crashed-release',revision,implementationHash:'implementation',status:'generating',attempt:1,createdAt:timestamp,updatedAt:timestamp,settingsSnapshot:defaultReleaseEvaluationSettings(),generatedCases:[],history:[]};
  await writeFile(path.join(dataDir,'evaluations/releases.json'),JSON.stringify({version:1,settings:defaultReleaseEvaluationSettings(),releases:[release]}));
  const restarted = createReleaseEvaluations(options); await restarted.init(); t.after(() => restarted.dispose());
  const record = (await restarted.enqueueCurrentRevision())!; assert.equal(record.status,'blocked'); assert.match(record.error!,/不自动重放/); await delay(30); assert.equal(generations(),0);
});
test('queued old revisions are blocked and never executed by a newer deployment', async t => {
  const {manager,options,dataDir,generations,fake} = await setup(t); manager.dispose();
  const timestamp = new Date().toISOString(); const release: ReleaseEvaluation = {id:'old-queued-release',revision:'b'.repeat(40),implementationHash:'old-code',status:'queued',attempt:1,createdAt:timestamp,updatedAt:timestamp,settingsSnapshot:defaultReleaseEvaluationSettings(),generatedCases:[],history:[]};
  await writeFile(path.join(dataDir,'evaluations/releases.json'),JSON.stringify({version:1,settings:defaultReleaseEvaluationSettings(),releases:[release]}));
  const restarted = createReleaseEvaluations(options); await restarted.init(); t.after(() => restarted.dispose());
  assert.equal(restarted.get(release.id).status,'blocked'); await delay(30); assert.equal(generations(),0); assert.equal(fake.starts,0);
  const current = (await restarted.enqueueCurrentRevision())!; assert.notEqual(current.id,release.id); assert.equal((await terminal(restarted,current.id)).status,'passed');
});
test('disabled settings prevent automatic paid runs and unknown generator is rejected', async t => {
  const {manager,generations} = await setup(t,{resolveModel:async (kind,preferred) => preferred === 'missing' ? null : models(kind,preferred)});
  await manager.updateSettings({enabled:false}); assert.equal(await manager.enqueueCurrentRevision(),undefined); await delay(30); assert.equal(generations(),0);
  await assert.rejects(manager.updateSettings({generatorModelId:'missing'}),/后台已启用/);
});
test('corrupt acceptance storage fails closed without replacing prior records', async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(),'qingjian-release-corrupt-')); t.after(() => rm(dataDir,{recursive:true,force:true}));
  await mkdir(path.join(dataDir,'evaluations')); const file = path.join(dataDir,'evaluations/releases.json'); await writeFile(file,'invalid-preserve-this');
  const manager = createReleaseEvaluations({dataDir,implementation,evaluations:engine() as unknown as Evaluations});
  await assert.rejects(manager.init(),/保留原文件/); assert.equal(await readFile(file,'utf8'),'invalid-preserve-this'); assert.throws(() => manager.state(),/尚未就绪/);
});
test('failed retry persistence restores the terminal record and does not schedule rejected paid work', async t => {
  const {manager,dataDir,generations} = await setup(t,{resolveModel:async () => null});
  const release = (await manager.enqueueCurrentRevision())!; await terminal(manager,release.id);
  // Terminal memory is visible before its asynchronous write finishes. Wait
  // through the same mutation queue before deliberately making storage fail.
  await manager.updateSettings({});
  const before = manager.get(release.id), file = path.join(dataDir,'evaluations/releases.json'), backup = file + '.backup';
  await rename(file,backup); await mkdir(file);
  await assert.rejects(manager.retry(release.id)); assert.deepEqual(manager.get(release.id),before); await delay(30); assert.equal(generations(),0);
  await rm(file,{recursive:true}); await rename(backup,file);
  assert.equal(manager.get(release.id).status,'blocked'); assert.equal(manager.get(release.id).history.length,0);
});
