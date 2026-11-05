import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {reflowContainedSvgText} from '../server/drawingCardLayout';
import {assertDrawingLayoutIdentity} from '../server/drawingLayoutIdentity';
import {checkHtmlProject,drawingHtml,hashBytes,validateDrawing,type HtmlDrawing} from '../server/narrativeScenes';
import {drawingContentHash,recoverLessonHtml} from '../server/lessonHtmlRecovery';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-contained-calendar-layout.json',import.meta.url),'utf8'));
const propose=(d:HtmlDrawing=fixture.drawing,issues=fixture.issues)=>reflowContainedSvgText(d,issues,'9:16');

test('the recorded calendar collision can reflow inside its own card without changing audience content or typography',()=>{
  const before=JSON.stringify(fixture.drawing),next=propose();assert.ok(next);
  assertDrawingLayoutIdentity(next,fixture.drawing);validateDrawing(next,'9:16');
  assert.equal(drawingContentHash(next),drawingContentHash(fixture.drawing));
  assert.deepEqual(next.nodes.map(n=>[n.id,n.kind,n.text,n.fontSize,n.tone,n.highlight,n.pathData]),fixture.drawing.nodes.map((n:any)=>[n.id,n.kind,n.text,n.fontSize,n.tone,n.highlight,n.pathData]));
  const card=next.nodes.find(n=>n.id==='calendar_card')!,text=next.nodes.find(n=>n.id==='year_2027')!;
  assert.ok(text.y>=card.y&&text.y+text.h<=card.y+card.h);
  assert.ok(text.w>fixture.drawing.nodes.find((n:any)=>n.id==='year_2027').w);
  assert.equal(JSON.stringify(fixture.drawing),before);
});

test('a growing card cannot swallow another object or cross the drawing safe zone',()=>{
  const blocked=structuredClone(fixture.drawing);blocked.nodes.push({id:'other_mark',kind:'circle',x:400,y:650,w:20,h:20,fontSize:24,text:'',tone:'ink',highlight:false});
  assert.equal(propose(blocked),undefined);
  const noRoom=structuredClone(fixture.drawing),card=noRoom.nodes.find((n:any)=>n.id==='calendar_card');card.y+=365;
  for(const id of ['calendar_shape','year_2027'])noRoom.nodes.find((n:any)=>n.id===id).y+=365;
  assert.equal(propose(noRoom),undefined);
});

test('ambiguous parents, unrelated findings and cards with existing copy stay on the authored repair path',()=>{
  const ambiguous=structuredClone(fixture.drawing);ambiguous.nodes.push({...ambiguous.nodes.find((n:any)=>n.id==='calendar_card'),id:'another_parent'});assert.equal(propose(ambiguous),undefined);
  const labeled=structuredClone(fixture.drawing);labeled.nodes.find((n:any)=>n.id==='calendar_card').text='另一个完整标题';assert.equal(propose(labeled),undefined);
  assert.equal(propose(fixture.drawing,[{code:'text_occluded',selector:'#title',containerSelector:'#qj-author-calendar_shape'}]),undefined);
  assert.equal(propose(fixture.drawing,[{code:'runtime_error',selector:'#qj-author-year_2027',containerSelector:'#qj-author-calendar_shape'}]),undefined);
});

test('controlled recovery spends the existing second check on the geometry proposal instead of asking for a competing redraw',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qj-contained-label-recovery-'));let authors=0,checks=0;
  try{
    await recoverLessonHtml({project,chapterId:'calendar',contextHash:'recorded-layout-controlled-recovery',format:'9:16',author:async()=>{authors++;return structuredClone(fixture.drawing);},produce:async drawing=>{
      checks++;await writeFile(path.join(project,'index.html'),drawingHtml(drawing,8,'9:16'));
      if(checks===1){await writeFile(path.join(project,'check-report.json'),JSON.stringify({ok:false,runtime:{ok:true},layout:{findings:fixture.issues}}));throw Error('HTML check 未通过：controlled recorded calendar collision');}
      assertDrawingLayoutIdentity(drawing!,fixture.drawing);const file=path.join(project,'controlled-not-a-movie');await writeFile(file,'controlled geometry boundary only');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};
    }});
    assert.equal(authors,1);assert.equal(checks,2);
    const record=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(record.attempts,2);assert.equal(record.failed.length,1);
  }finally{await rm(project,{recursive:true,force:true});}
});

test('recorded calendar geometry fails before repair and passes the full real loaded-font browser checks after repair',{skip:process.platform==='win32',timeout:180000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qj-contained-label-browser-'));
  try{
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
    await writeFile(path.join(project,'index.html'),drawingHtml(fixture.drawing,8,'9:16'));
    await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/未通过/);
    const next=propose();assert.ok(next);await writeFile(path.join(project,'index.html'),drawingHtml(next,8,'9:16'));
    try{await checkHtmlProject(project,{fullCheck:true});}catch(error){const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));throw new Error(String(error)+' '+JSON.stringify(report.layout?.findings));}
    assert.equal(JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8')).ok,true);
  }finally{await rm(project,{recursive:true,force:true});}
});
