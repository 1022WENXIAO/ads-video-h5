import test from 'node:test';
import assert from 'node:assert/strict';
import type {LessonReport,RenderReview} from '../shared/types';
import {lessonRepairPlan} from '../server/visualRecovery';

const report={chapters:[
  {id:'chapter-1',title:'灯亮不等于热透',narration:'冲煮头、手柄和杯子还可能偏凉，会吸走热水的热量。'},
  {id:'chapter-2',title:'短萃取怕温度飘',narration:'温度一变，溶出节奏就会飘，先热身更容易做稳定。'},
  {id:'chapter-3',title:'先热身再萃取',narration:'若味道仍不稳，再查磨豆粗细、粉量和萃取时间。'},
],factReview:{score:88,needsRepair:false,findings:[]}} as LessonReport;
const rejected=(findings:string[]):RenderReview=>({status:'needs-review',score:64,checks:[{name:'成片语义审查',passed:false,detail:findings.join('；')}],semantic:{score:64,findings,suggestions:[]},limitations:[],createdAt:''});

test('captured coffee illustration and duplicate-heading failures redraw the two affected chapters without rewriting verified speech',()=>{
  const findings=[
    'chapter-1：两张配图（冷杯会吸热、冲煮头待暖）均使用游戏手柄图标，与文案描述的咖啡机冲煮头、金属手柄完全不符，会误导新手把家电部件认成游戏设备，需替换为符合文案的咖啡机冲煮头、金属手柄相关示意插画。',
    'chapter-1：三张卡片的配图完全未对应文案主题，实际配图未出现咖啡豆、咖啡机和厨房台面元素，需替换为包含三类元素的厨房台面示意画面。',
    'chapter-1：底部补充说明条“开机灯亮，只代表机器已通电，不代表全系统热透”仅在1.752秒之后出现，两个抽帧时点该内容完全缺失，需将该说明条前置。',
    'chapter-2：画面顶部同时出现两次“短萃取怕温度飘”大标题，一处为页面顶部大标题，一处为居中重复标题，造成冗余，需删除其中一个重复标题。',
  ];
  const original=structuredClone(report),review=rejected(findings),plan=lessonRepairPlan(report,review);
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.visualChapterIds,['chapter-1','chapter-2']);
  assert.deepEqual(plan.scriptChapterIds,[]);assert.deepEqual(plan.scriptFindings,[]);
  assert.deepEqual(plan.visualFindings['chapter-2'],[findings[3]]);assert.deepEqual(report,original);
  assert.equal(review.score,64);assert.deepEqual(review.semantic!.findings,findings,'routing retains every original finding and score');
});

test('different phrasings of a duplicated on-screen heading stay visual',()=>{
  for(const finding of [
    'chapter-2：页面中标题重复显示了两遍，删去重复绘制。',
    'chapter-2：屏幕标题在顶部和中间重复渲染，排版冗余。',
    'chapter-2：同一大标题在画面出现两处，请只显示一处。',
    'chapter-2：画面标题印了两遍，需要修复排版。',
  ])assert.equal(lessonRepairPlan(report,rejected([finding])).kind,'visual',finding);
});

test('duplicate-title wording never bypasses real source, subtitle or spoken defects',()=>{
  for(const finding of [
    'chapter-2：画面顶部出现两次“短萃取怕温度飘”大标题，旁白错误，需要改写。',
    'chapter-2：画面标题重复，但字幕漏字。',
    'chapter-2：画面出现两次“短萃取怕温度飘”大标题，来源不支持这个说法。',
    'chapter-2：画面标题出现两次，来源没有核验。',
    'chapter-2：画面标题重复，原文尚未进行核实。',
    'chapter-2：画面标题重复，来源未经证实。',
    'chapter-2：画面标题重复，该结论尚未证实。',
    'chapter-2：画面标题重复，存在事实错误。',
    'chapter-2：画面出现两次“所有差异一定由预热造成”大标题。',
    'chapter-2：标题内容有待核验，需要补充说明。',
  ])assert.deepEqual(lessonRepairPlan(report,rejected([finding])).scriptChapterIds,['chapter-2'],finding);
  assert.equal(lessonRepairPlan({...report,factReview:{score:70,needsRepair:true,findings:['未核验']}},rejected(['chapter-2：画面标题重复显示两遍。'])).kind,'script');
});
