import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {LessonReport} from '../shared/types';
import {lessonScriptReviewContext} from '../server/lessonScriptReviewContext';
import {reviewLessonScript} from '../server/lessonWorkflow';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p21-news-review-scope.json',import.meta.url),'utf8'));
function report():LessonReport{
  return {workflowId:'controlled-news-scope',title:'纸尿裤调查通报',audience:'普通观众',objectives:['分清样本结论和普遍保证'],arc:'通报、范围、限制',requestedSeconds:30,explicitDuration:true,format:'9:16',limitations:[],
    references:[{id:'ref-8',title:'Controlled source excerpt',url:'https://example.org/controlled-news',verification:'news-page',freshness:'fresh',publishedAt:'2026-10-15T08:15:00.000Z',dateEvidence:'JSON-LD datePublished: 2026-10-15T08:15:00.000Z',excerpt:'2026年10月15日通报：抽检覆盖168家企业、180个品牌、368批次成品、32批次重点部位，均未检出甲酰胺。15个品牌58批次留存样品和210份血液样本均未检出。结论限本次调查范围。'}],
    hotResearch:{asOf:'2026-10-15T10:36:14.972Z',windowHours:24,topics:[],signals:[]},
    // Narrations are exact archived text. The rest is a controlled request
    // harness; this does not claim byte-exact revised P21 nested visuals.
    chapters:fixture.narrations.map((c:any,index:number)=>({id:c.chapterId,title:'受控章节',role:index===0?'hook':index===2?'recap':'foundation',goal:'核对本版内容',prerequisites:[],narration:c.text,reason:'受控测试',referenceIds:['ref-8'],claims:[],visual:{kind:'concept',takeaway:'只对本次范围作结论',items:index===1?[structuredClone(fixture.priorVisualItem)]:[]}})),
  };
}

test('actual 133-character script is indexed without making every source statistic mandatory narration',()=>{
  const value=report(),before=structuredClone(value),scope=lessonScriptReviewContext(value).newsScriptScope!;
  assert.deepEqual(scope.narrationCharacters.perChapter,fixture.serverCounts);
  assert.equal(scope.narrationCharacters.total,133);
  assert.ok(scope.narrationCharacters.total<fixture.serverBudget.totalCharacters);
  const second=scope.currentChapterFields.find(c=>c.chapterId==='chapter-2')!;
  assert.match(second.narration,/368批成品.*32批/);
  assert.equal(second.visual.items[0].label,'168家企业');
  assert.ok(!scope.currentChapterFields.some(c=>c.narration.includes('210')));
  assert.match(scope.contract,/不能自行缩小用户要求/);
  assert.match(scope.absenceFindings,/除非用户明确要求口播/);
  assert.deepEqual(value,before);
  delete value.hotResearch;
  assert.ok(!('newsScriptScope' in lessonScriptReviewContext(value)));
});

test('real HTTP primary and independent requests keep current scope, original requirements and archived rejecting scores',async()=>{
  const payloads:any[]=[],responses=[fixture.rawPrimaryReview,fixture.rawIndependentReview];
  const server=createServer(async(request,outgoing)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));payloads.push(JSON.parse(Buffer.concat(chunks).toString()));outgoing.writeHead(200,{'Content-Type':'application/json'});outgoing.end(JSON.stringify({choices:[{message:{content:JSON.stringify(responses[Math.min(payloads.length-1,1)])}}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={id:'controlled-news-scope',name:'Local HTTP only',provider:'controlled',kind:'text' as const,modelId:'controlled',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,apiKey:'controlled-test-only',enabled:true},requestedAt=Date.parse('2026-10-15T10:36:13.446Z'),value=report();
  try{
    const primary=await reviewLessonScript(config,value,'',undefined,undefined,fixture.userPrompt,requestedAt);
    const independent=await reviewLessonScript(config,value,'',undefined,primary,fixture.userPrompt,requestedAt);
    assert.equal(primary.score,96);assert.equal(independent.score,75);assert.equal(independent.needsRepair,true);
    for(const finding of fixture.rawIndependentReview.findings)assert.ok(independent.findings.includes(finding),'the server must not discard or rewrite the old rejecting result');
    assert.equal(payloads.length,2,'scope evidence uses existing requests');
    for(const payload of payloads){const input=JSON.parse(payload.messages.at(-1).content);assert.equal(input.userPrompt,fixture.userPrompt);assert.equal(input.newsScriptScope.narrationCharacters.total,133);assert.deepEqual(input.newsScriptScope.currentChapterFields[1].narration,value.chapters[1].narration);assert.match(input.report.references[0].excerpt,/210份/);}
    assert.deepEqual(JSON.parse(payloads[1].messages.at(-1).content).priorReview,primary);
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('wrong figures, absolute guarantees and explicit spoken requirements remain visible blocking findings',async()=>{
  let defect='',seen:any;
  const server=createServer(async(request,outgoing)=>{const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));seen=JSON.parse(JSON.parse(Buffer.concat(chunks).toString()).messages.at(-1).content);outgoing.writeHead(200,{'Content-Type':'application/json'});outgoing.end(JSON.stringify({choices:[{message:{content:JSON.stringify({score:84,needsRepair:true,findings:[defect]})}}]}));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={id:'controlled-news-scope-negative',name:'Local HTTP only',provider:'controlled',kind:'text' as const,modelId:'controlled',baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,apiKey:'controlled-test-only',enabled:true};
  try{
    for(const kind of ['wrong-number','absolute-guarantee','explicit-spoken-requirement']){
      const value=report();let prompt=fixture.userPrompt;
      if(kind==='wrong-number'){value.chapters[1].narration=value.chapters[1].narration.replace('368','386');defect='chapter-2：386批成品；依据：来源368批；修正：纠正实际数值。';}
      else if(kind==='absolute-guarantee'){value.chapters[2].narration='所有渠道的所有纸尿裤永远都不含甲酰胺。';defect='chapter-3：所有纸尿裤永远都不含甲酰胺；依据：仅本次检测范围；修正：保留结论边界。';}
      else{prompt+='必须在口播中明确说明210份血液样本。';defect='chapter-3：缺少用户明确要求口播的210份血液样本；修正：满足原用户要求。';}
      const result=await reviewLessonScript(config,value,'',undefined,undefined,prompt,Date.parse('2026-10-15T10:36:13.446Z'));
      assert.equal(result.needsRepair,true);assert.equal(result.score,84);assert.ok(result.findings.includes(defect));assert.equal(seen.userPrompt,prompt);assert.equal(seen.newsScriptScope.currentChapterFields[2].narration,value.chapters[2].narration);
    }
  }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
