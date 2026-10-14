import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvaluation } from '../server/evaluationScoring';
import { planHash } from '../server/renderTimeline';
import { newsPublicationScoringFixture } from './fixtures/newsPublicationScoring';

test('news scoring requires source-bound HTML and an actual same-movie date frame observation, even at numeric score 100',()=>{
  const f=newsPublicationScoringFixture();
  const score=()=>scoreEvaluation(f.test,f.artifact,f.media,[],30,true,f.actualFileSha256);
  const accepted=score();assert.equal(accepted.passed,true);assert.equal(accepted.checks.find(c=>c.id==='news-date')?.weight,0);
  delete f.artifact.review!.newsPublication;
  const metadataOnly=score();assert.equal(metadataOnly.score,100);assert.equal(metadataOnly.passed,false);assert.equal(metadataOnly.checks.find(c=>c.id==='news-date')?.passed,false);
});

test('news dates reject missing checks, stale movie or scene proofs, invisible layout, fabricated readings and changed original time',()=>{
  const mutations:Array<[string,(f:ReturnType<typeof newsPublicationScoringFixture>)=>void]>=[
    ['missing date check',f=>{f.artifact.review!.checks=f.artifact.review!.checks.filter(c=>c.name!=='新闻报道日期可见');}],
    ['failed date check',f=>{f.artifact.review!.checks.find(c=>c.name==='新闻报道日期可见')!.passed=false;}],
    ['different actual MP4',f=>{f.actualFileSha256='e'.repeat(64);}],
    ['different source media',f=>{f.proof.sourceId='other-media';}],
    ['changed source bytes',f=>{f.proof.sourceHash='e'.repeat(64);}],
    ['changed source HTML',f=>{f.proof.htmlHash='e'.repeat(64);}],
    ['changed plan',f=>{f.proof.planHash='e'.repeat(64);}],
    ['no trusted HTML evidence',f=>{delete f.media[0].generation!.newsPublication;}],
    ['different trusted scene bytes',f=>{f.media[0].generation!.newsPublication!.sceneHash='e'.repeat(64);}],
    ['hidden date',f=>{f.proof.layout.minimumOpacity=0;}],
    ['unreadable font',f=>{f.proof.layout.fontSize=12;}],
    ['no independent frame evidence',f=>{delete (f.proof as Partial<typeof f.proof>).frameEvidence;}],
    ['date reading differs from actual label',f=>{f.proof.frameEvidence.quote='报道日期：2026-10-13（北京时间）';}],
    ['unsampled reading time',f=>{f.proof.frameEvidence.frameTime=3.141;}],
    ['reading from another chapter',f=>{f.proof.frameEvidence.chapterId='ch2';}],
    ['missing original message time',f=>{delete f.artifact.requestedAt;}],
    ['proof and media both invent a new cutoff',f=>{f.proof.cutoffUtc='2026-10-14T18:01:00.000Z';f.media[0].generation!.newsPublication!.cutoffUtc=f.proof.cutoffUtc;}],
  ];
  for(const [name,mutate]of mutations){const f=newsPublicationScoringFixture();mutate(f);const result=scoreEvaluation(f.test,f.artifact,f.media,[],30,true,f.actualFileSha256);assert.equal(result.checks.find(c=>c.id==='news-date')?.passed,false,name);assert.equal(result.passed,false,name);}
  const f=newsPublicationScoringFixture();assert.equal(scoreEvaluation(f.test,f.artifact,f.media,[],30,true).passed,false,'a date proof cannot replace externally measured MP4 hash');
});

test('date scoring honors the actual requested reporting window while retaining historical 72-hour news requests',()=>{
  const f=newsPublicationScoringFixture();
  f.artifact.plan!.lesson!.hotResearch!.windowHours=72;f.proof.windowHours=72;f.media[0].generation!.newsPublication!.windowHours=72;
  f.artifact.planHash=planHash(f.artifact.plan!);f.proof.planHash=f.artifact.planHash;
  assert.equal(scoreEvaluation(f.test,f.artifact,f.media,[],30,true,f.actualFileSha256).checks.find(c=>c.id==='news-date')?.passed,false,'24-hour user request cannot silently become 72-hour research');
  f.test.messages=['制作最近3天报道的一条新闻视频，画面标明实际报道日期。'];
  assert.equal(scoreEvaluation(f.test,f.artifact,f.media,[],30,true,f.actualFileSha256).passed,true);
});
