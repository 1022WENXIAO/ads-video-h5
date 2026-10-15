import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {watch} from 'node:fs';
import {appendFile,copyFile,mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PNG} from 'pngjs';
import {runFFmpeg} from '../server/core';
import {runWithJobSignal} from '../server/jobExecution';
import {withModelSnapshot} from '../server/modelContext';
import {reviewRender} from '../server/renderReview';
import {planHash} from '../server/renderTimeline';
import {extractVisualRetentionRequirements} from '../server/visualRetentionReview';
import {mappedVisualRetentionSamples,pairedVisualRetentionMessages,sampleVisualRetentionSources} from '../server/visualRetentionSources';
import type {EditPlan,MediaItem} from '../shared/types';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function withFixture<T>(run:(p:{root:string;media:string;exports:string;temp:string;source:string;movie:string;item:MediaItem;plan:EditPlan})=>Promise<T>){
  const root=await mkdtemp(path.join(tmpdir(),'qingjian-retention-pair-'));
  try{const media=path.join(root,'media'),exports=path.join(root,'exports'),temp=path.join(root,'review');await Promise.all([media,exports,temp].map(p=>mkdir(p)));const source=path.join(media,'source-1'),movie=path.join(exports,'movie.mp4');
    // A real changing image plus a right/left marker switch at t=7: comparing
    // output 5.28 (source 6.18) against source 8.335 compares different states.
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','testsrc2=s=96x54:r=30:d=10.5','-vf',"drawbox=x=62:y=8:w=18:h=6:color=blue:t=fill:enable='lt(t,7)',drawbox=x=74:y=3:w=6:h=16:color=blue:t=fill:enable='lt(t,7)',drawbox=x=8:y=8:w=18:h=6:color=red:t=fill:enable='gte(t,7)',drawbox=x=8:y=3:w=6:h=16:color=red:t=fill:enable='gte(t,7)'",'-c:v','libx264','-threads','1','-crf','18','-pix_fmt','yuv420p','-f','mp4',source]);
    await runFFmpeg(['-v','error','-y','-ss','0.9','-i',source,'-t','6.6','-an','-c:v','libx264','-threads','1','-crf','18','-pix_fmt','yuv420p',movie]);
    const item={id:'source-1',ownerId:'fixture-owner',name:'moving original',kind:'video',duration:10.5,analysis:{sourceHash:hash(await readFile(source))}} as MediaItem;
    const plan={format:'16:9',targetSeconds:6.6,clips:[{sourceId:item.id,start:.9,end:7.5}]} as EditPlan;
    return await run({root,media,exports,temp,source,movie,item,plan});
  }finally{await rm(root,{recursive:true,force:true});}
}
async function pixels(file:string,out:string){await runFFmpeg(['-v','error','-y','-i',file,'-frames:v','1','-vf','scale=96:54',out]);return PNG.sync.read(await readFile(out)).data;}
const difference=(a:Buffer,b:Buffer)=>{let sum=0,count=0;for(let i=0;i<a.length;i++)if(i%4!==3){sum+=Math.abs(a[i]-b[i]);count++;}return sum/count;};

