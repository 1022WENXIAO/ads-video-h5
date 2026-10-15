import { createHash, randomUUID } from 'node:crypto';
import { currentJobSignal, JobCancelledError, jobDelay, recordJobTransportDiagnostic, throwIfJobCancelled } from './jobExecution';
import { executionFailure } from './executionErrors';

const MAX_ATTEMPTS=3, MAX_RECOVERY_WAIT_MS=30_000, MAX_QUEUE_WAIT_MS=300_000;
export interface AudioRecoveryEvent { at:string; kind:'queued'|'attempt'|'rate-limited'|'connect-timeout'|'wait'|'response'|'failed'; attempt:number; delayMs?:number; status?:number; code?:string; }
export interface AudioRecovery { requestId:string; attempts:number; queueWaitMs:number; retryDelaysMs:number[]; events:AudioRecoveryEvent[]; }
type Refusal={kind:'rate-limit'|'connect-timeout';retryAfterMs?:number;replayAllowed:boolean};
const refusals=new WeakMap<object,Refusal>();
type Waiter={grant:()=>void};
type Slot={active:boolean;waiters:Waiter[];cooldownUntil:number};
const slots=new Map<string,Slot>();

function accepted(value:unknown,depth=0):boolean {
  if(depth>8)return true; // Unknown nesting is not proof of rejection.
  if(Array.isArray(value))return value.some(item=>accepted(item,depth+1));
  // Vendors sometimes report an accepted task only in prose. An HTTP error
  // wrapper does not make that safe to replay as another paid generation.
  if(typeof value==='string')return /\b(?:accepted|processing|queued|pending|running|submitted|poll(?:ing)?)\b|已受理|已接受|已提交|排队中|处理中|生成中|查询(?:原|已有|该)(?:始)?(?:请求|任务)/i.test(value);
  if(!value||typeof value!=='object')return false;
  return Object.entries(value).some(([key,item])=>{
    const name=key.replace(/[-_]/g,'').toLowerCase();
    if(['id','taskid','jobid','operationid','task','job','operation','audio','audiodata','url','audiourl','downloadurl'].includes(name)&&item!==null&&item!==undefined&&item!=='')return true;
    if(['status','state'].includes(name)&&typeof item==='string'&&/^(?:queued|pending|running|processing|submitted|accepted|success|succeeded|completed)$/i.test(item))return true;
    if(name==='code'&&(item===0||item==='0'))return true;
    if(['status','statuscode'].includes(name)&&typeof item==='number'&&item>=200&&item<300)return true;
    return accepted(item,depth+1);
  });
}
function retryAfter(value:string|null):number|undefined {
  if(!value?.trim())return;
  const header=value.trim();
  if(/^\d+$/.test(header))return Math.min(Number.MAX_SAFE_INTEGER,Number(header)*1000);
  // Date.parse accepts malformed numeric headers as historical dates. Only
  // an unambiguous RFC HTTP-date can authorize another paid submission.
  if(!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(header))return;
  const date=Date.parse(header);
  return Number.isFinite(date)&&new Date(date).toUTCString().toLowerCase()===header.toLowerCase()?Math.max(0,date-Date.now()):undefined;
}
/** Only the actual HTTP client can tag a definite refusal. Error strings and
 * arbitrary retryable/status properties never authorize a paid replay. */
export function markAudioRateLimitRefusal(error:object,response:Response,body:unknown):void {
  if(response.status!==429||!body||typeof body!=='object'||Array.isArray(body)||accepted(body))return;
  if([...response.headers].some(([name,value])=>value&&/^(?:location|x-(?:api-)?(?:task|job|operation)-id)$/i.test(name)))return;
  const record=body as Record<string,unknown>;
  const fields=(value:unknown)=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.entries(value).some(([key,item])=>/^(?:code|status_code|message|msg|errmsg)$/i.test(key)&&(typeof item==='string'&&item.trim().length>0||typeof item==='number'&&item!==0)));
  const explicit=typeof record.error==='string'&&record.error.trim().length>0||fields(record.error)||
    Object.entries(record).some(([key,value])=>/^(?:code|status_code)$/i.test(key)&&(typeof value==='string'&&value.trim().length>0||typeof value==='number'&&value!==0))||
    typeof record.status==='number'&&record.status>=400||typeof record.status==='string'&&/^(?:429|failed|error|rejected)$/i.test(record.status)||
    Object.entries(record).some(([key,value])=>/^(?:message|msg|errmsg)$/i.test(key)&&typeof value==='string'&&/rate[ _-]*limit|too many requests|limit exceeded|quota exceeded|request (?:was )?rejected|capacity (?:exceeded|rejected)|限流|请求过多|频率超限|配额不足/i.test(value));
  const header=response.headers.get('retry-after'),delay=retryAfter(header);
  if(header?.trim()&&delay===undefined)return;
  if(explicit)refusals.set(error,{kind:'rate-limit',retryAfterMs:delay,replayAllowed:response.headers.get('x-should-retry')?.trim().toLowerCase()!=='false'});
}

