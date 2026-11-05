import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {drawingHtml,checkHtmlProject,validateDrawing,type HtmlDrawing} from '../server/narrativeScenes';

const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-numeric-circle-padding.json',import.meta.url),'utf8'));

test('captured year badges retain their original circles, numbers and fonts',()=>{
  const drawing=structuredClone(fixture.drawing) as HtmlDrawing,before=structuredClone(drawing);
  validateDrawing(drawing,'9:16');
  const html=drawingHtml(drawing,10.05,'9:16');
  for(const id of ['n4','n8']){
    const badge=drawing.nodes.find(n=>n.id===id)!;
    assert.deepEqual([badge.kind,badge.w,badge.h,badge.fontSize],['circle',70,70,24]);
    assert.match(html,new RegExp('id="qj-author-'+id+'"[^>]*data-qj-number'));
  }
  assert.deepEqual(drawing,before);
  assert.match(html,/\.node\.circle\[data-qj-number\]\{padding:0\}/);
  const ordinary=structuredClone(drawing);
  for(const node of ordinary.nodes)if(node.kind==='circle')node.text='年份';
  assert.doesNotMatch(drawingHtml(ordinary,10.05,'9:16'),/\.node\.circle\[data-qj-number\]\{padding:0\}/);
});

test('real year glyphs fail with the old padding, fit unchanged circles without it, and still reject genuinely narrow badges',
  {skip:process.platform==='win32',timeout:240000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qj-numeric-circle-padding-'));
  try{
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
    const html=drawingHtml(fixture.drawing,10.05,'9:16');
    const check=async(source:string)=>{await writeFile(path.join(project,'index.html'),source);return checkHtmlProject(project,{fullCheck:true});};
    await assert.rejects(check(html.replace('</style>','.node.circle[data-qj-number]{padding:4px}</style>')),/数字字形溢出/);
    await check(html);
    assert.equal(JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8')).ok,true);
    // Removing padding never exempts numeric glyphs from the real paint gate.
    await assert.rejects(check(html.replace('</style>','#qj-author-n4{width:50px!important}</style>')),/数字字形溢出/);
  }finally{await rm(project,{recursive:true,force:true});}
});
