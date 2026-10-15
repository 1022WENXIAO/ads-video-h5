import test from 'node:test';
import assert from 'node:assert/strict';
import type {LessonReport,RenderReview} from '../src/types';
import {createLessonLayoutRepairProofs,canUseLessonLayoutRepairProof} from '../server/lessonLayoutRepair';
import {nativeLessonFallbackAllowed} from '../server/lessonHtmlFallbackPolicy';

const renderer='a'.repeat(64),candidate='769c1e3c847b9429c34463ff9d20e88e9fe604d34427b04dea7ad29c815c07ec';
// Minimal public projection of P14's actual rejected movie findings. These
// tests verify repair authority, not actual source/video or creative acceptance.
function fixture(){
  const report={factReview:{score:92,needsRepair:false,findings:[]},references:[{id:'ref-7',url:'https://example.test/news',excerpt:'官方已定位原因，正在实施修复。'}],chapters:[
    {id:'chapter-1',title:'早高峰报错',narration:'网页和App都提示服务器暂时不可用。',reason:'显示两种访问入口',referenceIds:['ref-7'],claims:[{text:'正在实施修复',basis:'source',referenceIds:['ref-7']}],visual:{kind:'concept',takeaway:'区分两种访问入口',items:[{label:'网页',detail:'网页暂时不可用',cue:'网页'},{label:'App',detail:'App暂时不可用',cue:'App'}]}},
    {id:'chapter-2',title:'哪些服务受影响',narration:'官方已定位原因并修复，但根因和影响范围未披露。',reason:'核对官方进度',referenceIds:['ref-7'],claims:[{text:'官方已定位原因，正在实施修复',basis:'source',referenceIds:['ref-7']}],visual:{kind:'concept',takeaway:'仅陈述报道时状态',items:[{label:'已定位',detail:'正在实施修复',cue:'已定位原因'},{label:'未披露',detail:'根因和影响范围尚未披露',cue:'未披露'}]}}
  ]} as unknown as LessonReport;
  const findings=['chapter-1：手机设备图标两侧的“手”、“pp”文字仅露出部分字符，无法辨认完整内容，该元素显示存在截断遮挡。','chapter-2：旁白表述为“官方已定位原因并修复”，但对应来源及画面图解均标注为“正在实施修复”，表述不一致，未与权威来源进度保持对齐，存在信息误导风险。'];
  const review={score:82,status:'needs-review',checks:[{name:'成片语义审查',passed:false,detail:findings.join('；')}],semantic:{score:82,findings}} as RenderReview;
  return {report,review};
}

test('mixed P14 rejection permits only the unchanged chapter with a proved layout defect',()=>{
  const {report,review}=fixture(),original=structuredClone({report,review}),proofs=createLessonLayoutRepairProofs(report,review,candidate,renderer);
  assert.deepEqual(Object.keys(proofs),['chapter-1']);
  const chapter=report.chapters[0],feedback=proofs[chapter.id].findings.join('\n');
  assert.equal(canUseLessonLayoutRepairProof(report,chapter,feedback,proofs[chapter.id],renderer),true);
  assert.equal(nativeLessonFallbackAllowed('制作新闻图解',chapter,feedback),false);
  assert.equal(nativeLessonFallbackAllowed('制作新闻图解',chapter,feedback,{verifiedLayoutRepair:true}),true);
  assert.equal(canUseLessonLayoutRepairProof(report,report.chapters[1],review.semantic!.findings[1],proofs['chapter-1'],renderer),false);
  assert.deepEqual({report,review},original);
});

test('changed script, visual meaning, sources, feedback, policy or proof revokes repair authority',()=>{
  const {report,review}=fixture(),proof=createLessonLayoutRepairProofs(report,review,candidate,renderer)['chapter-1'],feedback=proof.findings.join('\n');
  for(const alter of [
    (value:LessonReport)=>{value.chapters[0].narration+='已经恢复。';},
    (value:LessonReport)=>{value.chapters[0].visual.items[0].detail='全部服务已经恢复';},
    (value:LessonReport)=>{value.references[0].excerpt='报道正文发生变化';},
  ]){const changed=structuredClone(report);alter(changed);assert.equal(canUseLessonLayoutRepairProof(changed,changed.chapters[0],feedback,proof,renderer),false);}
  assert.equal(canUseLessonLayoutRepairProof(report,report.chapters[0],feedback+'需要改写台词',proof,renderer),false);
  assert.equal(canUseLessonLayoutRepairProof(report,report.chapters[0],feedback,proof,'b'.repeat(64)),false);
  for(const key of ['candidateHash','reviewHash','feedbackHash','integrityHash'] as const){const changed=structuredClone(proof);changed[key]='c'.repeat(64);assert.equal(canUseLessonLayoutRepairProof(report,report.chapters[0],feedback,changed,renderer),false);}
  assert.equal(canUseLessonLayoutRepairProof(report,report.chapters[0],feedback,null,renderer),false);
});

test('semantic, factual, unreviewed and unavailable failures cannot create layout authority',()=>{
  const {report,review}=fixture();
  for(const finding of ['chapter-1：画面把不同事件错误归属，存在信息误导。','chapter-1：旁白与来源事实矛盾，需要改写台词。','chapter-1：图解说明不准确。']){
    const changed=structuredClone(review);changed.semantic!.findings=[finding];assert.deepEqual(createLessonLayoutRepairProofs(report,changed,candidate,renderer),{});
  }
  const passed=structuredClone(review);passed.status='passed';assert.deepEqual(createLessonLayoutRepairProofs(report,passed,candidate,renderer),{});
  const failedFacts=structuredClone(report);failedFacts.factReview!.needsRepair=true;assert.deepEqual(createLessonLayoutRepairProofs(failedFacts,review,candidate,renderer),{});
  assert.deepEqual(createLessonLayoutRepairProofs(report,review,'missing-real-candidate',renderer),{});
  const unavailable=structuredClone(review);unavailable.checks.push({name:'人声响度',passed:false,detail:'未取得实际测量'});assert.deepEqual(createLessonLayoutRepairProofs(report,unavailable,candidate,renderer),{});
});

test('verified layout repair never overrides user requirements or unsupported native content',()=>{
  const {report,review}=fixture(),proof=createLessonLayoutRepairProofs(report,review,candidate,renderer)['chapter-1'],chapter=report.chapters[0],feedback=proof.findings.join('\n');
  for(const prompt of ['必须使用真实现场画面','不要使用模板卡片','按参考图一比一复刻布局','使用自由构图和给定坐标'])assert.equal(nativeLessonFallbackAllowed(prompt,chapter,feedback,{verifiedLayoutRepair:true}),false,prompt);
  const unsupported=structuredClone(chapter);unsupported.visual.kind='formula';unsupported.visual.formula='x²';assert.equal(nativeLessonFallbackAllowed('制作数学图解',unsupported,feedback,{verifiedLayoutRepair:true}),false);
});
