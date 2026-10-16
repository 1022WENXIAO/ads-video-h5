import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createLessonPrecisionBaseline,restoreLessonPrecisionBaseline,lessonPrecisionReviewContext,lessonPrecisionSourceHash,lessonPrecisionEvidenceFindings,type LessonPrecisionWitness} from '../server/lessonEvidenceConcordance';
import {reviewLessonScript} from '../server/lessonWorkflow';
import type {LessonReport} from '../shared/types';

function report(text='观测站记录事件，具体时刻不详。',source='观测站记录事件，具体时刻不详。'):LessonReport{
  return{workflowId:'controlled',title:'观测记录',audience:'普通观众',objectives:['区分证据'],arc:'记录事实',requestedSeconds:30,explicitDuration:true,format:'portrait',limitations:[],references:[{id:'r',title:'实际观测记录',url:'https://example.invalid/report',excerpt:source,retrievedAt:'2026-10-16T00:00:00Z',verification:'primary-page',freshness:'fresh'}],chapters:[{id:'c',title:'观测记录',role:'hook',goal:'核对记录',prerequisites:[],reason:'解释证据',narration:text,referenceIds:['r'],claims:[{text,referenceIds:['r'],basis:'source'}],visual:{kind:'concept',takeaway:'观测记录',items:[{label:'观测站',detail:'保留原始记录',cue:'观测站'}]}}]};
}
const baseline=()=>createLessonPrecisionBaseline(report());
function witness(value:LessonReport,valueQuote:string,sourceQuote=value.references[0].excerpt):LessonPrecisionWitness[]{
  return (lessonPrecisionReviewContext(value,baseline())?.assertions||[]).map(a=>({assertionId:a.id,referenceId:'r',sourceHash:lessonPrecisionSourceHash(value.references[0]),publishedQuote:a.publishedQuote,sourceQuote,actorQuote:'观测站',roleQuote:'记录事件',valueQuote}));
}
const findings=(value:LessonReport,w:unknown=undefined)=>lessonPrecisionEvidenceFindings(value,baseline(),w);

test('actual source projection: a new visual 12:35 with unclear local attribution is blocked despite raw 82 and empty findings',async()=>{
  const fixture=JSON.parse(await readFile(new URL('./fixtures/p34-new-clock-precision.json',import.meta.url),'utf8')),prior=fixture.prior as LessonReport,current=fixture.current as LessonReport,b=createLessonPrecisionBaseline(prior),before=JSON.stringify(fixture);
  assert.ok(lessonPrecisionReviewContext(current,b)?.assertions.some(a=>a.value==='12:35'&&a.channel.includes('visual')));
  assert.ok(lessonPrecisionEvidenceFindings(current,b,[]).length);
  const context=lessonPrecisionReviewContext(current,b)!;assert.ok(context.sources.some(s=>s.precisionPassages.some(p=>p.quote.includes('15:35 local time (0335 GMT)'))));
  const fake=context.assertions.map(a=>({assertionId:a.id,referenceId:'ref-3',sourceHash:lessonPrecisionSourceHash(current.references[0]),publishedQuote:a.publishedQuote,sourceQuote:current.references[0].excerpt,actorQuote:'堪察加',roleQuote:'地震',valueQuote:'12点35分'}));
  assert.ok(lessonPrecisionEvidenceFindings(current,b,fake).length,'a source-local number cannot silently supply a published timezone');assert.equal(JSON.stringify(fixture),before);
});

test('no baseline, unchanged published precision, omission, internal claims and cue-only changes retain the old path',()=>{
  const prior=report('观测站记录事件于12:35 UTC。'),b=createLessonPrecisionBaseline(prior),current=structuredClone(prior);
  current.chapters[0].claims[0].text+='建议新增15:35。';current.factReview={score:82,needsRepair:false,findings:[],suggestions:['补充当地15:35']};current.chapters[0].visual.items[0].cue='15:35';
  assert.equal(lessonPrecisionReviewContext(current,b),undefined);assert.deepEqual(lessonPrecisionEvidenceFindings(current,b,[]),[]);
  assert.deepEqual(lessonPrecisionEvidenceFindings(report('观测站记录事件于12:35 UTC。'),undefined,[]),[]);
  const omitted=report('观测站记录事件发生在当天。');assert.deepEqual(lessonPrecisionEvidenceFindings(omitted,b,[]),[]);
});

test('a new explicitly published UTC clock is source-bound and an explicit fixed offset conversion is equivalent',()=>{
  for(const source of ['观测站记录事件于03:35 UTC。','观测站记录事件于12:35 JST。','观测站记录事件于0335 GMT。']){
    const value=report('观测站记录事件于03:35 UTC。',source),w=witness(value,source.match(/(?:\d{2}:\d{2}|\d{4}) (?:UTC|JST|GMT)/)![0]);
    assert.deepEqual(findings(value,w),[],source);
  }
});