test('actual moving FFmpeg source frames match the same output time, while the old different-time comparison does not',{timeout:45000},async()=>{
  await withFixture(async({temp,source,movie,item,plan})=>{const before=await readFile(source),times=[.5,2.64,5.28];const sampled=await sampleVisualRetentionSources(movie,plan,[item],temp,times);
    assert.equal(sampled.frames.length,4);assert.equal(sampled.truncated,false);assert.deepEqual(sampled.uncoveredClips,[]);const pair=sampled.frames.find(f=>f.mappedOutputTime===5.28)!;assert.ok(pair);assert.equal(pair.sourceTime,6.18);assert.equal(pair.clipIndex,0);assert.equal(pair.sourceHash,hash(before));assert.equal(sampled.frames.at(-1)!.purpose,'tail');assert.equal(sampled.frames.at(-1)!.sourceTime,10.29);assert.equal(sampled.frames.at(-1)!.mappedOutputTime,undefined);
    const actual=path.join(temp,'output-5.28.jpg'),wrong=path.join(temp,'different-8.335.jpg');await runFFmpeg(['-v','error','-y','-ss','5.28','-i',movie,'-frames:v','1','-vf','scale=540:-2',actual]);await runFFmpeg(['-v','error','-y','-ss','8.335','-i',source,'-frames:v','1','-vf','scale=540:-2',wrong]);
    const a=await pixels(actual,path.join(temp,'a.png')),same=await pixels(pair.image,path.join(temp,'same.png')),other=await pixels(wrong,path.join(temp,'other.png'));const matched=difference(a,same),mismatched=difference(a,other);assert.ok(matched<8,`same clock moving pixels: ${matched}`);assert.ok(mismatched>matched*3+3,`different clock ${mismatched} must not be claimed a source/output alteration`);
    const outputs=times.map(time=>({time,image:{type:'image_url',image_url:{url:'output-'+time}}})),sources=sampled.frames.map(frame=>({frame,image:{type:'image_url',image_url:{url:frame.image}}})),messages=pairedVisualRetentionMessages(outputs,sources),outputIndex=messages.findIndex(m=>m.image_url?.url==='output-5.28');
    assert.match(messages[outputIndex+1].text!,/sourceTime=6.18.*mappedOutputTime=5.28/);assert.equal(messages[outputIndex+2].image_url?.url,pair.image);assert.equal(messages.filter(m=>m.type==='image_url').length,times.length+sampled.frames.length,'no duplicate output image is added');assert.match(messages.at(-2)!.text!,/没有对应的成片同刻帧/);assert.deepEqual(await readFile(source),before);
  });
});

test('paired time policy respects cut offsets, avoids mixed fade frames, and labels greater-than-three clip coverage honestly',()=>{
  const plan={clips:[{sourceId:'s',start:0,end:1},{sourceId:'s',start:2,end:3},{sourceId:'s',start:4,end:5},{sourceId:'s',start:6,end:7}]} as EditPlan;
  const result=mappedVisualRetentionSamples(plan,'s',10,[.5,1.5,2.5,3.5]);assert.equal(result.samples.length,4);assert.deepEqual(result.samples.slice(0,3).map(s=>[s.clipIndex,s.mappedOutputTime,s.sourceTime]),[[0,.5,.5],[1,1.5,2.5],[2,2.5,4.5]]);assert.deepEqual(result.uncoveredClips,[{sourceId:'s',clipIndex:3,reason:'mapped-frame-budget'}]);assert.equal(result.samples.at(-1)!.purpose,'tail');
  const fade={clips:[{sourceId:'a',start:1,end:4},{sourceId:'b',start:5,end:8,transition:{kind:'fade',duration:.4}}]} as EditPlan;
  const first=mappedVisualRetentionSamples(fade,'a',10,[1,2.8,3.2,4]);assert.ok(first.samples.filter(s=>s.purpose==='mapped').every(s=>s.mappedOutputTime!==2.8));assert.deepEqual(first.samples.filter(s=>s.purpose==='mapped').map(s=>s.sourceTime),[2]);
  const second=mappedVisualRetentionSamples(fade,'b',10,[1,2.8,3.2,4]);assert.deepEqual(second.samples.filter(s=>s.purpose==='mapped').map(s=>s.sourceTime),[5.6,6.4]);
  const noClean=mappedVisualRetentionSamples(fade,'b',10,[2.8]);assert.equal(noClean.samples.length,1);assert.deepEqual(noClean.uncoveredClips,[{sourceId:'b',clipIndex:1,reason:'no-unmixed-review-frame'}]);
  const boundary=mappedVisualRetentionSamples(plan,'s',10,[.975]);assert.equal(boundary.samples.filter(s=>s.purpose==='mapped').length,0,'a decoded next frame at the cut is not claimed as the previous source');
  const fadeEdge=mappedVisualRetentionSamples(fade,'a',10,[2.58]);assert.equal(fadeEdge.samples.filter(s=>s.purpose==='mapped').length,0,'the frame next to a fade boundary is not an unmixed comparison');
  for(const bad of [[],[NaN],[Infinity],[-1],[.5,.5],[4]])assert.throws(()=>mappedVisualRetentionSamples(plan,'s',10,bad),/真实|无效/);
});

