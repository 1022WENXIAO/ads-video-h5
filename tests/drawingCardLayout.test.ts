import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {liftCardLabels,reflowCardDetails} from '../server/drawingCardLayout';
import {drawingContentHash,htmlLayoutIssues,recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {checkHtmlProject,drawingHtml,hashBytes,validateDrawing,type HtmlDrawing} from '../server/narrativeScenes';
const fixture=JSON.parse(await readFile(new URL('./fixtures/html-layout-news-p8.json',import.meta.url),'utf8'));
const knowledge=JSON.parse(await readFile(new URL('./fixtures/html-layout-knowledge-p8.json',import.meta.url),'utf8'));

for(const[index,attempt]of knowledge.attempts.entries())test(`P8 knowledge ${index+1}: real card/circle label repair retains all embedded entities`,async()=>{
  const before=structuredClone(attempt.drawing),fixed=liftCardLabels(attempt.drawing,htmlLayoutIssues(attempt.report),'16:9');assert.ok(fixed);validateDrawing(fixed,'16:9');
  assert.deepEqual(attempt.drawing,before);assert.equal(drawingContentHash(fixed),drawingContentHash(before));
  for(const node of before.nodes)if(node.id!=='stage2')assert.deepEqual(fixed.nodes.find(n=>n.id===node.id),node);
  assert.equal(fixed.nodes.find(n=>n.id==='stage2_label')!.fontSize,before.nodes.find((n:any)=>n.id==='stage2').fontSize);
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-p8-circle-browser-'));
  try{
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));await writeFile(path.join(project,'index.html'),drawingHtml(before,10,'16:9'));await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/content_overlap/);
    await writeFile(path.join(project,'index.html'),drawingHtml(fixed,10,'16:9'));
    // Lifting the circle/card label remains correct, but the old checker also
    // missed unrelated SVG icons painted across stage1/3's central labels.
    await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/Actual SVG fill\/stroke/);
    const rejected=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));
    assert.ok(rejected.svgPaint.findings.some((f:any)=>f.selector==='#qj-author-stage1'&&f.containerSelector==='#qj-author-lampIcon'));
    const separated=structuredClone(fixed);
    for(const id of ['stage1','stage3']){
      const card=separated.nodes.find(n=>n.id===id)!;
      separated.nodes.push({...card,id:id+'_clear_label',kind:'text',y:index===0?408:430,h:index===0?142:60,highlight:false});card.text='';
    }
    Object.assign(separated.nodes.find(n=>n.id==='bottomNote')!,{x:890,y:160,w:350,h:64});
    const loopLabel=separated.nodes.find(n=>n.id==='loopLabel');
    if(loopLabel){separated.nodes.push({...loopLabel,id:'loop_clear_label',kind:'text',y:510,h:40,highlight:false});loopLabel.text='';}
    assert.equal(drawingContentHash(separated),drawingContentHash(before));
    assert.deepEqual(separated.nodes.filter(n=>n.kind==='path'||n.kind==='line'),before.nodes.filter(n=>n.kind==='path'||n.kind==='line'));
    assert.deepEqual(separated.nodes.filter(n=>n.text).map(n=>[n.text,n.fontSize]).sort(),before.nodes.filter(n=>n.text).map(n=>[n.text,n.fontSize]).sort());
    await writeFile(path.join(project,'index.html'),drawingHtml(separated,10,'16:9'));await checkHtmlProject(project,{fullCheck:true});
  }finally{await rm(project,{recursive:true,force:true});}
});

