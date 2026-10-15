import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

// HyperFrames requires 1 GiB free. Reserve a further 1 GiB before a new
// service can start automatic paid acceptance. There is no environment bypass.
export const MIN_RENDER_AVAILABLE_BYTES=2n*1024n**3n;

function existingDirectory(requested){
  let current=path.resolve(requested);
  for(;;){
    try{
      if(!fs.statSync(current).isDirectory())throw new Error(`Render storage path is not a directory: ${current}`);
      return fs.realpathSync(current);
    }catch(error){
      if(error?.code!=='ENOENT')throw error;
      // A missing future project is measured on its actual existing ancestor.
      // A broken symlink is unknown storage, not permission to use its parent.
      try{if(fs.lstatSync(current).isSymbolicLink())throw new Error(`Broken render storage symlink: ${current}`,{cause:error});}
      catch(cause){if(cause?.code!=='ENOENT')throw cause;}
      const parent=path.dirname(current);if(parent===current)throw error;current=parent;
    }
  }
}

export function inspectRenderSpace(paths,statfs=(directory)=>fs.statfsSync(directory,{bigint:true})){
  if(!Array.isArray(paths)||!paths.length||paths.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new Error('Render storage preflight requires absolute candidate, data, project and temporary paths.');
  const records=paths.map(requested=>{
    const directory=existingDirectory(requested);let info;
    try{info=statfs(directory);}catch(error){throw new Error(`Cannot inspect render storage: ${requested} (${directory})`,{cause:error});}
    const block=BigInt(info.bsize),available=BigInt(info.bavail);
    if(block<=0n||available<0n)throw new Error(`Invalid filesystem availability: ${directory}`);
    return {path:requested,resolvedDirectory:directory,availableBytes:block*available,minimumBytes:MIN_RENDER_AVAILABLE_BYTES};
  });
  const low=records.filter(r=>r.availableBytes<MIN_RENDER_AVAILABLE_BYTES);
  if(low.length){
    const error=new Error('Render storage preflight rejected before version switch or paid acceptance: '+low.map(r=>`${r.path} (${r.resolvedDirectory}) has ${r.availableBytes} bytes (${(Number(r.availableBytes)/1024**3).toFixed(2)} GiB); requires at least ${MIN_RENDER_AVAILABLE_BYTES} bytes (2 GiB: HyperFrames 1 GiB + 1 GiB reserve)`).join('; '));
    error.code='RENDER_STORAGE_INSUFFICIENT';throw error;
  }
  return records;
}

// Node canonicalizes the module URL even when a parent directory is a symlink.
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const records=inspectRenderSpace([...process.argv.slice(2),os.tmpdir()]);
    console.log(JSON.stringify({event:'render-storage-preflight',minimumBytes:MIN_RENDER_AVAILABLE_BYTES,paths:records},(_key,value)=>typeof value==='bigint'?value.toString():value));
  }catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
