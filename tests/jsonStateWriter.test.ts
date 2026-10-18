import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,readdir,rm,stat} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createJsonStateWriter} from '../server/jsonStateWriter';

const deferred=()=>{let resolve!:()=>void;return {promise:new Promise<void>(r=>{resolve=r;}),resolve:()=>resolve()};};
test('a progress burst keeps one in-flight snapshot and resolves later callers only after their atomic state is durable',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-state-burst-'));
  const entered=[deferred(),deferred()],gates=[deferred(),deferred()];
  try{
    const file=path.join(dir,'state.json'),state={history:[{id:'original',text:'retain the original evidence'}],revision:1};
    let captures=0,writes=0;
    const persist=createJsonStateWriter(file,()=>{captures++;return state;},{write:async(filename,text)=>{const index=writes++;entered[index].resolve();await gates[index].promise;await writeFile(filename,text,{mode:0o600});}});
    const first=persist();await entered[0].promise;
    const pending:Promise<void>[]=[];for(let i=2;i<=100;i++){state.revision=i;pending.push(persist());}
    let newestDurable=false;void pending.at(-1)!.then(()=>{newestDurable=true;});
    assert.equal(captures,1,'pending progress must not allocate 99 full JSON strings');
    gates[0].resolve();await first;await entered[1].promise;
    assert.equal(JSON.parse(await readFile(file,'utf8')).revision,1);assert.equal(newestDurable,false);
    gates[1].resolve();await Promise.all(pending);
    assert.deepEqual(JSON.parse(await readFile(file,'utf8')),state);assert.equal(captures,2);assert.equal(writes,2);
  }finally{gates.forEach(g=>g.resolve());await rm(dir,{recursive:true,force:true});}
});

test('atomic rename failure preserves the existing target and removes only its own temporary file; a later save can recover',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-state-failure-'));
  try{
    const file=path.join(dir,'state.json');await mkdir(file);await writeFile(path.join(file,'sentinel'),'preserve');
    const persist=createJsonStateWriter(file,()=>({retained:true}));
    await assert.rejects(persist);assert.equal(await readFile(path.join(file,'sentinel'),'utf8'),'preserve');assert.deepEqual(await readdir(dir),['state.json']);
    await rm(file,{recursive:true});await persist();assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{retained:true});assert.equal((await stat(file)).mode&0o777,0o600);assert.deepEqual(await readdir(dir),['state.json']);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('serialization errors reject their callers without overwriting the previous durable state',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'qj-state-serialization-'));
  try{
    const file=path.join(dir,'state.json'),state:any={revision:1};const persist=createJsonStateWriter(file,()=>state);await persist();
    state.circular=state;await assert.rejects(persist,/circular/i);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{revision:1});
    delete state.circular;state.revision=2;await persist();assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{revision:2});
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('production-sized history and one hundred concurrent saves survive the former 384 MiB heap limit',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,['--max-old-space-size=384','--import','tsx',new URL('./fixtures/jsonStateStress.ts',import.meta.url).pathname],{timeout:30000,maxBuffer:10000});
  const result=JSON.parse(stdout);assert(result.passed);assert(result.bytes>=32*1024*1024);assert(result.captures<=2);assert.equal(result.revision,100);
});
