import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {assertDrawingLayoutIdentity,applyDrawingLayoutPatch,translateDrawingPath} from '../server/drawingLayoutIdentity';
import {authorDrawing,validateDrawing,drawingHtml,checkHtmlProject,type HtmlDrawing} from '../server/narrativeScenes';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {hashBytes} from '../server/narrativeScenes';
import {TEXT_MODEL_PRESETS,ARK_BASE_URL} from '../shared/textModels';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-650-layout-identity.json',import.meta.url),'utf8'));
const prior=fixture.first as HtmlDrawing;
function clear(){const d=structuredClone(prior);Object.assign(d.nodes.find(n=>n.id==='bad_card')!,{h:285});Object.assign(d.nodes.find(n=>n.id==='bad_label_neck')!,{x:90,y:460,w:110,h:55});Object.assign(d.nodes.find(n=>n.id==='bad_label_arm')!,{x:85,y:605,w:240,h:55});return d;}
const clearPatch={nodes:[{id:'bad_card',h:285},{id:'bad_label_neck',x:90,y:460,w:110,h:55},{id:'bad_label_arm',x:85,y:605,w:240,h:55}]};

test('actual failed repair added six nodes; geometry-only recovery preserves all source words and diagrams',()=>{
  assert.equal(prior.nodes.length,23);assert.equal(fixture.last.nodes.length,29);
  assert.throws(()=>assertDrawingLayoutIdentity(fixture.last,prior),/局部布局修复/);
  const d=clear(),before=structuredClone(prior);assertDrawingLayoutIdentity(d,prior);validateDrawing(d,'9:16');
  assert.deepEqual(d.nodes.filter(n=>['path','line','circle'].includes(n.kind)),prior.nodes.filter(n=>['path','line','circle'].includes(n.kind)));
  assert.deepEqual(d.nodes.map(n=>n.text),prior.nodes.map(n=>n.text));assert.deepEqual(prior,before);assert.equal(fixture.originalReviewScore,78);
});

test('source wording, numbers, paths, node identities, motion and semantic containers cannot be changed as a layout fix',()=>{
  for(const mode of ['text','number','path','add','delete','order','color','motion','container','tiny','grow'] as const){
    const d=clear();
    if(mode==='text')d.nodes[0].text+='新事实';
    if(mode==='number')d.nodes[0].text=d.nodes[0].text.replace('20','10');
    if(mode==='path')d.nodes.find(n=>n.kind==='path')!.pathData+=' L100 100';
    if(mode==='add')d.nodes.push({...d.nodes[0],id:'duplicate'});
    if(mode==='delete')d.nodes.pop();
    if(mode==='order')[d.nodes[0],d.nodes[1]]=[d.nodes[1],d.nodes[0]];
    if(mode==='color')d.nodes[0].tone='blue';
    if(mode==='motion')d.motion='playful';
    if(mode==='container')d.nodes.find(n=>n.id==='bad_label_neck')!.x=400;
    if(mode==='tiny')d.nodes[0].fontSize=12;
    if(mode==='grow')d.nodes[0].fontSize++;
    assert.throws(()=>assertDrawingLayoutIdentity(d,prior),/局部布局修复/,mode);
  }
});

test('real author API rejects added duplicate nodes then accepts only geometry changes within its existing bounded correction calls',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(String(options?.body));assert.match(JSON.stringify(body.messages),/SAME title/);assert.match(body.messages[0].content,/geometry patches/);assert.doesNotMatch(body.messages[0].content,/Design a useful/);if(calls===2)assert.match(JSON.stringify(body.messages),/局部布局修复/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?fixture.last:clearPatch)}}]}),{headers:{'Content-Type':'application/json'}});};
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-layout-only'};
  const result=await authorDrawing(config,{title:prior.title,line:'Controlled actual drawing projection',visualBrief:'{}'} as any,'9:16',{layoutRepair:prior});
  assert.equal(calls,2);assertDrawingLayoutIdentity(result,prior);
});

test('geometry patches retain content by construction and reject creative fields, new IDs, duplication, resizing symbols and unreadable fonts',()=>{
  assert.deepEqual(applyDrawingLayoutPatch(clearPatch,prior),clear());
  for(const edit of [{title:prior.title,nodes:[]},{nodes:[{id:'new',x:1}]},{nodes:[{id:'bad_card',text:'新事实'}]},{nodes:[{id:'bad_card',h:285},{id:'bad_card',h:286}]},{nodes:[{id:'bad_card',fontSize:12}]},{nodes:[{id:'bad_card',x:'50'}]},{nodes:[{id:'bad_card',translate:{x:1,y:1}}]},{nodes:[{id:prior.nodes.find(n=>n.kind==='path')!.id,pathData:'M0 0L1 1'}]}])assert.throws(()=>applyDrawingLayoutPatch(edit,prior),/局部布局修复/);
  assert.deepEqual(prior,fixture.first);
});

test('SVG translation handles absolute/relative moves, implicit lines, curves, H/V, closed subpaths and arcs without changing shape or scales',()=>{
  const a='m1 2 3 4 h5 v6 l7 8 C10 20 30 40 50 60 s1 2 3 4 Q5 6 7 8 T9 10 A5 6 30 0 1 20 30 z M40 50H60V70Z';
  const b=translateDrawingPath(a,100,200);
  assert.equal(b,'m101 202 l3 4 h5 v6 l7 8 C110 220 130 240 150 260 s1 2 3 4 Q105 206 107 208 T109 210 A5 6 30 0 1 120 230 z M140 250 H160 V270 Z');
  assert.equal(translateDrawingPath('M1e2,-2e1L.5 +3',-10,20),'M90 0 L-9.5 23');
  for(const pathData of ['M1 2 L3','L1 2','M1 2<script>','M1 2A5 6 0 2 0 3 4'])assert.throws(()=>translateDrawingPath(pathData,1,2),/局部布局修复/);
  assert.throws(()=>translateDrawingPath('M1 2',Infinity,0),/有限/);
});

