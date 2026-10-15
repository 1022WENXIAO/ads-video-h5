import test from 'node:test';
import assert from 'node:assert/strict';
import {captionFormattingOnlyRepair} from '../server/visualRecovery';
import type {RenderReview} from '../shared/types';

const finding='chapter-2：实际字幕18.22-22.00秒写作“对话服务和v四点一Flash接口部分中断”，违反方案既定的字幕规范化要求，应规范显示为“V4.1 Flash接口”，避免将口播读法逐字转写为非专业写法。';
const review=(findings:string[]):RenderReview=>({score:88,status:'needs-review',checks:[{name:'成片语义审查',passed:false,detail:findings.join('；')}],semantic:{score:88,findings}});
test('actual P15 version spelling failure may attempt verified caption formatting before script repair',()=>{
  assert.equal(captionFormattingOnlyRepair(review([finding])),true);
  assert.equal(captionFormattingOnlyRepair(review(['chapter-1：字幕出现同音错字，须规范书写。'])),true);
});
test('source conflicts, wrong speech, missing words and mixed content cannot take the spelling-only route',()=>{
  for(const text of ['字幕规范写法应改，但旁白与来源事实矛盾。','字幕版本格式错误，实际旁白的版本与脚本不同。','字幕同音错字同时伴随漏字。','图解文字遮挡。','chapter-2：字幕版本格式有误，同时图解卡片遮挡关键文字。'])assert.equal(captionFormattingOnlyRepair(review([text])),false,text);
  assert.equal(captionFormattingOnlyRepair(review([finding,'chapter-3：来源与旁白事实矛盾。'])),false);
  const measured=review([finding]);measured.checks.push({name:'人声响度',passed:false,detail:'缺少实测'});assert.equal(captionFormattingOnlyRepair(measured),false);
});
