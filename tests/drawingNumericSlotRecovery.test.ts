import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {assertNumericDrawingNode,fitNumericDrawingSlots,NumericDrawingSlotError} from '../server/drawingNumberLayout';
import {AuthoredDrawingGeometryError} from '../server/drawingGeometry';
import {authorDrawing,checkHtmlProject,drawingHtml,hashBytes,validateDrawing,type HtmlDrawing} from '../server/narrativeScenes';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';

const fixture=JSON.parse(await readFile(new URL('./fixtures/p32-knowledge-number-slot.json',import.meta.url),'utf8'));
const bounds={left:40,top:220,right:680,bottom:1010};
const drawing=()=>structuredClone(fixture.drawing) as HtmlDrawing;
const number=(d:HtmlDrawing)=>d.nodes.find(n=>n.id==='step1_num')!;
const content=(d:HtmlDrawing)=>({...d,nodes:d.nodes.map(({x,y,w,h,...n})=>n)});
const config={id:'controlled',name:'controlled',provider:'ark',kind:'text',enabled:true,baseUrl:'https://controlled.invalid',modelId:'controlled',apiKey:'not-a-secret'} as const;
const beat={id:'controlled',title:fixture.drawing.title,line:'先找源头',role:'argument',mode:'generated',visual:'html',reason:'Controlled incident projection, not actual model output',referenceIds:[],visualBrief:'只验证数字布局，不调用真实模型'} as const;

test('actual error projection keeps every value/font/motion field and enlarges only a clear number slot',()=>{
  const original=drawing(),before=structuredClone(original),old=number(original);
  assert.throws(()=>validateDrawing(original),/step1_num.*完整数值“1”.*31px.*30px/);
  const fixed=fitNumericDrawingSlots(original,bounds)!;assert.ok(fixed);validateDrawing(fixed);assertNumericDrawingNode(number(fixed));
  assert.deepEqual(original,before);assert.deepEqual(content(fixed),content(original));
  assert.equal(number(fixed).x+number(fixed).w/2,old.x+old.w/2);assert.equal(number(fixed).y+number(fixed).h/2,old.y+old.h/2);
  assert.ok(number(fixed).w>old.w);assert.ok(number(fixed).h>old.h);
  for(const n of original.nodes.filter(n=>n.id!==old.id))assert.deepEqual(fixed.nodes.find(next=>next.id===n.id),n);
  assert.equal(fixture.provenance.originalProposalPersisted,false,'missing original draft must not be represented as captured geometry');
});

test('width-only and height-only deficits preserve signed/decimal values and do not resize already valid slots',()=>{
  for(const change of [{w:30,h:60},{w:60,h:47},{text:'−12.5%',x:160,w:40,h:70}]){
    const original=drawing();Object.assign(number(original),change);const fixed=fitNumericDrawingSlots(original,bounds)!;
    assert.ok(fixed);assertNumericDrawingNode(number(fixed));assert.equal(number(fixed).text,number(original).text);assert.equal(number(fixed).fontSize,number(original).fontSize);
  }
  const valid=fitNumericDrawingSlots(drawing(),bounds)!;assert.equal(fitNumericDrawingSlots(valid,bounds),undefined);
});

test('only complete numeric geometry is typed; a split number or later structural fault cannot authorize recovery',()=>{
  assert.throws(()=>assertNumericDrawingNode(number(drawing())),error=>error instanceof NumericDrawingSlotError&&error.requiredWidth===31&&error.requiredHeight===53);
  assert.throws(()=>validateDrawing(drawing()),error=>{
    assert.ok(error instanceof AuthoredDrawingGeometryError);
    assert.deepEqual(error.issues,[{code:'numeric_slot',nodeId:'step1_num',box:{x:140,y:430,w:30,h:47},requiredWidth:31,requiredHeight:53}]);return true;
  });
  for(const fault of ['split','path','font','number-value'] as const){
    const original=drawing();
    if(fault==='split')number(original).text='1\n0';
    if(fault==='path')original.nodes.push({id:'badpath',kind:'path',x:400,y:600,w:100,h:50,text:'',pathData:'alert(1)',tone:'ink',fontSize:24,highlight:false});
    if(fault==='font')original.nodes.at(-1)!.fontSize=10;
    if(fault==='number-value')number(original).text='1\n';
    assert.throws(()=>validateDrawing(original),error=>!(error instanceof AuthoredDrawingGeometryError),fault);
  }
});