/** Called only by the HTTP client before a Response exists. Node's native
 * Undici connector reports this branded error before secureConnect hands the
 * socket to HTTP. Codes, messages and retryable flags alone are insufficient.
 * All other socket/timeout/abort failures remain ambiguous and are not replayed. */
export function markAudioConnectTimeout(error:object,failure:unknown):void {
  if(!(failure instanceof TypeError)||failure.name!=='TypeError'||failure.message!=='fetch failed')return;
  const cause=failure.cause;
  if(!(cause instanceof Error)||cause.name!=='ConnectTimeoutError'||cause.constructor.name!=='ConnectTimeoutError')return;
  const native=cause as Error&{code?:unknown;[key:symbol]:unknown};
  if(native.code!=='UND_ERR_CONNECT_TIMEOUT'||native[Symbol.for('undici.error.UND_ERR')]!==true||native[Symbol.for('undici.error.UND_ERR_CONNECT_TIMEOUT')]!==true)return;
  refusals.set(error,{kind:'connect-timeout',replayAllowed:true});
}

export class AudioRateLimitError extends Error {
  readonly code='AUDIO_RATE_LIMITED';readonly status=429;readonly retryable=false;
  readonly retryExhausted:boolean;
  constructor(readonly requestId:string,readonly attempts:number,readonly waitedMs:number,reason:string,cause:unknown){
    super(`配音服务限流（HTTP 429）；${attempts>1?`已安全重试${attempts-1}次（共${attempts}次提交尝试），`:''}${reason}`,{cause});
    this.name='AudioRateLimitError';this.retryExhausted=attempts>1;
  }
}

export class AudioConnectTimeoutError extends Error {
  readonly code='AUDIO_CONNECT_TIMEOUT';readonly retryable=false;
  readonly retryExhausted:boolean;
  constructor(readonly requestId:string,readonly attempts:number,readonly waitedMs:number,reason:string,cause:unknown){
    super(`配音服务 HTTPS 连接超时（本次 HTTP 请求尚未发送）；${attempts>1?`已安全重试${attempts-1}次（共${attempts}次提交尝试），`:''}${reason}`,{cause});
    this.name='AudioConnectTimeoutError';this.retryExhausted=attempts>1;
  }
}

