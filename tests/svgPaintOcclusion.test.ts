import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {checkHtmlProject,drawingHtml,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectSvgTextPaint} from '../server/svgPaintOcclusion';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';

const actual=JSON.parse(await readFile(new URL('./fixtures/p21-svg-text-occlusion.json',import.meta.url),'utf8')) as {drawing:HtmlDrawing;duration:number;format:'9:16';provenance:{actualHTMLSHA256:string}};
const leaf=JSON.parse(await readFile(new URL('./fixtures/p36-leaf-stroke-label-interference.json',import.meta.url),'utf8')) as {html:string;inspectionTime:number;provenance:{actualHTMLSHA256:string};clearZoneChanges:Array<{id:string;oldTop:number;newTop:number}>};
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
function controlled(pathData:string,options:{fill?:string;stroke?:string;strokeOpacity?:number;opacity?:number;z?:number;dash?:boolean;owned?:boolean;timeline?:boolean;labelBackground?:string;strokeWidth?:number}={}){
  return `<!doctype html><html><head><style>html,body{margin:0}#main{position:relative;width:720px;height:1280px;background:white}#label{position:absolute;left:120px;top:300px;font:700 40px Arial,sans-serif;z-index:1;background:${options.labelBackground??'transparent'}}.products{position:absolute;inset:0;width:720px;height:1280px;pointer-events:none;z-index:${options.z??2};opacity:${options.opacity??1}}</style><script src="./gsap.min.js"></script></head><body><section id="main" data-composition-id="main" data-width="720" data-height="1280" data-duration="4"><div id="label">TEST</div><svg class="products" viewBox="0 0 720 1280"><path id="graphic" ${options.owned===false?'':'data-drawing-id="graphic"'} d="${pathData}" fill="${options.fill??'none'}" stroke="${options.stroke??'black'}" stroke-opacity="${options.strokeOpacity??1}" stroke-width="${options.strokeWidth??5}" ${options.dash?'stroke-dasharray="300" stroke-dashoffset="300"':''}/></svg></section><script>${options.timeline===false?'':`window.__timelines={main:gsap.timeline({paused:true})};window.__timelines.main.to('#graphic',{${options.dash?'strokeDashoffset:0,':'opacity:1,'}duration:1},1);`}</script></body></html>`;
}

