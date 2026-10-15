import test from 'node:test';
import assert from 'node:assert/strict';
import {requestSemanticReview,semanticReviewDispositionAttempts} from '../server/semanticReview';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';

const config={id:'controlled-disposition',name:'Controlled disposition',provider:'ark',kind:'understanding' as const,modelId:'controlled-model',baseUrl:'https://fixture.invalid/v3',apiKey:'synthetic-only',enabled:true};
type Reply={score:number;needsRepair:boolean;findings:string[];suggestions:string[]};
const reply=(needsRepair:boolean,findings:string[]=[],score=88):Reply=>({score,needsRepair,findings,suggestions:[]});

async function controlled(t:{after:(cleanup:()=>void)=>void},responses:Reply[]){
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  const requests:any[]=[];
  globalThis.fetch=async(_url,options)=>{
    requests.push(JSON.parse(String(options?.body)));
    assert.ok(requests.length<=responses.length,'unexpected extra review request');
    return Response.json({choices:[{message:{content:JSON.stringify(responses[requests.length-1])}}]});
  };
  // This is synthetic protocol data, not the unknown original P29 wire flag
  // and not a claim that these placeholders are actual pixel/audio evidence.
  const messages=[{role:'user',content:[{type:'text',text:'Controlled same-film context'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,synthetic'}}]}];
  const before=structuredClone({responses,messages}),result=await requestSemanticReview(config,messages);
  assert.deepEqual({responses,messages},before,'the original response fixtures and caller message array remain unchanged');
  return {result,requests,messages};
}

test('synthetic false/nonempty disposition is clarified once on the same context; both raw flags and the original88 survive',async t=>{
  const first=reply(false,['chapter-1：字幕与当前画面一致，边界清楚。']),second=reply(false);
  const {result,requests,messages}=await controlled(t,[first,second]);
  assert.equal(requests.length,2);assert.equal(result.score,88);assert.equal(result.needsRepair,false);assert.deepEqual(result.findings,[]);
  assert.deepEqual(result.dispositionAttempts,[{attempt:1,...first},{attempt:2,...second}].map(({suggestions,...entry})=>entry));
  assert.deepEqual(requests[0].messages,messages);assert.deepEqual(requests[1].messages.slice(0,-1),messages);
  assert.equal(requests[1].messages.length,messages.length+1,'a local contradiction clarification preserves the same media context');
});

test('a first true disposition with an actual defect is returned without a new clarification or weakened finding',async t=>{
  const original=reply(true,['chapter-2：本次12秒帧中的标签遮住正文；重排该标签。']);
  const {result,requests}=await controlled(t,[original]);
  assert.equal(requests.length,1);assert.equal(result.score,88);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,original.findings);
  assert.deepEqual(result.dispositionAttempts,[{attempt:1,score:88,needsRepair:true,findings:original.findings}]);
});

test('mixed observations and a genuine defect can be clarified to true without filtering away the real defect',async t=>{
  const real='chapter-2：本次12秒帧的标签遮住正文；重排该标签。';
  const first=reply(false,['chapter-1：字幕清楚。',real]),second=reply(true,[real]);
  const {result,requests}=await controlled(t,[first,second]);
  assert.equal(requests.length,2);assert.equal(result.score,88);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,[real]);
  assert.deepEqual(result.dispositionAttempts,[{attempt:1,score:88,needsRepair:false,findings:first.findings},{attempt:2,score:88,needsRepair:true,findings:[real]}]);
});

test('a second false/nonempty disposition stays conservatively rejected, with no third request or automatic deletion',async t=>{
  const first=reply(false,['chapter-1：待核的原始观察。']),second=reply(false,['chapter-1：仍需核对的原始观察。']);
  const {result,requests}=await controlled(t,[first,second]);
  assert.equal(requests.length,2);assert.equal(result.score,88);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,second.findings);
  assert.deepEqual(result.dispositionAttempts,[{attempt:1,score:88,needsRepair:false,findings:first.findings},{attempt:2,score:88,needsRepair:false,findings:second.findings}]);
});

test('raw false with empty findings and a score below80 remains a one-request low-score rejection',async t=>{
  const original=reply(false,[],76),{result,requests}=await controlled(t,[original]);
  assert.equal(requests.length,1);assert.equal(result.score,76);assert.equal(result.needsRepair,true);assert.deepEqual(result.findings,[]);
  assert.deepEqual(result.dispositionAttempts,[{attempt:1,score:76,needsRepair:false,findings:[]}]);
});

test('a technical failure on the only clarification preserves the prior raw disposition without a third request',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;
  const first=reply(false,['chapter-1：边界清楚的受控观察。']);
  globalThis.fetch=async()=>++calls===1
    ?Response.json({choices:[{message:{content:JSON.stringify(first)}}]})
    :new Response('synthetic authentication response, not a provider',{status:401});
  await assert.rejects(requestSemanticReview(config,[]),error=>{
    assert.ok(error instanceof Error);assert.equal(error.message,'HTTP 401');
    assert.deepEqual(semanticReviewDispositionAttempts(error),[{attempt:1,score:88,needsRepair:false,findings:first.findings}]);
    return true;
  });
  assert.equal(calls,2,'the technical failure is not a request to invent a third clarification');
});