test('real source budget stays two sources/eight images, with explicit uncovered clips and an unpaired tail for each',{timeout:45000},async()=>{
  await withFixture(async({media,temp,movie,item,plan})=>{await copyFile(path.join(media,item.id),path.join(media,'source-2'));await copyFile(path.join(media,item.id),path.join(media,'source-3'));const inputs=[item,{...item,id:'source-2'},{...item,id:'source-3'}];const clips=[...plan.clips,{sourceId:item.id,start:1,end:2},{sourceId:item.id,start:2,end:3},{sourceId:item.id,start:3,end:4},{sourceId:'source-2',start:0,end:1},{sourceId:'source-3',start:0,end:1}];const result=await sampleVisualRetentionSources(movie,{...plan,clips},inputs,temp,[.5,2.64,5.28,7.1,8.1,9.1,10.1,11.1]);assert.ok(result.frames.length<=8);assert.deepEqual([...new Set(result.frames.map(f=>f.sourceId))],['source-1','source-2']);assert.equal(result.frames.filter(f=>f.purpose==='tail').length,2);assert.equal(result.truncated,true);assert.ok(result.uncoveredClips!.some(c=>c.clipIndex===3&&c.reason==='mapped-frame-budget'));assert.ok(result.uncoveredClips!.some(c=>c.sourceId==='source-3'&&c.reason==='source-budget'));assert.deepEqual(result.selectedRanges,clips.map(({sourceId,start,end})=>({sourceId,start,end})));
  });
});

test('source ownership/path/hash and mapped-output identity are checked without trusting names or replaying a provider',{timeout:45000},async()=>{
  await withFixture(async({root,media,temp,movie,item,plan,source})=>{const before=await readFile(source),bad={...item,analysis:{...item.analysis,sourceHash:'f'.repeat(64)}} as MediaItem;
    await assert.rejects(sampleVisualRetentionSources(movie,plan,[bad],temp,[.5]),/字节不符/);assert.deepEqual(await readdir(temp),[]);assert.deepEqual(await readFile(source),before);
    await assert.rejects(sampleVisualRetentionSources(movie,plan,[item,{...item,ownerId:'different-owner'}],temp,[.5]),/唯一登记/);
    await assert.rejects(sampleVisualRetentionSources(movie,{...plan,clips:[...plan.clips,{sourceId:'not-video',start:0,end:1}]},[item,{...item,id:'not-video',kind:'image'}],temp,[.5]),/唯一登记/);
    await assert.rejects(sampleVisualRetentionSources(movie,{...plan,clips:[{sourceId:'unregistered',start:0,end:1}]},[item],temp,[.5]),/缺少|登记/);
    const outside=path.join(root,'outside.mp4');await copyFile(source,outside);await symlink(outside,path.join(media,'escaped'));await assert.rejects(sampleVisualRetentionSources(movie,{...plan,clips:[{sourceId:'escaped',start:0,end:1}]},[{...item,id:'escaped'}],temp,[.5]),/路径/);
    const outputs=[{time:.5,image:{type:'image_url',image_url:{url:'actual-output'}}}],frame={sourceId:item.id,sourceName:item.name,sourceHash:item.analysis!.sourceHash,sourceTime:1.4,image:'original-image',purpose:'mapped' as const,mappedOutputTime:.5,clipIndex:0};
    assert.throws(()=>pairedVisualRetentionMessages(outputs,[{frame:{...frame,mappedOutputTime:5.28},image:{type:'image_url'}}]),/未绑定/);assert.throws(()=>pairedVisualRetentionMessages(outputs,[{frame:{...frame,purpose:'tail'},image:{type:'image_url'}}]),/未绑定/);
    const controller=new AbortController();controller.abort();await assert.rejects(runWithJobSignal(controller.signal,()=>sampleVisualRetentionSources(movie,plan,[item],temp,[.5])),/停止/);
  });
});

test('a source changed during actual FFmpeg sampling cannot retain its old hash-bound paired evidence',{timeout:45000},async()=>{
  await withFixture(async({temp,movie,item,plan,source})=>{let altered:Promise<void>|undefined;const watcher=watch(temp,(_event,name)=>{if(name==='retention-source-0-0.jpg'&&!altered)altered=appendFile(source,'owned-fixture-tamper');});
    try{await assert.rejects(sampleVisualRetentionSources(movie,plan,[item],temp,[.5,2.64,5.28]),/期间原素材改变/);assert.ok(altered);await altered;assert.notEqual(hash(await readFile(source)),item.analysis!.sourceHash);}finally{watcher.close();await altered;}
  });
});

