import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {assertLessonScriptBudget,assertLessonNewsSources,lessonScriptBudget,lessonScriptBudgetInstruction,lessonPacing} from '../server/lessonSpec';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {ARK_BASE_URL,TEXT_MODEL_PRESETS} from '../shared/textModels';
import type {LessonChapter,LessonReport,ResearchReference,WorkflowEvent} from '../src/types';

const replay=JSON.parse(readFileSync(new URL('./fixtures/lesson-script-p8-feedback.json',import.meta.url),'utf8')) as {
  budget:ReturnType<typeof lessonScriptBudget>;references:ResearchReference[];attempts:Array<{attempt:number;chapters:Array<Pick<LessonChapter,'id'|'narration'|'referenceIds'>>}>;
};
const chapters=(index:number)=>structuredClone(replay.attempts[index].chapters) as LessonChapter[];

test('actual P8 draft projections expose chapter count plus all excess, and target/current/max deltas',()=>{
  assert.throws(()=>assertLessonScriptBudget(chapters(0),replay.budget),error=>{
    const detail=String(error);assert.match(detail,/已分配3章.*实际提交4章/);assert.match(detail,/ch2：当前97字，目标68字，上限77字/);assert.match(detail,/建议删减29字.*至少须删减20字/);return true;
  });
  assert.throws(()=>assertLessonScriptBudget(chapters(1),replay.budget),/ch1：当前92字，目标68字，上限77字；建议删减24字.*至少须删减15字/);
  assert.throws(()=>assertLessonScriptBudget(chapters(2),replay.budget),/ch1：当前79字，目标68字，上限77字；建议删减11字.*至少须删减2字/);
  assert.doesNotThrow(()=>assertLessonScriptBudget(chapters(3),replay.budget));
  assert.doesNotThrow(()=>assertLessonScriptBudget(chapters(4),replay.budget));
  const simultaneous=[chapters(1)[0],...chapters(0).slice(1)],before=structuredClone(simultaneous);
  assert.throws(()=>assertLessonScriptBudget(simultaneous,replay.budget),error=>{assert.match(String(error),/实际提交4章/);assert.match(String(error),/ch1：当前92字/);assert.match(String(error),/ch2：当前97字/);return true;});
  assert.deepEqual(simultaneous,before,'feedback does not truncate narration or remove chapters');
});

function sourceReport(index:number):Pick<LessonReport,'chapters'|'references'|'hotResearch'>{
  const draft=chapters(index),ids=new Set(draft.flatMap(chapter=>chapter.referenceIds));
  // The retained rejected claims were depth-redacted. These controlled bindings
  // test the source gate, using the actual retained chapter IDs, not invented facts.
  for(const chapter of draft)chapter.claims=[{text:'Controlled source-binding probe',referenceIds:[...chapter.referenceIds]}];
  return {chapters:draft,references:structuredClone(replay.references.filter(ref=>ids.has(ref.id))),hotResearch:{asOf:'2026-10-14T20:53:14.914Z',expiresAt:'2026-10-14T21:23:14.914Z',windowHours:24,signals:[],topics:[],failures:[]}};
}
test('P8 fresh-reference gap reports trusted candidates without attaching them or pretending research is missing',()=>{
  const report=sourceReport(3),before=structuredClone(report);
  assert.throws(()=>assertLessonNewsSources(report,replay.references),error=>{
    const detail=String(error);assert.match(detail,/事实声明未实际引用/);assert.match(detail,/ref-1/);assert.match(detail,/ref-4/);assert.match(detail,/undated/);assert.match(detail,/ref-2/);assert.match(detail,/ref-5/);assert.match(detail,/谷歌 Gemini 4 Argon/);assert.match(detail,/2026-10-13T23:16:00/);assert.match(detail,/claim.referenceIds/);assert.doesNotMatch(detail,/缺少服务端.*研究记录/);return true;
  });
  assert.deepEqual(report,before,'hints must not silently attach a source or rewrite a fact');
  assert.doesNotThrow(()=>assertLessonNewsSources(sourceReport(4),replay.references));
});
test('missing trusted research is distinct, and a chapter-only fresh reference cannot bypass actual claims',()=>{
  const missing=sourceReport(4);missing.hotResearch=undefined;
  assert.throws(()=>assertLessonNewsSources(missing,replay.references),/缺少服务端已核验的热点研究记录.*research_topic/);
  const attachedOnly=sourceReport(4);for(const chapter of attachedOnly.chapters)chapter.claims=chapter.claims.map(claim=>({...claim,referenceIds:claim.referenceIds.filter(id=>id!=='ref-2')}));
  assert.throws(()=>assertLessonNewsSources(attachedOnly,replay.references),/不能只给章节附加来源/);
});

