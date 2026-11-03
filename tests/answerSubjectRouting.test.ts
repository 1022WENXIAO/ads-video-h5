import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,lessonRequest,wantsConversation} from '../server/intents';
import {inferCreationRoute} from '../server/creativeRequest';

const actual='帮我做一条新闻短讯。请选最近24小时内真实媒体报道的一条热点新闻，只回答一个问题：这篇报道实际发布当天，最值得公众注意的确认信息是什么？画面上要标明真实报道日期；如果事件发生在更早时间，也把事件日期和报道日期分开标。没被证实的内容不要当成定论。\n做成30秒竖屏视频，配音和字幕，画面用动态示意，给我可以播放的成片。内容讲最近24小时报道的一条真实热点，并在画面上标明实际报道日期。';

test('actual release news brief constrains the subject to one question and still authorizes the explicitly requested movie',()=>{
  assert.equal(wantsConversation(actual),false);
  assert.equal(classify(actual),'export');assert.equal(lessonRequest(actual,[]),actual);
  const route=inferCreationRoute({prompt:actual,history:[],sourceCount:0,hasPlan:false})!;
  assert.equal(route.mode,'news');assert.equal(route.export,true);assert.equal(route.lessonPrompt,actual);
});

test('a separate positive production clause works with duration/format and ordinary content questions',()=>{
  for(const action of ['做成30秒竖屏视频，配音和字幕。','制作一条新闻短片。','请生成一个30秒视频。','剪成20秒视频。']){
    const prompt='只回答一个问题：这条新闻确认了什么？'+action;
    assert.equal(wantsConversation(prompt),false,prompt);assert.equal(classify(prompt),'export',prompt);
  }
});

test('answer-only advice, quoted commands and explicit prohibitions do not start production',()=>{
  for(const prompt of [
    '只回答一个问题：怎么制作30秒视频？',
    '只回答一个问题。做成30秒视频需要什么？',
    '只回答一个问题。不要做成30秒视频。',
    '只回答一个问题。暂不制作一条新闻视频。',
    '只回答一个问题。“做成30秒视频”是什么意思？',
    '只回答一个问题：他为什么说“做成30秒竖屏视频，配音和字幕”？',
    '只回答一个问题：“先查证。做成30秒视频。”这句话是什么意思？',
    '只回答一个问题："先查证。制作一条新闻视频。"这句话是什么意思？',
    '只回答新闻问题。制作一条新闻视频。不要制作视频，只讨论方案。',
  ]){
    assert.equal(wantsConversation(prompt),true,prompt);assert.equal(classify(prompt),'plan',prompt);
    const route=inferCreationRoute({prompt,history:[],sourceCount:0,hasPlan:false})!;
    assert.equal(route.mode,'conversation',prompt);assert.equal(route.export,false,prompt);
  }
});
