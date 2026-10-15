import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateSemanticReview} from '../server/reviewResults';
import {requestSemanticReview} from '../server/semanticReview';
import {filterIdenticalSpellingFindings,numericVisualFindings,parseNumericVisualChecks,NUMERIC_VISUAL_REVIEW_INSTRUCTION} from '../server/visualReviewEvidence';
import {lessonRepairPlan} from '../server/visualRecovery';
import type {ModelConfig} from '../server/modelRegistry';
import type {RenderReview,LessonReport} from '../src/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p19-visual-review-evidence.json',import.meta.url),'utf8'));
const good={score:99,needsRepair:false,findings:[],suggestions:[]};
const config={id:'fixture',kind:'understanding',provider:'test',modelId:'fixture',baseUrl:'https://example.invalid/v1',apiKey:'fixture',enabled:true} as ModelConfig;
const response=(value:unknown)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}),{headers:{'Content-Type':'application/json'}});

test('actual P19 same-string typo allegation is removed locally while its orphan glyph and raw72 remain',()=>{
  const before=structuredClone(actual.originalSemantic);
  const result=validateSemanticReview({...actual.originalSemantic,needsRepair:true});
  assert.equal(result.score,72);assert.equal(result.needsRepair,true);
  assert.equal(result.findings.length,4);assert.match(result.findings[2],/“径”字孤字换行/);
  assert.doesNotMatch(result.findings[2],/将来源名“ShShell”误写为“ShShell”/);
  assert.equal(result.discardedFindings?.[0].original,actual.originalSemantic.findings[2]);
  assert.deepEqual(actual.originalSemantic,before);
});

test('local typo filtering preserves unrelated fact/date/speech defects without a defect-word whitelist',()=>{
  for(const suffix of ['报道与事实不符。','来源引用错误。','实际日期是10月14日，与来源10月15日矛盾。','旁白漏了一个字。','另有未说明的实质矛盾。']){
    const original='chapter-1：将“ShShell”误写为“ShShell”，'+suffix;
    const filtered=filterIdenticalSpellingFindings([original]);
    assert.ok(filtered.findings[0].includes(suffix.replace(/。$/,'')),suffix);
  }
  const genuine='chapter-1：将“ShShell”误写为“ShShell”，将“Liquid”误写为“Liqiud”。';
  assert.match(filterIdenticalSpellingFindings([genuine]).findings[0],/将“Liquid”误写为“Liqiud”/);
  const denial='chapter-1：并非将“ShShell”误写为“ShShell”，实际来源日期有误。';
  assert.deepEqual(filterIdenticalSpellingFindings([denial]),{findings:[denial],discarded:[]});
  assert.deepEqual(filterIdenticalSpellingFindings(['chapter-1：将“ShShell”误写为“Shshell”。']).findings,['chapter-1：将“ShShell”误写为“Shshell”。']);
});

test('a sole invalid allegation preserves raw score and needsRepair, even above80',()=>{
  for(const score of [72,95]){
    const r=validateSemanticReview({score,needsRepair:true,findings:['chapter-2：将“ShShell”误写为“ShShell”，属于渲染拼写错误。'],suggestions:[]});
    assert.equal(r.score,score);assert.equal(r.needsRepair,true);assert.deepEqual(r.findings,[]);assert.equal(r.discardedFindings?.length,1);
  }
});

test('actual P19 top4 label and three observed paths create a chapter-local redraw finding',()=>{
  const before=structuredClone(actual.numericCheck);
  const checks=parseNumericVisualChecks([actual.numericCheck]);
  const findings=numericVisualFindings(checks,actual.context);
  assert.equal(findings.length,1);assert.match(findings[0],/chapter-2.*标注4个.*仅3个.*重绘图解/);
  assert.deepEqual(actual.numericCheck,before);
  const report={chapters:[{id:'chapter-1'},{id:'chapter-2'},{id:'chapter-3'}],factReview:{score:95,needsRepair:false,findings:[]}} as unknown as LessonReport;
  const plan=lessonRepairPlan(report,{status:'needs-review',score:99,checks:[{name:'成片语义审查',passed:false,detail:findings[0]}],semantic:{score:99,findings}} as RenderReview);
  assert.deepEqual(plan.visualChapterIds,['chapter-2']);assert.deepEqual(plan.scriptChapterIds,[]);
});