test('actual news drawing can translate misplaced original SVG ink while preserving every word, node, path shape and the failed record',async()=>{
  const f=JSON.parse(await readFile(new URL('./fixtures/qa-d4-path-layout.json',import.meta.url),'utf8'));
  const d=applyDrawingLayoutPatch(f.proposedGeometryOnly,f.first);
  assertDrawingLayoutIdentity(d,f.first);validateDrawing(d,'9:16');
  assert.equal(d.nodes.length,28);assert.deepEqual(d.nodes.map((n:any)=>n.text),f.first.nodes.map((n:any)=>n.text));
  assert.equal(d.nodes.find((n:any)=>n.id==='route').pathData,translateDrawingPath(f.first.nodes.find((n:any)=>n.id==='route').pathData,0,780));
  for(const mode of ['reshape','resize','rotate'] as const){
    const bad=structuredClone(d),route=bad.nodes.find((n:any)=>n.id==='route');
    if(mode==='reshape')route.pathData+=' L500 500';
    if(mode==='resize')route.pathData=route.pathData.replace('M110 875','M110 876');
    if(mode==='rotate')route.pathData=route.pathData.replace('C210 800','C211 800');
    assert.throws(()=>assertDrawingLayoutIdentity(bad,f.first),/路径形状改变/);
  }
});

test('actual news geometry patch crosses the real author normalization boundary without letting the model recreate content',async t=>{
  const f=JSON.parse(await readFile(new URL('./fixtures/qa-d4-path-layout.json',import.meta.url),'utf8'));
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(String(options?.body));assert.match(body.messages[0].content,/translate/);assert.doesNotMatch(body.messages[0].content,/Design a useful/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(f.proposedGeometryOnly)}}]}));};
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-news-layout'};
  const result=await authorDrawing(config,{title:f.first.title,line:'Controlled real news layout',visualBrief:'Only repair measured title/path occlusion'} as any,'9:16',{layoutRepair:f.first});
  assert.equal(calls,1);assertDrawingLayoutIdentity(result,f.first);assert.deepEqual(result.nodes.map(n=>n.text),f.first.nodes.map((n:any)=>n.text));
});

test('a persistently creative replacement cannot exceed the existing three author corrections',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(fixture.last)}}]}),{headers:{'Content-Type':'application/json'}});};
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-layout-only'};
  await assert.rejects(authorDrawing(config,{title:prior.title,line:'Controlled original',visualBrief:'{}'} as any,'9:16',{layoutRepair:prior}),/局部布局修复/);assert.equal(calls,3);
});

test('the remaining local author receives an isolated copy of the actual checked drawing and retains the two-check budget',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qj-layout-binding-'));let authors=0,checks=0;
  try{
    await recoverLessonHtml({project,chapterId:'controlled-layout',contextHash:'source-and-script-unchanged',format:'9:16',
      author:async(_feedback,checked)=>{authors++;if(authors===1){assert.equal(checked,undefined);return structuredClone(prior);}assert.deepEqual(checked,prior);checked!.title='Mutating the callback copy must not alter evidence';return clear();},
      produce:async drawing=>{checks++;if(checks===1){await writeFile(path.join(project,'check-report.json'),JSON.stringify({ok:false,issues:[{code:'text_overflow',selector:'#qj-author-bad_label_arm',severity:'error'}]}));throw Error('HTML check 未通过：controlled checked overflow');}assertDrawingLayoutIdentity(drawing,prior);const file=path.join(project,'controlled-not-a-movie');await writeFile(file,'Controlled identity test only');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};},
    });
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(authors,2);assert.equal(checks,2);assert.equal(state.attempts,2);assert.deepEqual(state.failed[0].drawing,prior);
  }finally{await rm(project,{recursive:true,force:true});}
});

test('controlled geometry-only correction of actual 23-node layout passes all real browser checks',{skip:process.platform==='win32',timeout:120000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qj-layout-identity-'));
  try{
    const d=clear();assertDrawingLayoutIdentity(d,prior);
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
    await writeFile(path.join(project,'index.html'),drawingHtml(d,8,'9:16'));
    await checkHtmlProject(project,{fullCheck:true});
    const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));assert.equal(report.ok,true);
  }finally{await rm(project,{recursive:true,force:true});}
});

test('actual news SVG title occlusion is rejected before repair and its geometry patch passes the full loaded-font browser check',{skip:process.platform==='win32',timeout:180000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qj-news-path-identity-'));
  try{
    const f=JSON.parse(await readFile(new URL('./fixtures/qa-d4-path-layout.json',import.meta.url),'utf8'));
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(project,'gsap.min.js'));
    await writeFile(path.join(project,'index.html'),drawingHtml(f.first,8,'9:16'));
    await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/未通过/);
    const original=await readFile(path.join(project,'check-report.json'),'utf8');
    assert.match(original,/text_occluded/);assert.match(original,/#title/);assert.match(original,/qj-author-route/);
    const repaired=applyDrawingLayoutPatch(f.proposedGeometryOnly,f.first);
    await writeFile(path.join(project,'index.html'),drawingHtml(repaired,8,'9:16'));
    await checkHtmlProject(project,{fullCheck:true});
    assert.equal(JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8')).ok,true);
    // The immutable rejection is retained as evidence; no movie review is implied.
    assert.match(original,/text_occluded/);assert.deepEqual(repaired.nodes.map(n=>n.text),f.first.nodes.map((n:any)=>n.text));
  }finally{await rm(project,{recursive:true,force:true});}
});
