import test from 'node:test';
import assert from 'node:assert/strict';
import type { HotTopicSignal, LessonReport } from '../src/types';
import { newsObservationFindings } from '../server/newsTime';

// Exact public signal and original request cutoff from the cb36 release run;
// no current-time substitution, model calls or alterations to source records.
const requestedAt=1792019165210;
const signal={id:'baidu-13',title:'成都警方通报女子持U型锁打人',source:'baidu',rank:13,observedAt:'2026-10-14T23:06:06.161Z'} as HotTopicSignal;
const report=(text:string):LessonReport=>({title:'热榜观察',hotResearch:{asOf:'2026-10-14T23:06:05.913Z',windowHours:24,signals:[signal]},chapters:[{id:'chapter-1',title:'两个日期要看清',narration:'这里只记录本次榜单快照。',claims:[],visual:{takeaway:'榜单观察时间与报道日期分开',items:[{label:'热搜快照：非报道时间',detail:text,cue:'榜单快照',illustration:'bar-chart'}]}}],references:[]} as unknown as LessonReport);

test('actual cb36 visual denial is not an affirmative first-entry claim; original time and signal stay immutable',()=>{
  const actual=report('北京时间10月15日07:06:06，百度热搜第13位；非首次上榜时间'),before=JSON.stringify(actual);
  assert.deepEqual(newsObservationFindings(actual,requestedAt),[]);assert.equal(JSON.stringify(actual),before);
  for(const text of ['非首次上榜时间','非首度上榜','非第一次登上热搜','这并非首次上榜时间','不是首次上榜时间','这次快照不能证明首次上榜时间'])assert.deepEqual(newsObservationFindings(report(text),requestedAt),[],text);
});

test('local non-entry denial cannot hide an affirmative after contrast or a second predicate',()=>{
  for(const text of [
    '非首次上榜时间，但首次上榜发生于10月15日07:06:06',
    '非首次上榜时间。不过该话题刚刚登上热搜。',
    '非首次上榜时间，随后它首次登榜',
    '非首次上榜时间它今天首次上榜',
    '非非首次上榜时间',
    '非并非首次上榜时间',
    '不是非首次上榜时间',
  ])assert.ok(newsObservationFindings(report(text),requestedAt).length,text);
});

test('non-subject attributes and non-predicate uses do not negate an affirmative entry',()=>{
  for(const text of [
    '非机动车新闻首次上榜',
    '非原创报道首次上榜',
    '非首次发布的模型首次登上热搜',
    '非公开的消息刚刚进入热榜',
    '这条非常热门的新闻首次上榜',
    '这条不是谣言的新闻首次上榜',
  ])assert.ok(newsObservationFindings(report(text),requestedAt).length,text);
});

test('denied onset does not excuse a separate incorrect snapshot date or clock',()=>{
  for(const text of [
    '北京时间10月14日07:06:06，百度热搜第13位；非首次上榜时间',
    '北京时间10月15日23:06:06，百度热搜第13位；非首次上榜时间',
    '北京时间10月15日07:06:07，百度热搜第13位；非首次上榜时间',
    '首次上榜时间',
  ])assert.ok(newsObservationFindings(report(text),requestedAt).length,text);
});

test('a source denying a dated or clocked first entry cannot prove the opposite affirmative script',()=>{
  for(const time of ['10月14日','2026年10月14日13:44','10月14日13:44:06','十月十四日下午一点四十四分六秒']){
    const affirmative=`${time}首次登上百度热搜`;
    for(const denial of ['非','并非']){
      const draft=report('');draft.chapters[0].narration=affirmative;
      draft.references=[{id:'actual-page',verification:'news-page',freshness:'fresh',excerpt:`该消息${denial}${affirmative}。`} as LessonReport['references'][number]];
      const original=JSON.stringify(draft);
      assert.ok(newsObservationFindings(draft,requestedAt).length,`${denial}/${time}`);
      assert.equal(JSON.stringify(draft),original,'the actual source and original signal remain unchanged');
      draft.chapters[0].narration=`该消息${denial}${affirmative}`;draft.references=[];
      assert.deepEqual(newsObservationFindings(draft,requestedAt),[],`a narrow denied entry is not itself an unsupported affirmative: ${denial}/${time}`);
    }
    const positive=report('');positive.chapters[0].narration=affirmative;
    positive.references=[{id:'actual-page',verification:'news-page',freshness:'fresh',excerpt:`该消息${affirmative}。`} as LessonReport['references'][number]];
    assert.deepEqual(newsObservationFindings(positive,requestedAt),[],`a truly affirmative exact body quote still proves ${time}`);
  }
});

test('dated bare 非 stays local to the predicate and never negates a subject property or another entry',()=>{
  for(const text of [
    '非10月14日首次上榜，但10月14日首次登上百度热搜',
    '非10月14日首次上榜10月14日首次登上百度热搜',
    '非非10月14日首次登上百度热搜',
    '非并非10月14日13:44:06首次登上百度热搜',
    '非机动车10月14日首次登上百度热搜',
  ])assert.ok(newsObservationFindings(report(text),requestedAt).length,text);
  const affirmative='10月14日首次登上百度热搜';
  for(const prefix of ['非10月14日，','非10月14日但','非机动车','非非']){
    const draft=report('');draft.chapters[0].narration=affirmative;
    draft.references=[{id:'actual-page',verification:'news-page',freshness:'fresh',excerpt:`该消息${prefix}${affirmative}。`} as LessonReport['references'][number]];
    assert.deepEqual(newsObservationFindings(draft,requestedAt),[],`the matched source predicate is actually affirmative: ${prefix}`);
  }
});
