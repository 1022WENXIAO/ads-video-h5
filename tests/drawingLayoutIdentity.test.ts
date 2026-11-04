import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {assertDrawingLayoutIdentity} from '../server/drawingLayoutIdentity';
import {authorDrawing,validateDrawing,drawingHtml,checkHtmlProject,type HtmlDrawing} from '../server/narrativeScenes';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {hashBytes} from '../server/narrativeScenes';
import {TEXT_MODEL_PRESETS,ARK_BASE_URL} from '../shared/textModels';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-650-layout-identity.json',import.meta.url),'utf8'));
const prior=fixture.first as HtmlDrawing;
function clear(){const d=structuredClone(prior);Object.assign(d.nodes.find(n=>n.id==='bad_card')!,{h:285});Object.assign(d.nodes.find(n=>n.id==='bad_label_neck')!,{x:90,y:460,w:110,h:55});Object.assign(d.nodes.find(n=>n.id==='bad_label_arm')!,{x:85,y:605,w:240,h:55});return d;}

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
  globalThis.fetch=async(_url,options)=>{calls++;const body=JSON.parse(String(options?.body));assert.match(JSON.stringify(body.messages),/SAME title/);if(calls===2)assert.match(JSON.stringify(body.messages),/局部布局修复/);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(calls===1?fixture.last:clear())}}]}),{headers:{'Content-Type':'application/json'}});};
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-layout-only'};
  const result=await authorDrawing(config,{title:prior.title,line:'Controlled actual drawing projection',visualBrief:'{}'} as any,'9:16',{layoutRepair:prior});
  assert.equal(calls,2);assertDrawingLayoutIdentity(result,prior);
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