test('local-only publication, changed clock, changed date, different event role, unknown actor alias and guessed midnight conversion fail closed',()=>{
  for(const [text,source,valueQuote]of [
    ['观测站记录事件于当地12:35。','观测站记录事件于当地12:35。','12:35'],
    ['观测站记录事件于12:35 UTC。','观测站记录事件于15:35 UTC。','15:35 UTC'],
    ['观测站记录事件于2026-10-16 12:35 UTC。','观测站记录事件于2026-10-17 12:35 UTC。','12:35 UTC'],
    ['观测站记录事件于12:35 UTC。','观测站发布通报于12:35 UTC。','12:35 UTC'],
    ['观测站记录事件于12:35 UTC。','Station recorded event at12:35 UTC.','12:35 UTC'],
    ['观测站记录事件于00:35 JST。','观测站记录事件于15:35 UTC。','15:35 UTC'],
  ]){const value=report(text,source);assert.ok(findings(value,witness(value,valueQuote)).length,text);}
});

test('exact quantitative value, reference object and unit are bound; supported physical scaling is explicit, unrelated prose and versions are not clock evidence',()=>{
  for(const [text,source,v]of [['观测站记录事件距离2公里。','观测站记录事件距离2000米。','2000米'],['观测站记录事件质量2千克。','观测站记录事件质量2000克。','2000克']]){const value=report(text,source);assert.deepEqual(findings(value,witness(value,v)),[]);}
  for(const [text,source,v]of [['观测站记录事件距离2公里。','观测站记录事件距离3公里。','3公里'],['观测站记录事件质量2克。','观测站记录事件质量2米。','2米'],['观测站记录事件震级6.9级。','观测站记录事件震度6.9级。','6.9级'],['观测站记录事件于2026-10-16测距2公里。','观测站记录事件于2026-10-17测距2公里。','2公里']]){const value=report(text,source);assert.ok(findings(value,witness(value,v)).length);}
  assert.equal(lessonPrecisionReviewContext(report('观测站记录事件采用Fable5.1模型，另有三点五版本。'),baseline()),undefined);
});

test('quantity binding preserves adjacent bounds and approximation; a changed bound is a new assertion, and a new interval is conservatively unsupported',()=>{
  for(const qualifier of ['至少','不低于','不少于','大于','超过','最多','至多','不超过','小于','不足','约','大约','近']){
    const source=`观测站记录事件距离${qualifier}3米。`,same=report(source,source),value=report('观测站记录事件距离3米。',source);
    assert.deepEqual(findings(same,witness(same,'3米')),[],qualifier+' same relation');
    assert.ok(findings(value,witness(value,'3米')).length,qualifier+' cannot become an exact value');
    const prior=createLessonPrecisionBaseline(same);assert.ok(lessonPrecisionEvidenceFindings(value,prior,[]).length,'removing '+qualifier+' is a precision change even with the same digits/unit');
  }
  for(const range of ['2至3米','2到3米','2米至3米','2～3米','2-3米']){const value=report('观测站记录事件距离'+range+'。');value.references[0].excerpt=value.chapters[0].narration;assert.ok(findings(value,witness(value,range)).length,range);}
});

test('source ownership, exact source bytes, complete non-negated quotation and unique binding cannot be forged',()=>{
  const good=report('观测站记录事件于12:35 UTC。','观测站记录事件于12:35 UTC。'),w=witness(good,'12:35 UTC');
  assert.deepEqual(findings(good,w),[]);
  const cases:Array<[LessonReport,unknown]>=[];
  for(const mutate of [(v:LessonReport)=>v.references.push(structuredClone(v.references[0])),(v:LessonReport)=>{v.references[0].freshness='stale';},(v:LessonReport)=>{v.references[0].freshness='future';},(v:LessonReport)=>{v.references[0].verification='search-cited';},(v:LessonReport)=>{v.chapters[0].referenceIds=[];},(v:LessonReport)=>{v.references[0].excerpt+='正文变更';}]){const v=structuredClone(good);mutate(v);cases.push([v,w]);}
  cases.push([good,[...w,...w]],[good,[{...w[0],sourceQuote:'记录事件于12:35 UTC。'}]],[good,[{...w[0],sourceHash:'0'.repeat(64)}]]);
  for(const [v,proof]of cases)assert.ok(findings(v,proof).length);
  const unverified=report(good.chapters[0].narration,'网传未核实：观测站记录事件于12:35 UTC。');assert.ok(findings(unverified,witness(unverified,'12:35 UTC')).length);
  const chopped=witness(unverified,'12:35 UTC',good.references[0].excerpt);assert.ok(findings(unverified,chopped).length,'cannot omit the source negation prefix');
});

