import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {LessonBarChart,LessonReport,WorkflowEvent} from '../shared/types';
import {bindLessonBarChartEvidence,lessonBarChartGrounding} from '../server/lessonBarChartGrounding';
import {lessonPrecisionSourceHash} from '../server/lessonEvidenceConcordance';
import {validateLesson,lessonSettings} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {lessonRendererHash} from '../server/lessonScenes';
import {hashBytes} from '../server/narrativeScenes';
import {newsSourceParserHash} from '../server/newsSourceVersion';
import {reviewLessonScript,runLessonWorkflow} from '../server/lessonWorkflow';
import {withModelSnapshot} from '../server/modelContext';
import {JobCancelledError,runWithJobSignal,throwIfJobCancelled} from '../server/jobExecution';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p37-chart-source-grounding.json',import.meta.url),'utf8'));
const prompt='用30秒竖屏教学视频解释来源中的确定结果，不把未知情况讲成定论。';
const config={id:'controlled-source-bars',name:'controlled',provider:'controlled',kind:'text' as const,modelId:'controlled',baseUrl:'https://example.invalid',apiKey:'controlled-not-secret',enabled:true};
type Evidence=NonNullable<LessonBarChart['bars'][number]['evidence']>;
function proof(sourceQuote:string,entityQuote='甲',metricQuote='刑期',valueQuote='十五年',operation:Evidence['operation']='identity'):Evidence{
  return {referenceId:'ref',sourceQuote,entityQuote,metricQuote,valueQuote,operation};
}
function report(source='甲刑期为十五年。乙刑期为八年。',unit='年',metric='刑期'):LessonReport{
  const narration='甲的刑期为十五年，乙的刑期为八年。尚未确认的情况不能自行推断，先分清来源与结论。';
  const value:LessonReport={workflowId:'controlled-source-chart',...lessonSettings(prompt),presentation:lessonPresentation(prompt),title:'来源与确定结果',audience:'新手',objectives:['读懂来源中的确定结果','保留未知边界'],arc:'先来源再结果后边界',limitations:['Controlled local test; no new media acceptance.'],
    references:[{id:'ref',title:'受控连续来源',url:'https://example.invalid/source',excerpt:source,verification:'news-page'}],
    chapters:Array.from({length:3},(_,i)=>({id:'ch'+(i+1),title:'确定结果'+(i+1),role:i===0?'hook':i===1?'foundation':'recap',goal:'根据实际来源理解结果',reason:'不把未知变成精确值',prerequisites:i?['ch'+i]:[],narration,referenceIds:['ref'],claims:[{text:'甲与乙的结果依据来源，未知边界保留。',referenceIds:['ref'],basis:'source'}],visual:{kind:'comparison',takeaway:'未知情况仍待确认',items:[{label:'甲',detail:'十五年；未知情况不推断',cue:'甲的刑期为十五年'},{label:'乙',detail:'八年；未知情况不推断',cue:'乙的刑期为八年'}]}}))};
  value.chapters[1].visual.kind='bar-chart';
  value.chapters[1].visual.barChart={unit,illustrative:false,bars:[{label:'甲',value:15,evidence:proof('甲刑期为十五年')},{label:'乙',value:8,evidence:proof('乙刑期为八年','乙','刑期','八年')}],panels:[{title:metric,min:0,max:30}]};
  return value;
}
function oneBar(source:string,evidence:Evidence,value=15,unit='年',metric='刑期'){
  const r=report(source,unit,metric);r.chapters[1].visual.barChart!.bars=[{label:evidence.entityQuote,value,evidence}];return r;
}
const accepted=(r:LessonReport)=>assert.deepEqual(lessonBarChartGrounding(r).findings,[]);
const rejected=(r:LessonReport)=>assert.ok(lessonBarChartGrounding(r).findings.length,'unsupported chart must return bounded repair guidance');
function actual():LessonReport{
  const r=report();r.references=fixture.sourcePassages.map((p:any)=>({id:p.id,title:p.id,url:'https://example.invalid/'+p.id,excerpt:p.quote,verification:'news-page'}));
  r.chapters=[{...structuredClone(r.chapters[1]),...structuredClone(fixture.chapter),referenceIds:['ref-1','ref-5-sidebar']}];return r;
}

