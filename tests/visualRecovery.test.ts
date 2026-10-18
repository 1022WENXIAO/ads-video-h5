import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { LessonChapter, LessonReport, RenderReview } from '../src/types';
import { authorDrawing, drawingHtml, validateDrawing, type HtmlDrawing } from '../server/narrativeScenes';
import { lessonRepairPlan,visualRepairTargets,speechOnlyRepair,lessonVisualBrief } from '../server/visualRecovery';
import { validateLessonVisual } from '../server/lessonSpec';
import { assertVisibleContent } from '../server/visibleContent';

test('a landscape diagram uses the requested canvas and protects the subtitle area',()=>{
  const drawing:HtmlDrawing={title:'柱长示意',nodes:[{id:'axis',kind:'line',x:100,y:460,w:1000,h:0,text:'',tone:'ink',fontSize:24,highlight:false},{id:'bar',kind:'path',pathData:'M300 460V220H400V460Z',x:300,y:220,w:100,h:240,text:'',tone:'blue',fontSize:24,highlight:true},{id:'label',kind:'text',x:290,y:465,w:240,h:70,text:'甲 40分',tone:'ink',fontSize:32,highlight:false}]};
  assert.doesNotThrow(()=>validateDrawing(drawing,'16:9'));
  assert.throws(()=>validateDrawing(drawing,'9:16'),/安全区/);
  assert.throws(()=>validateDrawing({...drawing,nodes:drawing.nodes.map(n=>n.id==='label'?{...n,y:610}:n)},'16:9'),/安全区/);
  const html=drawingHtml(drawing,6,'16:9');
  assert.match(html,/data-width="1280" data-height="720"/);
  assert.match(html,/viewBox="0 0 1280 720"/);
  assert.match(html,/M300 460V220H400V460Z/);
  assert.match(html,/甲 40分/);
  for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))assert.doesNotThrow(()=>new Function(script[1]));
});

test('only a verified visual rendering defect can preserve the script during repair',()=>{
  const report={chapters:[{id:'c0'},{id:'c1'},{id:'c2'}],factReview:{score:95,needsRepair:false,findings:[]}} as LessonReport;
  const rejected=(findings:string[]):RenderReview=>({status:'needs-review',score:85,checks:[{name:'成片语义审查',passed:false,detail:findings.join(';')}],semantic:{score:85,findings,suggestions:[]},limitations:[],createdAt:''});
  assert.deepEqual(visualRepairTargets(report,rejected(['c1：没有出现柱状图，配图为无关图标'])),['c1']);
  const visualOmission=rejected(['c1：旁白清晰说出术语，但对应章节所有抽帧均未出现底部摘要提示条，存在重要信息视觉遗漏。']);
  assert.deepEqual(visualRepairTargets(report,visualOmission),['c1']);
  assert.equal(speechOnlyRepair(visualOmission),false,'a visual omission must not trigger another voice recording');
  assert.deepEqual(visualRepairTargets(report,rejected(['全局：静态卡片未呈现实际示意图'])),['c0','c1','c2']);
  for(const finding of ['c0：图解说明不准确','c0：字幕错误，图标无关','c0：数据错误，柱状图错误','c0：音色漂移'])assert.deepEqual(visualRepairTargets(report,rejected([finding])),[]);
  assert.deepEqual(visualRepairTargets({...report,factReview:{score:70,needsRepair:true,findings:['事实未核验']}},rejected(['全局：配图无关'])),[]);
});

test('captured card attribution and editorial-copy findings redraw verified visuals without reclassifying factual or spoken errors',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/visual-review-misattribution.json',import.meta.url),'utf8')) as {firstReview:RenderReview;repairedReview:RenderReview};
  const report={chapters:[{id:'ch1'},{id:'ch2'},{id:'ch3'},{id:'ch30'}],factReview:{score:93,needsRepair:false,findings:[]}} as LessonReport;
  assert.deepEqual(visualRepairTargets(report,fixture.firstReview),['ch3']);
  assert.deepEqual(visualRepairTargets(report,fixture.repairedReview),['ch1','ch2','ch3']);
  assert.equal(speechOnlyRepair(fixture.firstReview),false);assert.equal(speechOnlyRepair(fixture.repairedReview),false);
  for(const [finding,expected] of [['ch30：画面卡片信息归属错误',['ch30']],['ch3：旁白本身准确，但画面卡片信息归属错误',['ch3']]] as const)assert.deepEqual(visualRepairTargets(report,{...fixture.firstReview,semantic:{...fixture.firstReview.semantic!,findings:[finding]}}),expected);
  for(const finding of ['ch3：旁白与来源矛盾，卡片同样造成误导','ch3：事实错误，画面将旧事件当成新事件','ch3：旁白不准确，画面也有合并问题','ch3：字幕漏字，卡片缺失']) {
    const review={...fixture.firstReview,semantic:{...fixture.firstReview.semantic!,findings:[finding]}};
    assert.deepEqual(visualRepairTargets(report,review),[],'uncertain or actual spoken/factual faults must retain full repair');
  }
});

