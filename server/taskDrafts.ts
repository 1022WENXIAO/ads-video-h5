import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {TaskSpec} from '../shared/taskRuntime';
import {atomicStateWrite,withFileLock,stateHash} from './durableState';
type Draft=import('../shared/creativeProject').CreativeProject|import('../shared/scienceScene').ScienceScene|import('../shared/styleVideo').StyleVideoPlan;
interface Saved {taskId:string;revision:number;templateId?:string;hash:string;draft:Draft}
const location=(data:string,spec:TaskSpec)=>{if(!/^[a-f0-9-]{36}$/.test(spec.id))throw Error('任务草稿标识无效。');return path.join(data,'task-drafts',spec.id+'.json');};
export async function loadTaskDraft(data:string,spec:TaskSpec){
 let record:Saved;try{record=JSON.parse(await readFile(location(data,spec),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 if(record.taskId!==spec.id||record.templateId!==spec.templateId||record.revision>spec.revision||record.hash!==stateHash(record.draft))throw Error('任务草稿的版本、归属或内容已变化。');return record.draft;
}
export async function saveTaskDraft(data:string,spec:TaskSpec,draft:Draft,guard:()=>void){
 const file=location(data,spec);await withFileLock(file,async()=>{guard();const previous=await readFile(file,'utf8').then(JSON.parse,e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;return null;});if(previous&&previous.revision>spec.revision)throw Error('不能用旧任务覆盖后续草稿。');await atomicStateWrite(file,{taskId:spec.id,revision:spec.revision,templateId:spec.templateId,hash:stateHash(draft),draft});});
}
