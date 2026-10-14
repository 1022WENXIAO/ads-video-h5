import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {generateAudio,generateImage,ProviderError} from '../server/providers';
import {AudioRateLimitError,markAudioRateLimitRefusal,recoverAudioRequest} from '../server/audioRateLimit';
import {getJobTransportDiagnostics,JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import type {ModelConfig} from '../server/modelRegistry';

const bytes=Buffer.alloc(300,1);bytes.write('ID3');
const success={code:0,audio:bytes.toString('base64'),duration:1};
const refusal={error:{code:'RateLimitExceeded',message:'Audio capacity rejected this request'}};
const config=():ModelConfig=>({id:randomUUID(),kind:'audio',enabled:true,provider:'doubao',modelId:'seed-audio-1.0',name:'Local HTTP fixture',apiKey:'test-key-'+randomUUID(),baseUrl:'https://openspeech.bytedance.com'});
type Request={at:number;body:any;requestId:string;key:string};
const respond=(res:ServerResponse,status:number,body:unknown,headers:Record<string,string>={})=>{res.writeHead(status,{'Content-Type':'application/json',...headers});res.end(typeof body==='string'?body:JSON.stringify(body));};
async function fixture(handler:(req:IncomingMessage,res:ServerResponse,request:Request,requests:Request[])=>void|Promise<void>,run:(requests:Request[])=>Promise<void>,timeoutMs?:number){
  const requests:Request[]=[],original=globalThis.fetch;
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const request={at:Date.now(),body:JSON.parse(body||'{}'),requestId:String(req.headers['x-api-request-id']||''),key:String(req.headers['x-api-key']||'')};requests.push(request);try{await handler(req,res,request,requests);}catch{if(!res.destroyed)res.destroy();}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
  globalThis.fetch=(input,init)=>{assert.ok(['https://openspeech.bytedance.com','https://ark.cn-beijing.volces.com'].includes(new URL(String(input)).origin),'fixture must never issue an external provider request');return original(`http://127.0.0.1:${port}/audio`,{...init,...(timeoutMs?{signal:AbortSignal.timeout(timeoutMs)}:{})});};
  try{await run(requests);}finally{globalThis.fetch=original;server.closeAllConnections();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Local audio HTTP fixture close timed out')),2000);server.close(()=>{clearTimeout(timer);resolve();});});}
}
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean){const deadline=Date.now()+2000;while(!check()){if(Date.now()>=deadline)throw new Error('HTTP fixture did not reach expected state');await pause(5);}}

test('real HTTP 429 rejection recovers with one logical ID and an aggregate job diagnostic',async()=>{
  const model=config();
  await fixture((_req,res,_request,requests)=>respond(res,requests.length===1?429:200,requests.length===1?refusal:success,{'Retry-After':'0'}),async requests=>{
    await runWithJobSignal(new AbortController().signal,async()=>{
      const result=await generateAudio('Private controlled fixture words',model);
      assert.deepEqual(result.bytes,bytes);assert.equal(result.audioRecovery?.attempts,2);
      assert.equal(requests.length,2);assert.ok(requests[0].requestId);assert.equal(requests[0].requestId,requests[1].requestId);assert.deepEqual(requests[0].body,requests[1].body);
      const aggregate=getJobTransportDiagnostics().find(item=>item.recoveryKind==='audio-rate-limit');assert.equal(aggregate?.outcome,'recovered');assert.equal(aggregate?.attempts,2);assert.equal(aggregate?.status,429);assert.equal(aggregate?.requestId,requests[0].requestId);
      const evidence=JSON.stringify([result.audioRecovery,aggregate]);assert.ok(!evidence.includes(model.apiKey));assert.ok(!evidence.includes('Private controlled fixture words'));
      assert.deepEqual(result.audioRecovery?.events.map(e=>e.kind),['attempt','rate-limited','attempt','response']);
    });
  });
});
test('real repeated refusals stop after three POSTs and retain the original failure cause',async()=>{
  await fixture((_req,res)=>respond(res,429,refusal,{'Retry-After':'0'}),async requests=>{
    await assert.rejects(()=>generateAudio('Controlled fixture',config()),error=>{assert.ok(error instanceof AudioRateLimitError);assert.equal(error.attempts,3);assert.equal(error.retryExhausted,true);assert.ok(error.cause instanceof ProviderError);assert.equal(error.cause.status,429);return true;});
    assert.equal(requests.length,3);assert.equal(new Set(requests.map(request=>request.requestId)).size,1);
  });
});
test('long Retry-After fails without an early replay or a false claim that recovery was exhausted',async()=>{
  await fixture((_req,res)=>respond(res,429,refusal,{'Retry-After':'120'}),async requests=>{
    const started=Date.now();await assert.rejects(()=>generateAudio('Controlled fixture',config()),error=>{assert.ok(error instanceof AudioRateLimitError);assert.equal(error.attempts,1);assert.equal(error.retryExhausted,false);assert.match(error.message,/未提前重新提交/);return true;});
    assert.equal(requests.length,1);assert.ok(Date.now()-started<1000);
  });
});
test('audio recovery diagnostics redact a credential echoed in an upstream error code',async()=>{
  const model=config();await fixture((_req,res,_request,requests)=>respond(res,requests.length===1?429:200,requests.length===1?{error:{code:model.apiKey}}:success,{'Retry-After':'0'}),async()=>{await runWithJobSignal(new AbortController().signal,async()=>{await generateAudio('Private fixture',model);assert.ok(!JSON.stringify(getJobTransportDiagnostics()).includes(model.apiKey));});});
});
test('a settings mutation cannot change the credential or payload between definitive-refusal attempts',async()=>{
  const model=config(),key=model.apiKey;
  await fixture((_req,res,_request,requests)=>{if(requests.length===1){model.apiKey='replacement-'+randomUUID();respond(res,429,refusal,{'Retry-After':'0'});}else respond(res,200,success);},async requests=>{await generateAudio('Immutable controlled words',model);assert.equal(requests.length,2);assert.ok(requests.every(request=>request.key===key));assert.deepEqual(requests[0].body,requests[1].body);});
});
test('HTTP-date Retry-After is honored before a definite rejected request is replayed',async()=>{
  let earliest=0;
  await fixture((_req,res,_request,requests)=>{if(requests.length===1){const header=new Date(Date.now()+2200).toUTCString();earliest=Date.parse(header);respond(res,429,refusal,{'Retry-After':header});}else respond(res,200,success);},async requests=>{
    const result=await generateAudio('Controlled fixture',config());assert.equal(requests.length,2);assert.ok(requests[1].at>=earliest);assert.ok(result.audioRecovery!.retryDelaysMs[0]>1000);
  });
});
test('message-only rate-limit refusals recover, but accepted-task prose never authorizes another POST',async()=>{
  await fixture((_req,res,_request,requests)=>respond(res,requests.length===1?429:200,requests.length===1?{message:'Too many requests: rate limit exceeded'}:success,{'Retry-After':'0'}),async requests=>{await generateAudio('Controlled fixture',config());assert.equal(requests.length,2);});
  const bodies=[{message:'Task accepted; audio generation is processing. Please poll the original request.'},{error:{code:'RateLimit',message:'Task accepted; please poll the original request.'}},{message:'服务已受理，音频生成中，请查询原任务。'},{message:'Unrecognized response'},{error:{code:'Busy',detail:'Request pending'}}];
  let index=0;await fixture((_req,res)=>respond(res,429,bodies[index++],{'Retry-After':'0'}),async requests=>{for(let i=0;i<bodies.length;i++){await assert.rejects(()=>generateAudio('Controlled fixture '+i,config()),error=>error instanceof ProviderError&&error.status===429);assert.equal(requests.length,i+1);}});
});
test('unsafe or unrecognized 429 bodies and explicit no-retry never authorize a paid replay',async()=>{
  const cases:[unknown,Record<string,string>?][]=[['not JSON'],['{"error":'],[{}],[null],[[]],[{error:{}}],[{error:false}],[{error:[]}],[{status:'unknown'}],[{code:''}],[{code:0,error:'busy'}],[{error:'busy',task_id:'accepted'}],[{error:'busy',data:{job:{id:'accepted'}}}],[{error:'busy',audio:'payload'}],[{error:'busy',output:{url:'https://vendor/audio'}}],[{error:'busy',status:'processing'}],[refusal,{'x-task-id':'accepted'}],[refusal,{'Location':'/task/accepted'}],[refusal,{'x-should-retry':'false'}],...['not-a-date','0.1','1.5','-1','2026-10-15T01:00:00Z','Fri, 31 Feb 2027 01:00:00 GMT'].map(value=>[refusal,{'Retry-After':value}] as [unknown,Record<string,string>])];
  let index=0;
  await fixture((_req,res)=>{const [body,headers]=cases[index++];respond(res,429,body,headers);},async requests=>{
    for(let i=0;i<cases.length;i++){await assert.rejects(()=>generateAudio('Controlled fixture '+i,config()),error=>error instanceof ProviderError&&error.status===429);assert.equal(requests.length,i+1);}
  });
});
test('real HTTP auth, timeout-status, 5xx and socket failures are never replayed',async()=>{
  const statuses=[401,403,408,500,502];let index=0;
  await fixture((req,res)=>{if(index===statuses.length){index++;req.socket.destroy();}else respond(res,statuses[index++],{error:{code:'NotRetryableAudio'}});},async requests=>{
    for(let i=0;i<statuses.length+1;i++){await assert.rejects(()=>generateAudio('Controlled fixture '+i,config()),error=>error instanceof ProviderError);assert.equal(requests.length,i+1);}
  });
});
test('an ambiguous in-flight timeout makes only one actual HTTP submission',async()=>{
  await fixture(()=>{},async requests=>{await assert.rejects(()=>generateAudio('Controlled fixture',config()),error=>error instanceof ProviderError&&error.code==='TIMEOUT');assert.equal(requests.length,1);},60);
});
test('image generation retains its single-submission behavior for HTTP 429',async()=>{
  await fixture((_req,res)=>respond(res,429,refusal,{'Retry-After':'0'}),async requests=>{await assert.rejects(()=>generateImage('Controlled fixture',{...config(),kind:'image',baseUrl:'https://ark.cn-beijing.volces.com',modelId:'doubao-seedream-5-0-flash-260915'}),error=>error instanceof ProviderError&&error.status===429);assert.equal(requests.length,1);});
});
test('same-key audio uses FIFO single concurrency while different credentials remain independent',async()=>{
  let active=0,peak=0;
  await fixture(async(_req,res)=>{active++;peak=Math.max(peak,active);await pause(50);respond(res,200,success);active--;},async requests=>{
    const shared=config();await Promise.all(['first','second','third'].map(text=>generateAudio(text,shared)));assert.equal(peak,1);assert.deepEqual(requests.map(request=>request.body.text_prompt),['first','second','third']);
    peak=0;await Promise.all([generateAudio('other-a',config()),generateAudio('other-b',config())]);assert.equal(peak,2);
  });
});
test('cancellation removes a queued request without submitting or breaking the next FIFO request',async()=>{
  let release:()=>void=()=>{};
  await fixture(async(_req,res,_request,requests)=>{if(requests.length===1)await new Promise<void>(resolve=>{release=resolve;});respond(res,200,success);},async requests=>{
    const model=config(),first=generateAudio('first',model);await until(()=>requests.length===1);const abort=new AbortController();const queued=runWithJobSignal(abort.signal,()=>generateAudio('cancelled',model)).catch(error=>error);await pause(10);abort.abort();assert.ok(await queued instanceof JobCancelledError);assert.equal(requests.length,1);const third=generateAudio('third',model);release();await first;await third;assert.deepEqual(requests.map(request=>request.body.text_prompt),['first','third']);
  });
});
test('cancelled rate-limit waiting preserves the shared cooldown for the next credential peer',async()=>{
  await fixture((_req,res,_request,requests)=>respond(res,requests.length===1?429:200,requests.length===1?refusal:success,{'Retry-After':'1'}),async requests=>{
    const model=config(),abort=new AbortController();const first=runWithJobSignal(abort.signal,()=>generateAudio('cancelled-after-refusal',model)).catch(error=>error);await until(()=>requests.length===1);await pause(30);const second=generateAudio('next',model);abort.abort();assert.ok(await first instanceof JobCancelledError);await second;assert.equal(requests.length,2);assert.ok(requests[1].at-requests[0].at>=990,'a cancelled waiter cannot erase the provider cooldown');
  });
});
test('in-flight cancellation remains cancellation and never creates another submission',async()=>{
  await fixture(()=>{},async requests=>{const abort=new AbortController(),running=runWithJobSignal(abort.signal,()=>generateAudio('Controlled fixture',config())).catch(error=>error);await until(()=>requests.length===1);abort.abort();assert.ok(await running instanceof JobCancelledError);assert.equal(requests.length,1);});
});
test('no-retry rejects the logical request but preserves a real shared Retry-After cooldown',async()=>{
  await fixture((_req,res,_request,requests)=>respond(res,requests.length===1?429:200,requests.length===1?refusal:success,{'Retry-After':'1','x-should-retry':'false'}),async requests=>{
    const model=config();await assert.rejects(()=>generateAudio('first',model),error=>error instanceof ProviderError);await generateAudio('next',model);assert.equal(requests.length,2);assert.ok(requests[1].at-requests[0].at>=990);
  });
});
test('recovery uses one cumulative 30-second wait budget rather than 30 seconds per retry',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let attempts=0;
  const result=recoverAudioRequest('https://openspeech.bytedance.com/audio',randomUUID(),async()=>{attempts++;const error=new ProviderError('Definite refusal','RateLimit',429,true);markAudioRateLimitRefusal(error,new Response(JSON.stringify(refusal),{status:429,headers:{'Retry-After':'20'}}),refusal);throw error;}).catch(error=>error);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(attempts,1);t.mock.timers.tick(20_000);await new Promise<void>(resolve=>setImmediate(resolve));const error=await result;assert.ok(error instanceof AudioRateLimitError);assert.equal(error.attempts,2);assert.equal(error.waitedMs,20_000);assert.equal(error.retryExhausted,true);assert.equal(attempts,2);
});
test('FIFO queue times out at 300 seconds without submitting the queued request',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});const key=randomUUID();let release:()=>void=()=>{},queuedSubmissions=0;
  const first=recoverAudioRequest('https://openspeech.bytedance.com/audio',key,()=>new Promise<void>(resolve=>{release=resolve;}));await new Promise<void>(resolve=>setImmediate(resolve));
  const queued=recoverAudioRequest('https://openspeech.bytedance.com/audio',key,async()=>{queuedSubmissions++;}).catch(error=>error);await new Promise<void>(resolve=>setImmediate(resolve));t.mock.timers.tick(300_000);const error=await queued;assert.equal(error.code,'AUDIO_QUEUE_TIMEOUT');assert.equal(queuedSubmissions,0);release();await first;
});
