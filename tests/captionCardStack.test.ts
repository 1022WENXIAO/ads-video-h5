import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {parse,serialize} from 'parse5';
import {stackIndependentCards} from '../server/drawingCardLayout';
import {drawingHtml,drawingDomId,hashBytes,checkHtmlProject,type HtmlDrawing} from '../server/narrativeScenes';
import {drawingContentHash,htmlLayoutIssues,recoverLessonHtml} from '../server/lessonHtmlRecovery';
const fixture=JSON.parse(await readFile(new URL('./fixtures/caption-card-overlap-20261031.json',import.meta.url),'utf8'));
const drawing=fixture.drawing as HtmlDrawing;
const issues=htmlLayoutIssues(fixture.report);
function capturedTimingHtml(candidate:HtmlDrawing){
  const document=parse(fixture.originalHtml),replacement=parse(drawingHtml(candidate,fixture.report.layout.duration,'9:16',undefined,{}));
  const plane=(root:any)=>{let found:any;const visit=(node:any)=>{if(node.attrs?.some((a:any)=>a.name==='class'&&a.value==='drawing-plane'))found=node;for(const child of node.childNodes||[])visit(child)};visit(root);return found};
  // Production retains this chapter's narration-bound animation cues. Keep
  // that exact captured motion here rather than substituting default timing.
  plane(document).childNodes=plane(replacement).childNodes;
  return serialize(document);
}

test('captured opaque caption cards obtain separate rows without changing the diagram or its words',()=>{
  assert.equal(hashBytes(fixture.originalHtml),fixture.provenance.originalHtmlSha256);
  const original=structuredClone(drawing),proposal=stackIndependentCards(drawing,issues,'9:16');assert.ok(proposal);
  assert.deepEqual(drawing,original);assert.equal(drawingContentHash(proposal),drawingContentHash(original));
  assert.equal(proposal.nodes.find(n=>n.id==='bottom-caption')!.y,870);
  for(const node of original.nodes){const next=proposal.nodes.find(n=>n.id===node.id)!;assert.deepEqual(node.id==='bottom-caption'?{...next,y:node.y}:next,node);}
  for(const malformed of [[],[{...issues[0],code:'contrast_aa_failure'}],[{...issues[0],selector:'#bottom-caption'}],[{...issues[0],containerSelector:'#unknown'}]])assert.equal(stackIndependentCards(drawing,malformed,'9:16'),undefined);
  const blocked=structuredClone(drawing);blocked.nodes.push({id:'occupied-gap',kind:'card',x:70,y:870,w:580,h:30,text:'不可移动的原有内容',tone:'paper',fontSize:24,highlight:false});assert.equal(stackIndependentCards(blocked,issues,'9:16'),undefined);
  const bound=structuredClone(drawing);bound.serverCardLabels=[{cardId:'bottom-caption',labelId:'note',text:'原文',fontSize:30}];assert.equal(stackIndependentCards(bound,issues,'9:16'),undefined);
});

test('real loaded-font and paint checks repair the captured occlusion inside the original two-check budget',{timeout:120000},async t=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-caption-card-stack-'));t.after(()=>rm(project,{recursive:true,force:true}));
  await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
  let authors=0,checks=0;
  const options={project,chapterId:'captured-knowledge-caption',contextHash:'captured-20261031-caption-stack',format:'9:16' as const,author:async()=>{authors++;return structuredClone(drawing)},produce:async(candidate:HtmlDrawing)=>{
    checks++;await writeFile(path.join(project,'index.html'),checks===1?fixture.originalHtml:capturedTimingHtml(candidate));
    try{await checkHtmlProject(project,{fullCheck:true})}catch(error){
      const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));
      assert.equal(checks,1);assert.ok(htmlLayoutIssues(report).some(i=>i.code==='text_occluded'&&i.selector==='#'+drawingDomId('bottom-caption')&&i.containerSelector==='#'+drawingDomId('note')));throw error;
    }
    const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));assert.equal(report.ok,true);assert.equal(report.runtime.ok,true);assert.equal(report.contrast.ok,true);assert.equal(report.svgPaint.samples.length,9);assert.equal(report.drawingText.samples.length,9);assert.deepEqual(htmlLayoutIssues(report),[]);
    const file=path.join(project,'checked-layout-only.txt');await writeFile(file,'Actual browser layout proof, not a video acceptance claim.');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};
  }};
  const result=await recoverLessonHtml(options);assert.equal(authors,1);assert.equal(checks,2);assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(checks,2);
  const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,1);assert.equal(state.native,undefined);
});
