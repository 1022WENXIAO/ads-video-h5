import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {produceLessonScene,lessonRendererHash} from '../server/lessonScenes';
import {drawingHtml,hashBytes} from '../server/narrativeScenes';
import {runFFmpeg} from '../server/core';
import type {AudioAnalysis,LessonChapter} from '../shared/types';

const actual=JSON.parse(await readFile(new URL('./fixtures/p21-svg-text-occlusion.json',import.meta.url),'utf8'));

test('legacy, stale-policy and changed-video caches cannot bypass the new actual SVG paint gate',{timeout:180000},async()=>{
  const chapter:LessonChapter={id:'controlled-cache',title:'土白只是提醒',role:'foundation',goal:'检查缓存授权',prerequisites:[],narration:'土表发白，先检查土壤湿度。',reason:'受控缓存回归',referenceIds:[],claims:[],visual:{kind:'concept',takeaway:'检查真实遮挡',items:[]}};
  const analysis:AudioAnalysis={status:'ready',modelId:'controlled-only',sourceHash:'controlled-source',duration:actual.duration-.9,timing:'model-estimated',createdAt:'',transcript:'',sentences:[],pauses:[],warnings:[]};
  for(const mode of ['legacy','stale-policy','changed-video']){
    const project=await mkdtemp(path.join(tmpdir(),'qingjian-svg-cache-'));
    try{
      // A tiny, locally encoded placeholder models a pre-existing cache file;
      // it is not presented as either of the actual P21 movies.
      const visual=path.join(project,'visual.mp4');
      await runFFmpeg(['-v','error','-y','-f','lavfi','-i','color=white:s=160x160:r=30','-t',String(actual.duration),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',visual]);
      const before=await readFile(visual),htmlHash=hashBytes(drawingHtml(actual.drawing,actual.duration,actual.format));
      const metadata={htmlHash,...(mode==='legacy'?{}:{rendererHash:mode==='stale-policy'?'previous-policy':lessonRendererHash(),visualHash:mode==='changed-video'?hashBytes('different-video'):hashBytes(before)})};
      const metaBytes=JSON.stringify(metadata);await writeFile(path.join(project,'visual-cache.json'),metaBytes);
      await assert.rejects(produceLessonScene(chapter,0,1,actual.format,fileURLToPath(new URL('./fixtures/p8-original-speech-dynamics.wav',import.meta.url)),analysis,project,undefined,undefined,false,actual.drawing),/Actual SVG fill\/stroke/);
      assert.deepEqual(await readFile(visual),before,'a rejected cache does not overwrite the prior bytes before the layout gate passes');
      assert.equal(await readFile(path.join(project,'visual-cache.json'),'utf8'),metaBytes,'failed validation cannot write a current-policy cache authorization');
    }finally{await rm(project,{recursive:true,force:true});}
  }
});
