import { randomUUID } from 'node:crypto';
import type { Agent, AgentTool } from '@earendil-works/pi-agent-core';
import type { WorkflowEvent } from '../src/types';
import { isTransientExecutionError, recordExecutionOrigin } from './executionErrors';

// Persist executable decisions and tool I/O, never hidden model reasoning,
// credentials or media payloads. Bounds also protect state polling responses.
export function traceValue(value: unknown, secrets: string[]=[], depth=0): unknown {
  if(depth>5)return '[depth limited]';
  if(value instanceof Uint8Array)return `[media omitted: ${value.byteLength} bytes]`;
  if(typeof value==='string'){
    let text=value;for(const secret of secrets)if(secret.length>=6)text=text.replaceAll(secret,'[redacted]');
    text=text.replace(/Bearer\s+[\w.+/=-]+/gi,'Bearer [redacted]').replace(/data:(?:audio|image)\/[^;]+;base64,[\w+/=]+/gi,'[media omitted]');
    return text.length>2400?text.slice(0,2400)+'… [truncated]':text;
  }
  if(Array.isArray(value))return value.slice(0,32).map(v=>traceValue(v,secrets,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,40).map(([k,v])=>[k,/api.?key|authorization|password|secret|token|base64|audio_data|ciphertext|reasoning_content|chain_of_thought|thinking/i.test(k)?'[redacted]':traceValue(v,secrets,depth+1)]));
  return value;
}

