import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import type { EditPlan, MediaItem } from '../shared/types';
import { editFrameZoom } from '../server/editProposal';
import { renderPlan, runFFmpeg } from '../server/core';

test('original-ratio complete-frame intent reaches actual FFmpeg without enlarging or losing source edges',{timeout:30000},async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'qingjian-original-frame-'));
  try{
    const mediaDir=path.join(directory,'media'),exports=path.join(directory,'exports');await mkdir(mediaDir);await mkdir(exports);
    const source=path.join(mediaDir,'source');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=c=white:s=960x540:r=30:d=2','-vf','drawbox=x=0:y=0:w=iw:h=ih:color=red:t=8','-c:v','libx264','-threads','1','-f','mp4',source]);
    const media:MediaItem[]=[{id:'source',kind:'video',name:'controlled bordered source',mimeType:'video/mp4',url:'',duration:2,hasAudio:false,createdAt:''}];
    const border=[];
    for(const prompt of ['画面原比例完整放','正常剪辑并稍微放大主体']){
      const plan:EditPlan={format:'16:9',summary:'Controlled frame-edge proof',targetSeconds:1.8,clips:[{sourceId:'source',start:0,end:1.8,zoom:editFrameZoom(1.1,prompt)}],audio:{normalize:false,originalVolume:1,bgmVolume:0,narrationVolume:0}};
      const rendered=await renderPlan(plan,media,mediaDir,exports);await runFFmpeg(['-v','error','-i',rendered.file,'-f','null','-']);
      const frame=path.join(directory,'edge-'+border.length+'.png');await runFFmpeg(['-v','error','-y','-ss','1.65','-i',rendered.file,'-frames:v','1',frame]);
      const image=PNG.sync.read(await readFile(frame));assert.equal(image.width,960);assert.equal(image.height,540);
      border.push([[2,2],[957,2],[2,537],[957,537]].map(([x,y])=>{const i=(y*image.width+x)*4;return image.data[i]>180&&image.data[i+1]<70&&image.data[i+2]<70;}));
    }
    assert.deepEqual(border[0],[true,true,true,true],'all four actual source corners remain in the full-frame movie');
    assert.deepEqual(border[1],[false,false,false,false],'the zoom control really loses the border; the proof is sensitive to enlargement');
  }finally{await rm(directory,{recursive:true,force:true});}
});
