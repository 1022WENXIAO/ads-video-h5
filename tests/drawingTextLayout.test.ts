import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {drawingHtml,checkHtmlProject,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectDrawingTextLayout,addDrawingTextLayoutReport} from '../server/drawingTextLayout';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {JobCancelledError,runWithJobSignal} from '../server/jobExecution';

const actual=JSON.parse(await readFile(new URL('./fixtures/p23-authored-text-overlap.json',import.meta.url),'utf8'));
async function withProject<T>(html:string,run:(project:string)=>Promise<T>){const project=await mkdtemp(path.join(tmpdir(),'qingjian-drawing-text-'));try{await writeFile(path.join(project,'index.html'),html);await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));return await run(project);}finally{await rm(project,{recursive:true,force:true});}}
function actualHtml(which:'first'|'second'){return drawingHtml(actual[which],actual.duration,actual.format,actual.publicationAnnotation);}
function separated(){const drawing=structuredClone(actual.first) as HtmlDrawing;Object.assign(drawing.nodes.find(n=>n.id==='target')!,{x:80,y:870,w:560});return drawing;}
function overlappingLabels():HtmlDrawing{return{title:'实际文字几何',motion:'corporate',nodes:[
  {id:'left',kind:'text',x:100,y:300,w:400,h:80,text:'核查问题',tone:'ink',fontSize:40,highlight:false},
  {id:'right',kind:'text',x:100,y:300,w:400,h:80,text:'核查结论',tone:'ink',fontSize:40,highlight:false},
  {id:'diagram',kind:'path',x:140,y:650,w:440,h:50,text:'',tone:'blue',fontSize:24,highlight:false,pathData:'M140 650 H580 V700'},
]};}
function separateLabels(){const drawing=overlappingLabels();drawing.nodes.find(n=>n.id==='right')!.y=430;return drawing;}
function controlled(content:string,styles='',timeline=true){return `<!doctype html><html><head><style>html,body{margin:0}#main{position:relative;width:720px;height:1280px;background:white}.node{position:absolute;font:700 40px/1.3 Arial,sans-serif;color:black;white-space:nowrap;overflow:visible}${styles}</style><script src="./gsap.min.js"></script></head><body><section id="main" data-composition-id="main" data-width="720" data-height="1280" data-duration="4">${content}</section><script>${timeline?'window.__timelines={main:gsap.timeline({paused:true})};':''}</script></body></html>`;}
const node=(id:string,text:string,style:string)=>`<div id="${id}" data-drawing-id="${id}" class="node text" style="${style}">${text}</div>`;

test('exact first P23 incident keeps its original HTML/text and records the current real font and line geometry',{timeout:45000},async t=>{
  const before=structuredClone(actual),html=actualHtml('first');assert.equal(hashBytes(html),actual.provenance.firstHtmlHash);
  await withProject(html,async project=>{const report=await inspectDrawingTextLayout(project);assert.ok(report);assert.equal(report.htmlHash,hashBytes(html));assert.equal(report.samples.length,9);assert.equal(report.frames.length,9);
    const target=report.frames.at(-1)!.nodes.find(n=>n.selector==='#qj-author-target')!;
    assert.equal(target.text,actual.first.nodes.find((n:any)=>n.id==='target').text);
    assert.equal(target.lines.map(line=>line.text).join(''),target.text);
    assert.ok(target.lines.every(line=>line.rect.width>0&&line.rect.height>0));
    assert.ok(report.fonts.some(f=>f.selector==='#qj-author-target'&&f.fonts.some(font=>font.glyphCount>0&&font.familyName)));
    // Production used Noto CJK + DejaVu, Mac uses PingFang, and the CI's
    // fallback can produce different line geometry. The archived real orphan
    // remains evidence, not a claim that every installed font must reproduce it.
    t.diagnostic(JSON.stringify({htmlHash:report.htmlHash,targetFont:report.fonts.find(f=>f.selector===target.selector),observedLines:target.lines,findings:report.findings.map(f=>({code:f.code,selector:f.selector,characters:f.characters}))}));
    assert.equal(await readFile(path.join(project,'index.html'),'utf8'),html);
  });assert.deepEqual(actual,before);
});

test('independent labels with shared same-font glyphs really overlap on every platform; only moving geometry clears them',{timeout:45000},async()=>{
  const bad=overlappingLabels(),good=separateLabels();assert.deepEqual(bad.nodes.map(n=>[n.id,n.text,n.fontSize,n.pathData]),good.nodes.map(n=>[n.id,n.text,n.fontSize,n.pathData]));
  await withProject(drawingHtml(bad,4),async project=>{const report=(await inspectDrawingTextLayout(project))!;assert.ok(report.findings.some(f=>f.code==='content_overlap'&&f.selector==='#qj-author-left'&&f.containerSelector==='#qj-author-right'&&f.characters.includes('核')));assert.ok(report.findings.every(f=>f.code!=='orphan_line'));});
  await withProject(drawingHtml(good,4),async project=>assert.deepEqual((await inspectDrawingTextLayout(project))!.findings,[]));
});