for(const scenario of ['split value','boundary','new text collision','new connector collision','reserved server binding','unsafe font'] as const)test('unsafe numeric proposal remains rejected: '+scenario,()=>{
  const original=drawing();
  if(scenario==='split value')number(original).text='1\n0';
  if(scenario==='boundary')number(original).x=40;
  if(scenario==='new text collision')original.nodes.push({id:'adjacent',kind:'text',x:170.25,y:430,w:40,h:50,text:'注',tone:'ink',fontSize:24,highlight:false});
  if(scenario==='new connector collision')original.nodes.push({id:'connector',kind:'line',x:130,y:426.5,w:60,h:0,text:'',tone:'ink',fontSize:24,highlight:false});
  if(scenario==='reserved server binding')original.serverCardLabels=[];
  if(scenario==='unsafe font')number(original).fontSize=10;
  const before=structuredClone(original);assert.equal(fitNumericDrawingSlots(original,bounds),undefined);assert.deepEqual(original,before);assert.throws(()=>validateDrawing(original));
});

test('author normalizes a safe number slot after one controlled response; an unsafe slot keeps the original three-response cap',async()=>{
  const fetch=globalThis.fetch;
  try{
    for(const unsafe of [false,true]){
      const original=drawing();if(unsafe)number(original).x=40;const raw=JSON.stringify(original),rawHash=hashBytes(raw);let calls=0;
      globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:raw}}]}),{status:200});};
      if(unsafe){await assert.rejects(authorDrawing(config as any,beat as any,'9:16'),/HTML layout rejected/);assert.equal(calls,3);}
      else{const result=await authorDrawing(config as any,beat as any,'9:16');validateDrawing(result);assert.equal(calls,1);assert.deepEqual(content(result),content(original));}
      assert.equal(hashBytes(raw),rawHash);
    }
  }finally{globalThis.fetch=fetch;}
});

test('unsafe numeric growth archives the exact rejected JSON in two existing slots then uses one native callback',async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-numeric-slot-evidence-')),fetch=globalThis.fetch;
  const original=drawing();original.nodes.push({id:'connector',kind:'line',x:130,y:426.5,w:60,h:0,text:'',tone:'ink',fontSize:24,highlight:false});
  const before=structuredClone(original),raw=JSON.stringify(original);let requests=0,produces=0,natives=0;
  try{
    globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:raw}}]}),{status:200});};
    const options={project,chapterId:'controlled-chapter',contextHash:'numeric-geometry-bounded-evidence-only',format:'9:16' as const,
      author:()=>authorDrawing(config as any,beat as any,'9:16'),
      produce:async()=>{produces++;throw new Error('A rejected numeric draft must not render');return{file:'',analysis:{sourceHash:''}};},
      nativeFallback:async()=>{natives++;const file=path.join(project,'controlled-native.bin');await writeFile(file,'Controlled native callback identity, not media quality acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
    const result=await recoverLessonHtml(options);assert.equal(requests,6);assert.equal(produces,0);assert.equal(natives,1);assert.deepEqual(original,before);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,2);assert.equal(state.native.reason,'authored-geometry');
    for(const failure of state.failed){
      assert.equal(failure.hash,hashBytes(raw));const directory=path.join(project,failure.evidence.directory),manifestBytes=await readFile(path.join(directory,'manifest.json')),manifest=JSON.parse(manifestBytes.toString());
      assert.equal(hashBytes(manifestBytes),failure.evidence.manifestHash);assert.equal(manifest.geometry,false);assert.equal(manifest.files['index.html'],undefined);
      assert.equal(await readFile(path.join(directory,'draft.json'),'utf8'),raw);assert.equal(await readFile(path.join(directory,'raw-proposal.json'),'utf8'),raw);
      for(const[name,hash]of Object.entries(manifest.files))assert.equal(hashBytes(await readFile(path.join(directory,name))),hash);
      const validation=JSON.parse(await readFile(path.join(directory,'server-validation.json'),'utf8'));assert.equal(validation.htmlChecked,false);assert.equal(validation.accepted,false);assert.equal(validation.issues[0].code,'numeric_slot');assert.equal(validation.issues[0].requiredWidth,31);assert.equal(validation.issues[0].requiredHeight,53);
    }
    assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(requests,6);assert.equal(natives,1);
  }finally{globalThis.fetch=fetch;await rm(project,{recursive:true,force:true});}
});

