import test from 'node:test';
import assert from 'node:assert/strict';
import {withModelSnapshot,snapshotModels,type ModelSnapshot} from '../server/modelContext';
import {withReadOnlyTextFallback,ReadOnlyCapabilityError} from '../server/readOnlyFallback';
import {researchGaps} from '../server/narrativeResearch';
import {questionNeedsResearch,researchQuestion,type QuestionResearch} from '../server/questionResearch';
import {publicArticleUrl,publicResearchUrl} from '../server/publicResearch';
import {answerWithPi} from '../server/core';
import {sceneAuthorConfig} from '../server/sceneAuthorFallback';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';
import type {ModelConfig} from '../server/modelRegistry';
import type {WorkflowEvent} from '../src/types';

const primary:ModelConfig={id:'primary',name:'Primary',provider:'ark',kind:'text',modelId:'doubao-seed-2-1-pro-260915',apiKey:'private-primary-fixture',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',enabled:true};
const backup:ModelConfig={...primary,id:'backup',name:'Backup',modelId:'deepseek-v4-pro-ga-260813',apiKey:'private-backup-fixture'};
const snapshot:ModelSnapshot={text:primary,image:null,audio:null,understanding:null,textFallbacks:[backup]};
function stream(tool?:{sections:string[];summary:string;sourceIds?:string[]}){
  return new Response('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:primary.modelId,choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,id:'reply-call',type:'function',function:{name:'reply',arguments:JSON.stringify(tool)}}]}:{role:'assistant',content:'我会整理答复。'},finish_reason:tool?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
}
const body='这份官方说明介绍工具的实际用途、限制以及需要核对的版本。'.repeat(30);
const sources:QuestionResearch={observedAt:new Date().toISOString(),references:[{id:'ref-1',url:'https://official.example.org/announcement',title:'官方说明',excerpt:body,retrievedAt:new Date().toISOString(),verification:'public-page'}],failures:[],queries:[]};

test('read-only alternatives are frozen, de-duplicated, bounded and retain actual model provenance',async()=>{
  const attempts:any[]=[],called:string[]=[];
  await withModelSnapshot(snapshot,async()=>{
    const result=await withReadOnlyTextFallback(primary,async model=>{called.push(model.id);if(model.id===primary.id)throw new ReadOnlyCapabilityError('no usable citations');return 'verified';},{observe:a=>{attempts.push(a);}});
    assert.equal(result,'verified');
    assert.equal(sceneAuthorConfig(primary,''),primary);assert.equal(sceneAuthorConfig(primary,'actual layout failure'),backup);
  });
  assert.deepEqual(called,['primary','backup']);assert.deepEqual(attempts.map(a=>a.status),['failed','succeeded']);
  assert.deepEqual(snapshotModels(snapshot).map(m=>m.id),['primary','backup']);
  assert.equal(sceneAuthorConfig(primary,'actual layout failure'),primary,'no live registry lookup outside the captured snapshot');
});

test('auth, credits, filesystem failures and cancellation never replay through an alternative',async()=>{
  for(const error of [Object.assign(new Error('network wrapper'),{status:401}),Object.assign(new Error('forbidden'),{status:403}),new Error('联网搜索失败 HTTP 401（upstream）'),new Error('模型网络请求 status code: 403'),Object.assign(new Error('storage failed'),{code:'ENOSPC'}),Object.assign(new Error('insufficient credit'),{name:'CreditError'})]){
    let calls=0;await assert.rejects(()=>withReadOnlyTextFallback(primary,async()=>{calls++;throw new ReadOnlyCapabilityError('unavailable',{cause:error});},{alternatives:[backup]}));assert.equal(calls,1);
  }
  const abort=new AbortController();let calls=0;
  await assert.rejects(()=>runWithJobSignal(abort.signal,()=>withReadOnlyTextFallback(primary,async()=>{calls++;abort.abort();throw new Error('network');},{alternatives:[backup]})),JobCancelledError);assert.equal(calls,1);
});

test('search falls back to a different configured model while preserving real-search and citation checks',async()=>{
  const saved=globalThis.fetch,retries=process.env.QINGJIAN_TEXT_MAX_RETRIES,open=process.env.QINGJIAN_OPEN_WEBSEARCH_URL;const models:string[]=[];
  process.env.QINGJIAN_TEXT_MAX_RETRIES='0';process.env.QINGJIAN_OPEN_WEBSEARCH_URL='https://untrusted.example.org';
  globalThis.fetch=async(_url,init)=>{
    const request=JSON.parse(String(init?.body));models.push(request.model);
    if(request.model===primary.modelId)return new Response('{}',{status:503});
    return new Response(JSON.stringify({output:[{type:'web_search_call',status:'completed',action:{query:'actual'}},{content:[{type:'output_text',text:'可核对的搜索结果',annotations:[{type:'url_citation',url:'http://official.example.org/announcement',title:'原始说明'}]}]}]}));
  };
  try{
    const r=await withModelSnapshot(snapshot,()=>researchGaps(primary,'工具说明',[],'question'));
    assert.deepEqual(models,[primary.modelId,backup.modelId]);assert.equal(r.references[0].url,'https://official.example.org/announcement');
    assert(r.queries.some((q:any)=>q.provider==='text-backup'&&q.modelId===backup.modelId&&q.status==='succeeded'));
    assert.doesNotMatch(JSON.stringify(r),/private-primary-fixture|private-backup-fixture/);
  }finally{globalThis.fetch=saved;if(retries===undefined)delete process.env.QINGJIAN_TEXT_MAX_RETRIES;else process.env.QINGJIAN_TEXT_MAX_RETRIES=retries;if(open===undefined)delete process.env.QINGJIAN_OPEN_WEBSEARCH_URL;else process.env.QINGJIAN_OPEN_WEBSEARCH_URL=open;}
});

test('HTTP article spellings upgrade to HTTPS without weakening public URL validation',()=>{
  assert.equal(publicArticleUrl('http://official.example.org/report#fragment'),'https://official.example.org/report');
  assert.equal(publicResearchUrl('http://official.example.org/report'),undefined);
  for(const url of ['http://127.0.0.1/report','http://169.254.169.254/latest','http://user:secret@official.example.org/report','http://official.example.org:8080/report'])assert.equal(publicArticleUrl(url),undefined);
});

test('question research reads the actual source and never promotes a search snippet or challenge into a verified answer',async()=>{
  assert(questionNeedsResearch('请查一下最新版本'));assert(questionNeedsResearch('今天有哪些新闻？'));assert(!questionNeedsResearch('没有素材可以制作吗？'));assert(!questionNeedsResearch('不用搜索，解释最新版本这个词'));
  const direct=await researchQuestion(primary,'解释 http://official.example.org/report',{search:async()=>{throw new Error('direct source needs no search');},read:async url=>{assert.equal(url,'https://official.example.org/report');return {url,text:'<title>官方说明</title><article>'+body+'</article>',contentType:'text/html'};}});
  assert.equal(direct.references.length,1);assert.equal(direct.references[0].verification,'public-page');assert.equal(direct.references[0].publishedAt,undefined);
  const docs=await researchQuestion(primary,'查 https://official.example.org/report',{read:async url=>({url,text:'<title>官方说明</title><script>const old="<article>inert template</article>";</script><main>'+body+'</main><article>Follow Us '+('navigation contact '.repeat(8))+'</article>',contentType:'text/html'})});
  assert.equal(docs.references.length,1);assert.match(docs.references[0].excerpt,/实际用途/);assert.doesNotMatch(docs.references[0].excerpt,/Follow Us|inert template/);
  const footer=await researchQuestion(primary,'查 https://official.example.org/report',{read:async url=>({url,text:'<title>官方说明</title><article>Follow Us '+('navigation contact '.repeat(8))+'</article>',contentType:'text/html'})});
  assert.equal(footer.references.length,0,'short navigation chrome does not qualify as a source body');
  const unavailable=await researchQuestion(primary,'查一下新版本',{search:async()=>({summary:'unverified assertion',references:sources.references.map(r=>({...r,verification:'search-cited'})),queries:[]}),read:async url=>({url,text:'<title>Just a moment</title>Verify you are human',contentType:'text/html'})});
  assert.equal(unavailable.references.length,0);assert(unavailable.failures.length);
});

test('a real question reply validates source IDs before publishing and adds actual source links to the final answer',async()=>{
  const saved=globalThis.fetch;let calls=0;const visible:string[]=[];
  globalThis.fetch=async()=>{calls++;return stream({sections:['已核对用途与限制。'],summary:'应以官方说明为准。',sourceIds:[calls===1?'invented':'ref-1']});};
  try{
    const text=await answerWithPi('请查一下工具的新版本',primary,[],[],async(_id,text)=>{visible.push(text);},undefined,{research:async()=>sources});
    assert.equal(calls,2);assert.match(text,/https:\/\/official.example.org\/announcement/);assert.deepEqual(visible,['已核对用途与限制。']);
  }finally{globalThis.fetch=saved;}
});

test('two empty function turns use a schema-validated structured reply in the same three-request budget',async()=>{
  const saved=globalThis.fetch;let calls=0;const events:WorkflowEvent[]=[];
  globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));return request.response_format?new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({name:'reply',arguments:{sections:[],summary:'没有素材也能按主题创作。'}})}}]})):stream();};
  try{
    const text=await answerWithPi('没有素材能做什么？',primary,[],[],undefined,async value=>{events.splice(0,events.length,...structuredClone(value));});
    assert.equal(text,'没有素材也能按主题创作。');assert.equal(calls,3);assert(events.some(e=>e.tool==='reply_structured_backup'&&e.status==='succeeded'));
  }finally{globalThis.fetch=saved;}
});

