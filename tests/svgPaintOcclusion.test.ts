import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {checkHtmlProject,drawingHtml,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectSvgTextPaint} from '../server/svgPaintOcclusion';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';

const actual=JSON.parse(await readFile(new URL('./fixtures/p21-svg-text-occlusion.json',import.meta.url),'utf8')) as {drawing:HtmlDrawing;duration:number;format:'9:16';provenance:{actualHTMLSHA256:string}};
async function withProject<T>(html:string,run:(project:string)=>Promise<T>){
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-svg-paint-'));
  try{await writeFile(path.join(project,'index.html'),html);await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));return await run(project);}
  finally{await rm(project,{recursive:true,force:true});}
}
function clearZones(){
  const drawing=structuredClone(actual.drawing);
  for(const [id,y,h]of [['card_signal',255,52],['card_check',515,56]] as const){
    const card=drawing.nodes.find(n=>n.id===id)!;
    drawing.nodes.push({...card,id:id+'_label',kind:'text',x:card.x+15,y,w:card.w-30,h,highlight:false});card.text='';
  }
  return drawing;
}
function controlled(pathData:string,options:{fill?:string;stroke?:string;strokeOpacity?:number;opacity?:number;z?:number;dash?:boolean;owned?:boolean;timeline?:boolean}={}){
  return `<!doctype html><html><head><style>html,body{margin:0}#main{position:relative;width:720px;height:1280px;background:white}#label{position:absolute;left:120px;top:300px;font:700 40px Arial,sans-serif;z-index:1}.products{position:absolute;inset:0;width:720px;height:1280px;pointer-events:none;z-index:${options.z??2};opacity:${options.opacity??1}}</style><script src="./gsap.min.js"></script></head><body><section id="main" data-composition-id="main" data-width="720" data-height="1280" data-duration="4"><div id="label">TEST</div><svg class="products" viewBox="0 0 720 1280"><path id="graphic" ${options.owned===false?'':'data-drawing-id="graphic"'} d="${pathData}" fill="${options.fill??'none'}" stroke="${options.stroke??'black'}" stroke-opacity="${options.strokeOpacity??1}" stroke-width="5" ${options.dash?'stroke-dasharray="300" stroke-dashoffset="300"':''}/></svg></section><script>${options.timeline===false?'':`window.__timelines={main:gsap.timeline({paused:true})};window.__timelines.main.to('#graphic',{${options.dash?'strokeDashoffset:0,':'opacity:1,'}duration:1},1);`}</script></body></html>`;
}

test('actual P21 SVG fill and probe strokes hide loaded-font card text even though the old check passed',{timeout:45000},async()=>{
  const before=structuredClone(actual.drawing),html=drawingHtml(actual.drawing,actual.duration,actual.format);
  assert.equal(hashBytes(html),actual.provenance.actualHTMLSHA256);
  await withProject(html,async project=>{
    const result=await inspectSvgTextPaint(project);assert.ok(result);assert.equal(result.htmlHash,hashBytes(html));assert.equal(result.samples.length,9);
    for(const id of ['card_signal','card_check'])assert.ok(result.findings.some(f=>f.selector==='#qj-author-'+id&&f.coveredFraction>0));
    assert.ok(result.findings.every(f=>f.code==='text_occluded'&&f.containerSelector.startsWith('#qj-author-')));
    assert.equal(await readFile(path.join(project,'index.html'),'utf8'),html);
  });
  assert.deepEqual(actual.drawing,before);
});

test('spatially separated real drawing preserves every label, path and font and passes',{timeout:45000},async()=>{
  const repaired=clearZones(),text=(d:HtmlDrawing)=>d.nodes.map(n=>n.text).filter(Boolean).sort();
  assert.deepEqual(text(repaired),text(actual.drawing));
  assert.deepEqual(repaired.nodes.filter(n=>n.kind==='path').map(n=>n.pathData),actual.drawing.nodes.filter(n=>n.kind==='path').map(n=>n.pathData));
  assert.deepEqual(repaired.nodes.filter(n=>n.text).map(n=>[n.text,n.fontSize]).sort(),actual.drawing.nodes.filter(n=>n.text).map(n=>[n.text,n.fontSize]).sort());
  await withProject(drawingHtml(repaired,actual.duration,actual.format),async project=>assert.deepEqual((await inspectSvgTextPaint(project))?.findings,[]));
});

