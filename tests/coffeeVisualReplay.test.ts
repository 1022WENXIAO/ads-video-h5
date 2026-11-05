import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,copyFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {lessonRepairPlan} from '../server/visualRecovery';
import {authorDrawing,drawingHtml,checkHtmlProject} from '../server/narrativeScenes';
import {assertDrawingLayoutIdentity} from '../server/drawingLayoutIdentity';
import {TEXT_MODEL_PRESETS,ARK_BASE_URL} from '../shared/textModels';
const fixture=JSON.parse(await readFile(new URL('./fixtures/qa-464-coffee-visual-repair.json',import.meta.url),'utf8'));
test('actual kitchen visual rejection and optional disclosure preserve verified narration while targeting only chapter1',()=>{
  const f=structuredClone(fixture),before=structuredClone(f);
  const plan=lessonRepairPlan(f.report,f.review);
  assert.equal(plan.kind,'visual');assert.deepEqual(plan.scriptChapterIds,[]);assert.deepEqual(plan.visualChapterIds,['chapter-1']);
  assert.deepEqual(f,before);assert.equal(f.review.score,84);
});
test('optional disclosure cannot excuse wrong audio, unverified facts or a genuine spoken fault',()=>{
  for(const mode of ['audio','fact','spoken'] as const){
    const f=structuredClone(fixture);
    if(mode==='audio')f.review.checks.find((c:any)=>c.name==='字幕原话').passed=false;
    if(mode==='fact')f.report.factReview.needsRepair=true;
    if(mode==='spoken')f.review.semantic.findings=f.review.semantic.findings.map((s:string)=>s+'旁白把温度数字读错，需要改正。');
    assert.notEqual(lessonRepairPlan(f.report,f.review).kind,'visual',mode);
  }
});
test('transparent text uses zero padding and geometry-only retries retain explicit measured text boxes',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  const drawing={title:'滤纸位置',nodes:[{id:'background',kind:'card',x:60,y:240,w:600,h:400,text:'',tone:'paper',fontSize:36,highlight:false},{id:'label',kind:'text',x:90,y:300,w:130,h:32,text:'滤杯干滤纸',tone:'ink',fontSize:24,highlight:false},{id:'note',kind:'text',x:90,y:400,w:300,h:56,text:'厨房台面示意',tone:'ink',fontSize:24,highlight:false}]};
  let patch=false;globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(patch?{nodes:[{id:'note',y:410}]}:drawing)}}]}));
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-text-padding'};
  const beat={title:drawing.title,line:'Controlled geometry only',visualBrief:'{}'} as any;
  const first=await authorDrawing(config,beat);assert.equal(first.nodes[1].h,32);
  patch=true;const next=await authorDrawing(config,beat,'9:16',{layoutRepair:first});assert.deepEqual(next.nodes[1],first.nodes[1]);assert.equal(next.nodes[2].y,410);
});
test('captured live model corrects its rejected22px patch using node-specific feedback without changing source text or shapes',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let calls=0;
  globalThis.fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));if(calls===1)assert.match(JSON.stringify(body.messages),/dripper_label.*收到字号22/);return new Response(JSON.stringify({choices:[{message:{content:fixture.liveModelRegression.replies[calls++].content}}]}));};
  const config={...TEXT_MODEL_PRESETS[0],kind:'text' as const,provider:'ark',baseUrl:ARK_BASE_URL,enabled:true,apiKey:'controlled-live-replay'};
  const actual=await authorDrawing(config,{title:fixture.drawing.title,line:fixture.authorInput.narration,visualBrief:'Captured actual SVG label collision'} as any,'9:16',{layoutRepair:fixture.drawing});
  assert.equal(calls,2);assert.deepEqual(actual,fixture.liveModelRegression.fixedDrawing);assertDrawingLayoutIdentity(actual,fixture.drawing);assert.equal(fixture.review.score,84);
});
test('captured actual live-model geometry repairs the original rejected kitchen layout under full browser checks',{skip:process.platform==='win32',timeout:180000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'qj-live-coffee-replay-'));
  try{
    await copyFile('node_modules/gsap/dist/gsap.min.js',path.join(dir,'gsap.min.js'));
    await writeFile(path.join(dir,'index.html'),drawingHtml(fixture.drawing,8,'9:16'));
    await assert.rejects(checkHtmlProject(dir,{fullCheck:true}),/未通过/);
    const original=await readFile(path.join(dir,'check-report.json'),'utf8');assert.match(original,/qj-author-dripper_label/);assert.match(original,/qj-author-carafe/);
    const fixed=fixture.liveModelRegression.fixedDrawing;assertDrawingLayoutIdentity(fixed,fixture.drawing);
    await writeFile(path.join(dir,'index.html'),drawingHtml(fixed,8,'9:16'));await checkHtmlProject(dir,{fullCheck:true});
    assert.equal(JSON.parse(await readFile(path.join(dir,'check-report.json'),'utf8')).ok,true);
    assert.deepEqual(fixed.nodes.map((n:any)=>n.text),fixture.drawing.nodes.map((n:any)=>n.text));assert.equal(fixture.review.status,'needs-review');
  }finally{await rm(dir,{recursive:true,force:true});}
});