test('the real reviewRender request receives adjacent same-clock source/output images with one controlled semantic request',{timeout:45000},async()=>{
  await withFixture(async({source,movie,item,plan})=>{
    await runFFmpeg(['-v','error','-y','-ss','0.9','-i',source,'-f','lavfi','-i','sine=frequency=440:duration=6.6','-t','6.6','-map','0:v','-map','1:a','-c:v','libx264','-threads','1','-c:a','aac','-pix_fmt','yuv420p',movie]);
    const analyzed={...item,analysis:{...item.analysis,modelId:'controlled',duration:10.5,status:'ready',transcript:'',sentences:[],pauses:[],warnings:[],timing:'model-estimated',createdAt:'2026-10-15T00:00:00Z'}} as MediaItem;
    const next={...plan,summary:'controlled temporal evidence only',editorial:{scenes:[],script:{premise:'fixture',audience:'test',arc:'same-time frames',style:'original',beats:[]}}} as EditPlan;
    await writeFile(movie.replace('.mp4','.render.json'),JSON.stringify({planHash:planHash(next),captions:0,overlays:0,bgm:false,narration:false}));
    const prompt='请保留原有画面',requirements=extractVisualRetentionRequirements(prompt),original=globalThis.fetch;let calls=0;const published=new Map<string,string>();let captured:any;
    globalThis.fetch=(async(_input,init)=>{calls++;captured=JSON.parse(String(init?.body));const parts=captured.messages[1].content,times=parts.flatMap((p:any)=>/^成片时间 ([\d.]+) 秒$/.exec(p.text||'')?.[1]?[Number(/^成片时间 ([\d.]+) 秒$/.exec(p.text)[1])]:[]);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({score:80,findings:[],suggestions:[],needsRepair:false,visualRetentionChecks:requirements.map(r=>({...r,status:'met',frameTimes:[times[0]],detail:'controlled response protocol only; not model/media acceptance'}))})}}]}),{status:200,headers:{'content-type':'application/json'}});}) as typeof fetch;
    const config={id:'controlled',name:'controlled',provider:'ark',kind:'understanding' as const,modelId:'controlled',baseUrl:'https://fixture.invalid/v3',apiKey:'fixture-only',enabled:true};
    try{const review=await withModelSnapshot({text:null,image:null,audio:null,understanding:config},()=>reviewRender(movie,next,[analyzed],prompt,async(file,mime)=>{const url='fixture://'+path.basename(file);if(mime==='image/jpeg')published.set(url,hash(await readFile(file)));return url;}));assert.equal(calls,1);assert.equal(review.semantic!.score,80);assert.equal(review.status,'needs-review','controlled protocol must not masquerade as full media acceptance');
      const parts=captured.messages[1].content,pairs=parts.flatMap((p:any,i:number)=>p.type==='text'&&p.text.startsWith('同刻原素材对照')?[i]:[]);assert.ok(pairs.length>0&&pairs.length<=3);
      for(const i of pairs){const match=/sourceTime=([\d.]+).*mappedOutputTime=([\d.]+)/.exec(parts[i].text)!;assert.ok(match);assert.ok(Math.abs(Number(match[1])-Number(match[2])-.9)<.000001);assert.equal(parts[i-2].text,`成片时间 ${Number(match[2])} 秒`);assert.ok(published.has(parts[i-1].image_url.url));assert.ok(published.has(parts[i+1].image_url.url));}
      const imageParts=parts.filter((p:any)=>p.type==='image_url'),sourceParts=imageParts.filter((p:any)=>p.image_url.url.includes('retention-source-'));assert.ok(sourceParts.length<=4);assert.equal(new Set(imageParts.map((p:any)=>p.image_url.url)).size,imageParts.length,'neither image side is duplicated');assert.ok(parts.some((p:any)=>p.text?.includes('没有对应的成片同刻帧')));
    }finally{globalThis.fetch=original;}
  });
});
