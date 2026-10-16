import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {lessonSceneHtml} from '../server/lessonScenes';
import {lessonIllustrationSubject} from '../server/lessonIllustrationSubjects';
import type {LessonChapter,LessonVisual} from '../src/types';

const incident=JSON.parse(readFileSync(new URL('./fixtures/p38-coffee-native-subjects.json',import.meta.url),'utf8'));
const chapter=(items:LessonVisual['items'],context={title:'实际对象',narration:'说明当前对象。'}):LessonChapter=>({id:'c',...context,role:'concept',goal:'只画有依据的对象',prerequisites:[],referenceIds:[],claims:[],reason:'Controlled semantic illustration regression; no provider or media acceptance.',visual:{kind:'concept',takeaway:'画面为示意',items}});
const html=(c:LessonChapter)=>lessonSceneHtml(c,0,1,8,'9:16');
const item=(label:string,detail:string,illustration:LessonVisual['items'][number]['illustration']='controller')=>({label,detail,cue:'说明',illustration});
const coffeeContext={title:'咖啡机先热身',narration:'家用意式咖啡机预热时，冲煮头、手柄和杯子也需要温度稳定。'};
const gameContext={title:'游戏控制器',narration:'说明GameCube游戏手柄的操作和摇杆布局。'};
const articles=(value:string)=>[...value.matchAll(/<article\b[\s\S]*?<\/article>/g)].map(m=>m[0]);
const objects=(value:string)=>[...value.matchAll(/data-coffee-object="([^"]+)"/g)].map(m=>m[1]).sort();

test('actual P38 first-plan cards render their named coffee components, not game controllers',()=>{
  const original=JSON.stringify(incident),c=chapter(incident.chapter.visual.items,incident.chapter);c.visual.takeaway=incident.chapter.visual.takeaway;
  const output=html(c),cards=articles(output);assert.equal(cards.length,3);
  assert.deepEqual(objects(cards[0]),['cup','portafilter']);
  assert.deepEqual(objects(cards[1]),['group-head','portafilter']);
  assert.deepEqual(objects(cards[2]),['beans','counter','cup','machine']);
  assert.ok(!output.includes('data-illustration="controller"'));assert.ok(!output.includes('data-component="CPU"'));
  assert.ok(!cards[2].includes('data-illustration="desk"'));assert.ok(!cards[2].includes('data-coffee-object="filter"'));
  for(const current of incident.chapter.visual.items)for(const text of [current.label,current.detail])assert.ok(output.includes(text),text);
  assert.equal(JSON.stringify(incident),original,'actual projection and first score64 stay immutable');
});

test('published chapter context resolves locally named metal handles and cups without adding the whole kitchen',()=>{
  const items=[item('手柄先变暖','杯子及金属手柄接触热水，都会吸收一部分热量。','coffee'),item('冲煮头的温度','冲煮头和手柄达到稳定状态。','hardware')];
  const c=chapter(items,coffeeContext),output=html(c);assert.deepEqual(objects(articles(output)[0]),['cup','portafilter']);assert.deepEqual(objects(articles(output)[1]),['group-head','portafilter']);
  for(const absent of ['machine','beans','counter','filter'])assert.ok(!output.includes('data-coffee-object="'+absent+'"'),absent);
  assert.ok(!output.includes('data-illustration="controller"'));
});

test('explicit portafilter, espresso machine and pour-over objects work without Chinese coffee keywords',()=>{
  const c=chapter([item('Portafilter','Preheat the portafilter and cup.','hardware'),item('Espresso machine','The espresso machine is on the countertop.','desk'),item('Pour-over dripper','A dripper holds the paper filter.','coffee')]);
  const cards=articles(html(c));assert.deepEqual(objects(cards[0]),['cup','portafilter']);assert.deepEqual(objects(cards[1]),['counter','machine']);assert.deepEqual(objects(cards[2]),['filter']);
});

test('an ordinary coffee cup wall does not manufacture a vacuum thermos',()=>{
  const cards=articles(html(chapter([item('咖啡杯预热','杯壁接触热水后逐渐升温。','thermos'),item('真空杯壁','保温结构示意。','coffee')],coffeeContext)));
  assert.deepEqual(objects(cards[0]),['cup']);assert.ok(!cards[0].includes('data-illustration="thermos"'));
  assert.ok(cards[1].includes('data-illustration="thermos"'),'explicit existing vacuum structure stays supported');
});

test('isolated and explicitly other-owner handles never establish a game or coffee object',()=>{
  for(const label of ['手柄','金属手柄','摇杆','门把手','螺丝刀手柄','锅的手柄','行李箱手柄','云台摇杆']){
    const value=item(label,'说明这个物件的操作。');const output=html(chapter([value]));assert.ok(!output.includes('class="news-illustration"'),label);
  }
  for(const label of ['门把手','螺丝刀手柄','锅的手柄','行李箱手柄','云台摇杆']){
    const output=html(chapter([item(label,'说明这个物件的操作。')],coffeeContext));assert.ok(!output.includes('class="news-illustration"'),label);
  }
});

