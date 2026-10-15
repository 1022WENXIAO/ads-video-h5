import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {drawingHtml,checkHtmlProject,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {inspectSvgTextPaint} from '../server/svgPaintOcclusion';
import {inspectDrawingTextLayout} from '../server/drawingTextLayout';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
const actual=JSON.parse(await readFile(new URL('./fixtures/p23-authored-text-overlap.json',import.meta.url),'utf8'));
async function withProject<T>(html:string,run:(project:string)=>Promise<T>){const project=await mkdtemp(path.join(tmpdir(),'qingjian-svg-glyph-'));try{await writeFile(path.join(project,'index.html'),html);await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));return await run(project);}finally{await rm(project,{recursive:true,force:true});}}
function separated(){const drawing=structuredClone(actual.second) as HtmlDrawing;drawing.nodes.find(n=>n.id==='target')!.y=740;return drawing;}
function html(drawing:HtmlDrawing){return drawingHtml(drawing,actual.duration,actual.format,actual.publicationAnnotation);}
function controlled(mode:'half'|'pixel'|'transparent'|'behind'){
  return `<!doctype html><html><head><style>html,body{margin:0}#main{position:relative;width:720px;height:1280px;background:white}#label{position:absolute;left:60px;top:300px;font:700 32px Arial,sans-serif;z-index:1}svg{position:absolute;inset:0;width:720px;height:1280px;z-index:${mode==='behind'?0:2};pointer-events:none}</style><script src="./gsap.min.js"></script></head><body><section id="main" data-composition-id="main" data-width="720" data-height="1280" data-duration="4"><div id="label">READABLE LONG LABEL H</div><svg viewBox="0 0 720 1280"><path id="paint" data-drawing-id="paint" d="M0 0H1V1H0Z" fill="${mode==='transparent'?'transparent':'white'}" stroke="none"/></svg></section><script>const e=document.querySelector('#label'),n=e.firstChild,r=document.createRange();r.setStart(n,n.textContent.length-1);r.setEnd(n,n.textContent.length);const rect=r.getBoundingClientRect();${mode==='pixel'?`const c=document.createElement('canvas'),cx=c.getContext('2d');cx.font=getComputedStyle(e).font;const m=cx.measureText('H'),h=m.fontBoundingBoxAscent+m.fontBoundingBoxDescent;c.width=Math.ceil(m.width);c.height=Math.ceil(h);cx.font=getComputedStyle(e).font;cx.fillText('H',0,m.fontBoundingBoxAscent);const bytes=cx.getImageData(0,0,c.width,c.height).data;let sample;for(let y=1;y<c.height&&!sample;y+=2)for(let x=1;x<c.width;x+=2)if(bytes[(y*c.width+x)*4+3]>=128){sample={x:rect.left+(x+.5)/m.width*rect.width,y:rect.top+(y+.5)/h*rect.height};break;}document.querySelector('#paint').setAttribute('d','M'+(sample.x-.2)+' '+(sample.y-.2)+'h.4v.4h-.4Z');`:`document.querySelector('#paint').setAttribute('d','M'+rect.left+' '+(rect.top+rect.height/2)+'H'+rect.right+'V'+rect.bottom+'H'+rect.left+'Z');`}window.__timelines={main:gsap.timeline({paused:true})};</script></body></html>`;
}

test('actual second P23 HTML has a damaged final glyph that its whole long-label ink average concealed',{timeout:45000},async()=>{
  const before=structuredClone(actual.second),source=html(actual.second);assert.equal(hashBytes(source),actual.provenance.secondHtmlHash);
  await withProject(source,async project=>{const svg=(await inspectSvgTextPaint(project))!;const finding=svg.findings.find(f=>f.selector==='#qj-author-target')!;assert.ok(finding);assert.equal(finding.text,before.nodes.find((n:any)=>n.id==='target').text);assert.ok(finding.coveredFraction<.15,'the old span average did not reach its threshold');
    const glyph=finding.affectedGlyphs!.find(g=>g.char==='题')!;assert.ok(glyph);assert.ok(glyph.coveredFraction>=.15&&glyph.coveredInkSamples>=4);assert.ok(glyph.paths.includes('#qj-author-pedal'));assert.equal(glyph.utf16End-glyph.utf16Start,1);assert.equal(finding.text.slice(glyph.utf16Start,glyph.utf16End),'题');assert.equal(svg.htmlHash,hashBytes(source));
    assert.deepEqual((await inspectDrawingTextLayout(project))!.findings,[],'HTML text geometry alone must not claim to detect or clear SVG paint');assert.equal(await readFile(path.join(project,'index.html'),'utf8'),source);
  });assert.deepEqual(actual.second,before);
});

test('an independent clear text zone preserves all actual words, fonts and SVG paths and passes both guards',{timeout:45000},async()=>{
  const repaired=separated();assert.deepEqual(repaired.nodes.map(n=>[n.id,n.text,n.fontSize,n.pathData]),actual.second.nodes.map((n:any)=>[n.id,n.text,n.fontSize,n.pathData]));
  await withProject(html(repaired),async project=>{assert.deepEqual((await inspectSvgTextPaint(project))!.findings,[]);assert.deepEqual((await inspectDrawingTextLayout(project))!.findings,[]);});
});

test('single-glyph protection generalizes to a long ASCII label while a one-sample contact does not become a failure',{timeout:45000},async()=>{
  await withProject(controlled('half'),async project=>{const finding=(await inspectSvgTextPaint(project))!.findings.find(f=>f.selector==='#label')!;assert.ok(finding);assert.ok(finding.text.length>16&&finding.coveredFraction<.15);assert.ok(finding.affectedGlyphs!.some(g=>g.char==='H'&&g.coveredFraction>=.15&&g.coveredInkSamples>=4));});
  for(const mode of ['pixel','transparent','behind'] as const)await withProject(controlled(mode),async project=>assert.deepEqual((await inspectSvgTextPaint(project))!.findings,[]));
});

test('the actual last-glyph failure enters only the existing bounded local HTML redraw and keeps raw upstream evidence',{timeout:120000},async()=>{
  await withProject(html(actual.second),async project=>{let authors=0,checks=0;const result=await recoverLessonHtml({project,chapterId:'chapter-1',contextHash:'actual-p23-svg-last-glyph',format:'9:16',author:async feedback=>{authors++;if(authors===2)assert.match(feedback,/Actual SVG fill\/stroke/);return authors===1?structuredClone(actual.second):separated();},produce:async drawing=>{checks++;await writeFile(path.join(project,'index.html'),html(drawing!));await checkHtmlProject(project,{fullCheck:true});const file=path.join(project,'controlled-result.bin');await writeFile(file,'geometry-only');return{file,analysis:{sourceHash:hashBytes('geometry-only')}};}});
    assert.ok(result.file);assert.equal(authors,2);assert.equal(checks,2);const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.ok(!state.native);
    const combined=JSON.parse(await readFile(path.join(project,state.failed[0].evidence.directory,'check-report.json'),'utf8'));assert.equal(combined.ok,false);const finding=combined.layout.findings.find((f:any)=>f.selector==='#qj-author-target');assert.ok(finding.affectedGlyphs.some((g:any)=>g.char==='题'));assert.equal(combined.svgPaint.htmlHash,actual.provenance.secondHtmlHash);const bytes=await readFile(path.join(project,combined.svgPaint.upstreamReport.path));assert.equal(hashBytes(bytes),combined.svgPaint.upstreamReport.sha256);assert.equal(JSON.parse(bytes.toString()).ok,true);
  });
});
