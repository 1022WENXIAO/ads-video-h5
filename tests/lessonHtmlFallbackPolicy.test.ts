import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeLessonFallbackAllowed } from '../server/lessonHtmlFallbackPolicy';
import type { LessonChapter } from '../shared/types';

const chapter=():LessonChapter=>({id:'ch1',title:'日期核对',role:'hook',goal:'解释日期',prerequisites:[],narration:'先看事件，再看报道。',reason:'按时间顺序解释',referenceIds:[],claims:[],visual:{kind:'timeline',takeaway:'两个日期要分清',items:[{label:'事件日期',detail:'说明事件实际发生时间',cue:'先看事件'},{label:'报道日期',detail:'说明本次公开报道时间',cue:'再看报道'}]}});
test('only complete native concept, timeline and comparison semantics without rejected feedback allow fallback',()=>{
  const input=chapter(),before=structuredClone(input);
  for(const kind of ['concept','timeline','comparison']as const)assert.equal(nativeLessonFallbackAllowed('制作一个新闻视频',{...input,visual:{...input.visual,kind}}),true);
  assert.equal(nativeLessonFallbackAllowed('制作新闻视频',input,'ch1图解把两个日期错误归属'),false);
  for(const kind of ['formula','curve','bar-chart']as const)assert.equal(nativeLessonFallbackAllowed('制作新闻视频',{...input,visual:{...input.visual,kind}}),false);
  for(const changed of [{...input,visual:{...input.visual,items:[input.visual.items[0]]}},{...input,visual:{...input.visual,items:[{...input.visual.items[0],cue:'不存在的旁白'},input.visual.items[1]]}},{...input,visual:{...input.visual,formula:'x+y'}}])assert.equal(nativeLessonFallbackAllowed('制作新闻视频',changed),false);
  assert.deepEqual(input,before);
});
test('explicit freeform, exact reference geometry and unsupported cross-section demands remain constraints',()=>{
  for(const prompt of ['自由布局绘制示意图','使用自定义SVG呈现知识','精确排版按给定坐标','节点位置要与原图完全一致，指定位置','复刻参考图','照着参考画面制作','不要套模板','禁止卡片','别用卡片','必须按我指定的版式','按给定坐标放置所有节点','绘制保温杯剖面，标出热流路径','Use a custom layout','pixel-perfect chart layout','freeform infographic'])assert.equal(nativeLessonFallbackAllowed(prompt,chapter()),false,prompt);
  assert.equal(nativeLessonFallbackAllowed('制作1:1新闻视频，标日期，使用SVG动画和字幕',chapter()),true);
});
test('exact-reference, prohibited slideshow and required real-footage constraints cannot silently become native cards',()=>{
  for(const prompt of ['所有元素的位置都要与原图保持完全一致','布局必须跟原图一模一样','不要做成PPT或幻灯片','Do not use cards or a template; match the reference image exactly.','必须用实拍人群排队的画面，不能只展示示意文字','要求真实实体画面，不允许示意图代替','请用真实人物现场画面','需要实拍视频，不接受示意画面','Use real footage, not illustrations.','No slides please.'])assert.equal(nativeLessonFallbackAllowed(prompt,chapter()),false,prompt);
  for(const prompt of ['生成今天的热点 AI 新闻视频','解释PPT如何制作，按步骤讲清楚','新闻介绍了PowerPoint的新功能','不要漏掉PPT软件的发布日期','Do not omit the PPT release date.','制作知识视频，讲解实拍摄影基础','请展示真实报道日期，画面用明确标注的示意图','不要混淆示意图与实际事实，必须标清楚','介绍事件，用动态示意图讲解，配完整原声','A news explainer about the history of PowerPoint and slideshow software.'])assert.equal(nativeLessonFallbackAllowed(prompt,chapter()),true,prompt);
});
