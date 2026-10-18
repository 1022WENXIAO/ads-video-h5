import {randomUUID} from 'node:crypto';
import {writeFile,rename,rm} from 'node:fs/promises';

async function atomicJsonWrite(filename:string,text:string):Promise<void>{
  const temp=filename+'.'+randomUUID()+'.tmp';
  try{
    await writeFile(temp,text,{mode:0o600,flag:'wx'});
    await rename(temp,filename);
  }catch(error){await rm(temp,{force:true}).catch(()=>undefined);throw error;}
}

/** Progress bursts must not retain an entire serialized database per caller.
 * Capture one consistent JSON snapshot only when the prior write has finished.
 * Calls arriving during that write wait for the next snapshot's atomic rename.
 * Every historical record remains in the state; only pending writes coalesce. */
export function createJsonStateWriter(filename:string,state:()=>unknown,options:{write?:(filename:string,text:string)=>Promise<void>}={}):()=>Promise<void>{
  let requested=0,running=false;
  let waiting:Array<{version:number;resolve:()=>void;reject:(error:unknown)=>void}>=[];
  const write=options.write||atomicJsonWrite;
  const schedule=()=>{
    if(running)return;
    running=true;
    queueMicrotask(()=>{void drain();});
  };
  async function drain(){
    try{
      while(waiting.length){
        const version=requested;
        let error:unknown,failed=false;
        try{await write(filename,JSON.stringify(state()));}catch(value){error=value;failed=true;}
        const finished=waiting.filter(item=>item.version<=version);
        waiting=waiting.filter(item=>item.version>version);
        for(const item of finished)if(failed)item.reject(error);else item.resolve();
      }
    }finally{running=false;if(waiting.length)schedule();}
  }
  return ()=>new Promise<void>((resolve,reject)=>{waiting.push({version:++requested,resolve,reject});schedule();});
}