async function acquire(slot:Slot):Promise<()=>void>{
  const signal=currentJobSignal();throwIfJobCancelled(signal);
  return new Promise((resolve,reject)=>{
    let settled=false,timer:ReturnType<typeof setTimeout>|undefined;
    const cleanup=()=>{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
    const release=()=>{slot.active=false;slot.waiters.shift()?.grant();};
    const waiter:Waiter={grant:()=>{if(settled)return;settled=true;cleanup();slot.active=true;resolve(release);}};
    const remove=()=>{const index=slot.waiters.indexOf(waiter);if(index>=0)slot.waiters.splice(index,1);};
    const cancel=()=>{if(settled)return;settled=true;remove();cleanup();reject(new JobCancelledError());};
    if(!slot.active&&!slot.waiters.length){waiter.grant();return;}
    slot.waiters.push(waiter);
    timer=setTimeout(()=>{if(settled)return;settled=true;remove();cleanup();const error=Object.assign(new Error('配音请求排队超过300秒，尚未提交。'),{code:'AUDIO_QUEUE_TIMEOUT',retryable:false});reject(error);},MAX_QUEUE_WAIT_MS);
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  });
}

/** Serializes only one credential's audio generation. A stable request ID is
 * correlation, not an assumption of vendor idempotency. */
export async function recoverAudioRequest<T>(url:string,key:string,submit:(requestId:string)=>Promise<T>):Promise<{value:T;recovery:AudioRecovery}>{
  const started=Date.now(),requestId=randomUUID(),bucket=createHash('sha256').update(new URL(url).origin+'\0'+key).digest('hex');
  let slot=slots.get(bucket);if(!slot){slot={active:false,waiters:[],cooldownUntil:0};slots.set(bucket,slot);}
  const recovery:AudioRecovery={requestId,attempts:0,queueWaitMs:0,retryDelaysMs:[],events:[]};
  const event=(kind:AudioRecoveryEvent['kind'],extra:Partial<AudioRecoveryEvent>={})=>recovery.events.push({at:new Date().toISOString(),kind,attempt:recovery.attempts,...extra});
  let release:(()=>void)|undefined,lastRefusal:unknown,lastKind:Refusal['kind']|undefined,waitedMs=0;
  const kinds=new Set<Refusal['kind']>();
  const exhausted=(reason:string,cause=lastRefusal)=>lastKind==='connect-timeout'?new AudioConnectTimeoutError(requestId,recovery.attempts,waitedMs,reason,cause):new AudioRateLimitError(requestId,recovery.attempts,waitedMs,reason,cause);
  const diagnostic=(outcome:'failed'|'recovered',failure:unknown)=>recordJobTransportDiagnostic({at:new Date().toISOString(),origin:new URL(url).origin,path:new URL(url).pathname,attempts:recovery.attempts,durationMs:Date.now()-started,outcome,failure:executionFailure(failure,[key]),status:(failure as {status?:number})?.status,requestId,...(kinds.size?{recoveryKind:kinds.size>1?'audio-mixed' as const:lastKind==='connect-timeout'?'audio-connect-timeout' as const:'audio-rate-limit' as const}:{}),retryDelaysMs:[...recovery.retryDelaysMs],queueWaitMs:recovery.queueWaitMs});
  try{
    if(slot.active||slot.waiters.length)event('queued');
    release=await acquire(slot);recovery.queueWaitMs=Date.now()-started;
    for(;;){
      throwIfJobCancelled();
      const delay=Math.max(0,slot.cooldownUntil-Date.now());
      if(delay>MAX_RECOVERY_WAIT_MS-waitedMs)throw exhausted('供应商冷却时间超过30秒恢复预算，未提前重新提交。');
      if(delay){event('wait',{delayMs:delay});const before=Date.now();try{await jobDelay(delay);}finally{const elapsed=Date.now()-before;waitedMs+=elapsed;recovery.retryDelaysMs.push(elapsed);}if(waitedMs>MAX_RECOVERY_WAIT_MS)throw exhausted('已到30秒恢复等待上限，未继续提交。');}
      throwIfJobCancelled();recovery.attempts++;event('attempt');
      try{
        const value=await submit(requestId);event('response');slot.cooldownUntil=0;
        if(lastRefusal)diagnostic('recovered',lastRefusal);
        return {value,recovery};
      }catch(error){
        throwIfJobCancelled();
        const refusal=error&&typeof error==='object'?refusals.get(error):undefined;
        if(!refusal)throw error;
        kinds.add(refusal.kind);lastKind=refusal.kind;
        if(refusal.kind==='rate-limit')event('rate-limited',{status:429});else event('connect-timeout',{code:'UND_ERR_CONNECT_TIMEOUT'});
        const retryDelay=refusal.retryAfterMs??Math.min(2000,1000*recovery.attempts);
        slot.cooldownUntil=Math.max(slot.cooldownUntil,Date.now()+retryDelay);
        if(!refusal.replayAllowed)throw error;
        lastRefusal=error;
        if(recovery.attempts>=MAX_ATTEMPTS)throw exhausted(refusal.kind==='connect-timeout'?'仍无法建立 HTTPS 连接，已停止继续尝试。':'仍被拒绝，已停止继续提交。',error);
      }
    }
  }catch(error){if(!release)recovery.queueWaitMs=Date.now()-started;event('failed',{status:(error as {status?:number})?.status});diagnostic('failed',error);throw error;}
  finally{release?.();if(!slot.active&&!slot.waiters.length&&slot.cooldownUntil<=Date.now()&&slots.get(bucket)===slot)slots.delete(bucket);}
}
