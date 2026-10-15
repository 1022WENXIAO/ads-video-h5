// Drain every active worker before propagating failure: no provider calls are
// left mutating caches after the owning task is marked failed or retried.
export interface PoolFailure {index:number;error:unknown}
export async function mapLimited<T,R>(items:T[],limit:number,run:(item:T,index:number)=>Promise<R>,selectFailure?:(failures:ReadonlyArray<PoolFailure>)=>unknown):Promise<R[]> {
  const result:R[]=[];let next=0;let failed=false;let error:unknown;const failures:PoolFailure[]=[];
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failed&&next<items.length){const index=next++;try{result[index]=await run(items[index],index);}catch(e){failed=true;error=e;failures.push({index,error:e});}}
  }));
  if(failed)throw selectFailure?selectFailure(failures):error;return result;
}