test('actual P37 qualitative life sentence cannot become 30 years or be laundered as illustrative',()=>{
  const r=actual(),before=structuredClone(r);rejected(r);r.chapters[0].visual.barChart!.illustrative=true;rejected(r);
  assert.equal(before.chapters[0].visual.barChart!.bars[0].value,30);assert.equal(fixture.preservedOriginalOutcome.evaluationScore,100);
  assert.equal(fixture.preservedOriginalOutcome.renderSemanticScore,89);assert.equal(fixture.preservedOriginalOutcome.scriptFactReview.score,96);
});

test('a different actor monetary fine and unrelated recommended-story years cannot prove the same actor sentence',()=>{
  const r=actual(),chart=r.chapters[0].visual.barChart!;chart.bars=[{label:'李慧芳',value:30,evidence:{referenceId:'ref-1',sourceQuote:fixture.sourcePassages[0].quote,entityQuote:'李慧芳',metricQuote:'无期徒刑',valueQuote:'三十万元'}}];
  chart.panels=[{title:'无期徒刑',min:0,max:30}];rejected(r);
  chart.bars[0].evidence={referenceId:'ref-5-sidebar',sourceQuote:fixture.sourcePassages[1].quote,entityQuote:'李慧芳',metricQuote:'刑期',valueQuote:'30年'};chart.panels[0].title='刑期';rejected(r);
});

test('direct finite owner/measurement/value binds a server-derived current hash without mutating input',()=>{
  const r=validateLesson(report(),prompt),before=structuredClone(r);accepted(r);
  for(const bar of r.chapters[1].visual.barChart!.bars)assert.equal(bar.evidence!.sourceHash,lessonPrecisionSourceHash(r.references[0]));
  const missing=report(),original=structuredClone(missing),bound=bindLessonBarChartEvidence(missing);assert.deepEqual(missing,original);
  assert.notDeepEqual(bound,original);assert.deepEqual(r,before);
  accepted(oneBar('判处甲有期徒刑十五年。',proof('判处甲有期徒刑十五年','甲','有期徒刑','十五年'),15,'年','有期徒刑'));
});

test('normalized source units and canonical Chinese numerals preserve measured values',()=>{
  accepted(oneBar('甲长度为六百厘米。',proof('甲长度为六百厘米','甲','长度','六百厘米'),6,'米','长度'));
  accepted(oneBar('甲金额为人民币三十万元。',proof('甲金额为人民币三十万元','甲','金额','三十万元'),.003,'亿元','金额'));
  accepted(oneBar('甲长度为两百米。',proof('甲长度为两百米','甲','长度','两百米'),200,'米','长度'));
  accepted(oneBar('甲长度为一千零一米。',proof('甲长度为一千零一米','甲','长度','一千零一米'),1001,'米','长度'));
  accepted(oneBar('甲错误率为十五%。',proof('甲错误率为十五%','甲','错误率','十五%'),15,'%','错误率'));
});