// Prefer the most specific stable subject. Audio hashes and artifact IDs are
// deliberately excluded: a genuine repair may create a new take/artifact.
const subjectKeys=['itemId','clipId','beatId','sceneId','chapterId','mediaId','sourceId','assetId'] as const;
function executionSubject(input:unknown):Map<string,string> {
  if(!input||typeof input!=='object'||Array.isArray(input))return new Map();
  const value=input as Record<string,unknown>,subject=new Map<string,string>();
  for(const key of subjectKeys){
    const nested=value[key.slice(0,-2)];
    const id=value[key]??(nested&&typeof nested==='object'&&!Array.isArray(nested)?(nested as Record<string,unknown>).id:typeof nested==='string'?nested:undefined);
    if((typeof id==='string'&&id.trim()&&!/^\[(?:redacted|depth limited)/.test(id))||typeof id==='number'&&Number.isFinite(id))subject.set(key,String(id));
  }
  return subject;
}
function sameExecutionSubject(a:WorkflowEvent,b:WorkflowEvent):boolean {
  const first=executionSubject(a.input),second=executionSubject(b.input);
  if(!first.size&&!second.size)return true; // Existing global tools have no per-item subject.
  const specific=subjectKeys.find(key=>first.has(key)),other=subjectKeys.find(key=>second.has(key));
  return Boolean(specific&&specific===other&&first.get(specific)===second.get(specific)&&[...first].every(([key,id])=>!second.has(key)||second.get(key)===id));
}
function beganAfterFailure(failed:WorkflowEvent,candidate:WorkflowEvent):boolean {
  const start=Date.parse(failed.at),next=Date.parse(candidate.at);
  // Old traces sometimes lack clock data; retain array order only when there
  // is no contradictory timing. Never use a known parallel success as retry.
  if(!Number.isFinite(start)||!Number.isFinite(next))return true;
  return next>=start+(Number.isFinite(failed.durationMs)?Math.max(0,failed.durationMs!):0);
}
const laterSameSubject=(failed:WorkflowEvent,candidate:WorkflowEvent)=>sameExecutionSubject(failed,candidate)&&beganAfterFailure(failed,candidate);

export function executionDiagnostics(events:WorkflowEvent[]) {
  const completed=events.filter(e=>e.status!=='running');
  const details=(e:WorkflowEvent):Record<string,any>=>{
    if(!e.output||typeof e.output!=='object')return {};
    const value=e.output as Record<string,any>;return value.details&&typeof value.details==='object'?value.details:value;
  };
  const failures=completed.flatMap((event,index)=>{
    if(event.status!=='failed')return [];
    const detail=event.detail||'工具失败';
    const kind=isTransientExecutionError(detail)?'provider-unavailable':/参数|校验|格式|主题必须|无效|预算|须为|最多|不能为空/.test(detail)?'validation':/原片|素材|source/.test(detail)?'missing-source':/审查|错读|事实|不一致|证据/.test(detail)?'quality-gate':/取消|中断|已停止|已终止/.test(detail)?'interrupted':'tool-failure';
    const recovered=kind==='interrupted'?undefined:completed.slice(index+1).find(e=>e.status==='succeeded'&&(e.tool===event.tool||event.tool==='write_lesson_script'&&e.tool==='revise_lesson_script')&&laterSameSubject(event,e));
    return [{callId:event.callId,tool:event.tool,kind,detail,recovery:recovered?{callId:recovered.callId,tool:recovered.tool,status:'recovered' as const}:{status:'unresolved' as const}}];
  });
  const qualityFeedback=completed.flatMap((event,index)=>{
    const review=details(event);
    if(event.status!=='succeeded'||!(review.needsRepair===true||review.status==='needs-review'))return [];
    const action=completed.slice(index+1).find(e=>e.status==='succeeded'&&/^(?:repair_|revise_)/.test(e.tool)&&laterSameSubject(event,e));
    const passed=completed.slice(index+1).find(e=>e.status==='succeeded'&&e.tool===event.tool&&(details(e).needsRepair===false||details(e).status==='passed')&&laterSameSubject(event,e));
    return [{callId:event.callId,tool:event.tool,score:typeof review.score==='number'?review.score:null,findings:review.findings,status:review.reviewUnavailable?'unavailable':passed?'repaired':'unresolved',...(action?{repairTool:action.tool,repairCallId:action.callId}:{})}];
  });
  return {toolCalls:completed.length,successfulCalls:completed.filter(e=>e.status==='succeeded').length,failures,recoveredFailures:failures.filter(f=>f.recovery.status==='recovered').length,qualityFeedback};
}

export function createToolTrace(publish:(events:WorkflowEvent[])=>Promise<void>,secrets:string[]=[],events:WorkflowEvent[]=[]) {
  return {
    events,
    async run<T>(tool:string,stage:string,input:unknown,execute:()=>Promise<T>,callId:string=randomUUID()):Promise<T>{
      const start=Date.now();const event:WorkflowEvent={tool,stage,callId,status:'running',at:new Date().toISOString(),input:traceValue(input,secrets)};
      events.push(event);await publish(events);
      try{const result=await execute();event.status='succeeded';event.output=traceValue(result,secrets);return result;}
      catch(error){recordExecutionOrigin(error,{tool,stage,callId});event.status='failed';event.detail=String(traceValue(error instanceof Error?error.message:String(error),secrets));throw error;}
      finally{event.durationMs=Date.now()-start;await publish(events);}
    },
    wrap(tools:AgentTool[]):AgentTool[]{return tools.map(tool=>({...tool,execute:async(...args:Parameters<AgentTool['execute']>)=>this.run(tool.name,tool.label,args[1],()=>tool.execute(...args),args[0])}));},
  };
}

export function observeToolErrors(agent:Agent,trace:ReturnType<typeof createToolTrace>){
  const started=new Map<string,unknown>();const pending:Promise<unknown>[]=[];
  const unsubscribe=agent.subscribe(e=>{
    if(e.type==='tool_execution_start')started.set(e.toolCallId,e.args);
    if(e.type==='tool_execution_end'&&e.isError&&!trace.events.some(v=>v.callId===e.toolCallId)){
      const detail=(e.result?.content||[]).filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')||'工具参数被框架拒绝。';
      pending.push(trace.run(e.toolName,'校验工具参数',started.get(e.toolCallId),async()=>{throw new Error(detail);},e.toolCallId).catch(()=>{}));
    }
  });
  return async()=>{unsubscribe();await Promise.allSettled(pending);};
}