test('a missing nested publication field cannot erase a legal core disposition or its unfiltered identical-spelling allegation',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});let calls=0;
  const first=reply(false,['chapter-1：字幕清楚的受控观察。','chapter-1：将“ShShell”误写为“ShShell”。']);
  globalThis.fetch=async()=>++calls===1
    ?Response.json({choices:[{message:{content:JSON.stringify(first)}}]})
    :new Response('synthetic authentication response, not a provider',{status:401});
  await assert.rejects(requestSemanticReview(config,[],undefined,true),error=>{
    assert.ok(error instanceof Error);assert.equal(error.message,'HTTP 401');
    assert.deepEqual(semanticReviewDispositionAttempts(error),[{attempt:1,score:88,needsRepair:false,findings:first.findings}],
      'the unfiltered core evidence is retained before the missing nested newsPublication field rejects the response');
    return true;
  });
  assert.equal(calls,2,'the nested protocol error and subsequent401 share the same two-attempt budget');
});

test('cancellation during the nested-protocol retry delay retains the parsed first disposition and never dispatches attempt2',async t=>{
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  const controller=new AbortController(),first=reply(false,['chapter-1：本轮已解析的受控原始观察。']);
  let calls=0,timer:ReturnType<typeof setTimeout>|undefined,fetchReturned=false;
  t.after(()=>{if(timer)clearTimeout(timer);});
  globalThis.fetch=async()=>{
    calls++;timer=setTimeout(()=>{assert.equal(fetchReturned,true,'the first response must already have returned');controller.abort();},50);
    fetchReturned=true;return Response.json({choices:[{message:{content:JSON.stringify(first)}}]});
  };
  let inner:{error:unknown;attempts:ReturnType<typeof semanticReviewDispositionAttempts>}|undefined;
  await assert.rejects(runWithJobSignal(controller.signal,async()=>{
    try{return await requestSemanticReview(config,[],undefined,true);}
    catch(error){
      // renderReview consumes this evidence inside the job context, before
      // the outer cancellation guard may replace the thrown error object.
      inner={error,attempts:semanticReviewDispositionAttempts(error)};throw error;
    }
  }),JobCancelledError);
  assert.ok(inner?.error instanceof JobCancelledError);
  assert.deepEqual(inner.attempts,[{attempt:1,score:88,needsRepair:false,findings:first.findings}],
    'the first core response survives at the real renderReview consumption boundary');
  assert.equal(calls,1,'abort happens during the retry delay, not before fetch or after attempt2');
});