test('same-scale source numbers are exact, tiny positive quantities never become zero, and conversion only tolerates machine representation error',()=>{
  const tiny=proof('甲长度为0.000000001米','甲','长度','0.000000001米');
  accepted(oneBar('甲长度为0.000000001米。',tiny,1e-9,'米','长度'));
  rejected(oneBar('甲长度为0.000000001米。',tiny,0,'米','长度'));
  rejected(oneBar('甲长度为0.000000001米。',tiny,2e-9,'米','长度'));
  const large=proof('甲长度为9000000000000000米','甲','长度','9000000000000000米');
  accepted(oneBar('甲长度为9000000000000000米。',large,9000000000000000,'米','长度'));
  rejected(oneBar('甲长度为9000000000000000米。',large,9000000000000001,'米','长度'));
  accepted(oneBar('甲长度为0.57米。',proof('甲长度为0.57米','甲','长度','0.57米'),57,'厘米','长度'));
  accepted(oneBar('甲长度为0.000000001厘米。',proof('甲长度为0.000000001厘米','甲','长度','0.000000001厘米'),1e-11,'米','长度'));
  rejected(oneBar('甲长度为0.000000001厘米。',proof('甲长度为0.000000001厘米','甲','长度','0.000000001厘米'),0,'米','长度'));
  rejected(oneBar('甲长度为0.1000000000000000001米。',proof('甲长度为0.1000000000000000001米','甲','长度','0.1000000000000000001米'),.1,'米','长度'));
  const range=report('甲长度为1厘米至2米。','厘米','长度');
  range.chapters[1].visual.barChart!.bars=[{label:'甲最低',value:1.0000000000000002,evidence:proof('甲长度为1厘米至2米','甲','长度','1厘米至2米','range-min')}];rejected(range);
  range.chapters[1].visual.barChart!.bars=[{label:'甲最高',value:200,evidence:proof('甲长度为1厘米至2米','甲','长度','1厘米至2米','range-max')}];accepted(range);
});

test('only explicitly labelled range endpoints are allowed, never an invented mean or a covert endpoint identity',()=>{
  const r=report('甲长度六至八米。','米','长度');r.chapters[1].visual.barChart!.bars=[{label:'甲最低',value:6,evidence:proof('甲长度六至八米','甲','长度','六至八米','range-min')},{label:'甲最高',value:8,evidence:proof('甲长度六至八米','甲','长度','六至八米','range-max')}];accepted(r);
  r.chapters[1].visual.barChart!.bars[0].value=7;rejected(r);
  rejected(oneBar('甲长度六至八米。',proof('甲长度六至八米','甲','长度','八米'),8,'米','长度'));
});

test('unique quote ordering does not grant another actor or another measurement role',()=>{
  for(const source of ['甲负责管理，乙刑期十五年。','甲表示乙刑期十五年。','甲刑期无期，没收财产三十万元。']){
    const money=source.includes('万元');rejected(oneBar(source,proof(source.slice(0,-1),'甲','刑期',money?'三十万元':'十五年'),money?30:15,money?'万元':'年'));
  }
  const multi=report('甲刑期十五年，乙刑期八年。');multi.chapters[1].visual.barChart!.bars[0].evidence=proof('甲刑期十五年，乙刑期八年');rejected(multi);
});

test('entity and measurement must be distinct non-overlapping spans with an explicit axis role',()=>{
  rejected(oneBar('甲公司2025年。',proof('甲公司2025年','甲公司','甲公司','2025年'),2025,'年','甲公司'));
  rejected(oneBar('甲公司长度15米。',proof('甲公司长度15米','甲公司','公司长度','15米'),15,'米','公司长度'));
  const r=report();r.chapters[1].visual.barChart!.panels[0].title='罚金';rejected(r);
  rejected(oneBar('AA刑期15年。',proof('AA刑期15年','A','刑期','15年')));
});

test('rebuttals, negation and uncertainty cannot witness a positive quantitative claim',()=>{
  for(const source of ['甲刑期并不等于15年。','辟谣：甲刑期15年为虚假消息。','甲刑期15年，是错误说法。','未经证实：甲刑期15年。','甲刑期可能15年。']){
    const start=source.includes('：')?source.indexOf('：')+1:0,quote=source.slice(start,-1);rejected(oneBar(source,proof(quote,'甲','刑期','15年')));
  }
  rejected(oneBar('甲刑期15年，为不实消息。',proof('甲刑期15年','甲','刑期','15年')));
});

