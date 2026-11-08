import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileDigest} from './artifactIntegrity';
import type {TaskSpec,TaskCheckpoint,TaskEvidence} from '../shared/taskRuntime';
import {atomicStateWrite,withFileLock,stateHash} from './durableState';
import {taskContext,taskSpecHash} from './taskContract';
import {throwIfJobCancelled,withoutJobSignal,withExecutionDeadline,JobDeadlineError} from './jobExecution';
import {traceValue} from './toolTrace';
const context=new AsyncLocalStorage<TaskExecution>();
export const currentTaskExecution=()=>context.getStore();
export class OutcomeUnknownError extends Error {constructor(id:string){super(`外部操作 ${id} 的结果未知，已阻止再次提交；请先通过只读工具核对远程状态。`);}}
type Action={id:string;tool:string;inputHash:string;status:'started'|'confirmed'|'outcome_unknown';startedAt:string;result?:unknown};
type VerifiedStep={id:string;dependsOn:string[];projectHash?:string;evidenceHash?:string;status:'pending'|'passed'};
interface DurableRun {deadlineAt?:number;dependencies?:Record<string,string>;spentMicros?:number;usageSeen?:Record<string,true>;usageUnknown?:boolean;plan:VerifiedStep[];contractHash:string;environmentHash:string;calls:number;checkpoints:TaskCheckpoint[];actions:Action[];evidence?:TaskEvidence}
export interface TaskExecution {
 spec:TaskSpec;directory:string;environmentHash:string;instructions:string;
 observeDependency:(name:string,value:unknown)=>Promise<void>;
 verify:(step:'technical'|'requirements'|'render',projectHash:string,evidence:unknown)=>Promise<void>;
 assertModelBudget:()=>Promise<void>;recordCost:(requestId:string,micros?:number)=>Promise<void>;
 guard:()=>void;consume:()=>Promise<void>;
 checkpoint:<R>(stage:string,input:unknown,action:()=>Promise<R>)=>Promise<R>;
 external:<T>(tool:string,args:unknown,action:()=>Promise<T>,secrets?:string[])=>Promise<T>;
 receipts:()=>Promise<Array<Omit<Action,'result'>>>;
 accept:(evidence:Omit<TaskEvidence,'contractHash'|'environmentHash'|'userAccepted'>)=>Promise<TaskEvidence>;
}
export async function captureTaskEnvironment(root:string,extra:unknown){
 const files=['server/index.ts','package.json','pnpm-lock.yaml','server/core.ts','server/taskRuntime.ts','server/taskContract.ts','server/requiredTool.ts','server/creativeReview.ts','server/scienceRender.ts','server/defoldRuntime.ts','server/defoldInspect.ts','server/defoldVisual.ts','server/artifactIntegrity.ts','server/durableState.ts','server/creativeWorkspace.ts','server/creativeTools.ts','server/templateWorkflow.ts','server/scienceCoding.ts','server/defoldCoding.ts','server/defoldProject.ts','server/pixelfx.ts','server/pixelfxDefold.ts','server/pixelfxTools.ts','tooling/creative/render-pixelfx.mjs','third_party/pixelfx/vendor.lock.json','skills/defold-game/assets/pixelfx.lua','server/jobExecution.ts','server/creditUsage.ts','shared/taskRuntime.ts','server/taskDrafts.ts','server/scienceWorkspace.ts'];
 files.push('server/questionResearch.ts','server/deepQuestionResearch.ts','server/narrativeResearch.ts','server/searxSearch.ts','server/openWebSearch.ts','server/publicResearch.ts','server/jobQueue.ts');
 if((extra as any)?.film)files.push('server/filmAnalysis.ts','shared/film.ts');
 const engineDirectory=path.join(process.env.QINGJIAN_ENGINE_CACHE||path.join(homedir(),'.cache/qingjian-engines'),'defold/1.14.0');
 const installed=await readFile(path.join(engineDirectory,'runtime.json'),'utf8').then(JSON.parse,()=>({}));
 const engineFiles=(extra as any)?.template?.id==='defold-game'?[process.env.QINGJIAN_DEFOLD_BOB||installed.bob||path.join(engineDirectory,'bob.jar'),process.env.QINGJIAN_JAVA_PATH||installed.java,process.env.QINGJIAN_DEFOLD_WORKER].filter((f):f is string=>Boolean(f)):[];
 const binaries=await Promise.all([process.env.QINGJIAN_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',...engineFiles].map(async file=>[file,await fileDigest(file).catch(()=>null)]));
 return stateHash({node:process.version,platform:process.platform,binaries,extra,files:await Promise.all(files.map(async f=>[f,stateHash(await readFile(path.join(root,f),'utf8'))]))});
}
export async function withTaskExecution<T>(o:{spec:TaskSpec;directory:string;environmentHash:string;assertCurrent:()=>void;assertEnvironment?:()=>Promise<void>;maxCalls?:number;maxCredits?:number;timeoutMs?:number|null;ledgerDirectory?:string},action:()=>Promise<T>){
 if(o.maxCredits!==undefined&&(!Number.isFinite(o.maxCredits)||o.maxCredits<0))throw Error('任务积分预算必须是非负数。');
 await mkdir(o.directory,{recursive:true});const file=path.join(o.directory,'run.json'),contractHash=taskSpecHash(o.spec);
 const update=async<R>(fn:(s:DurableRun)=>R|Promise<R>)=>withoutJobSignal(()=>withFileLock(file,async()=>{
  let state:DurableRun;try{state=JSON.parse(await readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={contractHash,environmentHash:o.environmentHash,plan:[{id:'technical',dependsOn:[],status:'pending'},{id:'requirements',dependsOn:['technical'],status:'pending'},...(o.spec.templateId==='animated-science-video'?[{id:'render',dependsOn:['requirements'],status:'pending' as const}]:[]),{id:'deliver',dependsOn:o.spec.templateId==='animated-science-video'?['render']:['requirements'],status:'pending'}],calls:0,checkpoints:[],actions:[]};}
  if(state.contractHash!==contractHash||state.environmentHash!==o.environmentHash)throw Error('任务契约或运行环境已漂移；本次恢复已停止，请以最新要求重新运行。');
  const value=await fn(state);await atomicStateWrite(file,state);return value;
 }));
 let deadlineAt=0;
 const effectsFile=path.join(o.ledgerDirectory||path.join(o.directory,'effects'),'effects.json');
 const effects=async<R>(fn:(actions:Action[])=>R)=>withoutJobSignal(()=>withFileLock(effectsFile,async()=>{let stored:{taskId:string;actions:Action[]};try{stored=JSON.parse(await readFile(effectsFile,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;stored={taskId:o.spec.id,actions:[]};}if(stored.taskId!==o.spec.id||!Array.isArray(stored.actions))throw Error('外部操作收据格式或任务归属无效。');const result=fn(stored.actions);await atomicStateWrite(effectsFile,stored);return {result,actions:stored.actions};}));
 const syncActions=async(actions:Action[])=>update(s=>{s.actions=actions;});
 const guard=()=>{throwIfJobCancelled();if(deadlineAt&&Date.now()>=deadlineAt)throw new JobDeadlineError();o.assertCurrent();};
 const execution:TaskExecution={spec:structuredClone(o.spec),directory:o.directory,environmentHash:o.environmentHash,instructions:taskContext(o.spec),guard,
  observeDependency:async(name,value)=>{guard();await update(s=>{s.dependencies||={};const digest=stateHash(value);if(s.dependencies[name]&&s.dependencies[name]!==digest)throw Error('外部依赖在恢复或执行期间已变化：'+name);s.dependencies[name]=digest;});},
  assertModelBudget:async()=>{guard();if(o.maxCredits!==undefined)await update(s=>{if(s.usageUnknown)throw Error('模型用量尚未确认，已停止追加付费请求。');if((s.spentMicros||0)>=o.maxCredits!*1000000)throw Error('任务及子阶段已达到配置的积分预算。');});},
  recordCost:async(id,micros)=>{if(o.maxCredits!==undefined)await update(s=>{s.usageSeen||={};if(s.usageSeen[id])return;s.usageSeen[id]=true;if(micros===undefined)s.usageUnknown=true;else s.spentMicros=(s.spentMicros||0)+micros;});},
  verify:async(step,projectHash,evidence)=>{guard();await update(s=>{
    const target=s.plan.find(p=>p.id===step);if(!target)throw Error('任务计划中没有此验收步骤。');
    if(step==='technical'){for(const p of s.plan)if(p.projectHash!==projectHash){p.status='pending';p.evidenceHash=undefined;}if(!(evidence as any)?.technicalPassed&&!(evidence as any)?.framesChecked)throw Error('技术检查未通过，不能推进计划。');}
    if(step==='requirements'&&!(evidence as any)?.approved)throw Error('需求审查未通过。');
    for(const dependency of target.dependsOn){const parent=s.plan.find(p=>p.id===dependency);if(parent?.status!=='passed'||parent.projectHash!==projectHash)throw Error('计划前置条件失效：'+dependency);}
    Object.assign(target,{status:'passed',projectHash,evidenceHash:stateHash(evidence)});
  });},
  consume:async()=>{guard();await update(s=>{if(s.calls>=(o.maxCalls||200))throw Error('任务及其子阶段已达到共享工具预算，不能通过重试重置。');s.calls++;});},
  checkpoint:async(stage,input,run)=>{
   guard();const checkpointId=randomUUID(),inputHash=stateHash(input),stamp=()=>new Date().toISOString();
   await update(s=>{s.checkpoints.push({id:checkpointId,stage,inputHash,status:'started',updatedAt:stamp()});});
   try{const value=await run();guard();await update(s=>{const cp=s.checkpoints.find(c=>c.id===checkpointId)!;cp.status='completed';cp.outputHash=stateHash(value);cp.updatedAt=stamp();});return value;}
   catch(error){await update(s=>{const cp=s.checkpoints.find(c=>c.id===checkpointId)!;cp.status='failed';cp.error=String(traceValue(error instanceof Error?error.message:String(error))).slice(0,2000);cp.updatedAt=stamp();});throw error;}
  },
  external:async(tool,args,run,secrets=[])=>{
   guard();const inputHash=stateHash(args),id=stateHash({taskId:o.spec.id,tool,inputHash});
   const initial=await effects(actions=>{const old=actions.find(a=>a.id===id);if(old)return structuredClone(old);actions.push({id,tool,inputHash,status:'started',startedAt:new Date().toISOString()});});await syncActions(initial.actions);
   const previous=initial.result;
   if(previous){if(previous.status==='confirmed')return previous.result as any;throw new OutcomeUnknownError(id);}
   try{const result=await run();const settled=await effects(actions=>{Object.assign(actions.find(a=>a.id===id)!,{status:'confirmed',result:JSON.parse(JSON.stringify(result,(_key,value)=>typeof value==='string'?secrets.reduce((s,key)=>key?s.replaceAll(key,'[redacted]'):s,value):value)??'null')});});await syncActions(settled.actions);guard();return result;}
   catch(error){const settled=await effects(actions=>{const a=actions.find(a=>a.id===id)!;if(a.status!=='confirmed')a.status='outcome_unknown';});await syncActions(settled.actions);throw error;}
  },
  receipts:async()=>{const actual=await effects(actions=>actions.map(({result:_result,...a})=>a));await syncActions(actual.actions);return actual.result;},
  accept:async evidence=>{guard();await o.assertEnvironment?.();if(!evidence.technicalPassed||!evidence.requirementsReviewed)throw Error('技术验收或需求审查未完成，不能交付。');await update(s=>{const target=s.plan.find(p=>p.id==='deliver')!;for(const dependency of target.dependsOn){const parent=s.plan.find(p=>p.id===dependency);if(parent?.status!=='passed'||parent.projectHash!==evidence.projectHash)throw Error('交付计划尚未完成或工程版本不一致：'+dependency);}Object.assign(target,{status:'passed',projectHash:evidence.projectHash});});const receipt:TaskEvidence={...evidence,contractHash,environmentHash:o.environmentHash,userAccepted:false};await update(s=>{s.evidence=receipt;});return receipt;},
 };
 deadlineAt=await update(s=>s.deadlineAt??=(o.timeoutMs===null?0:Date.now()+(o.timeoutMs||1800000)));
 const initialEffects=await effects(actions=>actions);await syncActions(initialEffects.actions);
 guard();return context.run(execution,()=>deadlineAt?withExecutionDeadline(Math.max(1,deadlineAt-Date.now()),action):action());
}
export function scopedWorkspace(kind:string,fallback:string){return currentTaskExecution()?path.join(currentTaskExecution()!.directory,'workspaces',kind):fallback;}