const prompt='制作45秒横屏知识图解视频，解释预测误差如何评分，先给脚本';
const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'feedback-test-no-live-credential'};
function toolResponse(name:string,args:unknown,sequence:number){
  return new Response(`data: ${JSON.stringify({id:'feedback-test',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'feedback-'+sequence,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
}
async function workflowSetup(){
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-script-feedback-')),work=path.join(directory,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const owner='feedback-fixture',fingerprint=createHash('sha256').update(JSON.stringify({version:1,owner,prompt,export:false})).digest('hex');
  const references=[{id:'r1',title:'Controlled primary source',url:'https://arxiv.org/abs/1708.02001',verification:'primary-page',excerpt:'Controlled fixture about error magnitude and scoring; no live research.'}];
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint,phase:'budget',research:{summary:'Controlled script feedback fixture',references,queries:[]},researchRounds:1}));
  const draft:LessonChapter[]=Array.from({length:3},(_,i)=>({id:'c'+i,title:'误差评分'+i,role:i===0?'hook':i===1?'foundation':'recap',goal:'理解误差与评分',prerequisites:i?['c'+(i-1)]:[],narration:'误差变大损失越高。'.repeat(7),reason:'先例子再归纳',referenceIds:['r1'],claims:[{text:'误差影响评分',referenceIds:['r1']}],visual:{kind:'concept',takeaway:'误差影响评分',items:[{label:'误差',detail:'预测与实际的差',cue:'误差变大'},{label:'评分',detail:'为偏差计分',cue:'损失越高'}]}}));
  const events:WorkflowEvent[]=[];
  const options={prompt,config,audioConfig:null,media:[],dataDir:directory,mediaDir:directory,ownerId:owner,checkpointKey:'case',export:false,analyze:async()=>{throw new Error('Script test must not analyze audio');},register:async()=>{throw new Error('Script test must not create media');},persist:async()=>{throw new Error('Script test must not create a timeline');},saveDraft:async()=>{},progress:async(next:WorkflowEvent[])=>{events.splice(0,events.length,...structuredClone(next));},render:async()=>{throw new Error('Script test must not render');},review:async()=>{throw new Error('Script test must not review media');}};
  return {directory,draft,options,events};
}
test('actual write and partial-repair requests share one allocated budget across stage, tool and schema',async()=>{
  const fixture=await workflowSetup(),original=globalThis.fetch,budget=lessonScriptBudget(45,lessonPacing(prompt),3),instruction=lessonScriptBudgetInstruction(budget);let writes=0,revisions=0,reviews=0;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    if(!body.stream){reviews++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(reviews===1?{score:75,needsRepair:true,findings:['c1：受控示例需要修正。']}:{score:92,needsRepair:false,findings:[]})}}]}));}
    const name=body.tool_choice.function.name;assert.ok(['write_lesson_script','revise_lesson_script'].includes(name));
    const tool=body.tools[0].function,system=JSON.stringify(body.messages.filter((message:any)=>message.role==='system'));
    assert.ok(system.includes(instruction));assert.ok(tool.description.includes(instruction));assert.doesNotMatch(tool.description,/建议3[–-]5章|建议8[–-]12章/);
    assert.equal(tool.parameters.properties.chapters.minItems,name==='write_lesson_script'?3:1);assert.equal(tool.parameters.properties.chapters.maxItems,name==='write_lesson_script'?3:undefined);
    assert.match(tool.parameters.properties.chapters.items.properties.narration.description,new RegExp(`约${budget.perChapterTarget}字.*最多${budget.perChapterMaximum}`));
    assert.match(tool.parameters.properties.chapters.items.properties.visual.description,/comparison.*多个items\.illustration=bar-chart.*必须同时提供barChart/);
    assert.ok(JSON.stringify(body.messages).includes(`总旁白约${budget.totalCharacters}字`));
    if(name==='write_lesson_script'){writes++;return toolResponse(name,{title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters:fixture.draft},writes);}
    revisions++;assert.match(tool.description,/只提交审查反馈涉及/);return toolResponse(name,{chapters:[{...fixture.draft[1],narration:'误差变大损失越高。'.repeat(6)+'这是修正后的示例。'}]},writes+revisions);
  };
  try{const result=await runLessonWorkflow(fixture.options);assert.equal(result.report.factReview?.score,92);assert.equal(writes,1);assert.equal(revisions,1);assert.equal(reviews,2);assert.deepEqual(result.report.chapters[0],fixture.draft[0]);assert.deepEqual(result.report.chapters[2],fixture.draft[2]);assert.notEqual(result.report.chapters[1].narration,fixture.draft[1].narration);assert.equal(result.rendered,undefined);}
  finally{globalThis.fetch=original;await rm(fixture.directory,{recursive:true,force:true});}
});
test('the unchanged six-attempt cap still ends invalid script submissions without paid media work',async()=>{
  const fixture=await workflowSetup(),original=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.stream,true);calls++;return toolResponse('write_lesson_script',{title:'误差评分',audience:'初学者',objectives:['理解误差','理解评分'],arc:'先误差再评分',chapters:fixture.draft.slice(0,2)},calls);};
  try{await assert.rejects(()=>runLessonWorkflow(fixture.options),/修正超过6次/);assert.equal(calls,7);assert.equal(fixture.events.filter(event=>event.tool==='write_lesson_script'&&event.status==='failed').length,7);assert.ok(!fixture.events.some(event=>event.tool==='synthesize_narration'));}
  finally{globalThis.fetch=original;await rm(fixture.directory,{recursive:true,force:true});}
});
