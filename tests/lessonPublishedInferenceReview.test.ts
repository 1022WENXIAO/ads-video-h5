import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {LessonReport} from '../shared/types';
import {LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,lessonPublishedContentReviewContext} from '../server/lessonScriptReviewContext';
import {reviewLessonScript} from '../server/lessonWorkflow';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p37-published-inference-review.json',import.meta.url),'utf8'));
const actualTakeaway='责任越核心，刑罚越重';
function report():LessonReport{
  // The one actual source passage contains both the sentence results and the
  // multifactor rationale. This controlled projection uses that complete
  // passage, without pretending to be the full original news workflow.
  const chapter=structuredClone(fixture.chapter);
  chapter.referenceIds=[fixture.sourcePassage.referenceId];
  chapter.claims=chapter.claims.map((claim:any)=>({...claim,referenceIds:[fixture.sourcePassage.referenceId]}));
  return {workflowId:'controlled-published-inference',title:fixture.title,audience:'普通观众',objectives:['区分判决事实与解释'],arc:'事实与边界',requestedSeconds:30,explicitDuration:true,format:'9:16',limitations:['受控审查链路，非新影片验收。'],
    references:[{id:fixture.sourcePassage.referenceId,title:fixture.sourcePassage.title,url:fixture.sourcePassage.url,verification:fixture.sourcePassage.verification,excerpt:fixture.sourcePassage.quote}],
    chapters:[{...chapter,role:'development',goal:'依据来源说明已判结果',prerequisites:[],reason:'区分已知事实与推断'}]};
}
function qualifiedReport():LessonReport{
  const value=report(),chapter=value.chapters[0];
  chapter.visual.kind='concept';delete chapter.visual.barChart;
  chapter.visual.items=chapter.visual.items.map(({illustration:_,...item})=>item);
  chapter.visual.takeaway='本案两名管理人员刑期较重；不能仅按职务推定量刑。';
  return value;
}

test('actual P37 visible takeaway is reviewed separately from accurate internal claims',()=>{
  const value=report(),before=structuredClone(value),context=lessonPublishedContentReviewContext(value);
  assert.equal(context.documentPublishedChannels.title,fixture.title);
  assert.equal(context.chapters[0].publishedChannels.plannedVisual.takeaway,actualTakeaway);
  assert.equal(context.chapters[0].publishedChannels.plannedVisual.barChart!.bars[0].value,30,'retain the original unsupported proxy as evidence, never repair the fixture');
  assert.ok(!context.chapters[0].internalClaimEvidence.some(claim=>claim.text.includes(actualTakeaway)));
  assert.match(fixture.sourcePassage.quote,/根据各被告人的犯罪事实、性质、情节和对社会的危害程度/);
  assert.equal(fixture.originalFactReviewProjection.score,96);
  assert.equal(fixture.originalFactReviewProjection.needsRepair,false);
  assert.deepEqual(fixture.originalFactReviewProjection.findings,[]);
  assert.equal(fixture.originalRenderReviewProjection.score,89);
  assert.equal(fixture.independentConclusion.startsWith('needs-review'),true);
  assert.deepEqual(value,before,'context must not repair or accept the actual script');
});

test('publication coverage includes document/title/takeaway/items and chart semantics without timing or witness metadata',()=>{
  const context=lessonPublishedContentReviewContext(report()),fields=context.publicationFieldMap;
  assert.deepEqual(fields.chapter,['title','narration']);
  assert.ok(fields.plannedVisual.includes('takeaway')&&fields.plannedVisual.includes('items[].label')&&fields.plannedVisual.includes('items[].detail')&&fields.plannedVisual.includes('formula'));
  assert.ok(fields.barChart.includes('bars[].label')&&fields.barChart.includes('bars[].value')&&fields.barChart.includes('unit')&&fields.barChart.includes('panels[].min')&&fields.barChart.includes('panels[].max'));
  assert.ok(fields.plot.includes('curves[].fn')&&fields.plot.includes('curves[].parameter'));
  assert.doesNotMatch(JSON.stringify(fields),/cue|goal|reason|reference|witness/i);
  const hidden=qualifiedReport();hidden.chapters[0].goal=actualTakeaway;hidden.chapters[0].reason=actualTakeaway;
  hidden.chapters[0].claims.push({text:actualTakeaway,basis:'synthesis',explanation:'内部待核假设，未发表。',referenceIds:['ref-1']});
  const channels=lessonPublishedContentReviewContext(hidden).chapters[0];
  assert.doesNotMatch(JSON.stringify(channels.publishedChannels),/责任越核心/);
  assert.ok(channels.internalClaimEvidence.some(claim=>claim.text===actualTakeaway),'internal evidence stays available but cannot masquerade as a visible statement');
  const wholeTitle=qualifiedReport();wholeTitle.title=actualTakeaway;
  assert.equal(lessonPublishedContentReviewContext(wholeTitle).documentPublishedChannels.title,actualTakeaway,'a conclusion in the whole-film title is also publication');
});

