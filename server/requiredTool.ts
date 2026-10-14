import type { Agent } from '@earendil-works/pi-agent-core';
import { throwIfJobCancelled } from './jobExecution';
import { traceValue } from './toolTrace';
import type { ModelConfig } from './modelRegistry';
import { recoverToolDecision } from './workflowDriver';

// A required tool is an executable contract. A promise or refusal in plain
// text does not satisfy it. Keep the correction bounded and preserve the
// actual public response/provider error, never private reasoning.
export async function runRequiredTool(agent:Agent,prompt:string,options:{name:string;label:string;done:()=>boolean;config?:ModelConfig;secrets?:string[];timeoutMs?:number;maxTurns?:number;maxRejections?:number}){
  const allowed=new Set(agent.state.tools.map(t=>t.name));
  let turns=0,idle=0,rejections=0,lastReply='',reason='',expired=false,recovered=false;
  const maxRejections=Number.isInteger(options.maxRejections)?Math.max(1,Math.min(6,options.maxRejections!)):3;
  const clean=(value:string)=>String(traceValue(value,options.secrets)).slice(0,900);
  agent.finishTurn=async(turn,signal)=>{
    if(options.done())return {action:'end'};
    const message=turn.message;
    if(message.stopReason==='error'||message.stopReason==='aborted'){
      reason=clean(message.errorMessage||`模型响应${message.stopReason}`);return {action:'end'};
    }
    const calls=message.content.filter(c=>c.type==='toolCall'&&allowed.has(c.name));
    const failures=turn.toolResults.filter(r=>r.isError).flatMap(r=>r.content.filter(c=>c.type==='text').map(c=>c.text)).join('\n');
    if(failures){reason=clean(failures);rejections++;}else if(calls.length)rejections=0;
    if(!calls.length){
      idle++;const text=message.content.filter(c=>c.type==='text').map(c=>c.text).join('').trim();
      if(text)lastReply=clean(text);
      reason=`模型连续${idle}轮没有执行有效工具。${lastReply?'最近回复：'+lastReply:'响应为空或没有可执行调用。'}`;
    }else idle=0;
    if(idle===2&&options.config&&!recovered){
      recovered=true;
      try{await recoverToolDecision(options.config,agent.state.tools,prompt,{error:reason,lastPublicReply:lastReply,toolErrors:clean(failures)},signal);if(options.done())return {action:'end'};}
      catch(error){throwIfJobCancelled();reason+='；结构化恢复：'+clean(error instanceof Error?error.message:String(error));}
    }
    if(++turns>=(options.maxTurns??6)||idle>=3||rejections>=maxRejections)return {action:'end'};
    if(!calls.length||failures)agent.steer({role:'user',content:`任务尚未完成。当前可执行工具：${[...allowed].join('、')}；必须提交${options.name}的有效参数。后续工具由服务端推进，不需要用户开放工具或重新表述已明确的要求。${failures?'根据实际工具校验错误修正后重试：'+clean(failures):'请实际调用工具，不要用文字承诺代替执行。'}`,timestamp:Date.now()});
    return {action:'continue'};
  };
  const timer=setTimeout(()=>{expired=true;agent.abort();},options.timeoutMs??180000);
  try{await agent.prompt(`本次执行契约：完成${options.name}，其他工作由后续阶段处理。\n`+prompt);}
  catch(error){throwIfJobCancelled();throw new Error(`${options.label}未完成：${clean(error instanceof Error?error.message:String(error))}`);}
  finally{clearTimeout(timer);}
  throwIfJobCancelled();
  if(!options.done())throw new Error(`${options.label}未完成：${expired?'模型请求超时。':reason||'模型未提交经过校验的工具结果。'}`);
}
