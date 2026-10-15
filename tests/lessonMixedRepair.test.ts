import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {LessonReport,RenderReview} from '../src/types';
import {lessonRepairPlan,speechOnlyRepair,visualRepairTargets} from '../server/visualRecovery';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p14-mixed-review.json',import.meta.url),'utf8')) as {report:LessonReport;review:RenderReview};
const rejected=(findings:string[]):RenderReview=>({...structuredClone(fixture.review),semantic:{score:82,findings,suggestions:[]}});

test('actual P14 mixed review repairs only the bad narrated chapter and separately retains the visual layout feedback',()=>{
  const before=structuredClone(fixture),plan=lessonRepairPlan(fixture.report,fixture.review);
  assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.visualChapterIds,['chapter-1']);assert.deepEqual(plan.layoutChapterIds,['chapter-1']);
  assert.deepEqual(plan.scriptFindings,[fixture.review.semantic!.findings[1]]);assert.deepEqual(plan.visualFindings,{'chapter-1':[fixture.review.semantic!.findings[0]]});assert.deepEqual(plan.unknownFindings,[]);
  assert.deepEqual(visualRepairTargets(fixture.report,fixture.review),[]);assert.equal(speechOnlyRepair(fixture.review),false);assert.deepEqual(fixture,before);
});

test('a correct literal narration with a wrong screen label stays visual, without claiming a layout-only defect',()=>{
  const report=structuredClone(fixture.report);report.chapters[1].narration='官方已定位原因，正在实施修复，但根因和影响范围未披露。';
  const review=rejected(['chapter-2：旁白原句“正在实施修复”与来源一致，但画面误写为“已经修复”，信息存在误导。']);
  const plan=lessonRepairPlan(report,review);assert.equal(plan.kind,'visual');assert.deepEqual(plan.visualChapterIds,['chapter-2']);assert.deepEqual(plan.scriptChapterIds,[]);assert.deepEqual(plan.layoutChapterIds,[]);
  assert.deepEqual(visualRepairTargets(report,review),['chapter-2']);
});

test('an asserted correct quote that is absent from the actual narration cannot authorize preserving that narration',()=>{
  const review=rejected(['chapter-2：旁白原句“正在实施修复”与来源一致，但画面表述错误。']);
  const plan=lessonRepairPlan(fixture.report,review);assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.layoutChapterIds,[]);
});

test('a positive clause cannot exempt a later actual narrated/source conflict or an unknown narration problem',()=>{
  for(const finding of ['chapter-2：旁白本身准确，但后半段旁白与来源矛盾，图解也不符。','chapter-2：旁白不准确，需要复查。','chapter-2：旁白和画面说法不一致，无法判断哪一个正确。']){
    const plan=lessonRepairPlan(fixture.report,rejected([finding]));assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.layoutChapterIds,[]);
  }
});

test('explicit chapter boundaries separate a combined mixed finding without broadening script targets',()=>{
  const combined=fixture.review.semantic!.findings.join('；');const plan=lessonRepairPlan(fixture.report,rejected([combined]));
  assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.visualChapterIds,['chapter-1']);assert.deepEqual(plan.layoutChapterIds,['chapter-1']);assert.equal(plan.scriptFindings.some(text=>text.includes('chapter-1')),false);
});

test('splitting chapter headers cannot discard an earlier unscoped source defect',()=>{
  for(const finding of ['全局来源未核验；chapter-1：手机图标遮挡标签。；chapter-2：标题重叠。','来源未核验；chapter-1：手机图标遮挡文字。']){
    const plan=lessonRepairPlan(fixture.report,rejected([finding]));assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,fixture.report.chapters.map(chapter=>chapter.id));assert.deepEqual(plan.layoutChapterIds,[]);assert.match(plan.scriptFindings[0],/来源未核验/);
  }
});

test('layout authority requires every finding in that chapter to be purely geometric',()=>{
  const geometry=['chapter-1：手机图标遮挡了标签文字。','chapter-1：标题字号太小，文字不可读。'];
  assert.deepEqual(lessonRepairPlan(fixture.report,rejected(geometry)).layoutChapterIds,['chapter-1']);
  for(const extra of ['chapter-1：图解箭头的因果关系错误，图标也有重叠。','chapter-1：画面把处理原因绑定到错误对象，存在归属误导。','chapter-1：图解说明不准确。']){
    const plan=lessonRepairPlan(fixture.report,rejected([...geometry,extra]));assert.deepEqual(plan.layoutChapterIds,[]);
  }
  const sameChapter=rejected([geometry[0],fixture.review.semantic!.findings[1].replace('chapter-2','chapter-1')]);
  assert.deepEqual(lessonRepairPlan(fixture.report,sameChapter).layoutChapterIds,[],'a script defect in the same chapter blocks layout-only authority');
});

test('ordinary scoped visual feedback retains the verified narration and exact chapter identity',()=>{
  const report=structuredClone(fixture.report);report.chapters.push({...report.chapters[2],id:'chapter-30'});
  for(const [finding,expected] of [['chapter-30：手机图标遮挡标签文字。',['chapter-30']],['chapter-1：旁白本身准确，但画面卡片信息归属错误。',['chapter-1']],['chapter-2：旁白清晰说出术语，但对应章节所有抽帧均未出现底部摘要提示条，存在重要信息视觉遗漏。',['chapter-2']]] as const){
    const plan=lessonRepairPlan(report,rejected([finding]));assert.equal(plan.kind,'visual');assert.deepEqual(plan.visualChapterIds,expected);
  }
});

test('clear pronunciation and voice problems stay on the existing sound route, while source conflicts do not',()=>{
  const sound=rejected(['chapter-2：旁白漏字，需要重录。']);assert.equal(lessonRepairPlan(fixture.report,sound).kind,'none');assert.equal(speechOnlyRepair(sound),true);
  const factual=rejected(['chapter-2：旁白与来源不符，完成状态错误。']);assert.equal(lessonRepairPlan(fixture.report,factual).kind,'script');assert.equal(speechOnlyRepair(factual),false);
});

test('a sound failure alongside a different chapter layout fault cannot preserve the failed audio',()=>{
  const plan=lessonRepairPlan(fixture.report,rejected(['chapter-1：手机图标遮挡标签文字。','chapter-2：旁白漏字，需要重录。']));
  assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,['chapter-2']);assert.deepEqual(plan.visualChapterIds,['chapter-1']);assert.deepEqual(plan.layoutChapterIds,['chapter-1']);assert.deepEqual(plan.scriptFindings,['chapter-2：旁白漏字，需要重录。']);
});

test('missing semantic evidence or unverified facts never manufacture a visual-layout authorization',()=>{
  const unknown={...rejected([]),semantic:undefined};assert.deepEqual(lessonRepairPlan(fixture.report,unknown).scriptChapterIds,fixture.report.chapters.map(chapter=>chapter.id));
  const unverified={...fixture.report,factReview:{score:70,needsRepair:true,findings:['来源未核验']}};assert.deepEqual(lessonRepairPlan(unverified,fixture.review).layoutChapterIds,[]);
  const technical={...fixture.review,checks:[{name:'成片语义审查请求',passed:false,detail:'Connection error'}]};assert.equal(lessonRepairPlan(fixture.report,technical).kind,'none');assert.deepEqual(lessonRepairPlan(fixture.report,technical).layoutChapterIds,[]);
});