test('bounds, malformed numerals, unsupported dimensions and value changes cannot silently normalize into exact data',()=>{
  for(const [source,n]of [['八百百',900],['九百零零',900],['一千一',1001],['015',15],['9007199254740993',9007199254740992]]as const)rejected(oneBar(`甲长度${source}米。`,proof(`甲长度${source}米`,'甲','长度',`${source}米`),n,'米','长度'));
  for(const qualifier of ['至少','最多','约','不超过'])rejected(oneBar(`甲刑期${qualifier}15年。`,proof(`甲刑期${qualifier}15年`,'甲','刑期','15年')));
  rejected(oneBar('甲刑期十五天。',proof('甲刑期十五天','甲','刑期','十五天'),15,'年'));
  rejected(oneBar('甲刑期十五年。',proof('甲刑期十五年'),30));
});

test('malformed, stale, uncited, duplicate or truncated proof cannot authorize a source chart',()=>{
  for(const mutate of [(r:LessonReport)=>{r.chapters[1].visual.barChart!.bars[0].evidence=undefined;},(r:LessonReport)=>{r.chapters[1].visual.barChart!.bars[0].evidence!.sourceHash='0'.repeat(64);},(r:LessonReport)=>{r.references[0].excerpt+='甲刑期为十五年。';},(r:LessonReport)=>{r.references[0].verification='search-cited';},(r:LessonReport)=>{r.references[0].freshness='stale';},(r:LessonReport)=>{r.chapters[1].referenceIds=[];},(r:LessonReport)=>{r.chapters[1].visual.barChart!.bars[0].evidence!.sourceQuote='甲刑期为十五';},(r:LessonReport)=>{r.chapters[1].visual.barChart!.bars[0].evidence!.operation='average' as any;}]){const r=report();mutate(r);rejected(r);}
});

test('explicit classroom calculations retain the existing no-external-source path without exempting source-based teaching charts',()=>{
  const r=report();r.references=[];r.chapters.forEach(ch=>{ch.referenceIds=[];ch.claims=[{text:'甲为15，乙为8，按同一单位比较。',referenceIds:[],basis:'calculation',explanation:'课堂给定数值15与8，不声明外部实验结果。'}];ch.visual.barChart?.bars.forEach(bar=>delete bar.evidence);});accepted(r);
  r.chapters[1].claims[0].basis='source';rejected(r);
});

test('categorical cards preserve narration, claims and information while still undergoing the existing fact gate',async()=>{
  const r=report();r.chapters[1].visual.barChart!.bars[0].value=30;assert.throws(()=>validateLesson(r,prompt),/来源柱图/);
  const preserved=r.chapters.map(ch=>({narration:ch.narration,claims:ch.claims,items:ch.visual.items}));r.chapters[1].visual.kind='comparison';delete r.chapters[1].visual.barChart;
  const fixed=validateLesson(r,prompt);assert.deepEqual(fixed.chapters.map(ch=>({narration:ch.narration,claims:ch.claims,items:ch.visual.items})),preserved);
  const saved=globalThis.fetch;let calls=0;
  try{globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({score:78,needsRepair:true,findings:['ch2：受控的另一真实缺陷仍待修。'],suggestions:[]})}}]});};
    const reviewed=await reviewLessonScript(config,fixed,'',undefined,undefined,prompt);assert.equal(reviewed.score,78);assert.equal(reviewed.needsRepair,true);assert.equal(calls,1);
  }finally{globalThis.fetch=saved;}
});

test('an empty 96-point model response cannot authorize the initial unsupported source chart or change its raw score/flag',async()=>{
  const r=actual(),before=structuredClone(r),raw={score:96,needsRepair:false,findings:[],suggestions:[]},records:unknown[]=[],saved=globalThis.fetch;let calls=0;
  try{globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(raw)}}]});};
    const review=await reviewLessonScript(config,r,'',async value=>{records.push(value);},undefined,'解释判决');assert.equal(review.score,96);assert.equal(review.needsRepair,true);assert.ok(review.findings.some(f=>f.includes('来源柱图')));assert.deepEqual(records,[raw]);assert.equal(calls,1);assert.deepEqual(r,before);
  }finally{globalThis.fetch=saved;}
});

