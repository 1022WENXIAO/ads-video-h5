import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createTcpServer,type Socket} from 'node:net';
import {createServer,type ServerResponse} from 'node:http';
import {randomUUID} from 'node:crypto';
import {generateAudio,generateImage,ProviderError} from '../server/providers';
import {AudioConnectTimeoutError,AudioRateLimitError,markAudioConnectTimeout,markAudioRateLimitRefusal,recoverAudioRequest} from '../server/audioRateLimit';
import {getJobTransportDiagnostics,JobCancelledError,runWithJobSignal} from '../server/jobExecution';
import type {ModelConfig} from '../server/modelRegistry';

const nativeFetch=globalThis.fetch;
const bytes=Buffer.alloc(300,1);bytes.write('ID3');
const success={code:0,audio:bytes.toString('base64'),duration:1};
const refusal={error:{code:'RateLimitExceeded',message:'Too many requests'}};
const model=():ModelConfig=>({id:randomUUID(),kind:'audio',enabled:true,provider:'doubao',modelId:'seed-audio-1.0',name:'Local TLS/HTTP fixture',apiKey:'test-secret-'+randomUUID(),baseUrl:'https://openspeech.bytedance.com'});
const respond=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Retry-After':'0'});res.end(JSON.stringify(body));};
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
let capturedNativeFailure:TypeError;
const nativeFailure=()=>{assert.ok(capturedNativeFailure instanceof TypeError,'real native TLS-stall fixture must have completed');return capturedNativeFailure;};
function wrappedNative(){const error=new ProviderError('Controlled pre-header failure','NETWORK_ERROR',undefined,true,{cause:nativeFailure()});markAudioConnectTimeout(error,error.cause);return error;}
async function httpFixture(run:(url:string,requests:Array<{body:string;requestId:string}>)=>Promise<void>,response=success){
  const requests:Array<{body:string;requestId:string}>=[];
  const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({body,requestId:String(req.headers['x-api-request-id']||'')});respond(res,200,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/audio`;
  try{await run(url,requests);}finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned HTTP fixture close timed out')),2000);server.close(()=>{clearTimeout(timer);resolve();});});}
}
async function nativeTlsStall(init?:RequestInit){
  const sockets=new Set<Socket>(),records:Buffer[]=[];let connections=0;
  const server=createTcpServer(socket=>{connections++;sockets.add(socket);socket.on('data',data=>records.push(Buffer.from(data)));socket.on('close',()=>sockets.delete(socket));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  try{
    let failure:unknown;
    try{await nativeFetch(`https://127.0.0.1:${port}/audio`,{...init,method:'POST',redirect:'error'});}catch(error){failure=error;}
    assert.ok(failure instanceof TypeError);assert.equal(failure.message,'fetch failed');
    const cause=failure.cause as Error&{code?:string;[key:symbol]:unknown};
    assert.ok(cause instanceof Error);assert.equal(cause.name,'ConnectTimeoutError');assert.equal(cause.code,'UND_ERR_CONNECT_TIMEOUT');
    assert.equal(cause[Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT')],true);
    assert.equal(connections,1);assert.ok(records.length>0);assert.equal(records[0][0],0x16,'TLS handshake record, not an HTTP request');
    const wire=Buffer.concat(records).toString('latin1');
    assert.ok(!wire.includes('POST '));assert.ok(!wire.includes('X-Api-Key'));assert.ok(!wire.includes('Authorization'));assert.ok(!wire.includes('text_prompt'));
    return {failure,wire,connections};
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned TLS fixture close timed out')),2000);server.close(()=>{clearTimeout(timer);resolve();});});}
}

test('real native TLS-connect stall sends zero HTTP payload and safely recovers at the actual audio client boundary',{timeout:30000},async()=>{
  const saved=globalThis.fetch,config=model(),attempts:Array<{requestId:string;body:unknown}>=[];let stall:{wire:string;connections:number}|undefined;
  await httpFixture(async(url,requests)=>{
    globalThis.fetch=async(input,init)=>{assert.equal(String(input),'https://openspeech.bytedance.com/api/v3/tts/create','no external provider request permitted');attempts.push({requestId:new Headers(init?.headers).get('X-Api-Request-Id')||'',body:init?.body});if(attempts.length===1){const result=await nativeTlsStall(init);capturedNativeFailure=result.failure;stall=result;throw result.failure;}return nativeFetch(url,init);};
    try{await runWithJobSignal(new AbortController().signal,async()=>{
      const result=await generateAudio('Private connect fixture narration',config);
      assert.deepEqual(result.bytes,bytes);assert.equal(result.audioRecovery?.attempts,2);assert.equal(attempts.length,2);assert.equal(requests.length,1,'only the successful connection sends an HTTP POST');
      assert.equal(attempts[0].requestId,attempts[1].requestId);assert.equal(attempts[0].body,attempts[1].body);assert.equal(requests[0].requestId,attempts[0].requestId);
      assert.ok(!stall?.wire.includes(config.apiKey));assert.ok(!stall?.wire.includes('Private connect fixture narration'));
      assert.deepEqual(result.audioRecovery?.events.map(e=>e.kind),['attempt','connect-timeout','wait','attempt','response']);
      const diagnostic=getJobTransportDiagnostics().find(d=>d.recoveryKind==='audio-connect-timeout');
      assert.equal(diagnostic?.attempts,2);assert.equal(diagnostic?.outcome,'recovered');assert.equal(diagnostic?.status,undefined);assert.equal(diagnostic?.requestId,attempts[0].requestId);
      assert.ok(JSON.stringify(diagnostic).includes('UND_ERR_CONNECT_TIMEOUT'));assert.ok(!JSON.stringify(diagnostic).includes(config.apiKey));assert.ok(!JSON.stringify(diagnostic).includes('Private connect fixture narration'));
    });}finally{globalThis.fetch=saved;}
  });
});

test('native connect failures exhaust one three-attempt budget and preserve the exact original cause',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let calls=0;const ids:string[]=[];
  const running=recoverAudioRequest('https://openspeech.bytedance.com/audio',randomUUID(),async id=>{calls++;ids.push(id);throw wrappedNative();}).catch(error=>error);
  await tick();assert.equal(calls,1);t.mock.timers.tick(1000);await tick();assert.equal(calls,2);t.mock.timers.tick(2000);await tick();
  const error=await running;assert.ok(error instanceof AudioConnectTimeoutError);assert.equal(calls,3);assert.equal(new Set(ids).size,1);assert.equal(error.attempts,3);assert.equal(error.retryExhausted,true);assert.equal(error.retryable,false);assert.equal(error.waitedMs,3000);assert.ok(error.cause instanceof ProviderError);assert.equal(error.cause.cause,nativeFailure());
});

test('connect and explicit 429 refusals share the same attempt limit and one aggregate mixed diagnostic',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let calls=0;
  const running=runWithJobSignal(new AbortController().signal,async()=>{
    await assert.rejects(()=>recoverAudioRequest('https://openspeech.bytedance.com/audio',randomUUID(),async()=>{calls++;if(calls!==2)throw wrappedNative();const error=new ProviderError('Rejected','RateLimit',429,true);markAudioRateLimitRefusal(error,new Response(JSON.stringify(refusal),{status:429,headers:{'Retry-After':'0'}}),refusal);throw error;}),error=>error instanceof AudioConnectTimeoutError&&error.attempts===3);
    const aggregate=getJobTransportDiagnostics().find(d=>d.recoveryKind==='audio-mixed');assert.equal(aggregate?.attempts,3);assert.equal(aggregate?.outcome,'failed');
  });
  await tick();assert.equal(calls,1);t.mock.timers.tick(1000);await tick();await running;assert.equal(calls,3);
});

test('connect waits and Retry-After share the existing cumulative thirty-second wait budget',async t=>{
  t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});let calls=0;
  const running=recoverAudioRequest('https://openspeech.bytedance.com/audio',randomUUID(),async()=>{calls++;if(calls===1)throw wrappedNative();const error=new ProviderError('Rejected','RateLimit',429,true);markAudioRateLimitRefusal(error,new Response(JSON.stringify(refusal),{status:429,headers:{'Retry-After':'30'}}),refusal);throw error;}).catch(error=>error);
  await tick();t.mock.timers.tick(1000);await tick();const error=await running;
  assert.ok(error instanceof AudioRateLimitError);assert.equal(calls,2);assert.equal(error.waitedMs,1000);assert.equal(error.attempts,2);assert.match(error.message,/未提前重新提交/);
});