test('an explicitly named component owner survives a later short reference and untrusted illustration hints',()=>{
  for(const context of [coffeeContext,gameContext])for(const illustration of ['coffee','controller']as const)for(const [label,detail]of [
    ['螺丝刀手柄','手柄保持干燥。'],['工具手柄','使用后把手柄擦干。'],['相机手柄','手柄连接设备。'],['锅柄','手柄避免接触热源。'],['门把手','手柄保持清洁。'],['咖啡色工具手柄','手柄保持干燥。'],
  ]){
    const value=item(label,detail,illustration),subject=lessonIllustrationSubject(value,context);
    assert.equal(subject.ambiguous,true,label);assert.equal(subject.controller,false,label);assert.deepEqual(subject.coffeeObjects,[],label);
    assert.ok(!html(chapter([value],context)).includes('class="news-illustration"'),label+' / '+illustration+' / '+context.title);
  }
  const coffee=html(chapter([item('咖啡机金属手柄','手柄先预热。','controller')],coffeeContext));
  assert.ok(objects(coffee).includes('portafilter'));assert.ok(!coffee.includes('data-illustration="controller"'));
  const game=html(chapter([item('游戏握把','手柄和摇杆用于控制游戏。','coffee')],gameContext));
  assert.ok(game.includes('data-illustration="controller"'));assert.deepEqual(objects(game),[]);
});

test('a known local owner selects its own component despite the opposite chapter or hint',()=>{
  for(const illustration of ['coffee','controller']as const){
    for(const label of ['冲煮手柄','过滤的金属手柄']){
      const value=item(label,'清洁后保持干燥。',illustration),subject=lessonIllustrationSubject(value,gameContext);
      assert.equal(subject.controller,false);assert.deepEqual(subject.coffeeObjects,['portafilter']);assert.equal(subject.ambiguous,false);
      const output=html(chapter([value],gameContext));assert.deepEqual(objects(output),['portafilter']);assert.ok(!output.includes('data-illustration="controller"'));
    }
    for(const label of ['游戏握把','GameCube控制器']){
      const value=item(label,'手柄保持干燥。',illustration),subject=lessonIllustrationSubject(value,coffeeContext);
      assert.equal(subject.controller,true);assert.deepEqual(subject.coffeeObjects,[]);assert.equal(subject.ambiguous,false);
      assert.ok(html(chapter([value],coffeeContext)).includes('data-illustration="controller"'));
    }
    for(const label of ['过滤手柄与游戏握把','游戏握把与过滤手柄'])assert.ok(!html(chapter([item(label,'分别说明这些物件。',illustration)],coffeeContext)).includes('class="news-illustration"'),'conflicting explicit owners must not choose one');
  }
});

test('real gaming terms or an unambiguous gaming chapter preserve the original controller drawing',()=>{
  for(const c of [chapter([item('GameCube手柄','游戏摇杆与按键布局。','coffee')]),chapter([item('Xbox游戏手柄','说明手柄按键。')]),chapter([item('手柄','按键与摇杆的布局。')],gameContext)]){
    const output=html(c);assert.ok(output.includes('data-illustration="controller"'));assert.ok(output.includes('M39 44Q90 31 141 44L167 99'),'original gamepad silhouette stays');assert.equal(objects(output).length,0);
  }
});

test('negative references and mixed owner contexts do not grant an illustration identity',()=>{
  for(const c of [chapter([item('门把手','不是游戏手柄。')]),chapter([item('金属手柄','说明手柄操作。')],{title:'比较对象',narration:'这里同时比较咖啡机和游戏手柄。'}),chapter([item('游戏手柄与咖啡机','同时介绍两个不同对象。')]),chapter([item('对象','不是咖啡机，而是门把手。','coffee')])]){
    assert.ok(!html(c).includes('class="news-illustration"'));
  }
  const c=chapter([item('金属手柄','不是游戏手柄；手柄用于本章萃取。')],coffeeContext);assert.deepEqual(objects(html(c)),['portafilter']);
});

test('a chapter does not lend unmentioned objects or let a production hint manufacture them',()=>{
  for(const value of [item('观察状态','确认已完成准备。','coffee'),item('清洁玻璃','说明操作和观察条件。','controller')]){
    const s=lessonIllustrationSubject(value,coffeeContext);assert.deepEqual(s.coffeeObjects,[]);assert.equal(s.controller,false);
    const output=html(chapter([value],coffeeContext));assert.equal(objects(output).length,0);assert.ok(!output.includes('data-illustration="controller"'));
  }
  for(const value of [item('GameCube游戏主机','说明游戏主机的外观。'),item('电子游戏','说明游戏流程。')])assert.ok(!html(chapter([value])).includes('data-illustration="controller"'),'a gaming topic does not name a controller');
});
