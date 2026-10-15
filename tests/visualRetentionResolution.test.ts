import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {appendFile,mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {runFFmpeg} from '../server/core';
import {sampleVisualRetentionSources,VISUAL_RETENTION_FRAME_SCALE} from '../server/visualRetentionSources';
import type {EditPlan,MediaItem} from '../shared/types';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function png(image:string,out:string){
  await runFFmpeg(['-v','error','-y','-i',image,'-frames:v','1',out]);
  return PNG.sync.read(await readFile(out));
}
function pixel(image:PNG,x:number,y:number){const at=(Math.floor(y)*image.width+Math.floor(x))*4;return [...image.data.subarray(at,at+3)];}
function corners(image:PNG){
  // These four distinct markers touch every original edge. Cropping or a
  // square fill cannot satisfy all four at the expected full-frame corners.
  const [red,green,blue,yellow]=[[.015,.015],[.985,.015],[.015,.985],[.985,.985]].map(([x,y])=>pixel(image,image.width*x,image.height*y));
  assert.ok(red[0]>180&&red[1]<60&&red[2]<60,JSON.stringify({red}));
  assert.ok(green[1]>180&&green[0]<60&&green[2]<60,JSON.stringify({green}));
  assert.ok(blue[2]>180&&blue[0]<60&&blue[1]<60,JSON.stringify({blue}));
  assert.ok(yellow[0]>180&&yellow[1]>180&&yellow[2]<60,JSON.stringify({yellow}));
}

test('real full-frame 960-long-edge evidence preserves landscape, portrait and square edges and the same source clock',{timeout:90000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'qingjian-retention-resolution-'));
  try{
    await Promise.all(['media','exports','review'].map(name=>mkdir(path.join(root,name))));
    for(const [width,height,outWidth,outHeight] of [[1920,1080,960,540],[1080,1920,540,960],[1440,1440,960,960]]){
      const id=`source-${width}-${height}`,source=path.join(root,'media',id),movie=path.join(root,'exports',id+'.mp4');
      const filter='drawbox=x=0:y=0:w=80:h=80:color=red:t=fill,drawbox=x=iw-80:y=0:w=80:h=80:color=0x00ff00:t=fill,drawbox=x=0:y=ih-80:w=80:h=80:color=blue:t=fill,drawbox=x=iw-80:y=ih-80:w=80:h=80:color=yellow:t=fill,'+
        "drawbox=x=iw/2-80:y=ih/2-80:w=160:h=160:color=magenta:t=fill:enable='lt(t,0.65)',drawbox=x=iw/2-80:y=ih/2-80:w=160:h=160:color=cyan:t=fill:enable='gte(t,0.65)'";
      await runFFmpeg(['-v','error','-y','-f','lavfi','-i',`color=c=white:s=${width}x${height}:r=30:d=2`,'-vf',filter,'-c:v','libx264','-threads','1','-crf','18','-pix_fmt','yuv420p','-f','mp4',source]);
      await runFFmpeg(['-v','error','-y','-ss','0.2','-i',source,'-t','1.2','-an','-c:v','libx264','-threads','1','-crf','18','-pix_fmt','yuv420p',movie]);
      const bytes=await readFile(source),item={id,name:'controlled edge and time markers',kind:'video',duration:2,analysis:{sourceHash:sha(bytes)}} as MediaItem;
      const plan={clips:[{sourceId:id,start:.2,end:1.4}]} as EditPlan;
      const result=await sampleVisualRetentionSources(movie,plan,[item],path.join(root,'review'),[.15,.55,.95]);
      assert.equal(result.frames.length,4);assert.equal(result.truncated,false);assert.deepEqual(result.uncoveredClips,[]);
      assert.deepEqual(result.selectedRanges,[{sourceId:id,start:.2,end:1.4}]);
      assert.deepEqual(result.frames.filter(f=>f.purpose==='mapped').map(f=>[f.mappedOutputTime,f.sourceTime]),[[.15,.35],[.55,.75],[.95,1.15]]);
      assert.equal(result.frames.at(-1)!.purpose,'tail');assert.equal(result.frames.at(-1)!.sourceTime,1.96);assert.equal(result.frames.at(-1)!.mappedOutputTime,undefined);
      for(const frame of result.frames){const image=await png(frame.image,path.join(root,'review',id+'-'+frame.sourceTime+'.png'));assert.equal(image.width,outWidth);assert.equal(image.height,outHeight);corners(image);assert.ok((await stat(frame.image)).size<=2*1024*1024);assert.equal(frame.sourceHash,sha(bytes));}
      const pair=result.frames.find(f=>f.mappedOutputTime===.55)!,output=path.join(root,'review',id+'-output.jpg');
      await runFFmpeg(['-v','error','-y','-ss','0.55','-i',movie,'-frames:v','1','-vf',VISUAL_RETENTION_FRAME_SCALE,output]);
      const same=await png(pair.image,path.join(root,'review',id+'-same.png')),actual=await png(output,path.join(root,'review',id+'-output.png')),earlier=await png(result.frames[0].image,path.join(root,'review',id+'-earlier.png'));
      assert.deepEqual([actual.width,actual.height],[same.width,same.height]);corners(actual);
      for(const image of [same,actual]){const rgb=pixel(image,image.width/2,image.height/2);assert.ok(rgb[1]>180&&rgb[2]>180&&rgb[0]<60,'same-clock center is cyan: '+JSON.stringify(rgb));}
      const wrong=pixel(earlier,earlier.width/2,earlier.height/2);assert.ok(wrong[0]>180&&wrong[2]>180&&wrong[1]<60,'different source time is magenta, not equivalent evidence');
      assert.deepEqual(await readFile(source),bytes,'sampling never rewrites the original source');
    }
  }finally{await rm(root,{recursive:true,force:true});}
});

test('the original two-MiB frame cap still rejects an oversized actual sampled JPEG before returning evidence',{timeout:30000},async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'qingjian-retention-image-cap-'));
  let stub:ReturnType<typeof mock.method>|undefined;
  try{
    await Promise.all(['media','exports','review'].map(name=>mkdir(path.join(root,name))));
    const source=path.join(root,'media','source-1');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=blue:s=96x54:r=30:d=1','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-f','mp4',source]);
    const bytes=await readFile(source),item={id:'source-1',name:'controlled',kind:'video',duration:1,analysis:{sourceHash:sha(bytes)}} as MediaItem;
    const nativeStat=fs.promises.stat;let inflated=false;
    // Keep actual FFmpeg and actual file IO. Inject an over-budget artifact at
    // the native post-extraction stat boundary, then measure those real bytes.
    stub=mock.method(fs.promises,'stat',async(file:any,...args:any[])=>{
      if(String(file)===path.join(root,'review','retention-source-0-0.jpg')){await appendFile(file,Buffer.alloc(2*1024*1024));inflated=true;}
      return (nativeStat as any)(file,...args);
    });syncBuiltinESMExports();
    await assert.rejects(sampleVisualRetentionSources(path.join(root,'exports','movie.mp4'),{clips:[{sourceId:item.id,start:0,end:1}]} as EditPlan,[item],path.join(root,'review'),[.5]),/有界有效图像/);
    assert.equal(inflated,true);assert.ok((await nativeStat(path.join(root,'review','retention-source-0-0.jpg'))).size>2*1024*1024);assert.deepEqual(await readFile(source),bytes);
  }finally{stub?.mock.restore();syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});
