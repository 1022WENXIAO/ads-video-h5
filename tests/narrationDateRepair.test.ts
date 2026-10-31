import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createNarrationDateBaseline,restoreNarrationDateBaseline,assertNarrationRepairDates,narrationCalendarValues} from '../server/narrationDateRepair';
import {lessonSettings,validateLesson} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {runLessonWorkflow} from '../server/lessonWorkflow';
import {withModelSnapshot} from '../server/modelContext';
import {runWithJobSignal} from '../server/jobExecution';
const fixture=JSON.parse(await readFile(new URL('./fixtures/speech-date-repair-20261031.json',import.meta.url),'utf8'));
const now=Date.parse('2026-10-31T00:47:30.397Z');
const chapter=(narration:string)=>({id:'chapter-1',narration});

test('actual date-30 to month-end speech repair is rejected before it can replace the verified script',()=>{
  assert.equal(fixture.source.publishedAt,'2026-10-30T02:18:29.000Z');
  const original=chapter(fixture.originalNarration),replacement=chapter(fixture.replacementNarration),baseline=createNarrationDateBaseline([original]),before=structuredClone({original,replacement,baseline});
  assert.deepEqual(narrationCalendarValues(original.narration,now),[{unit:'月',value:10},{unit:'日',value:30}]);
  assert.deepEqual(narrationCalendarValues(replacement.narration,now),[{unit:'月',value:10},{unit:'日',value:31}]);
  assert.throws(()=>assertNarrationRepairDates(baseline,[replacement],now),/改变了已明确日期.*30.*31.*只修读法/);
  assert.deepEqual({original,replacement,baseline},before,'rejected input and original evidence remain untouched');
  assert.doesNotThrow(()=>assertNarrationRepairDates(baseline,[chapter(original.narration.replace('十月三十日','10 月，30 号'))],now));
});

test('calendar-equivalent month ends and different readings retain the actual date, including leap years',()=>{
  for(const [original,replacement] of [['10月31日','十月最后一天'],['11月30号','十一月最后一日'],['10月30日','十月倒数第二天'],['2028年2月29日','二〇二八年，二月最后一天'],['2028年2月29日','2028 年，2 月 最后一天'],['2月28日','二月最后一天']]){
    assert.doesNotThrow(()=>assertNarrationRepairDates(createNarrationDateBaseline([chapter(original)]),[chapter(replacement)],now),original+' → '+replacement);
  }
  const baseline=createNarrationDateBaseline([chapter('10月30日')]);
  for(const replacement of ['10月31日','十月月底','本月最后一天','十月最后一个交易日','11月30日'])assert.throws(()=>assertNarrationRepairDates(baseline,[chapter(replacement)],now),/改变了已明确日期/);
});