test('exact second P23 drawing has no HTML-only text-to-text collision; SVG paint is checked separately',{timeout:45000},async()=>{
  const html=actualHtml('second');assert.equal(hashBytes(html),actual.provenance.secondHtmlHash);
  await withProject(html,async project=>{const report=(await inspectDrawingTextLayout(project))!;assert.deepEqual(report.findings,[]);
    const target=report.frames.at(-1)!.nodes.find(n=>n.selector==='#qj-author-target')!;assert.equal(target.lines.at(-1)!.text,'断裂问题');assert.equal(target.lines.map(l=>l.text).join(''),actual.second.nodes.find((n:any)=>n.id==='target').text);
    const joint=report.frames.at(-1)!.nodes.find(n=>n.selector==='#qj-author-joint')!;assert.equal(joint.lines.at(-1)!.text,'组');
  });
});

test('separated first drawing retains every word, font and path and passes the actual browser text check',{timeout:45000},async()=>{
  const repaired=separated();assert.deepEqual(repaired.nodes.map(n=>[n.id,n.text,n.fontSize,n.pathData]),actual.first.nodes.map((n:any)=>[n.id,n.text,n.fontSize,n.pathData]));
  await withProject(drawingHtml(repaired,actual.duration,actual.format,actual.publicationAnnotation),async project=>assert.deepEqual((await inspectDrawingTextLayout(project))!.findings,[]));
});

test('real clipping is rejected, while overflow-visible text outside its own small box is not called cropped',{timeout:45000},async()=>{
  const content=node('long','READABLE','left:100px;top:300px;width:25px;height:55px');
  await withProject(controlled(content),async project=>assert.deepEqual((await inspectDrawingTextLayout(project))!.findings,[]));
  await withProject(controlled(`<div style="position:absolute;left:100px;top:300px;width:100px;height:60px;overflow:hidden">${node('cut','READABLE','left:0;top:0;width:300px;height:55px')}</div>`),async project=>assert.ok((await inspectDrawingTextLayout(project))!.findings.some(f=>f.code==='text_overflow'&&f.characters.length)));
  await withProject(controlled(node('edge','READABLE','left:690px;top:300px;width:300px;height:55px')),async project=>assert.ok((await inspectDrawingTextLayout(project))!.findings.some(f=>f.code==='text_overflow')));
});

test('line-box overlap, explicit line breaks, transparent/hidden text and astral Han offsets remain safe',{timeout:60000},async()=>{
  const content=node('first','TEST','left:100px;top:300px;width:300px;height:60px')+node('second','TEST','left:100px;top:340px;width:300px;height:60px')+node('hidden','TEST','left:100px;top:300px;opacity:0')+node('transparent','TEST','left:100px;top:300px;color:transparent')+node('rare','𬸚𬸦名字','left:100px;top:600px;width:300px;height:60px')+node('intentional','这是完整的显式换行说明文字\n题','left:100px;top:800px;width:500px;height:150px;white-space:pre-line');
  await withProject(controlled(content),async project=>{const report=(await inspectDrawingTextLayout(project))!;assert.deepEqual(report.findings,[]);assert.equal(report.frames.at(-1)!.nodes.find(n=>n.selector==='#rare')!.lines[0].text,'𬸚𬸦名字');});
});

test('a natural soft-wrapped final Han is an advisory and alone never rejects the combined candidate',{timeout:45000},async()=>{
  const text='甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌';assert.equal([...text].length,21);
  const html=controlled(node('soft-wrap',text,'left:100px;top:300px;width:10em;height:200px;white-space:normal'));
  await withProject(html,async project=>{
    const report=(await inspectDrawingTextLayout(project))!,label=report.frames.at(-1)!.nodes.find(n=>n.selector==='#soft-wrap')!;
    assert.deepEqual(label.lines.map(line=>line.text),['甲乙丙丁戊己庚辛壬癸','子丑寅卯辰巳午未申酉','戌']);
    assert.ok(report.findings.some(f=>f.code==='orphan_line'&&f.severity==='warning'&&f.characters[0]==='戌'));
    assert.ok(report.findings.every(f=>f.severity==='warning'));
    const upstream={ok:true,layout:{ok:true,errorCount:0,findings:[]}},combined=await addDrawingTextLayoutReport(project,'check',upstream,JSON.stringify(upstream),upstream);
    assert.equal(combined.ok,true);assert.equal(combined.layout.ok,true);assert.equal(combined.layout.errorCount,0);assert.deepEqual(combined.layout.findings,[]);
    const archived=JSON.parse(await readFile(path.join(project,combined.drawingText.report.path),'utf8'));
    assert.ok(archived.findings.some((f:any)=>f.code==='orphan_line'&&f.severity==='warning'));
  });
});

