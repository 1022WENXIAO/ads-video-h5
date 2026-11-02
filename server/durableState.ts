import {mkdir,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {throwIfJobCancelled,jobDelay} from './jobExecution';

function canonical(value:any):any{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));return value;}
export const stateHash=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonical(value))??'null').digest('hex');
export async function atomicStateWrite(file:string,value:unknown){
  await mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});await rename(temp,file);}
  finally{await rm(temp,{force:true});}
}
/** One writer across instances/processes. A live owner is never evicted by a TTL. */
export async function acquireFileLock(file:string):Promise<()=>Promise<void>>{
  await mkdir(path.dirname(file),{recursive:true});const directory=file+'.lock',token=randomUUID(),owner={pid:process.pid,host:hostname(),token};
  const deadline=Date.now()+15000;
  while(true){
    throwIfJobCancelled();
    try{await mkdir(directory);try{await writeFile(path.join(directory,'owner.json'),JSON.stringify(owner),{flag:'wx',mode:0o600});}catch(e){await rm(directory,{recursive:true,force:true});throw e;}break;}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      try{
        const previous=JSON.parse(await readFile(path.join(directory,'owner.json'),'utf8'));
        if(previous.host===hostname()&&Number.isInteger(previous.pid)){
          let dead=false;try{process.kill(previous.pid,0);}catch(e){dead=(e as NodeJS.ErrnoException).code==='ESRCH';}
          if(dead){const reaper=directory+'.reap';let claimed=false;try{await mkdir(reaper);claimed=true;const latest=JSON.parse(await readFile(path.join(directory,'owner.json'),'utf8'));if(latest.token===previous.token){const tombstone=directory+'.abandoned-'+randomUUID();await rename(directory,tombstone);await rm(tombstone,{recursive:true,force:true});}}catch{}finally{if(claimed)await rm(reaper,{recursive:true,force:true});}continue;}
        }
      }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){const age=await stat(directory).then(s=>Date.now()-s.mtimeMs,()=>0);if(age>15000)throw Error('持久化锁缺少所有者，已停止写入以保留现场。');}}
      if(Date.now()>deadline)throw Error('持久化资源正在被其他执行器使用，请稍后读取最新版本。');
      await jobDelay(25);
    }
  }
  return async()=>{const actual=await readFile(path.join(directory,'owner.json'),'utf8').then(JSON.parse,()=>null);if(actual?.token===token)await rm(directory,{recursive:true,force:true});};
}
export async function withFileLock<T>(file:string,action:()=>Promise<T>):Promise<T>{const release=await acquireFileLock(file);try{return await action();}finally{await release();}}
