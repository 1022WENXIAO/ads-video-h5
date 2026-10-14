import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, lessonRequest, reusesFootage, wantsConversation } from '../server/intents';
import { inferCreationRoute, planCreationRoute } from '../server/creativeRequest';

const original = '嗯……帮我从零生成一条生活家电科普视频，主题是南方回南天怎么选除湿机。要用通俗的方式讲清楚除湿量、适用面积、水箱、噪音、干衣模式这些点，最好有对比思路和选购避坑提醒，画面干净清楚，适合新手看完就知道怎么买。';
const oldConstraints = '\n本次制作约束：制作30秒横屏视频，画面由你制作HTML动态图解，带实际配音和字幕。先查证事实，再制作有开场、递进解释和总结的完整内容。直接完成视频、渲染和成片审查。';
const naturalConstraints = '\n做成30秒横屏视频，配音和字幕，画面用动态示意，给我可以播放的成片。';

test('actual release failure and its natural user version reach production instead of chat without a model call', async () => {
  for (const prompt of [original,original + oldConstraints,original + naturalConstraints,original.replace(/[，。……\s]/g,'') + '做成三十秒横屏视频配音和字幕']) {
    assert.equal(wantsConversation(prompt),false); assert.equal(reusesFootage(prompt),false); assert.equal(classify(prompt),'export'); assert.equal(lessonRequest(prompt,[]),prompt);
    const route = await planCreationRoute({prompt,history:[],sourceCount:0,hasPlan:false},async () => {throw new Error('Known science production needs no semantic detour');},async () => {});
    assert.equal(route.mode,'explainer'); assert.equal(route.export,true); assert.equal(route.requiresFootage,false); assert.equal(route.lessonPrompt,prompt);
  }
});
test('demonstratives and nouns in topic descriptions cannot invent a requirement for uploaded footage', () => {
  for (const prompt of [
    '生成30秒科普视频，用通俗方式解释这些概念，画面你来制作。',
    '制作科普视频，解释适用面积、功耗、费用这些点，配音字幕。',
    '制作一条科普视频，说明作用、费用这些概念。',
    '生成科普视频，用动态示意解释以上知识点，不需要现成素材。',
  ]) {
    assert.equal(reusesFootage(prompt),false,prompt);
    assert.equal(inferCreationRoute({prompt,history:[],sourceCount:0,hasPlan:false})?.mode,'explainer',prompt);
  }
  for (const prompt of ['用这些视频做成30秒成片','把以上素材剪成竖屏视频','将这段口播剪成视频','把这两段视频剪成20秒成片','把附加的视频剪成20秒成片','使用上传的视频做一条新闻短片','运用这些片段剪成视频']) {
    assert.equal(reusesFootage(prompt),true,prompt);
    const route = inferCreationRoute({prompt,history:[],sourceCount:2,hasPlan:false}); assert.equal(route?.mode,'footage',prompt);
  }
});

for (const prompt of [
  '麻烦你从零制作一条科普视频，讲怎么做咖啡才不苦，30秒横屏，带配音字幕。',
  '能不能帮我现在从零生成科普视频，主题如何读懂柱状图？做成30秒竖屏成片。',
  '嗯，帮忙重新做一条科普视频，介绍怎样选择家用空气净化器，配音字幕都要。',
  '请你直接制作科普视频，给新手讲怎么做酸奶。成片30秒，横屏。',
  '给我从零做一条教学视频，介绍怎样做收纳，最后给可播放的成片。',
  '替我现在生成一条科普视频，内容是如何制作纸飞机，给儿童看。',
  '帮我从零生成一条科普视频，内容讲为什么这个实验方案有误差。',
  '为我重新生成30秒科普视频，主题怎么制作太阳能小车，配音字幕一起。',
  '制作一条科普视频，主题是怎么选电饭煲。做成30秒横屏，配音字幕。',
  '生成科普视频，讲如何做健康早餐。制作30秒竖屏成片。',
  '来一条生活科普视频，介绍怎么买净水器，做成30秒横屏。',
  '科普视频主题：怎么做冷萃咖啡。制作30秒横屏，配音字幕，交付视频。',
  '科普视频主题是怎样选除湿机；制作30秒横屏成片。',
]) test(`a production topic question retains execution authority: ${prompt}`, () => {
  assert.equal(wantsConversation(prompt),false,prompt); assert.equal(classify(prompt),'export',prompt);
  const route = inferCreationRoute({prompt,history:[],sourceCount:0,hasPlan:false});
  assert.equal(route?.mode,'explainer',prompt); assert.equal(route?.export,true,prompt);
});

for (const prompt of [
  '如何制作一个实时新闻资讯视频？请解释流程。',
  '怎么做一条科普视频？只解释流程。',
  '怎样生成视频，告诉我具体流程，先只讨论。',
  '制作新闻视频是否一定要真人素材？只讨论可行性。',
  '为什么Agent会对“制作一个Fable5.5新闻视频”回复“请先添加素材”？分析原因。',
  '为什么Agent对“帮我从零生成一条科普视频”回复“没有工具”？分析原因。',
  '先不要制作科普视频，我们只聊聊这个想法。',
  '不要生成新视频，解释已有方案就行。',
  '帮我从零制作科普视频，先只解释流程，暂时不生成成片。',
]) test(`workflow questions, quoted failures and explicit discussion stay non-executing: ${prompt}`, () => {
  assert.equal(wantsConversation(prompt),true,prompt); assert.equal(classify(prompt),'plan',prompt);
  const route = inferCreationRoute({prompt,history:[],sourceCount:0,hasPlan:false});
  assert.equal(route?.mode,'conversation',prompt); assert.equal(route?.export,false,prompt);
});