test('optional count schema is legacy compatible but invalid/inconsistent observations fail closed',()=>{
  assert.equal(validateSemanticReview(good).numericVisualChecks,undefined);
  assert.deepEqual(numericVisualFindings(parseNumericVisualChecks([])),[]);
  for(const patch of [{observedEvidence:''},{chapterId:''},{frameTime:NaN},{expectedCount:3,observedCount:3},{observedCount:-1},{observedCount:2.5},{claim:'top–4路由',expectedCount:5},{claim:'选择4个专家',expectedCount:3,observedCount:3},{claim:'激活4条路径',expectedCount:3,observedCount:3}])assert.throws(()=>parseNumericVisualChecks([{...actual.numericCheck,...patch}]),/数字图解/);
  assert.throws(()=>parseNumericVisualChecks(Array(25).fill(actual.numericCheck)),/24项/);
  assert.throws(()=>numericVisualFindings([actual.numericCheck]),/未绑定/);
  for(const patch of [{chapterId:'chapter-1'},{frameTime:23.1901},{frameTime:30}])assert.throws(()=>numericVisualFindings([{...actual.numericCheck,...patch}],actual.context),/章节或时点/);
  assert.throws(()=>numericVisualFindings([actual.numericCheck],{...actual.context,chapters:[{id:'chapter-2',start:NaN,end:29.22}]}),/章节或时点/);
  assert.throws(()=>numericVisualFindings([actual.numericCheck,{...actual.numericCheck,observedCount:4}],actual.context),/冲突/);
  assert.deepEqual(numericVisualFindings([{...actual.numericCheck,observedCount:4}],actual.context),[]);
});

test('controlled actual P19 movie frame payload cannot pass99 when its bound count observation contradicts the label',async t=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let calls=0;
  const bytes=await readFile(new URL('./fixtures/p19-route-count-frame.png',import.meta.url));
  const data='data:image/png;base64,'+bytes.toString('base64');
  globalThis.fetch=(async(_url,options)=>{calls++;const body=JSON.parse(String(options?.body));assert.match(JSON.stringify(body.messages),/numericVisualChecks/);assert.ok(JSON.stringify(body.messages).includes(data));return response({...good,numericVisualChecks:[actual.numericCheck]});}) as typeof fetch;
  const result=await requestSemanticReview(config,[{role:'user',content:[{type:'text',text:NUMERIC_VISUAL_REVIEW_INSTRUCTION},{type:'image_url',image_url:{url:data}}]}],undefined,false,actual.context);
  assert.equal(calls,1);assert.equal(result.score,99);assert.equal(result.needsRepair,true);assert.match(result.findings[0],/标注4个.*仅3个/);
});

test('unbound frame/chapter evidence consumes only the existing review correction budget',async t=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});let calls=0;
  globalThis.fetch=(async()=>response({...good,numericVisualChecks:[{...actual.numericCheck,chapterId:++calls===1?'wrong':'chapter-2'}]})) as typeof fetch;
  assert.equal((await requestSemanticReview(config,[],undefined,false,actual.context)).needsRepair,true);assert.equal(calls,2);
  calls=0;globalThis.fetch=(async()=>{calls++;return response({...good,numericVisualChecks:[{...actual.numericCheck,frameTime:23.1901}]});}) as typeof fetch;
  await assert.rejects(requestSemanticReview(config,[],undefined,false,actual.context),/章节或时点/);assert.equal(calls,2);
});

test('sole self-identical findings request at most one correction and never promote an unchanged low/high raw verdict',async t=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old;});
  for(const score of [72,95]){let calls=0;const messages:unknown[]=[];globalThis.fetch=(async(_url,options)=>{calls++;const sent=JSON.parse(String(options?.body)).messages;if(calls===1)assert.deepEqual(sent,[]);else {assert.equal(sent.length,1);assert.match(sent[0].content,/原串与目标串逐字相同/);assert.match(sent[0].content,/不要求提高分数/);}return response({score,needsRepair:true,findings:['chapter-2：将“ShShell”误写为“ShShell”。'],suggestions:[]});}) as typeof fetch;
    const result=await requestSemanticReview(config,messages);assert.deepEqual(messages,[]);assert.equal(calls,2);assert.equal(result.score,score);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,[]);assert.equal(result.evidenceAttempts?.length,2);
  }
});