for(const fault of ['forged-width','split','later-structure'] as const)test('invalid numeric rejection evidence cannot enter native recovery: '+fault,async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-numeric-slot-forged-'));let natives=0;
  try{
    let rejection:AuthoredDrawingGeometryError|undefined;try{validateDrawing(drawing());}catch(error){assert.ok(error instanceof AuthoredDrawingGeometryError);rejection=error;}
    const draft=structuredClone(rejection!.draft),issues=structuredClone(rejection!.issues);
    if(fault==='forged-width')issues[0].requiredWidth=30;
    if(fault==='split')number(draft).text='1\n0';
    if(fault==='later-structure')draft.nodes.at(-1)!.fontSize=10;
    const forged=new AuthoredDrawingGeometryError(draft,'9:16',issues,'forged numeric geometry');
    await assert.rejects(recoverLessonHtml({project,chapterId:'controlled',contextHash:'forged-numeric',format:'9:16',author:async()=>{throw forged;},produce:async()=>{throw new Error('must not render');return{file:'',analysis:{sourceHash:''}};},nativeFallback:async()=>{natives++;throw new Error('must not recover');return{file:'',analysis:{sourceHash:''}};}}),/无法确认/);
    assert.equal(natives,0);await assert.rejects(readFile(path.join(project,'html-recovery.json')),{code:'ENOENT'});
  }finally{await rm(project,{recursive:true,force:true});}
});

test('a cached invalid number slot uses real HTML/font checks in one existing slot; CSS narrowing still fails',{timeout:120000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-numeric-slot-real-'));let authors=0,checks=0,natives=0;
  try{
    await copyFile(path.join(process.cwd(),'node_modules/gsap/dist/gsap.min.js'),path.join(project,'gsap.min.js'));
    const original=drawing(),before=structuredClone(original);let compiled='';
    const options={project,chapterId:'controlled-chapter',contextHash:'controlled-numeric-slot-not-audio-or-media-acceptance',format:'9:16' as const,
      author:async()=>{authors++;return original;},
      produce:async(draft:HtmlDrawing)=>{checks++;compiled=drawingHtml(draft,4,'9:16');await writeFile(path.join(project,'index.html'),compiled);await checkHtmlProject(project,{fullCheck:true});const file=path.join(project,'checked-geometry-only.bin');await writeFile(file,'Controlled checked HTML geometry; not a rendered video or speech acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};},
      nativeFallback:async()=>{natives++;throw new Error('A safe numeric resize must use normal authored HTML checks');return{file:'',analysis:{sourceHash:''}};}};
    const result=await recoverLessonHtml(options);assert.equal(authors,1);assert.equal(checks,1);assert.equal(natives,0);assert.deepEqual(original,before);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,1);assert.deepEqual(state.failed,[]);assert.equal(state.native,undefined);assert.deepEqual(content(state.completed.drawing),content(original));
    const report=JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8'));assert.equal(report.ok,true);
    for(const pointer of [report.drawingText.report,report.svgPaint.report]){
      const bytes=await readFile(path.join(project,pointer.path));assert.equal(hashBytes(bytes),pointer.sha256);
      const audit=JSON.parse(bytes.toString());assert.equal(audit.htmlHash,hashBytes(compiled));assert.equal(audit.samples.length,9);assert.deepEqual(audit.findings,[]);
    }
    const textAudit=JSON.parse(await readFile(path.join(project,report.drawingText.report.path),'utf8'));assert.ok(textAudit.fonts.length>0,'real loaded-font evidence must be present');
    assert.deepEqual(await recoverLessonHtml(options),result);assert.equal(checks,1);assert.equal(authors,1);
    await writeFile(path.join(project,'index.html'),compiled.replace('</style>','#qj-author-step1_num{width:10px!important}</style>'));
    await assert.rejects(checkHtmlProject(project,{fullCheck:true}),/数字字形溢出/);
  }finally{await rm(project,{recursive:true,force:true});}
});
