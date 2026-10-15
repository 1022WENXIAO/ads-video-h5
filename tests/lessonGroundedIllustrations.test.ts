import test from 'node:test';
import assert from 'node:assert/strict';
import {lessonSceneHtml} from '../server/lessonScenes';
import type {LessonChapter,LessonVisual} from '../src/types';

const scene=(items:LessonVisual['items'])=>{
  const chapter:LessonChapter={id:'c',title:'实际对象示意',role:'concept',goal:'保留真实对象',prerequisites:[],referenceIds:[],claims:[],narration:'观察实际对象，说明方法。',reason:'Grounded native fallback regression.',visual:{kind:'concept',takeaway:'画面为示意',items}};
  return lessonSceneHtml(chapter,0,1,6,'9:16');
};

test('unsupported native hints never manufacture an unrelated concrete object',()=>{
  const html=scene([
    {label:'干燥木筷',detail:'筷子表面保持干燥',cue:'观察',illustration:'hardware'},
    {label:'细泡是参考',detail:'具体温度看菜谱',cue:'实际对象',illustration:'thermos'},
    {label:'轻轻入油',detail:'不要丢进油里',cue:'说明',illustration:'interaction'},
  ]);
  for(const token of ['data-component="CPU"','data-illustration="thermos"','data-illustration="interaction"','class="news-illustration"'])assert.ok(!html.includes(token),token);
  for(const text of ['干燥木筷','细泡是参考','具体温度看菜谱','轻轻入油'])assert.ok(html.includes(text));
});

test('grounded objects take precedence and legitimate explicit hints remain usable',()=>{
  const html=scene([
    {label:'显卡和内存',detail:'GPU与RAM配置',cue:'观察',illustration:'thermos'},
    {label:'真空杯壁',detail:'保温结构示意',cue:'实际对象',illustration:'hardware'},
    {label:'消息状态',detail:'核查来源证据',cue:'说明',illustration:'signal'},
  ]);
  for(const token of ['data-component="GPU"','data-component="RAM"','data-illustration="thermos"','data-illustration="signal"'])assert.ok(html.includes(token),token);
  assert.ok(!html.includes('data-component="CPU"'));
});

test('new unsupported topics preserve content without generic object substitution',()=>{
  for(const label of ['清洁玻璃','观察幼苗','调整梯子位置','校对书法笔画']){
    const html=scene([{label,detail:'说明操作和观察条件',cue:'观察',illustration:'hardware'},{label:'下一项',detail:'说明方法',cue:'方法',illustration:'coffee'}]);
    assert.ok(html.includes(label));assert.ok(!html.includes('class="news-illustration"'));assert.ok(!html.includes('data-component="CPU"'));
  }
});
