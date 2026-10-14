import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateSemanticReview,reviewNeedsContentRepair} from '../server/reviewResults';
import {newsPublicationFrameEvidence} from '../server/newsPublicationReview';
import {requestSemanticReview} from '../server/semanticReview';
import type {ModelConfig} from '../server/modelRegistry';

const expected={chapterId:'ch1',label:'报道日期：2026-10-14（北京时间）'};
const observation={visible:true,...expected,quote:expected.label,frameTime:2.5};
const semantic={score:100,needsRepair:false,findings:[],suggestions:[]};
test('news date evidence requires the actual first-chapter sampled frame and exact readable date',()=>{
  assert.equal(newsPublicationFrameEvidence(observation,expected,[.6,2.5,9],{start:0,end:8})?.frameTime,2.5);
  assert.ok(newsPublicationFrameEvidence({...observation,quote:'报道日期： 2026-10-14 (北京时间) · 画面示意'},expected,[2.5],{start:0,end:8}),'the exact complete visible note, including its known illustration suffix, is valid evidence');
  for(const patch of [{visible:false},{chapterId:'ch2'},{frameTime:2.6},{frameTime:9},{quote:'报道日期：2026-10-15（北京时间）'},{quote:'事件日期：2026-10-14（北京时间）'},{quote:''}])assert.equal(newsPublicationFrameEvidence({...observation,...patch},expected,[.6,2.5,9],{start:0,end:8}),undefined);
  assert.equal(newsPublicationFrameEvidence(undefined,expected,[2.5],{start:0,end:8}),undefined);
});
test('a semantic score or self-reported proof cannot substitute for a frame observation',()=>{
  assert.equal(validateSemanticReview({...semantic,newsPublication:{...observation,renderedSha256:'self-report',htmlVerified:true}}).newsPublication?.quote,expected.label);
  assert.deepEqual(Object.keys(validateSemanticReview({...semantic,newsPublication:{...observation,renderedSha256:'self-report',htmlVerified:true}}).newsPublication!).sort(),['chapterId','frameTime','quote','visible']);
  assert.equal(validateSemanticReview(semantic).newsPublication,undefined);
  for(const patch of [{visible:'yes'},{frameTime:NaN},{chapterId:0},{quote:null}])assert.throws(()=>validateSemanticReview({...semantic,newsPublication:{...observation,...patch}}),/抽帧观察格式无效/);
});

test('missing date observation retries only the existing review request; a real absence stays a content defect',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const config={id:'fixture',kind:'understanding',provider:'test',modelId:'fixture',baseUrl:'https://example.invalid/v1',apiKey:'fixture',enabled:true} as ModelConfig;
  let calls=0;
  globalThis.fetch=(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(++calls===1?semantic:{...semantic,newsPublication:observation})}}]}),{headers:{'Content-Type':'application/json'}})) as typeof fetch;
  assert.equal((await requestSemanticReview(config,[],undefined,true)).newsPublication?.quote,expected.label);assert.equal(calls,2);
  calls=0;globalThis.fetch=(async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({...semantic,newsPublication:{...observation,visible:false,quote:''}})}}]}));}) as typeof fetch;
  assert.equal((await requestSemanticReview(config,[],undefined,true)).newsPublication?.visible,false);assert.equal(calls,1);
  const checks=[{name:'成片语义审查',passed:false},{name:'新闻报道日期可见',passed:false}];
  assert.equal(reviewNeedsContentRepair({status:'needs-review',checks}),false,'an unavailable review must not synthesize or redraw media');
  assert.equal(reviewNeedsContentRepair({status:'needs-review',checks:[checks[1]],semantic:{score:90,findings:[]}}),true,'an actual observed date absence needs visual repair');
});
