import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import type {AudioAnalysis,LessonBarChart,LessonChapter} from '../src/types';
import {barChartSvg,chapterBarChart,quantitativeBarIntent} from '../server/barChart';
import {validateLessonVisual} from '../server/lessonSpec';
import {lessonSceneHtml,produceLessonScene} from '../server/lessonScenes';
import {checkHtmlProject,hashBytes, type HtmlDrawing} from '../server/narrativeScenes';
import {runFFmpeg,probeVideo} from '../server/core';

const fixture=JSON.parse(await readFile(new URL('./fixtures/lesson-bar-pricing-p9.json',import.meta.url),'utf8'));
const original=fixture.chapter as LessonChapter,chart=fixture.structuredChart as LessonBarChart;
const height=(html:string,index:number)=>Number(html.match(new RegExp(`<g id="chart-bar-0-${index}"[^>]*>[\\s\\S]*?<rect[^>]*height="([\\d.]+)"`))![1]);
const withChart=()=>({...structuredClone(original),visual:{...structuredClone(original.visual),barChart:structuredClone(chart)}});

test('actual P9 comparison cannot bypass quantitative chart data through illustration flags',()=>{
  assert.equal(original.visual.kind,'comparison');assert.equal(quantitativeBarIntent(original.visual),true);
  const before=structuredClone(original);
  assert.throws(()=>validateLessonVisual(original.visual,original.narration),/结构化数值.*visual\.barChart/);
  assert.throws(()=>chapterBarChart(original),/不能由HTML绘图猜柱高/);
  assert.throws(()=>lessonSceneHtml(original,2,3,13.55,'9:16',undefined,true),/结构化数值/);
  assert.deepEqual(original,before,'missing data cannot be silently invented or attached');
  const single={...structuredClone(original.visual),items:[{label:'许可金额69亿美元',detail:'真实报道的累计金额',cue:'许可金额',illustration:'bar-chart' as const},{label:'累计口径',detail:'属于累计口径',cue:'累计口径',illustration:'announcement' as const}]};
  assert.equal(quantitativeBarIntent(single),false);assert.doesNotThrow(()=>validateLessonVisual(single,'许可金额为69亿美元，属于累计口径。'));
});

test('P9 four source amounts use one zero baseline and deterministic proportional heights',()=>{
  const chapter=withChart(),before=structuredClone(chapter);validateLessonVisual(chapter.visual,chapter.narration);
  const html=lessonSceneHtml(chapter,2,3,13.55,'9:16',undefined,true),heights=chart.bars.map((_,i)=>height(html,i));
  assert.deepEqual(chart.bars.map(b=>b.value),[2,10,4,20]);
  assert.ok(Math.abs(heights[0]/heights[1]-.2)<1e-10);assert.ok(Math.abs(heights[2]/heights[3]-.2)<1e-10);
  assert.ok(Math.abs(heights[2]/heights[0]-2)<1e-10);assert.ok(Math.abs(heights[3]/heights[1]-2)<1e-10);
  for(const value of [2,10,4,20])assert.match(html,new RegExp(`data-value="${value}" data-axis-min="0" data-axis-max="20"`));
  assert.doesNotMatch(html,/data-illustration="bar-chart"/,'no unrelated arbitrary-height thumbnail chart next to the true data');
  assert.deepEqual(chapter,before);
  assert.notEqual(fixture.actualIncorrectHeights[0]/fixture.actualIncorrectHeights[1],.2,'captured actual P9 geometry is explicitly rejected evidence');
  assert.match(barChartSvg(chart),/单位：美元\/百万Token/);
});

test('fresh actual browser validates the P9 native chart with all source numbers and without authored geometry',{timeout:60000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-p9-native-chart-check-'));
  try{await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));await writeFile(path.join(project,'index.html'),lessonSceneHtml(withChart(),2,3,13.55,'9:16',undefined,true));await checkHtmlProject(project,{fullCheck:true});}
  finally{await rm(project,{recursive:true,force:true});}
});

test('real scene renderer gives verified bar data precedence over the actual incorrect P9 drawing',{timeout:90000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-p9-native-chart-render-'));
  try{
    const audio=path.join(project,'controlled-tone.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1.2',audio]);
    const analysis={duration:1.2,sourceHash:hashBytes(await readFile(audio)),sentences:[],pauses:[],warnings:[],status:'ready',transcript:''} as unknown as AudioAnalysis;
    // This is a technical renderer fixture using a generated test tone. It
    // does not claim fresh ASR/TTS, creative acceptance or another live movie.
    const result=await produceLessonScene(withChart(),2,3,'9:16',audio,analysis,project,undefined,undefined,true,fixture.rejectedDrawing as HtmlDrawing);
    const html=await readFile(path.join(project,'index.html'),'utf8');
    assert.match(html,/id="chart-bar-0-3"/);assert.doesNotMatch(html,/id="before_input_bar"|id="after_output_bar"/);
    assert.ok(Math.abs(height(html,0)/height(html,1)-.2)<1e-10);assert.ok(Math.abs(height(html,3)/height(html,1)-2)<1e-10);
    assert.equal(result.htmlHash,hashBytes(html));assert.equal(result.analysis.sourceHash,hashBytes(await readFile(result.file)));assert.ok((await probeVideo(result.file)).hasAudio);
    await runFFmpeg(['-v','error','-xerror','-i',result.file,'-f','null','-']);
  }finally{await rm(project,{recursive:true,force:true});}
});