test('actual SDK repair tool rejects the captured date change after restart without overwriting the script or calling media providers',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qingjian-date-repair-sdk-')),work=path.join(dir,'lesson-workflows/case');await mkdir(work,{recursive:true});
  const originalFetch=globalThis.fetch;t.after(async()=>{globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true})});
  const prompt='制作45秒横屏知识图解视频，解释时间与来源的核验',config={id:'controlled',name:'Controlled',kind:'text' as const,provider:'ark',baseUrl:'https://provider.example.invalid',modelId:'controlled-model',apiKey:'controlled-only',enabled:true};
  const references=[{id:'r1',title:'Controlled source',url:'https://source.example.invalid',verification:'primary-page' as const,excerpt:'Controlled fixture for tool enforcement, not factual acceptance.'}];
  const chapters=Array.from({length:3},(_,i)=>({id:'chapter-'+(i+1),title:'时间核验'+i,role:i===0?'hook' as const:i===1?'foundation' as const:'recap' as const,goal:'先核对来源再说明',prerequisites:i?['chapter-'+i]:[],narration:i===0?fixture.originalNarration:'先看来源再做比较。完整信息比猜测更可靠。'.repeat(3),reason:'受控工具恢复夹具',referenceIds:['r1'],claims:[{text:'说明前应检查来源',referenceIds:['r1'],basis:'source' as const}],visual:{kind:'concept' as const,takeaway:'核对来源和时间',items:i===0?[{label:'报道',detail:'核对报道日期',cue:'第一财经'},{label:'事件',detail:'区分事件时间',cue:'英特尔'}]:[{label:'来源',detail:'检查依据',cue:'先看来源'},{label:'边界',detail:'完整表达',cue:'完整信息'}]}}));
  const report=validateLesson({workflowId:'controlled-date-tool',...lessonSettings(prompt),title:'时间与依据',audience:'普通观众',objectives:['核验时间','核验来源'],arc:'来源与边界',chapters,references,limitations:[],presentation:lessonPresentation(prompt),factReview:{score:94,needsRepair:false,findings:[]}},prompt);
  const baseline=createNarrationDateBaseline(report.chapters),script=JSON.stringify(report);await writeFile(path.join(work,'script.json'),script);
  await writeFile(path.join(work,'checkpoint.json'),JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'controlled-owner',prompt,export:true})),requestedAt:now,phase:'script',rendererHash:lessonRendererHash(),report,research:{summary:'Controlled prior research',queries:[],references},repairRequirements:'修稿章节：chapter-1\n本次只修口播读法，保持日期。',narrationDateBaseline:baseline,renders:0}));
  const controller=new AbortController();let decisions=0,mediaCalls=0;const events:any[]=[];
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.stream,true,'no fact reviewer or media provider can run for the rejected script');decisions++;
    const candidate={...structuredClone(report.chapters[0]),narration:fixture.replacementNarration};
    return new Response(`data: ${JSON.stringify({id:'controlled',object:'chat.completion.chunk',created:1,model:config.modelId,choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'controlled-bad-date',type:'function',function:{name:'revise_lesson_script',arguments:JSON.stringify({chapters:[candidate]})}}]},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  };
  await assert.rejects(runWithJobSignal(controller.signal,()=>withModelSnapshot({text:config,understanding:null,audio:{...config,kind:'audio'},image:null},()=>runLessonWorkflow({prompt,config,audioConfig:{...config,kind:'audio'},requestedAt:now,media:[],dataDir:dir,mediaDir:dir,ownerId:'controlled-owner',checkpointKey:'case',export:true,stage:async()=>{},progress:async updates=>{events.splice(0,events.length,...updates);if(events.some(e=>e.tool==='revise_lesson_script'&&e.status==='failed'))controller.abort()},register:async()=>{mediaCalls++;},persist:async()=>{},saveDraft:async draft=>{assert.equal(draft.chapters[0].narration,fixture.originalNarration)},analyze:async()=>{mediaCalls++;throw new Error('Unexpected ASR')},render:async()=>{mediaCalls++;throw new Error('Unexpected render')},review:async()=>{mediaCalls++;throw new Error('Unexpected media review')}}))));
  assert.equal(decisions,1);assert.equal(mediaCalls,0);assert.ok(events.some(e=>e.tool==='revise_lesson_script'&&e.status==='failed'&&/改变了已明确日期/.test(e.detail||'')));
  assert.equal(await readFile(path.join(work,'script.json'),'utf8'),script);const saved=JSON.parse(await readFile(path.join(work,'checkpoint.json'),'utf8'));assert.equal(saved.report.chapters[0].narration,fixture.originalNarration);assert.deepEqual(saved.narrationDateBaseline,baseline);assert.equal(saved.renders,0);
});

test('missing dates stay optional; speech-only repair cannot add or erase an already explicit calendar value',()=>{
  const baseline=createNarrationDateBaseline([chapter('报道说明了新情况，没有明确日期。')]);
  assert.doesNotThrow(()=>assertNarrationRepairDates(baseline,[chapter('这条报道说明了新情况。')],now));
  assert.throws(()=>assertNarrationRepairDates(baseline,[chapter('10月30日发布。')],now),/改变了已明确日期/);
  const dated=createNarrationDateBaseline([chapter('2026年10月30日发布。')]);
  assert.throws(()=>assertNarrationRepairDates(dated,[chapter('十月三十日发布。')],now),/改变了已明确日期/);
  assert.throws(()=>assertNarrationRepairDates(dated,[{id:'renamed',narration:'2026年10月30日发布。'}],now),/保留原章节ID/);
});

test('restart restores the complete date baseline and corrupt snapshots cannot disable the guard',()=>{
  const baseline=createNarrationDateBaseline([chapter(fixture.originalNarration)]),restored=restoreNarrationDateBaseline(JSON.parse(JSON.stringify(baseline)));
  assert.deepEqual(restored,baseline);assert.throws(()=>assertNarrationRepairDates(restored,[chapter(fixture.replacementNarration)],now),/改变了已明确日期/);
  const bad=structuredClone(baseline);bad.chapters[0].narration=fixture.replacementNarration;assert.throws(()=>restoreNarrationDateBaseline(bad),/基线损坏/);assert.equal(restoreNarrationDateBaseline(undefined),undefined);
});