test('code-only, same-name, nested, reset, headers, read-body, abort and retryable flags cannot authorize replay',async()=>{
  const native=nativeFailure();
  const errors:unknown[]=[Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT',name:'ConnectTimeoutError',retryable:true}),new TypeError('fetch failed',{cause:{code:'UND_ERR_CONNECT_TIMEOUT',name:'ConnectTimeoutError'}}),new TypeError('fetch failed',{cause:Object.assign(new Error('Connect Timeout Error'),{code:'UND_ERR_CONNECT_TIMEOUT',name:'ConnectTimeoutError'})}),new Error('outer wrapper',{cause:native}),new TypeError('fetch failed',{cause:Object.assign(new Error('reset'),{code:'ECONNRESET'})}),new TypeError('fetch failed',{cause:Object.assign(new Error('headers'),{code:'UND_ERR_HEADERS_TIMEOUT'})}),new TypeError('fetch failed',{cause:Object.assign(new Error('body'),{code:'UND_ERR_BODY_TIMEOUT'})}),new DOMException('aborted','AbortError'),Object.assign(new Error('retryable'),{retryable:true})];
  for(const failure of errors){let calls=0;const wrapped=new ProviderError('Controlled unknown failure','NETWORK_ERROR',undefined,true,{cause:failure});markAudioConnectTimeout(wrapped,failure);await assert.rejects(()=>recoverAudioRequest('https://openspeech.bytedance.com/audio',randomUUID(),async()=>{calls++;throw wrapped;}),error=>error===wrapped);assert.equal(calls,1);}
});

test('a body failure after response headers cannot gain connect recovery even if its error mimics the genuine native cause',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(controller){controller.error(nativeFailure());}}),{status:200,headers:{'content-type':'application/json'}});};
  try{await assert.rejects(()=>generateAudio('No body replay',model()),error=>error===nativeFailure());assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test('same-key generation stays queued during connect recovery and cancellation prevents a second connection',async()=>{
  const key=randomUUID(),abort=new AbortController(),started=Date.now();let calls=0,peerCalls=0;
  const first=runWithJobSignal(abort.signal,()=>recoverAudioRequest('https://openspeech.bytedance.com/audio',key,async()=>{calls++;throw wrappedNative();})).catch(error=>error);
  await tick();assert.equal(calls,1);
  const peer=recoverAudioRequest('https://openspeech.bytedance.com/audio',key,async()=>{peerCalls++;return 'peer';});
  await tick();assert.equal(peerCalls,0);abort.abort();assert.ok(await first instanceof JobCancelledError);const result=await peer;assert.equal(calls,1);assert.equal(peerCalls,1);assert.equal(result.value,'peer');assert.ok(Date.now()-started>=990,'cancellation preserves the shared connect-recovery cooldown');
});

test('the actual audio POST refuses redirects and cannot retry a downstream connect failure after sending the initial request',async()=>{
  const original=globalThis.fetch;let fetches=0,posts=0,redirected=0;
  const server=createServer((req,res)=>{if(req.url==='/audio'){posts++;res.writeHead(302,{Location:'/downstream'});res.end();}else{redirected++;respond(res,200,success);}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
  globalThis.fetch=async(input,init)=>{assert.equal(String(input),'https://openspeech.bytedance.com/api/v3/tts/create');assert.equal(init?.redirect,'error');fetches++;return nativeFetch(`http://127.0.0.1:${port}/audio`,init);};
  try{await assert.rejects(()=>generateAudio('Never follow a paid POST',model()),error=>error instanceof ProviderError&&error.code==='NETWORK_ERROR'&&error.cause instanceof TypeError);assert.equal(fetches,1);assert.equal(posts,1);assert.equal(redirected,0);}finally{globalThis.fetch=original;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('image generation remains single-attempt for the same real native connect failure',async()=>{
  const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw nativeFailure();};
  try{await assert.rejects(()=>generateImage('No image replay',{...model(),kind:'image',modelId:'doubao-seedream-5-0-flash-260915',baseUrl:'https://ark.cn-beijing.volces.com'}),error=>error instanceof ProviderError&&error.cause===nativeFailure());assert.equal(calls,1);}finally{globalThis.fetch=original;}
});
