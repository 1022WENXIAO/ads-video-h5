import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type {LessonReport,RenderReview} from '../src/types';
import {lessonRepairPlan} from '../server/visualRecovery';
import {lessonRepairTargets} from '../server/lessonSpec';

const actual=JSON.parse(await readFile(new URL('./fixtures/p24-local-whole-duration-review.json',import.meta.url),'utf8')) as {report:LessonReport;review:RenderReview;expectedScriptChapterIds:string[]};
const ids=actual.report.chapters.map(chapter=>chapter.id);
const rejected=(findings:string[]):RenderReview=>({...structuredClone(actual.review),checks:[{name:'成片语义审查',passed:false,detail:findings.join(';')}],semantic:{score:65,findings,suggestions:[]}});

test('actual P24 chapter-local whole-duration subtitle findings do not expand the repair to all chapters',()=>{
  const before=structuredClone(actual),plan=lessonRepairPlan(actual.report,actual.review);
  assert.equal(plan.kind,'script');assert.deepEqual(plan.scriptChapterIds,actual.expectedScriptChapterIds);assert.deepEqual(plan.scriptFindings,actual.review.semantic!.findings);
  assert.deepEqual(plan.visualChapterIds,[]);assert.deepEqual(actual,before);assert.equal(actual.review.score,65);assert.equal(actual.review.status,'needs-review');
});

test('a named chapter stays local through duration paraphrases, global labels and quoted scope words',()=>{
  for(const finding of [
    'ch2：该段画面全程遮挡标签文字。',
    'ch2 画面在整个章节期间都有文字重叠。',
    'ch2：本章全程字幕与来源矛盾。',
    'ch2：全局标签遮挡下方文字。',
    'ch2：global label 与标题文字重叠。',
    'ch2：标签“全片、所有章节、ch1”遮挡正文。',
    'ch2：标签「全局：每章」发生文字重叠。',
    'ch2：标题 "all chapters" 遮挡文字。',
    'ch2：只是本章的问题，并非全片，标签相互重叠。',
  ]){
    const plan=lessonRepairPlan(actual.report,rejected([finding]));
    assert.deepEqual([...new Set([...plan.scriptChapterIds,...plan.visualChapterIds])],['ch2'],finding);
  }
});

test('explicit ordinal chapter names resolve only the actual chapter, including local whole-duration wording',()=>{
  for(const finding of ['第二章：该章全程字幕与来源矛盾。','第2章：画面标签全程被遮挡。','第二章全程都存在标签重叠。','chapter-2：该段全程文字重叠。']){
    const plan=lessonRepairPlan(actual.report,rejected([finding]));assert.deepEqual([...plan.scriptChapterIds,...plan.visualChapterIds],['ch2'],finding);
  }
});

test('explicit whole-film or cross-chapter defects still target every actual chapter',()=>{
  for(const finding of ['全局：存在事实错误。','global: 存在事实错误。','ch2：全片都有事实错误。','ch2：所有章节都有事实错误。','ch2：每一章都存在事实错误。','ch2：各章节存在事实错误。','ch2：这是跨章的事实错误。','ch2：全局问题导致事实错误。','ch2: all chapters have 事实错误。','ch2: global issue: 事实错误。']){
    const plan=lessonRepairPlan(actual.report,rejected([finding]));assert.deepEqual(plan.scriptChapterIds,ids,finding);
  }
});

test('separate local findings union their own chapters; one genuine global finding unions all',()=>{
  const local=['ch1：标题文字相互重叠。','ch2：本章全程字幕错误。'];
  const plan=lessonRepairPlan(actual.report,rejected(local));assert.deepEqual(plan.visualChapterIds,['ch1']);assert.deepEqual(plan.scriptChapterIds,['ch2']);
  assert.deepEqual(lessonRepairPlan(actual.report,rejected([...local,'全片字幕存在错误。'])).scriptChapterIds,ids);
});

test('combined explicit chapter headers keep their independent visual and spoken classifications',()=>{
  const plan=lessonRepairPlan(actual.report,rejected(['第一章：标题文字相互重叠；第二章：本章全程字幕错误。']));
  assert.deepEqual(plan.visualChapterIds,['ch1']);assert.deepEqual(plan.scriptChapterIds,['ch2']);assert.equal(plan.scriptFindings.some(f=>f.includes('第一章')),false);
});

test('quoted chapter headers do not split or broaden a real local finding',()=>{
  const plan=lessonRepairPlan(actual.report,rejected(['ch2：标签“ch1：全片”遮挡文字；标签「第一章：所有章节」发生文字重叠。']));
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.visualChapterIds,['ch2']);assert.deepEqual(plan.scriptChapterIds,[]);
});

test('unknown, absent or ambiguous chapter targets remain conservative instead of selecting a convenient chapter',()=>{
  for(const finding of ['画面全程存在事实错误。','第九章：存在事实错误。','ch2：存在事实错误；chapter9：存在事实错误。'])assert.deepEqual(lessonRepairPlan(actual.report,rejected([finding])).scriptChapterIds,ids,finding);
  const ambiguous={...actual.report,chapters:[{id:'chapter-2'},{id:'ch2'},{id:'chapter-3'}]} as LessonReport;
  assert.deepEqual(lessonRepairPlan(ambiguous,rejected(['chapter2：本章全程存在事实错误。'])).scriptChapterIds,ambiguous.chapters.map(chapter=>chapter.id));
});

test('an explicit local repair instruction can rule out rerecording the whole film without enlarging its scope',()=>{
  for(const finding of [
    'ch2：字幕存在事实错误，无需重录全片。',
    'ch2：本章字幕与来源矛盾，不需要修改所有章节。',
    '第二章：字幕存在事实错误，不必重新调整全部章节。',
    'ch2：字幕存在事实错误；no need to re-record the whole film.',
    'ch2：字幕存在事实错误；not the entire film.',
  ])assert.deepEqual(lessonRepairPlan(actual.report,rejected([finding])).scriptChapterIds,['ch2'],finding);
  const soundOnly='ch2：字幕错误，不涉及对其他章节的修改。';
  assert.equal(lessonRepairPlan(actual.report,rejected([soundOnly])).kind,'none','the existing sound-only route is unchanged');
  assert.deepEqual(lessonRepairTargets(actual.report,soundOnly),['ch2'],'the existing sound route still targets only the explicit chapter');
});

test('a negated global repair instruction cannot hide a separate positive whole-film defect',()=>{
  for(const finding of [
    'ch2：全片均有事实错误，无需重录全片。',
    'ch2：所有章节都有事实错误，不需要修改所有章节。',
    'ch2：字幕存在事实错误，无需重录全片，但所有章节都有同样的事实错误。',
    'ch2：字幕存在事实错误；not the entire film. All chapters have 事实错误。',
    'ch2：The entire film has 事实错误。',
    'ch2：The whole film has 事实错误。',
  ])assert.deepEqual(lessonRepairPlan(actual.report,rejected([finding])).scriptChapterIds,ids,finding);
});