test('baseline is immutable, integrity-bound and never inferred from untrusted old metadata',()=>{
  const prior=report(),b=createLessonPrecisionBaseline(prior),before=JSON.stringify(b);prior.chapters[0].narration+='12:35 UTC。';assert.equal(JSON.stringify(b),before);
  assert.deepEqual(restoreLessonPrecisionBaseline(b),b);assert.throws(()=>restoreLessonPrecisionBaseline({...b,fields:[...b.fields,{chapterId:'c',channel:'narration',text:'12:35 UTC'}]}),/完整性/);
  assert.equal(restoreLessonPrecisionBaseline(undefined),undefined);
});

test('a pure built-in squared-loss correction needs calculation review rather than an impossible external witness; clocks/dates and mixed claims remain guarded',()=>{
  const prior=report('误差2个单位，平方损失3个单位。');prior.references=[];prior.chapters[0].referenceIds=[];prior.chapters[0].claims=[{text:prior.chapters[0].narration,basis:'calculation',referenceIds:[],explanation:'平方损失等于误差的平方：e²。'}];
  const b=createLessonPrecisionBaseline(prior),current=structuredClone(prior);current.chapters[0].narration='误差2个单位，平方损失4个单位。';current.chapters[0].claims[0].text=current.chapters[0].narration;
  assert.deepEqual(lessonPrecisionEvidenceFindings(current,b,[]),[]);
  for(const text of [current.chapters[0].narration+'计算时刻12:35 UTC。',current.chapters[0].narration+'日期2026-10-16。']){const value=structuredClone(current);value.chapters[0].narration=text;assert.ok(lessonPrecisionEvidenceFindings(value,b,[]).length);}
  for(const mutate of [(v:LessonReport)=>{v.chapters[0].claims.push({text:'有外部观测',basis:'source',referenceIds:['r']});},(v:LessonReport)=>{v.chapters[0].claims[0].basis='synthesis';},(v:LessonReport)=>{v.chapters[0].claims[0].explanation='';},(v:LessonReport)=>{v.chapters[0].claims[0].referenceIds=['r'];},(v:LessonReport)=>{v.chapters[0].claims=[];},(v:LessonReport)=>{v.hotResearch={asOf:'2026-10-16T00:00:00Z',expiresAt:'2026-10-16T00:30:00Z',windowHours:24,signals:[],topics:[],failures:[]};}]){const value=structuredClone(current);mutate(value);assert.ok(lessonPrecisionEvidenceFindings(value,b,[]).length);}
});

test('the calculation exception does not replace the real fact/formula review or its original failure disposition',async()=>{
  const prior=report('误差2个单位，平方损失3个单位。');prior.references=[];prior.chapters[0].referenceIds=[];prior.chapters[0].claims=[{text:prior.chapters[0].narration,basis:'calculation',referenceIds:[],explanation:'平方损失=e²，2²=4。'}];const b=createLessonPrecisionBaseline(prior),current=structuredClone(prior);current.chapters[0].narration='误差2个单位，平方损失4个单位。';
  const savedFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({score:79,needsRepair:true,findings:['c：受控公式问题仍未解决'],suggestions:[]})}}]});};
  try{const result=await reviewLessonScript({id:'fixture',name:'fixture',provider:'ark',kind:'text',modelId:'controlled',baseUrl:'https://example.invalid',apiKey:'controlled',enabled:true},current,'',undefined,undefined,'',Date.now(),undefined,b);assert.equal(calls,1);assert.equal(result.score,79);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,['c：受控公式问题仍未解决']);}
  finally{globalThis.fetch=savedFetch;}
});

test('same single fact-review request records raw 82 before the precision gate; source references and original findings stay unchanged',async()=>{
  const value=report('观测站记录事件于当地12:35。'),raw={score:82,needsRepair:false,findings:[],suggestions:['可进一步说明时区。']},before=JSON.stringify(value),savedFetch=globalThis.fetch;let calls=0,recorded:unknown;
  globalThis.fetch=async(_url,init)=>{calls++;const payload=JSON.parse(String(init?.body)),context=JSON.parse(payload.messages[1].content);assert.ok(context.precisionEvidence.assertions.length);return Response.json({choices:[{message:{content:JSON.stringify(raw)}}]});};
  try{const result=await reviewLessonScript({id:'fixture',name:'fixture',provider:'ark',kind:'text',modelId:'controlled',baseUrl:'https://example.invalid',apiKey:'controlled',enabled:true},value,'',async v=>{recorded=structuredClone(v);},undefined,'',Date.now(),undefined,baseline());assert.equal(calls,1);assert.deepEqual(recorded,raw);assert.equal(result.score,82);assert.equal(result.needsRepair,true);assert.match(result.findings.join(' '),/precision-evidence/);assert.equal(JSON.stringify(value),before);}
  finally{globalThis.fetch=savedFetch;}
});