test('a failed answer model switches once to the captured alternative without publishing its incomplete sections',async()=>{
  const saved=globalThis.fetch,retries=process.env.QINGJIAN_TEXT_MAX_RETRIES;process.env.QINGJIAN_TEXT_MAX_RETRIES='0';const calls:string[]=[];
  globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));calls.push(request.model);return request.model===primary.modelId?new Response('{}',{status:503}):stream({sections:[],summary:'备用模型已完成问题答复。'});};
  try{assert.equal(await withModelSnapshot(snapshot,()=>answerWithPi('解释制作流程',primary,[],[])),'备用模型已完成问题答复。');assert.deepEqual(calls,[primary.modelId,backup.modelId]);}
  finally{globalThis.fetch=saved;if(retries===undefined)delete process.env.QINGJIAN_TEXT_MAX_RETRIES;else process.env.QINGJIAN_TEXT_MAX_RETRIES=retries;}
});

test('unavailable live evidence produces an explicit limited answer and never asks a model to invent fresh facts',async()=>{
  const saved=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('must not invent a live conclusion');};
  try{const text=await answerWithPi('今天有什么新消息？',primary,[],[],undefined,undefined,{research:async()=>({...sources,references:[],failures:['no readable body']})});assert.match(text,/没有取得可核对的原文/);assert.doesNotMatch(text,/已核实|刚刚发布/);}
  finally{globalThis.fetch=saved;}
});
