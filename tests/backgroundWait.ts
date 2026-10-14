// Background schedulers intentionally unref their wake timer. A test awaiting
// their callback owns a bounded, referenced deadline, just as the live HTTP
// server owns its listening handle. Awaiting a Promise alone cannot do this.
export async function waitForBackground<T>(operation:Promise<T>,milliseconds=5000):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Background test callback exceeded its deadline.')),milliseconds);
    })]);
  }finally{clearTimeout(timer);}
}