test('visible copy rejects private editing commands while keeping ordinary negative teaching explanations',()=>{
  for(const text of ['不与零相乘','不要把相关当因果','尚无证据证明两者存在因果关系','请勿相信未经核实的说法'])assert.doesNotThrow(()=>assertVisibleContent([text]));
  const leaked='警方明确列入谣言，不与任何人的处理原因合并';
  assert.throws(()=>validateLessonVisual({kind:'concept',takeaway:'保留事实边界',items:[{label:'已核验',detail:leaked,cue:'核验'},{label:'未知',detail:'仍待来源确认',cue:'来源'}]},'核验事实与来源'),/内部制作或返修指令/);
  const drawing:HtmlDrawing={title:'事实边界',nodes:[{id:'one',kind:'card',x:70,y:180,w:300,h:120,text:'经查证的说法',tone:'blue',fontSize:24,highlight:false},{id:'two',kind:'text',x:400,y:180,w:650,h:140,text:leaked,tone:'ink',fontSize:24,highlight:false},{id:'link',kind:'line',x:370,y:240,w:30,h:0,text:'',tone:'ink',fontSize:24,highlight:false}]};
  assert.throws(()=>validateDrawing(drawing,'16:9'),/内部制作或返修指令/);
  assert.throws(()=>drawingHtml(drawing,8,'16:9'),/内部制作或返修指令/,'rejected editorial copy cannot reach the renderer');
});

test('a drawing retry keeps verified audience facts separate from rejected prior copy and never renders repair instructions',async t=>{
  const chapter={id:'ch1',title:'观察与推测',goal:'区分已知与未知',narration:'看到颜色变化是观察，原因仍要核验。',claims:[{text:'观察不能单独确定原因',referenceIds:['r1']}],referenceIds:['r1'],reason:'先观察再解释',visual:{kind:'concept',takeaway:'保留事实边界',items:[{label:'旧标签',detail:'错误合并的原因',cue:'观察'},{label:'原因',detail:'仍需核验',cue:'原因'}]}} as LessonChapter;
  const report={chapters:[chapter],references:[{id:'r1',title:'已读来源',excerpt:'观察记录和因果解释分开。'},{id:'unselected',title:'其他来源',excerpt:'不得加入本章的未选材料。'}]} as LessonReport;
  const brief=lessonVisualBrief(report,chapter,'制作知识视频','ch1：卡片合并造成归属误导');
  assert.equal(brief.priorVisual.rejected,true);assert.equal(brief.audienceContent.references.length,1);assert.equal('reviewFeedback' in brief.audienceContent,false);
  assert.equal('goal' in brief.audienceContent,false);assert.equal(brief.internalDesignInstructions.goal,chapter.goal);
  const original=globalThis.fetch;let requests=0;
  const drawing:HtmlDrawing={title:'观察与解释',nodes:[{id:'one',kind:'card',x:70,y:180,w:300,h:120,text:'观察：颜色变化',tone:'blue',fontSize:24,highlight:false},{id:'two',kind:'text',x:400,y:180,w:650,h:140,text:'解释仍需核验',tone:'ink',fontSize:24,highlight:false},{id:'link',kind:'line',x:370,y:240,w:30,h:0,text:'',tone:'ink',fontSize:24,highlight:false}]};
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)),input=JSON.parse(body.messages[1].content);assert.deepEqual(input.design,brief);assert.match(body.messages[0].content,/never invent gender, profession, headcount/);requests++;const output=structuredClone(drawing);if(requests===1)output.nodes[1].text='不与其他卡片合并';return Response.json({choices:[{message:{content:JSON.stringify(output)}}]});};
  t.after(()=>{globalThis.fetch=original;});
  const config={id:'fixture',name:'fixture',kind:'text' as const,modelId:'fixture',provider:'ark',baseUrl:'https://example.invalid',apiKey:'fixture-only',enabled:true};
  const result=await authorDrawing(config,{id:chapter.id,title:chapter.title,line:chapter.narration,mode:'generated',visual:'html',visualBrief:JSON.stringify(brief),role:'argument',reason:chapter.reason,referenceIds:chapter.referenceIds},'16:9');
  assert.equal(requests,2,'existing bounded layout recovery fixes rejected visible copy');assert.deepEqual(result,drawing);assert.doesNotMatch(drawingHtml(result,8,'16:9'),/归属误导|不与其他卡片合并/);
});


test('mixed verified caption separators and scene wrapping target display repair without rerecording all chapters',()=>{
  const report={chapters:[{id:'chapter-1'},{id:'chapter-2'},{id:'chapter-3'}],factReview:{score:95,needsRepair:false,findings:[]}} as LessonReport;
  const findings=['chapter-2：红色文字「不同区域／对角」换行为孤字，单字成行，排版可读性差。','global：全片所有字幕未添加空格分隔并列成分，出现「保持安静干净容易到达」「可能是碗压力或疾病」，需添加分隔标点。'];
  const review={status:'needs-review',checks:[{name:'成片语义审查',passed:false}],semantic:{findings}} as RenderReview;
  const plan=lessonRepairPlan(report,review);
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.scriptChapterIds,[]);assert.deepEqual(plan.visualChapterIds,['chapter-2']);assert.deepEqual(plan.captionChapterIds,['chapter-1','chapter-2','chapter-3']);
  for(const fault of ['字幕数字错误，需要标点分隔','字幕并列成分缺字，需要空格','字幕与来源不一致，需分隔','字幕缺少顿号，但旁白漏读疾病']){
    const result=lessonRepairPlan(report,{...review,semantic:{...review.semantic!,findings:[fault]}});
    assert.equal(result.captionChapterIds,undefined,'formatting cannot hide factual, source or spoken defects');
  }
});