// Opt-in local evidence only. Default CI does not take diagnostic PNGs.
async function captureLeafEvidence(project:string,name:string,report:unknown){
  const output=process.env.QINGJIAN_SVG_BELOW_STROKE_QA_DIR;if(!output)return;
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));
  const [{default:puppeteer},browsers]=await Promise.all([import(require.resolve('puppeteer-core')),import(require.resolve('@puppeteer/browsers'))]);
  let executablePath=process.env.HYPERFRAMES_BROWSER_PATH||process.env.PRODUCER_HEADLESS_SHELL_PATH;
  for(const cacheDir of [path.join(homedir(),'.cache/hyperframes/chrome'),path.join(homedir(),'.cache/puppeteer')]){
    if(executablePath)break;
    executablePath=(await browsers.getInstalledBrowsers({cacheDir})).find((b:any)=>b.platform===browsers.detectBrowserPlatform()&&['chrome-headless-shell','chrome'].includes(b.browser))?.executablePath;
  }
  assert.ok(executablePath,'local QA requires an already installed browser');await mkdir(output,{recursive:true,mode:0o700});
  const browser=await puppeteer.launch({executablePath,headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--allow-file-access-from-files']});
  try{
    const page=await browser.newPage();await page.setViewport({width:720,height:1280});await page.setRequestInterception(true);
    page.on('request',(request:any)=>{void (/^(?:file:|data:)/.test(request.url())?request.continue():request.abort()).catch(()=>{});});
    await page.goto(pathToFileURL(path.join(project,'index.html')).href,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);
    await page.evaluate((time:number)=>{(window as any).__timelines.main.pause().seek(time,false);},leaf.inspectionTime);
    await page.screenshot({path:path.join(output,name+'.png')});
    await writeFile(path.join(output,name+'.json'),JSON.stringify({htmlHash:hashBytes(await readFile(path.join(project,'index.html'))),time:leaf.inspectionTime,report},null,2),{flag:'wx',mode:0o600});
  }finally{await browser.close();}
}

test('actual transparent leaf labels reject visible under-strokes; spatially separated same words/fonts/paths pass',{timeout:60000},async()=>{
  assert.equal(hashBytes(leaf.html),leaf.provenance.actualHTMLSHA256);
  await withProject(leaf.html,async project=>{
    const result=(await inspectSvgTextPaint(project))!;assert.equal(result.htmlHash,leaf.provenance.actualHTMLSHA256);assert.equal(result.samples.length,9);
    for(const id of ['dry_text','wet_text'])assert.ok(result.findings.some(f=>f.selector==='#qj-author-'+id&&f.code==='content_overlap'&&f.paintRelation==='visible-below-stroke'&&f.visibleStrokeSamples!>0),id);
    assert.ok(result.findings.every(f=>f.affectedGlyphs?.some(g=>g.coveredInkSamples>=4&&g.coveredFraction>=.15)));
    assert.equal(await readFile(path.join(project,'index.html'),'utf8'),leaf.html);await captureLeafEvidence(project,'actual-before',result);
  });
  let clear=leaf.html;
  for(const change of leaf.clearZoneChanges){
    const before=new RegExp(`(id="qj-author-${change.id}"[^>]*style="[^"]*top:)${change.oldTop}px`);assert.match(clear,before);clear=clear.replace(before,`$1${change.newTop}px`);
  }
  assert.equal(clear.replace(/top:900px/g,'top:954px'),leaf.html,'only the two label positions change; words, font, paths and animation remain exact');
  await withProject(clear,async project=>{const result=(await inspectSvgTextPaint(project))!;assert.deepEqual(result.findings,[]);await captureLeafEvidence(project,'clear-zone-after',result);});
});

test('below-stroke visibility excludes opaque label/ancestor/sibling paint, under-fill and normal underline; actual dash reveal remains bounded',{timeout:90000},async()=>{
  const opaqueAncestor=controlled('M100 325H400',{z:0}).replace('<div id="label">TEST</div>','<div style="position:absolute;left:100px;top:280px;width:320px;height:90px;z-index:1;background:white"><div id="label" style="left:20px;top:20px">TEST</div></div>');
  const opaqueSibling=controlled('M100 325H400',{z:0}).replace('z-index:1;background:transparent','z-index:2;background:transparent').replace('<div id="label">TEST</div>','<div style="position:absolute;left:100px;top:280px;width:320px;height:90px;z-index:1;background:white"></div><div id="label">TEST</div>');
  for(const html of [controlled('M100 325H400',{z:0,labelBackground:'white'}),opaqueAncestor,opaqueSibling,controlled('M80 270H400V370H80Z',{z:0,fill:'#eee',stroke:'none'}),controlled('M100 350H400',{z:0}),controlled('M100 325H400',{z:0,strokeOpacity:0})])await withProject(html,async project=>assert.deepEqual((await inspectSvgTextPaint(project))?.findings,[]));
  // This synthetic positive uses a clearly crossing ten-pixel stroke; the
  // actual five-pixel leaf strokes are independently covered above.
  await withProject(controlled('M100 325H400',{z:0,strokeWidth:10}),async project=>assert.ok((await inspectSvgTextPaint(project))!.findings.some(f=>f.paintRelation==='visible-below-stroke')));
  await withProject(controlled('M100 325H400',{z:0,dash:true,strokeWidth:10}),async project=>{const result=(await inspectSvgTextPaint(project))!;assert.ok(result.findings.some(f=>f.paintRelation==='visible-below-stroke'));assert.ok(result.findings.every(f=>f.time>1),'an undrawn dash cannot create visible interference');});
});

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

test('real browser rejection uses a verified automatic label repair within two checks and preserves the upstream passing bytes',{timeout:120000},async()=>{
  await withProject(drawingHtml(actual.drawing,actual.duration,actual.format),async project=>{
    let authors=0,checks=0;
    const result=await recoverLessonHtml({project,chapterId:'chapter-1',contextHash:'actual-p21-svg-geometry-regression',format:'9:16',author:async feedback=>{authors++;if(authors===2)assert.match(feedback,/Actual SVG fill\/stroke/);return authors===1?structuredClone(actual.drawing):clearZones();},produce:async drawing=>{
      checks++;await writeFile(path.join(project,'index.html'),drawingHtml(drawing!,actual.duration,actual.format));await checkHtmlProject(project,{fullCheck:true});
      // Controlled local result identity only: no model, voice or movie quality
      // is asserted by these bytes. The real HTML/browser checks ran above.
      const file=path.join(project,'controlled-result.bin'),bytes='geometry check completed';await writeFile(file,bytes);return{file,analysis:{sourceHash:hashBytes(bytes)}};
    }});
    assert.ok(result.file);assert.equal(authors,1);assert.equal(checks,2);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.ok(!state.native);
    assert.deepEqual(state.completed.drawing.serverCardLabels.map((binding:any)=>binding.cardId).sort(),['card_check','card_signal']);
    for(const binding of state.completed.drawing.serverCardLabels){assert.equal(binding.text,actual.drawing.nodes.find(node=>node.id===binding.cardId)!.text);assert.equal(state.completed.drawing.nodes.find((node:any)=>node.id===binding.labelId).text,binding.text);}
    const evidence=path.join(project,state.failed[0].evidence.directory),combined=JSON.parse(await readFile(path.join(evidence,'check-report.json'),'utf8'));
    assert.equal(combined.ok,false);assert.equal(combined.svgPaint.source,'server-svg-paint');assert.equal(combined.svgPaint.htmlHash,actual.provenance.actualHTMLSHA256);
    const original=await readFile(path.join(project,combined.svgPaint.upstreamReport.path));assert.equal(hashBytes(original),combined.svgPaint.upstreamReport.sha256);
    const raw=JSON.parse(original.toString());assert.equal(raw.ok,true);assert.equal(raw.layout.findings.length,0,'the old checker blind spot remains honestly observable');
    assert.ok(combined.layout.findings.some((f:any)=>f.source==='server-svg-paint'));
  });
});
