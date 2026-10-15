import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,symlink,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {runFFmpeg} from '../server/core';
import {sampleVisualRetentionSources} from '../server/visualRetentionSources';
import {runWithJobSignal} from '../server/jobExecution';
import type {EditPlan,MediaItem} from '../shared/types';

test('real FFmpeg samples at most two registered sources/eight images, including generated-origin inputs, and binds actual hashes',{timeout:45000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'qingjian-retention-source-'));
  try{
    const media=path.join(root,'media'),exports=path.join(root,'exports'),temp=path.join(root,'review');await Promise.all([media,exports,temp].map(p=>mkdir(p)));
    const first=path.join(media,'source-1');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=96x54:r=30:d=2','-f','lavfi','-i','color=c=green:s=96x54:r=30:d=1','-filter_complex','[0:v][1:v]concat=n=2:v=1:a=0[v]','-map','[v]','-c:v','libx264','-pix_fmt','yuv420p','-f','mp4',first]);
    const sha=createHash('sha256').update(await readFile(first)).digest('hex');await copyFile(first,path.join(media,'source-2'));await copyFile(first,path.join(media,'source-3'));
    const inputs=[1,2,3].map(i=>({id:'source-'+i,name:'registered-'+i,kind:'video',duration:3,analysis:{sourceHash:sha},...(i===1?{generation:{mode:'generated'}}:{})})) as MediaItem[];
    const plan={clips:inputs.map(m=>({sourceId:m.id,start:0,end:1}))} as EditPlan;
    const result=await sampleVisualRetentionSources(path.join(exports,'movie.mp4'),plan,inputs,temp);
    assert.equal(result.frames.length,8);assert.equal(result.truncated,true);assert.deepEqual([...new Set(result.frames.map(f=>f.sourceId))],['source-1','source-2']);
    assert.deepEqual(result.frames.slice(0,4).map(f=>f.sourceTime),[.6,1.5,2.4,2.94]);assert.ok(result.frames.every(f=>f.sourceHash===sha));
    for(const frame of result.frames)assert.ok((await readFile(frame.image)).length>100);
    const late=path.join(temp,'late.png');await runFFmpeg(['-v','error','-y','-i',result.frames[3].image,'-vf','scale=1:1','-frames:v','1',late]);
    const pixel=PNG.sync.read(await readFile(late)).data;
    assert.ok(pixel[1]>pixel[0]+30,'real late original-source frame is green, not a fabricated source witness');
    await assert.rejects(sampleVisualRetentionSources(path.join(exports,'movie.mp4'),plan,[{...inputs[0],analysis:{sourceHash:'f'.repeat(64)}} as MediaItem],temp),/字节不符/);
    await assert.rejects(sampleVisualRetentionSources(path.join(exports,'movie.mp4'),plan,[{...inputs[0],analysis:undefined}],temp),/字节不符/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('source compare rejects traversal, external symlinks, missing original files and job cancellation without providers',{timeout:20000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'qingjian-retention-path-'));
  try{
    await Promise.all(['media','exports','review'].map(p=>mkdir(path.join(root,p))));
    const movie=path.join(root,'exports','movie.mp4'),temp=path.join(root,'review');
    const inputs=[{id:'../outside',kind:'video',duration:3}] as MediaItem[];
    await assert.rejects(sampleVisualRetentionSources(movie,{clips:[{sourceId:'../outside',start:0,end:1}]} as EditPlan,inputs,temp),/标识/);
    await symlink('/etc/hosts',path.join(root,'media','outside'));
    await assert.rejects(sampleVisualRetentionSources(movie,{clips:[{sourceId:'outside',start:0,end:1}]} as EditPlan,[{id:'outside',kind:'video',duration:3}] as MediaItem[],temp),/路径/);
    await assert.rejects(sampleVisualRetentionSources(movie,{clips:[{sourceId:'missing',start:0,end:1}]} as EditPlan,[{id:'missing',kind:'video',duration:3}] as MediaItem[],temp),/ENOENT/);
    const controller=new AbortController();controller.abort();await assert.rejects(runWithJobSignal(controller.signal,()=>sampleVisualRetentionSources(movie,{clips:[]} as EditPlan,[],temp)),/停止/);
  }finally{await rm(root,{recursive:true,force:true});}
});