for(const[index,attempt]of fixture.attempts.entries()){
  test(`P8 news ${index+1}: content-preserving card reflow retains text, font, paths and input`,()=>{
    const before=structuredClone(attempt.drawing),fixed=reflowCardDetails(attempt.drawing,htmlLayoutIssues(attempt.report),'9:16');assert.ok(fixed);
    validateDrawing(fixed,'9:16');assert.deepEqual(attempt.drawing,before);assert.equal(drawingContentHash(fixed),drawingContentHash(before));
    for(const n of before.nodes){const after=fixed.nodes.find(node=>node.id===n.id)!;assert.equal(after.fontSize,n.fontSize);assert.equal(after.x,n.x);assert.equal(after.w,n.w);if(n.kind==='card'&&after.text==='')assert.equal(fixed.nodes.find(node=>node.id===n.id+'_label')!.text,n.text);else assert.equal(after.text,n.text);if(['line','path'].includes(n.kind))assert.deepEqual(after,n);}
  });
  test(`P8 news ${index+1}: real browser rejects raw overlap and validates reflow and zero text padding`,async()=>{
    const project=await mkdtemp(path.join(tmpdir(),'qingjian-p8-card-browser-'));
    try{
      await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
      await writeFile(path.join(project,'index.html'),drawingHtml(attempt.drawing,8.49,'9:16'));
      await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/content_overlap/);
      const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));
      const fixed=reflowCardDetails(attempt.drawing,htmlLayoutIssues(report),'9:16');assert.ok(fixed);
      const html=drawingHtml(fixed,8.49,'9:16').replace('</body>',`<script>document.fonts.ready.then(()=>{for(const node of document.querySelectorAll('.node.text')){if(getComputedStyle(node).paddingLeft!=='0px'||getComputedStyle(node).paddingTop!=='0px')throw new Error('Actual text padding contradicts drawing contract');}for(const node of document.querySelectorAll('.node.card')){if(getComputedStyle(node).paddingLeft!=='12px')throw new Error('Card padding changed');}});</script></body>`);
      await writeFile(path.join(project,'index.html'),html);await checkHtmlProject(project,{fullCheck:true});
    }finally{await rm(project,{recursive:true,force:true});}
  });
}

test('card reflow refuses ambiguous, data-path and no-space layouts without mutating content',()=>{
  const base=fixture.attempts[1],issues=htmlLayoutIssues(base.report);
  assert.equal(reflowCardDetails(base.drawing,[{code:'text_overflow',selector:'#event_card'}],'9:16'),undefined);
  assert.equal(reflowCardDetails(base.drawing,[{code:'content_overlap',selector:'#not_a_node'}],'9:16'),undefined);
  assert.equal(reflowCardDetails(base.drawing,[{code:'content_overlap',selector:'#not_a_node',containerSelector:'#event_detail'}],'9:16'),undefined);
  for(const alter of[(d:HtmlDrawing)=>d.nodes.push({...d.nodes.find(n=>n.id==='event_detail')!,id:'ambiguous_detail'}),(d:HtmlDrawing)=>d.nodes.push({id:'grounded_path',kind:'path',x:90,y:630,w:60,h:20,pathData:'M90 630 L150 650',text:'',tone:'ink',fontSize:24,highlight:false}),(d:HtmlDrawing)=>{d.nodes.find(n=>n.id==='rank_card')!.y=720;}]){
    const drawing=structuredClone(base.drawing);alter(drawing);const before=structuredClone(drawing);assert.equal(reflowCardDetails(drawing,issues,'9:16'),undefined);assert.deepEqual(drawing,before);
  }
});

test('actual overflow fixture consumes only the second HTML check with one author and retains cache',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-p8-card-recovery-'));const actual=fixture.attempts[1];let authors=0,checks=0;
  const options={project,chapterId:'ch1',contextHash:'controlled-P8-public-layout-only',format:'9:16' as const,author:async()=>{authors++;return structuredClone(actual.drawing);},produce:async(drawing:HtmlDrawing)=>{checks++;if(drawing.nodes.find(n=>n.id==='event_card')!.text){await writeFile(path.join(project,'check-report.json'),JSON.stringify(actual.report));throw new Error('HTML check 未通过：captured content_overlap');}const file=path.join(project,'controlled-not-video');await writeFile(file,JSON.stringify(drawing));return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
  try{const result=await recoverLessonHtml(options);assert.equal(authors,1);assert.equal(checks,2);assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(authors,1);assert.equal(checks,2);}finally{await rm(project,{recursive:true,force:true});}
});
