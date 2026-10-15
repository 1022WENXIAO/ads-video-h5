import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedLessonRepairTargets} from '../server/lessonRepairScope';
import {lessonRepairTargets} from '../server/lessonSpec';
import type {LessonReport} from '../shared/types';

const chapters=[{id:'chapter-1'},{id:'chapter-2'},{id:'chapter-3'}];
test('explicit review chapter3 and ch3 headers resolve to the real unique chapter-3',()=>{
  for(const text of ['chapter3：本版时长与开始时间矛盾。','ch3: 来源不支持该口径。','chapter-3：须删除无依据时长。'])assert.deepEqual(scopedLessonRepairTargets(chapters,text),['chapter-3']);
  assert.deepEqual(scopedLessonRepairTargets(chapters,'chapter-1：文字遮挡；chapter3：来源矛盾'),['chapter-1','chapter-3']);
});
test('ordinary numbers and prose never invent a targeted chapter; ambiguous or unknown headers stay unscoped',()=>{
  for(const text of ['3个多小时有误。','这段说明提到ch3版本。','chapter9：无法确认章节。','chapter-1：文字遮挡；ch9：未知问题。'])assert.deepEqual(scopedLessonRepairTargets(chapters,text),[]);
  assert.deepEqual(scopedLessonRepairTargets([{id:'chapter-3'},{id:'chapter_3'}],'chapter3：有误'),[]);
  assert.deepEqual(scopedLessonRepairTargets([{id:'chapter-3'},{id:'ch3'}],'ch3：有误'),['ch3']);
});
test('custom IDs retain exact token matching and cannot collide with longer IDs',()=>{
  const ids=[{id:'intro'},{id:'intro-extra'},{id:'part.2'}];
  assert.deepEqual(scopedLessonRepairTargets(ids,'intro-extra：重画'),['intro-extra']);
  assert.deepEqual(scopedLessonRepairTargets(ids,'part.2：核对来源'),['part.2']);
});
test('workflow target selection keeps an explicit corrected header local and global or unknown issues conservative',()=>{
  const report={chapters} as unknown as LessonReport;
  assert.deepEqual(lessonRepairTargets(report,'chapter3：本版的时长与实际来源矛盾。'),['chapter-3']);
  assert.deepEqual(lessonRepairTargets(report,'全片需要修复；chapter3：时长错误。'),chapters.map(chapter=>chapter.id));
  assert.deepEqual(lessonRepairTargets(report,'chapter-1：重画；chapter9：无法定位的事实问题。'),chapters.map(chapter=>chapter.id));
});
