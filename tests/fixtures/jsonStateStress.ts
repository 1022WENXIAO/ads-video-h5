import assert from 'node:assert/strict';
import {mkdtemp,open,rm,stat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {getHeapStatistics} from 'node:v8';
import {createJsonStateWriter} from '../../server/jsonStateWriter';

const dir=await mkdtemp(path.join(os.tmpdir(),'qj-state-heap-'));
try{
  const file=path.join(dir,'state.json');
  const state={history:Array.from({length:64},(_,id)=>({id,text:('实际原文 narration '+id+' ').repeat(25000)})),revision:0};
  let captures=0;const persist=createJsonStateWriter(file,()=>{captures++;return state;});
  const saves:Promise<void>[]=[];for(let revision=1;revision<=100;revision++){state.revision=revision;saves.push(persist());}
  await Promise.all(saves);
  const info=await stat(file),handle=await open(file,'r'),tail=Buffer.alloc(512);
  try{await handle.read(tail,0,tail.length,info.size-tail.length);}finally{await handle.close();}
  assert.match(tail.toString(),/"revision":100\}$/);assert.equal(info.mode&0o777,0o600);assert.deepEqual(await readdir(dir),['state.json']);
  let records=0;for await(const chunk of createReadStream(file,{encoding:'utf8'}))records+=(chunk.match(/"id":/g)||[]).length;
  assert.equal(records,64);assert(info.size>=32*1024*1024);assert(captures<=2);
  console.log(JSON.stringify({passed:true,bytes:info.size,captures,records,revision:100,heapLimitBytes:getHeapStatistics().heap_size_limit,peakRssKiB:process.resourceUsage().maxRSS}));
}finally{await rm(dir,{recursive:true,force:true});}
