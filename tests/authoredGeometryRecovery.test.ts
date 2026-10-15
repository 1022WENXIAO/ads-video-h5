import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {AuthoredDrawingGeometryError} from '../server/drawingGeometry';
import {authorDrawing,validateDrawing,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {runWithJobSignal,throwIfJobCancelled,JobCancelledError} from '../server/jobExecution';
import {produceLessonScene} from '../server/lessonScenes';
import {runFFmpeg} from '../server/core';
import {newsPublicationScoringFixture} from './fixtures/newsPublicationScoring';
import type {AudioAnalysis} from '../src/types';

const fixture=JSON.parse(await readFile(new URL('./fixtures/authored-geometry-p14.json',import.meta.url),'utf8'));
const invalid=()=>structuredClone(fixture.drawing) as HtmlDrawing;
const valid=()=>{const drawing=invalid();drawing.nodes[0].y=240;return drawing;};
const config={id:'fixture',name:'fixture',kind:'text' as const,provider:'ark',baseUrl:'https://example.invalid',enabled:true,apiKey:'fixture-not-secret',modelId:'fixture'};
const beat={id:'ch1',title:'早高峰报错',line:'受控公开短句',role:'hook' as const,mode:'generated' as const,visual:'html' as const,reason:'实际几何回归',referenceIds:[],visualBrief:'只供离线回归'};
async function setup(){
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-authored-proposal-'));let authors=0,produces=0,natives=0;
  const options={project,chapterId:'ch1',contextHash:'controlled-original-script-sound-geometry',format:'9:16' as const,author:async()=>{authors++;return invalid();},produce:async()=>{produces++;throw new Error('Invalid proposal must not be rendered');return{file:'',analysis:{sourceHash:''}};},nativeFallback:async()=>{natives++;const file=path.join(project,'controlled-native');await writeFile(file,'CONTROLLED local bytes, not media acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};}};
  return{project,options,counts:()=>({authors,produces,natives})};
}
test('actual y72 title is a typed geometry rejection, while malformed or unsafe later nodes cannot inherit that classification',()=>{
  assert.throws(()=>validateDrawing(invalid()),error=>{assert.ok(error instanceof AuthoredDrawingGeometryError);assert.equal(error.draft.nodes[0].y,72);assert.deepEqual(error.issues.map(i=>i.code),['node_bounds']);assert.equal(error.issues[0].safeZone?.top,220);return true;});
  for(const kind of ['id','kind','finite','path','font','content']){
    const drawing=invalid(),node=drawing.nodes[2];
    if(kind==='id')node.id='../../bad';if(kind==='kind')(node as any).kind='script';if(kind==='finite')node.x=NaN;if(kind==='font')node.fontSize=10;if(kind==='path'){node.kind='path';node.pathData='alert(1)';}if(kind==='content')node.text='实际审查要求';
    assert.throws(()=>validateDrawing(drawing),error=>!(error instanceof AuthoredDrawingGeometryError),kind);
  }
});
test('authorDrawing retains its existing three-response cap and attaches the actual final rejected JSON',async()=>{
  const original=globalThis.fetch,raw=JSON.stringify(invalid());let calls=0;
  try{
    globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:raw}}]}),{status:200});};
    await assert.rejects(authorDrawing(config,beat),error=>{assert.ok(error instanceof AuthoredDrawingGeometryError);assert.equal(error.rawProposal,raw);assert.equal(error.draft.nodes[0].y,72);assert.match(error.message,/HTML layout rejected/);return true;});assert.equal(calls,3);
  }finally{globalThis.fetch=original;}
});
test('two identical genuine rejected proposals spend two original slots and permit one hashed native result without pretending HTML was checked',async()=>{
  const f=await setup(),original=globalThis.fetch;let requests=0;
  try{
    globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(invalid())}}]}),{status:200});};
    const result=await recoverLessonHtml({...f.options,author:()=>authorDrawing(config,beat)});assert.equal(requests,6,'original two outer slots times existing three author responses');assert.deepEqual(f.counts(),{authors:0,produces:0,natives:1});
    const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,2);assert.equal(state.failed[0].hash,state.failed[1].hash);assert.equal(state.native.reason,'authored-geometry');assert.equal(state.native.status,'completed');
    for(const failure of state.failed){
      const directory=path.join(f.project,failure.evidence.directory),manifestBytes=await readFile(path.join(directory,'manifest.json')),manifest=JSON.parse(manifestBytes.toString());assert.equal(hashBytes(manifestBytes),failure.evidence.manifestHash);assert.equal(failure.evidence.kind,'authored-proposal');assert.equal(failure.evidence.geometry,false);assert.equal(manifest.geometry,false);assert.equal(manifest.files['index.html'],undefined);assert.equal((await stat(directory)).mode&0o777,0o700);
      for(const[name,hash]of Object.entries(manifest.files)){assert.equal(hashBytes(await readFile(path.join(directory,name))),hash);assert.equal((await stat(path.join(directory,name))).mode&0o777,0o600);}
      const validation=JSON.parse(await readFile(path.join(directory,'server-validation.json'),'utf8'));assert.equal(validation.htmlChecked,false);assert.equal(validation.accepted,false);assert.equal(validation.draftHash,failure.hash);assert.equal(await readFile(path.join(directory,'raw-proposal.json'),'utf8'),JSON.stringify(invalid()));
    }
    assert.deepEqual(await recoverLessonHtml({...f.options,author:()=>authorDrawing(config,beat)}),result);assert.equal(requests,6);assert.equal(f.counts().natives,1);
  }finally{globalThis.fetch=original;await rm(f.project,{recursive:true,force:true});}
});
test('a real saved HTML layout failure and a rejected authored proposal may share the existing native budget',async()=>{
  const f=await setup();let calls=0;
  try{
    await recoverLessonHtml({...f.options,author:async()=>++calls===1?valid():invalid(),produce:async()=>{await writeFile(path.join(f.project,'index.html'),'<html>Controlled actual attempted HTML</html>');await writeFile(path.join(f.project,'check-report.json'),JSON.stringify({ok:false,layout:{findings:[{code:'content_overlap',severity:'error'}]}}));throw new Error('HTML check 未通过：content_overlap');return{file:'',analysis:{sourceHash:''}};}});
    const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed[0].evidence.geometry,true);assert.equal(state.failed[1].evidence.kind,'authored-proposal');assert.equal(state.native.reason,'authored-geometry');assert.equal(f.counts().natives,1);
  }finally{await rm(f.project,{recursive:true,force:true});}
});
for(const kind of ['unknown','authorization','permission','corrupt-json','forged-valid','forged-issues','wrong-format'] as const)test('unknown or forged author rejection cannot create geometry evidence: '+kind,async()=>{
  const f=await setup();let calls=0;
  try{
    const error=kind==='unknown'?new Error('HTML layout rejected: node invalid'):kind==='authorization'?Object.assign(new Error('HTTP 401'),{status:401}):kind==='permission'?Object.assign(new Error('read EACCES'),{code:'EACCES'}):kind==='corrupt-json'?new SyntaxError('Unexpected end of JSON'):kind==='wrong-format'?new AuthoredDrawingGeometryError(invalid(),'16:9',[],'wrong format'):new AuthoredDrawingGeometryError(kind==='forged-issues'?invalid():valid(),'9:16',[],'forged geometry');
    await assert.rejects(recoverLessonHtml({...f.options,author:async()=>{calls++;throw error;}}));assert.equal(calls,1);assert.equal(f.counts().natives,0);assert.equal(f.counts().produces,0);await assert.rejects(readFile(path.join(f.project,'html-recovery-native',hashBytes(f.options.contextHash),'started.json')),{code:'ENOENT'});
  }finally{await rm(f.project,{recursive:true,force:true});}
});
test('corrupt raw proposal JSON cannot be archived as trusted geometry',async()=>{
  const f=await setup();try{
    let genuine:AuthoredDrawingGeometryError|undefined;try{validateDrawing(invalid());}catch(error){assert.ok(error instanceof AuthoredDrawingGeometryError);genuine=error;}
    const error=new AuthoredDrawingGeometryError(genuine!.draft,genuine!.format,genuine!.issues,genuine!.message,'{');
    await assert.rejects(recoverLessonHtml({...f.options,author:async()=>{throw error;}}),SyntaxError);assert.equal(f.counts().natives,0);const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,1);assert.equal(state.failed.length,0);
  }finally{await rm(f.project,{recursive:true,force:true});}
});
test('proposal archive filesystem failure spends its slot and never falls back or fabricates saved evidence',async()=>{
  const f=await setup();try{
    await writeFile(path.join(f.project,'html-recovery-evidence'),'blocked directory');await assert.rejects(recoverLessonHtml(f.options),{code:'ENOTDIR'});const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,1);assert.equal(state.failed.length,0);assert.equal(f.counts().natives,0);
  }finally{await rm(f.project,{recursive:true,force:true});}
});
test('proposal SHA corruption stops before native claim and a running native remains non-replayable',async()=>{
  const f=await setup();let calls=0;
  try{
    const author=async()=>{if(++calls===2)await writeFile(path.join(f.project,'html-recovery-evidence',hashBytes(f.options.contextHash),'authored-1','draft.json'),'{}');return invalid();};
    await assert.rejects(recoverLessonHtml({...f.options,author}),/SHA不一致/);assert.equal(f.counts().natives,0);
  }finally{await rm(f.project,{recursive:true,force:true});}
  const g=await setup();try{
    await recoverLessonHtml(g.options);const file=path.join(g.project,'html-recovery.json'),state=JSON.parse(await readFile(file,'utf8'));delete state.completed;state.native.status='running';delete state.native.terminalHash;await writeFile(file,JSON.stringify(state));await assert.rejects(recoverLessonHtml(g.options),/已running/);assert.equal(g.counts().natives,1);
  }finally{await rm(g.project,{recursive:true,force:true});}
});
test('cancellation during author validation does not run another author or native renderer',async()=>{
  const f=await setup(),controller=new AbortController();let calls=0;
  try{
    await assert.rejects(runWithJobSignal(controller.signal,()=>recoverLessonHtml({...f.options,author:async()=>{calls++;controller.abort();throwIfJobCancelled();return invalid();}})),JobCancelledError);assert.equal(calls,1);assert.equal(f.counts().natives,0);
  }finally{await rm(f.project,{recursive:true,force:true});}
});
test('known invalid proposals recover once through actual native Chromium checks, news date evidence and full FFmpeg decode',{timeout:120000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-authored-native-real-')),original=globalThis.fetch;
  try{
    globalThis.fetch=async()=>{throw new Error('No provider is permitted in authored geometry recovery');};
    const source=newsPublicationScoringFixture(),chapter=structuredClone(source.artifact.plan!.lesson!.chapters[0]);delete chapter.mediaId;delete chapter.htmlHash;delete chapter.audioHash;
    const before=structuredClone(chapter),speech=path.join(project,'original-speech.wav');await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1.5','-ar','44100','-ac','1',speech]);const speechHash=hashBytes(await readFile(speech));
    const analysis:AudioAnalysis={sourceHash:speechHash,duration:1.5,status:'ready',modelId:'controlled-waveform-not-tts',timing:'model-estimated',createdAt:'',transcript:chapter.narration,sentences:[],pauses:[],warnings:[]};let authors=0,natives=0;
    const result=await recoverLessonHtml({project,chapterId:chapter.id,contextHash:'actual-rejected-proposal-native',format:'9:16',author:async()=>{authors++;return invalid();},produce:async()=>{throw new Error('Invalid draft cannot produce HTML');return{file:'',analysis:{sourceHash:''}};},nativeFallback:async()=>{natives++;return produceLessonScene(chapter,0,1,'9:16',speech,analysis,project,undefined,undefined,true,undefined,undefined,source.annotation);}});
    assert.equal(authors,2);assert.equal(natives,1);assert.equal(result.audioHash,speechHash);assert.equal(hashBytes(await readFile(speech)),speechHash);assert.deepEqual(chapter,before);assert.equal(result.analysis.sourceHash,hashBytes(await readFile(result.file)));assert.equal(result.publicationEvidence?.htmlVerified,true);assert.equal(JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8')).ok,true);
    const html=await readFile(path.join(project,'index.html'),'utf8');assert.ok(html.includes(source.annotation.label));for(const item of chapter.visual.items){assert.ok(html.includes(item.label));assert.ok(html.includes(item.detail));}assert.ok(html.includes(chapter.visual.takeaway));await runFFmpeg(['-v','error','-i',result.file,'-f','null','-']);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.completed.rendererKind,'native');assert.equal(state.native.reason,'authored-geometry');assert.equal(state.failed.every((f:any)=>f.evidence.geometry===false),true);
  }finally{globalThis.fetch=original;await rm(project,{recursive:true,force:true});}
});