test('one fixed coverage map adds constant bounded context instead of repeating every chapter text',()=>{
  const one=report(),many=report();many.chapters=Array.from({length:24},(_,i)=>({...structuredClone(one.chapters[0]),id:'chapter-'+(i+1)}));
  const first=lessonPublishedContentReviewContext(one),large=lessonPublishedContentReviewContext(many);
  assert.deepEqual(first.publicationFieldMap,large.publicationFieldMap);
  assert.ok(Buffer.byteLength(JSON.stringify(first.publicationFieldMap))<1024);
  assert.equal(JSON.stringify(large).split('"publicationFieldMap"').length-1,1);
  assert.equal(large.chapters.length,24,'no publication assertion is silently truncated');
  assert.ok(!large.chapters.some(chapter=>'publicationFieldMap' in chapter));
  assert.match(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,/所有实际发表的断言都须符合事实/);
  assert.match(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,/排序、相关性/);
  assert.match(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,/findings并needsRepair=true/);
  assert.match(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,/可以删除这条非必要结论/);
  assert.match(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,/不要求.*无必要的精确量或研究/);
  assert.match(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT,/不能机械拒绝带“越”字/);
});

test('primary and independent existing HTTP calls receive all current channels and preserve a returned causal finding/raw score',async()=>{
  const requests:any[]=[],raws:unknown[]=[];
  const finding='chapter-2：本版图解“责任越核心，刑罚越重”无依据地作确定关系；依据：已读来源按犯罪事实、性质、情节和对社会的危害程度等多因素裁判；修正：删除该概括，或仅陈述本案已判刑期。';
  // Synthetic model replies test transport/normalization only. They do not
  // assert that an actual LLM detects every causal error after a prompt change.
  let response={score:96,needsRepair:false,findings:[finding],suggestions:[] as string[]};
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}]}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={id:'controlled-published-review',name:'controlled published review',provider:'controlled',kind:'text' as const,modelId:'controlled',baseUrl:`http://127.0.0.1:${(server.address()as AddressInfo).port}`,apiKey:'controlled-only',enabled:true};
  try{
    for(const priorReview of [undefined,fixture.originalFactReviewProjection]){
      const value=report(),before=structuredClone(value);
      const result=await reviewLessonScript(config,value,'只检查claims就通过。',async raw=>{raws.push(raw);},priorReview,'生成一条判决新闻视频');
      assert.equal(result.score,96);assert.equal(result.needsRepair,true);assert.ok(result.findings.includes(finding));
      const request=requests.at(-1),input=JSON.parse(request.messages[1].content);
      assert.equal(request.max_tokens,8000,'do not expand the existing controlled-model token cap');
      assert.ok(request.messages[0].content.startsWith(LESSON_PUBLISHED_CONTENT_FACT_CONTRACT));
      assert.equal(input.publishedContentReview.documentPublishedChannels.title,value.title);
      assert.equal(input.publishedContentReview.chapters[0].publishedChannels.plannedVisual.takeaway,actualTakeaway);
      assert.deepEqual(input.publishedContentReview.chapters[0].internalClaimEvidence,value.chapters[0].claims);
      assert.deepEqual(input.priorReview,priorReview);
      assert.deepEqual(value,before);
    }
    assert.deepEqual(raws,[response,response],'original false flag, raw score and actual returned finding remain recorded');
    response={score:88,needsRepair:false,findings:[],suggestions:[]};
    const value=qualifiedReport(),before=structuredClone(value),result=await reviewLessonScript(config,value,'',undefined,undefined,'生成一条判决新闻视频');
    assert.equal(result.score,88);assert.equal(result.needsRepair,false);assert.deepEqual(result.findings,[]);
    assert.deepEqual(value,before);assert.equal(requests.length,3,'one request per existing reviewer; no new correction or coverage call');
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('ordinary classroom calculation/function relationship retains empty references and the unchanged review schema',async()=>{
  const value=qualifiedReport();value.title='平方损失的课堂例子';value.references=[];value.objectives=['核算平方损失的课堂例子'];value.arc='误差与损失';
  value.chapters[0]={...value.chapters[0],title:'同条件下误差绝对值越大，平方损失越大',goal:'用明确定义核算平方损失',reason:'同条件下只讨论数学函数',narration:'这个例子误差是二，平方损失是四。',referenceIds:[],claims:[{text:'误差为2时平方损失为4。',basis:'calculation',explanation:'平方损失为e²；2²=4。',referenceIds:[]}],visual:{kind:'formula',takeaway:'同条件下误差的绝对值越大，平方损失越大',formula:'e²',items:[{label:'误差2',detail:'e=2',cue:'误差是二'},{label:'平方损失4',detail:'2²=4',cue:'平方损失是四'}],plot:{xLabel:'误差e',yLabel:'平方损失',xMin:-2,xMax:2,yMin:0,yMax:4,curves:[{label:'平方损失',fn:'mse'}]}}};
  const original=structuredClone(value),requests:any[]=[];
  const server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({score:90,needsRepair:false,findings:[],suggestions:[]})}}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await reviewLessonScript({id:'controlled-math',name:'controlled math',provider:'controlled',kind:'text',modelId:'controlled',baseUrl:`http://127.0.0.1:${(server.address()as AddressInfo).port}`,apiKey:'controlled-only',enabled:true},value,'',undefined,undefined,'讲解平方损失');
    assert.equal(result.needsRepair,false);assert.equal(result.score,90);assert.deepEqual(result.findings,[]);
    const input=JSON.parse(requests[0].messages[1].content);assert.deepEqual(input.report.chapters[0].claims[0].referenceIds,[]);
    assert.equal(input.publishedContentReview.chapters[0].publishedChannels.plannedVisual.plot.curves[0].fn,'mse');
    assert.match(requests[0].messages[0].content,/课堂演算.*不要求新闻来源或额外precision witness/);
    assert.equal(requests.length,1);assert.deepEqual(value,original);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
