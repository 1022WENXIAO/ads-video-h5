import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {lessonElapsedEvidenceFindings,lessonSourceResearchFeedback} from '../server/lessonElapsedEvidence';
import type {LessonReport} from '../shared/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p15-elapsed-contradiction.json',import.meta.url),'utf8')) as {report:LessonReport};
const actual=()=>structuredClone(fixture.report);
function clean(){
  const r=actual(),c=r.chapters[1];c.narration='截至10时，环球网实测服务仍未恢复，官方正在修复。';c.claims=[{text:'环球网记者10时实测，相关服务仍未恢复正常。',basis:'source',referenceIds:['ref-1']}];
  c.visual.takeaway='10时仍未恢复，官方正在修复';c.visual.items[0].detail='环球网实测仍未恢复；自绘示意';return r;
}
function narrated(text:string,source?:string){const r=clean();r.chapters[1].narration=text;if(source!==undefined)r.references[0].excerpt=source;return r;}
const finding=(r:LessonReport)=>lessonElapsedEvidenceFindings(r);

test('actual P15 current accepted script still has a source-bound duration contradiction despite a passing score',()=>{
  const r=actual(),before=structuredClone(r),result=finding(r);assert.ok(result.length>=2);assert.ok(result.every(v=>v.startsWith('chapter-3：')));assert.match(result[0],/不足169分钟/);assert.match(result[0],/ref-1/);assert.match(result[0],/3个多小时/);assert.deepEqual(r,before);
});
test('arithmetic correction feedback cannot consume source-research rounds while independent missing-source findings remain',()=>{
  const r=actual(),math=finding(r),missing='chapter-2：缺少可核验的原始来源，需要补充联网检索。';
  assert.ok(math.length>0);
  assert.match(math.join('；'),/(?:缺少|未找到|无法取得|不足).*(?:来源|原始.*论文|证据)/,'the old text classifier misrouted the actual deterministic finding');
  assert.equal(lessonSourceResearchFeedback(r,math),'');
  assert.equal(lessonSourceResearchFeedback(r,[...math,missing]),missing);
  assert.deepEqual(finding(r),math,'routing does not remove factual vetoes or repair requirements');
});
test('a partial report without actual chapter-claim source binding cannot infer an elapsed contradiction',()=>{
  const r=actual();
  for(const partial of [{references:r.references},{references:r.references,chapters:[{id:'chapter-3'}]},{references:r.references,chapters:[{...r.chapters[1],referenceIds:undefined}]}])assert.deepEqual(finding(partial as LessonReport),[]);
});
test('attribution, unsupported measurement explanations and Chinese/Arabic number rewrites do not resolve arithmetic',()=>{
  for(const text of ['故障已超过三小时。','据媒体称故障已持续3个多小时。','媒体按现场观察口径称已持续3个多小时。','按现场持续不可用体验计，故障已持续三个多小时。','故障已持续3小时，根因未经核实。'])assert.ok(finding(narrated(text)).length,text);
});
test('removing the unsupported quantity from every current surface resolves the veto, even though the source remains inconsistent',()=>{
  assert.deepEqual(finding(clean()),[]);
  assert.deepEqual(finding(narrated('8点11分启动，截至10时仍未恢复。')),[]);
});
test('title, visual labels/details/takeaway and internal source claims cannot hide a remaining false quantity',()=>{
  for(const field of ['title','label','detail','takeaway','claim'] as const){
    const r=clean(),c=r.chapters[1];
    if(field==='title')c.title='故障已持续3个多小时';if(field==='label')c.visual.items[0].label='已持续3个多小时';if(field==='detail')c.visual.items[0].detail='故障已持续3个多小时';if(field==='takeaway')c.visual.takeaway='故障已持续3个多小时';if(field==='claim')c.claims[0].text='媒体按现场观察口径称故障已持续3个多小时。';
    assert.ok(finding(r).length,field);
  }
});
test('explicitly presenting an unverified internal source conflict is different from inventing a statistical basis',()=>{
  const warning='报道原文称故障已持续3个多小时，来源起止时间与时长不一致，该时长未经核实。';
  assert.deepEqual(finding(narrated(warning)),[]);
  assert.ok(finding(narrated(warning+'但是故障确已持续3个多小时。')).length,'a later affirmative assertion is not exempted by the warning');
  assert.ok(finding(narrated('来源时长不一致，但媒体按现场观察口径称故障已持续3个多小时。')).length,'a conflict without a current unverified qualification cannot justify a fabricated method');
});
test('actual scalar lower and upper bounds preserve meaning without pretending an hour-only clock is minute-precise',()=>{
  for(const text of ['故障已持续不足3小时。','故障已持续不到三小时。','故障已持续不超过3小时。','故障已持续不多于3小时。','故障持续2小时。','故障持续2.5小时。'])assert.deepEqual(finding(narrated(text)),[],text);
  for(const text of ['故障已持续至少3小时。','故障已持续不少于3小时。','故障时长超过3小时。','故障已逾3小时。'])assert.ok(finding(narrated(text)).length,text);
  assert.deepEqual(finding(narrated('故障已持续约3小时。')),[],'fuzzy approximations remain for the independent reviewer, not an invented numeric tolerance');
});
test('local denial and proof uncertainty cannot become affirmative elapsed assertions, while contrast resets their scope',()=>{
  for(const text of ['故障并非已持续3小时。','故障没有持续3小时。','目前不能证明故障已持续3小时。','“故障已持续3小时”的说法未经证实。'])assert.deepEqual(finding(narrated(text)),[],text);
  assert.ok(finding(narrated('不能证明故障已持续3小时，但故障确已持续3个多小时。')).length);
});
test('another explicit actor or historical calendar event cannot inherit this source interval',()=>{
  for(const text of ['乙平台故障已持续3小时。','此前故障已持续3小时。','此前10月15日的故障已持续3小时。','10月2日故障已持续3小时。','2025年10月2日故障已持续3小时。'])assert.deepEqual(finding(narrated(text)),[],text);
  assert.ok(finding(narrated('2026年10月15日，故障已持续3小时。')).length,'a source with no printed year does not falsely become the year 2000');
});
test('a source can separately explain a different observed start; multiple explicit frames are not forced into one interval',()=>{
  const source='10月15日，本次故障于北京时间8时11分启动。记者的独立观测从6时45分开始，截至10时故障已持续3个多小时。';
  assert.deepEqual(finding(narrated('记者观测故障已持续3个多小时。',source)),[]);
});
test('same-day contradictory evidence is not joined across two distinct source subjects',()=>{
  const source='10月15日，甲平台故障于8时11分启动，截至10时，乙平台故障已持续3个多小时。';
  assert.deepEqual(finding(narrated('乙平台故障已持续3个多小时。',source)),[]);
});
test('explicit cross-midnight dates and next-day markers retain their actual elapsed duration',()=>{
  for(const source of ['10月14日，本次故障于22时11分启动，截至10月15日2时，故障已持续3个多小时。','2026年10月14日，本次故障于22时11分启动，截至次日2时，故障已持续3个多小时。','本次故障于昨晚22时11分启动，截至今早2时，故障已持续3个多小时。'])assert.deepEqual(finding(narrated('故障已持续3个多小时。',source)),[],source);
  assert.ok(finding(narrated('故障已持续3个多小时。','10月14日，本次故障于23时11分启动，截至次日1时，故障已持续3个多小时。')).length,'an explicit midnight crossing does not excuse a still-impossible lower bound');
});
test('missing dates, unclear local time zones and reversed unqualified clocks never invent a day rollover',()=>{
  for(const source of ['本次故障于8时11分启动，截至10时，故障已持续3个多小时。','10月15日，本次故障于当地时间8时11分启动，截至10时，故障已持续3个多小时。','10月15日，本次故障于23时11分启动，截至1时，故障已持续3个多小时。','10月15日，本次故障于北京时间8时11分启动，截至UTC10时，故障已持续3个多小时。'])assert.deepEqual(finding(narrated('故障已持续3个多小时。',source)),[],source);
});
test('only uniquely identified, genuinely read and chapter-claim-linked sources can create the veto',()=>{
  for(const kind of ['missing','duplicate','search','unlinked','unclaimed'] as const){
    const r=narrated('故障已持续3个多小时。');
    if(kind==='missing')r.references=[];if(kind==='duplicate')r.references.push({...r.references[0]});if(kind==='search')r.references[0].verification='search-cited';if(kind==='unlinked')r.chapters[1].referenceIds=[];if(kind==='unclaimed')r.chapters[1].claims[0].referenceIds=[];
    assert.deepEqual(finding(r),[],kind);
  }
});

test('a claim cannot borrow another claim\'s inconsistent source merely because both appear in the chapter',()=>{
  const r=clean();r.references.push({...r.references[0],id:'separate-event',excerpt:'另一事件的独立来源，只记载持续三小时，未记载上述起止时间。'});r.chapters[1].referenceIds.push('separate-event');r.chapters[1].claims.push({text:'故障已持续3小时。',basis:'source',referenceIds:['separate-event']});
  assert.deepEqual(finding(r),[]);
});