test('a path viewport or empty interior is not actual SVG paint; transparent and behind-text shapes do not occlude',{timeout:90000},async()=>{
  const cases=[
    controlled('M80 270H400V370H80Z'),
    controlled('M80 270H400V370H80Z',{fill:'rgba(0,0,0,0)',stroke:'none'}),
    controlled('M100 325H400',{strokeOpacity:0}),
    controlled('M80 270H400V370H80Z',{fill:'black',z:0}),
    controlled('M80 270H400V370H80Z',{fill:'black',opacity:.2}),
    controlled('M600 600H650V650H600Z',{fill:'black'}),
  ];
  for(const html of cases)await withProject(html,async project=>assert.deepEqual((await inspectSvgTextPaint(project))?.findings,[]));
});

test('actual foreground stroke crossing text is rejected, but undrawn dash length is not invented',{timeout:45000},async()=>{
  await withProject(controlled('M100 325H400'),async project=>assert.ok((await inspectSvgTextPaint(project))!.findings.length>0));
  await withProject(controlled('M100 325H400',{dash:true}),async project=>{
    const result=(await inspectSvgTextPaint(project))!;assert.ok(result.findings.length>0);
    assert.ok(result.findings.every(f=>f.time>1),'the stroke is not painted before its actual timeline reveal');
  });
});

test('unowned native SVG is outside this authored-geometry guard; missing timeline and IO cannot pass',{timeout:45000},async()=>{
  await withProject(controlled('M80 270H400V370H80Z',{fill:'black',owned:false}),async project=>assert.equal(await inspectSvgTextPaint(project),undefined));
  await withProject(controlled('M100 325H400',{timeline:false}),async project=>assert.rejects(inspectSvgTextPaint(project),/timeline/));
  await assert.rejects(inspectSvgTextPaint(path.join(tmpdir(),'missing-svg-paint-'+Date.now())),{code:'ENOENT'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(runWithJobSignal(controller.signal,()=>inspectSvgTextPaint('/not-read-after-cancel')),JobCancelledError);
});

test('cancellation as the real browser opens closes that owned browser and propagates cancellation',{timeout:45000},async()=>{
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const {default:puppeteer}=await import(require.resolve('puppeteer-core')),launch=puppeteer.launch;
  const controller=new AbortController();let opened:any;
  puppeteer.launch=async function(options:any){opened=await launch.call(this,options);controller.abort();return opened;};
  try{
    await withProject(controlled('M100 325H400'),async project=>assert.rejects(runWithJobSignal(controller.signal,()=>inspectSvgTextPaint(project)),JobCancelledError));
    assert.ok(opened);assert.equal(opened.connected,false);const child=opened.process();assert.ok(child?.pid);assert.ok(child.exitCode!==null||child.signalCode!==null,'only this test-owned browser process has exited');
  }finally{puppeteer.launch=launch;await opened?.close();}
});

test('real browser rejection joins the existing two-author local recovery and preserves the upstream passing bytes',{timeout:120000},async()=>{
  await withProject(drawingHtml(actual.drawing,actual.duration,actual.format),async project=>{
    let authors=0,checks=0;
    const result=await recoverLessonHtml({project,chapterId:'chapter-1',contextHash:'actual-p21-svg-geometry-regression',format:'9:16',author:async feedback=>{authors++;if(authors===2)assert.match(feedback,/Actual SVG fill\/stroke/);return authors===1?structuredClone(actual.drawing):clearZones();},produce:async drawing=>{
      checks++;await writeFile(path.join(project,'index.html'),drawingHtml(drawing!,actual.duration,actual.format));await checkHtmlProject(project,{fullCheck:true});
      // Controlled local result identity only: no model, voice or movie quality
      // is asserted by these bytes. The real HTML/browser checks ran above.
      const file=path.join(project,'controlled-result.bin'),bytes='geometry check completed';await writeFile(file,bytes);return{file,analysis:{sourceHash:hashBytes(bytes)}};
    }});
    assert.ok(result.file);assert.equal(authors,2);assert.equal(checks,2);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.ok(!state.native);
    const evidence=path.join(project,state.failed[0].evidence.directory),combined=JSON.parse(await readFile(path.join(evidence,'check-report.json'),'utf8'));
    assert.equal(combined.ok,false);assert.equal(combined.svgPaint.source,'server-svg-paint');assert.equal(combined.svgPaint.htmlHash,actual.provenance.actualHTMLSHA256);
    const original=await readFile(path.join(project,combined.svgPaint.upstreamReport.path));assert.equal(hashBytes(original),combined.svgPaint.upstreamReport.sha256);
    const raw=JSON.parse(original.toString());assert.equal(raw.ok,true);assert.equal(raw.layout.findings.length,0,'the old checker blind spot remains honestly observable');
    assert.ok(combined.layout.findings.some((f:any)=>f.source==='server-svg-paint'));
  });
});