test('missing timeline/IO/cancellation cannot become a text layout pass and cancellation closes the owned browser',{timeout:45000},async()=>{
  await withProject(controlled(node('text','TEST','left:100px;top:300px'),'',false),async project=>assert.rejects(inspectDrawingTextLayout(project),/timeline/));
  await assert.rejects(inspectDrawingTextLayout(path.join(tmpdir(),'missing-text-layout-'+Date.now())),{code:'ENOENT'});
  const require=createRequire(createRequire(import.meta.url).resolve('hyperframes/package.json'));const {default:puppeteer}=await import(require.resolve('puppeteer-core')),launch=puppeteer.launch;const controller=new AbortController();let opened:any;
  puppeteer.launch=async function(options:any){opened=await launch.call(this,options);controller.abort();return opened;};
  try{await withProject(controlled(node('text','TEST','left:100px;top:300px')),async project=>assert.rejects(runWithJobSignal(controller.signal,()=>inspectDrawingTextLayout(project)),JobCancelledError));assert.ok(opened);assert.equal(opened.connected,false);const child=opened.process();assert.ok(child?.exitCode!==null||child?.signalCode!==null);}finally{puppeteer.launch=launch;await opened?.close();}
});

test('new evidence preserves controlled passing upstream bytes and HTML separately from the real-browser failing candidate',{timeout:45000},async()=>{
  // A controlled upstream input tests byte preservation independently of
  // whether that platform's HyperFrames already catches this obvious overlap.
  const upstream={ok:true,layout:{ok:true,errorCount:0,findings:[]}},stdout='controlled upstream output\n'+JSON.stringify(upstream),html=drawingHtml(overlappingLabels(),4);
  await withProject(html,async project=>{const combined=await addDrawingTextLayoutReport(project,'check',upstream,stdout,upstream);assert.equal(combined.ok,false);assert.equal(combined.layout.errorCount,1);assert.equal(combined.layout.findings[0].source,'server-drawing-text');assert.deepEqual(upstream,{ok:true,layout:{ok:true,errorCount:0,findings:[]}});
    for(const [pointer,bytes]of [[combined.drawingText.upstreamReport,JSON.stringify(upstream,null,2)],[combined.drawingText.upstreamStdout,stdout],[combined.drawingText.htmlSnapshot,html]] as const){const saved=await readFile(path.join(project,pointer.path),'utf8');assert.equal(saved,bytes);assert.equal(hashBytes(saved),pointer.sha256);}
    const report=JSON.parse(await readFile(path.join(project,combined.drawingText.report.path),'utf8'));assert.equal(report.htmlHash,hashBytes(html));assert.equal(report.samples.length,9);assert.equal(combined.layout.findings.length,1,'only the actual independent-label ink collision is a hard failure');
  });
});

test('controlled real glyph overlap uses the existing two-author HTML recovery without changing its budget or words',{timeout:120000},async()=>{
  await withProject(drawingHtml(overlappingLabels(),4),async project=>{let authors=0,checks=0;const result=await recoverLessonHtml({project,chapterId:'chapter-1',contextHash:'controlled-actual-text-geometry-regression',format:'9:16',author:async feedback=>{authors++;if(authors===2)assert.match(feedback,/content_overlap|text_occluded|glyph ink/);return authors===1?overlappingLabels():separateLabels();},produce:async drawing=>{checks++;await writeFile(path.join(project,'index.html'),drawingHtml(drawing!,4));
      const actualText=(await inspectDrawingTextLayout(project))!;
      assert.equal(actualText.findings.some(f=>f.code==='content_overlap'),checks===1,'real loaded-font ink is checked before the full CLI, independently of its own overlap detection');
      await checkHtmlProject(project,{fullCheck:true});const file=path.join(project,'controlled-result.bin');await writeFile(file,'geometry-only');return{file,analysis:{sourceHash:hashBytes('geometry-only')}};}});
    assert.ok(result.file);assert.equal(authors,2);assert.equal(checks,2);const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.ok(!state.native);
    const failed=JSON.parse(await readFile(path.join(project,state.failed[0].evidence.directory,'check-report.json'),'utf8'));assert.equal(failed.ok,false);assert.ok(failed.layout.findings.some((f:any)=>['content_overlap','text_occluded'].includes(f.code)));
  });
});