test('cached unsupported charts at render/done return to bounded script repair before voice/render/review without reusing old acceptance',async()=>{
  for(const phase of ['render','done']){
    const dir=await mkdtemp(path.join(tmpdir(),'qingjian-cached-source-chart-')),work=path.join(dir,'lesson-workflows/case'),controller=new AbortController(),saved=globalThis.fetch,events:WorkflowEvent[]=[];let calls=0,voice=0;
    await mkdir(work,{recursive:true});const r=report();r.chapters[1].visual.barChart!.bars[0].value=30;r.factReview={score:96,needsRepair:false,findings:[]};
    const checkpoint=Buffer.from(JSON.stringify({fingerprint:hashBytes(JSON.stringify({version:1,owner:'controlled-owner',prompt,export:true})),requestedAt:Date.now(),rendererHash:lessonRendererHash(),newsSourceParserHash:newsSourceParserHash(),phase,report:r,research:{summary:'Controlled cached report',queries:[],references:r.references},renders:1,reviewRetries:0,review:{score:89,status:'passed',checks:[],semantic:{score:89,findings:[],suggestions:[]}}}));await writeFile(path.join(work,'checkpoint.json'),checkpoint);
    globalThis.fetch=async()=>{calls++;throw new Error('No provider request allowed');};
    try{await assert.rejects(withModelSnapshot({text:config,understanding:null,audio:{...config,kind:'audio'},image:null},()=>runWithJobSignal(controller.signal,()=>runLessonWorkflow({prompt,config,audioConfig:{...config,kind:'audio'},media:[],dataDir:dir,mediaDir:dir,ownerId:'controlled-owner',checkpointKey:'case',export:true,register:async()=>{},persist:async()=>{},saveDraft:async()=>{},progress:async value=>{events.splice(0,events.length,...value);},stage:async value=>{if(/旁白/.test(value))voice++;if(value.startsWith('规划')){controller.abort();throwIfJobCancelled();}},analyze:async()=>{throw new Error('No ASR');},render:async()=>{throw new Error('No render');},review:async()=>{throw new Error('No cached review');}}))),JobCancelledError);
      const meta=(await readFile(path.join(work,'llm-request-meta.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(meta.at(-1).phase,'script');assert.deepEqual(meta.at(-1).allowed,['revise_lesson_script']);assert.equal(calls,0);assert.equal(voice,0);assert.ok(!events.some(e=>/synthesize|render_lesson|review_lesson$/.test(e.tool)));
      assert.deepEqual(await readFile(path.join(work,'news-source-history',hashBytes(checkpoint)+'.json')),checkpoint,'old score/flags and exact bytes survive revalidation');
    }finally{globalThis.fetch=saved;await rm(dir,{recursive:true,force:true});}
  }
});

test('the whole grounding helper participates in renderer authorization while leaving speech processing identity unchanged',async()=>{
  const source=fileURLToPath(new URL('..',import.meta.url)),copy=await mkdtemp(path.join(tmpdir(),'qingjian-source-chart-closure-'));
  try{for(const name of ['server','shared'])await cp(path.join(source,name),path.join(copy,name),{recursive:true});await cp(path.join(source,'package.json'),path.join(copy,'package.json'));await symlink(path.join(source,'node_modules'),path.join(copy,'node_modules'),'dir');
    const {lessonRendererHash:renderer}=await import(pathToFileURL(path.join(copy,'server/lessonScenes.ts')).href),{lessonSpeechProcessingHash:speech}=await import(pathToFileURL(path.join(copy,'server/lessonSpeechProof.ts')).href);
    const a=renderer(),b=speech();await appendFile(path.join(copy,'server/lessonBarChartGrounding.ts'),'\n// private closure probe\n');assert.notEqual(renderer(),a);assert.equal(speech(),b);
    const c=renderer();await appendFile(path.join(copy,'server/reviewFrameTextLayoutContext.ts'),'\n// private review-context closure probe\n');assert.notEqual(renderer(),c);assert.equal(speech(),b);
  }finally{await rm(copy,{recursive:true,force:true});}
});
