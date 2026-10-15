import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recoverLessonHtml} from '../server/lessonHtmlRecovery';
import {drawingHtml,hashBytes,type HtmlDrawing} from '../server/narrativeScenes';
import {produceLessonScene} from '../server/lessonScenes';
import {lessonPacing,alignLessonSpeech} from '../server/lessonSpec';
import {lessonPresentation} from '../server/lessonPresentation';
import {runFFmpeg} from '../server/core';
import {inspectEvaluationStreamDuration} from '../server/evaluationMediaGate';
import type {AudioAnalysis,LessonChapter} from '../shared/types';
const fixture=JSON.parse(await readFile(new URL('./fixtures/html-layout-static-sweep.json',import.meta.url),'utf8'));
const staticReport=fixture.reports[1];
async function setup(reports:any[]=fixture.reports){
 const project=await mkdtemp(path.join(tmpdir(),'qingjian-static-native-'));let authors=0,produces=0,natives=0;
 const options={project,chapterId:'chapter-static',contextHash:'same-verified-static-script-and-speech',format:'9:16' as const,
  author:async()=>structuredClone(fixture.drawings[authors++]) as HtmlDrawing,
  produce:async(drawing:HtmlDrawing)=>{const report=reports[produces++];await writeFile(path.join(project,'index.html'),drawingHtml(drawing,fixture.duration,'9:16'));await writeFile(path.join(project,'check-report.json'),JSON.stringify(report));throw new Error('HTML check 未通过：'+JSON.stringify(report.layout?.findings));return{file:'',analysis:{sourceHash:''}};},
  nativeFallback:async()=>{natives++;const file=path.join(project,'native-controlled');await writeFile(file,'Controlled result, not actual video acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};},
 };
 return{project,options,counts:()=>({authors,produces,natives})};
}

for(const reports of [fixture.reports,[staticReport,staticReport]])test('actual mixed/static reports retain geometry=false and permit exactly one separately recorded native recovery',async()=>{
 const f=await setup(reports);
 try{
  await assert.rejects(recoverLessonHtml({...f.options,nativeFallback:undefined}),/检查2\/2/);
  const stateFile=path.join(f.project,'html-recovery.json'),old=JSON.parse(await readFile(stateFile,'utf8'));
  assert.deepEqual(f.counts(),{authors:2,produces:2,natives:0});assert.ok(old.failed.every((v:any)=>v.evidence.geometry===false));
  const immutable=new Map<string,string>();for(const failure of old.failed){const dir=path.join(f.project,failure.evidence.directory),manifest=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));for(const name of [...Object.keys(manifest.files),'manifest.json']){const file=path.join(dir,name);immutable.set(file,hashBytes(await readFile(file)));}}
  const result=await recoverLessonHtml(f.options),saved=JSON.parse(await readFile(stateFile,'utf8'));
  assert.deepEqual(f.counts(),{authors:2,produces:2,natives:1});assert.deepEqual(saved.failed,old.failed);assert.equal(saved.attempts,2);assert.equal(saved.native.reason,'static-sweep');assert.equal(saved.native.status,'completed');
  const native=path.join(f.project,'html-recovery-native',hashBytes(f.options.contextHash));for(const name of ['started.json','terminal.json'])assert.equal(JSON.parse(await readFile(path.join(native,name),'utf8')).reason,'static-sweep');
  for(const[file,hash]of immutable)assert.equal(hashBytes(await readFile(file)),hash,'old failed HTML/reports/manifests remain byte-identical');
  assert.deepEqual(await recoverLessonHtml(f.options),result);assert.equal(f.counts().natives,1);
 }finally{await rm(f.project,{recursive:true,force:true});}
});

test('known static eligibility rejects runtime/unknown/incomplete reports and unconfirmed paused GSAP registration',async()=>{
 for(const kind of ['runtime-false','runtime-missing','runtime-error','unknown','unknown-first','unknown-last','empty','missing-report','missing-gsap','unpaused','unregistered','comment-only','string-only','inert-script','nested-script']){
  const f=await setup();let calls=0;
  try{
   const produce=async(drawing:HtmlDrawing)=>{
    calls++;let report=structuredClone(staticReport),html=drawingHtml(drawing,fixture.duration,'9:16');
    if(kind==='runtime-false')report.runtime.ok=false;
    if(kind==='runtime-missing')delete report.runtime;
    if(kind==='runtime-error')report.runtime.findings.push({code:'script_error',severity:'error'});
    if(kind==='unknown')report.layout.findings.push({code:'unknown_sweep',severity:'error'});
    if(kind==='empty')report={ok:false,layout:{findings:[]}};
    if(kind==='missing-gsap')html=html.replace('<script src="./gsap.min.js"></script>','');
    if(kind==='unpaused')html=html.replace('gsap.timeline({paused:true})','gsap.timeline({paused:false})');
    if(kind==='unregistered')html=html.replace('window.__timelines.main=tl;','');
    if(kind==='comment-only'||kind==='string-only')html='<script src="./gsap.min.js"></script><script>'+ (kind==='comment-only'?'/*const tl=gsap.timeline({paused:true});window.__timelines.main=tl;*/':'const example="const tl=gsap.timeline({paused:true});window.__timelines.main=tl;";')+'</script>';
    if(kind==='inert-script')html='<script src="./gsap.min.js"></script><script type="application/json">const tl=gsap.timeline({paused:true});window.__timelines.main=tl;</script>';
    if(kind==='nested-script')html='<script src="./gsap.min.js"></script><script>function unused(){const tl=gsap.timeline({paused:true});window.__timelines.main=tl;}</script>';
    await writeFile(path.join(f.project,'index.html'),html);
    if(kind!=='missing-report')await writeFile(path.join(f.project,'check-report.json'),JSON.stringify(kind==='unknown-first'?{ok:false}:report));
    if(kind==='unknown-first'||kind==='unknown-last')await writeFile(path.join(f.project,'lint-report.json'),JSON.stringify(kind==='unknown-first'?report:{ok:false}));
    throw new Error('HTML check 未通过：static rejection');return{file:'',analysis:{sourceHash:''}};
   };
   await assert.rejects(recoverLessonHtml({...f.options,produce}),/检查2\/2/,kind);assert.equal(calls,2,kind);assert.equal(f.counts().natives,0,kind);
   await assert.rejects(readFile(path.join(f.project,'html-recovery-native',hashBytes(f.options.contextHash),'started.json')),{code:'ENOENT'});
  }finally{await rm(f.project,{recursive:true,force:true});}
 }
});

test('old false evidence corruption and native running/failed status cannot be replayed or reclassified',async()=>{
 for(const kind of ['html-hash','report-hash','manifest-hash','failed','running']){
  const f=await setup();let natives=0;
  try{
   await assert.rejects(recoverLessonHtml({...f.options,nativeFallback:undefined}),/检查2\/2/);
   const stateFile=path.join(f.project,'html-recovery.json'),state=JSON.parse(await readFile(stateFile,'utf8')),dir=path.join(f.project,state.failed[0].evidence.directory);
   if(kind.endsWith('hash')){
    await writeFile(path.join(dir,kind==='html-hash'?'index.html':kind==='report-hash'?'check-report.json':'manifest.json'),'changed actual evidence');
    await assert.rejects(recoverLessonHtml(f.options),/SHA不一致/);assert.equal(f.counts().natives,0);
   }else{
    const options={...f.options,nativeFallback:async()=>{natives++;throw new Error('Controlled native failure');}};
    await assert.rejects(recoverLessonHtml(options),/Controlled native failure/);
    if(kind==='running'){const current=JSON.parse(await readFile(stateFile,'utf8'));current.native.status='running';delete current.native.terminalHash;await writeFile(stateFile,JSON.stringify(current));}
    await assert.rejects(recoverLessonHtml(options),kind==='running'?/已running/:/已failed/);assert.equal(natives,1);
   }
  }finally{await rm(f.project,{recursive:true,force:true});}
 }
});

test('actual P12 static drawings recover through real native full-check/render/decode with the same controlled word grid',{timeout:120000},async()=>{
 const project=await mkdtemp(path.join(tmpdir(),'qingjian-static-native-real-')),originalFetch=globalThis.fetch;
 try{
  globalThis.fetch=async()=>{throw new Error('No provider allowed in native technical regression');};
  const chapter=structuredClone(fixture.chapter)as LessonChapter,scriptBefore=structuredClone(chapter),speech=path.join(project,'controlled-speech.wav');
  await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=17.76','-ar','48000','-ac','1',speech]);
  const bytes=await readFile(speech),chars=[...chapter.narration],analysis:AudioAnalysis={status:'ready',modelId:'controlled-no-provider',sourceHash:hashBytes(bytes),duration:17.76,transcript:chapter.narration,createdAt:'',timing:'model-estimated',warnings:[],pauses:[],sentences:[{id:'actual-grid-control',start:0,end:17.76,text:chapter.narration,complete:true,words:chars.map((text,i)=>({text,start:17.76*i/chars.length,end:17.76*(i+1)/chars.length}))}]};
  const raw=structuredClone(analysis),pacing=lessonPacing('生成今天的热点 AI 新闻视频');assert.equal(alignLessonSpeech(chapter,analysis).similarity,1);
  let authors=0,natives=0;const produce=(drawing?:HtmlDrawing)=>produceLessonScene(chapter,1,3,'9:16',speech,analysis,project,pacing,lessonPresentation('生成今天的热点 AI 新闻视频'),true,drawing);
  const result=await recoverLessonHtml({project,chapterId:chapter.id,contextHash:'actual-static-native-regression',format:'9:16',author:async()=>structuredClone(fixture.drawings[authors++]),produce,nativeFallback:async()=>{natives++;return produce();}});
  assert.equal(authors,2);assert.equal(natives,1);assert.deepEqual(chapter,scriptBefore);assert.deepEqual(analysis,raw);assert.equal(hashBytes(await readFile(speech)),analysis.sourceHash);assert.equal(result.audioHash,analysis.sourceHash);
  for(const[sentenceIndex,sentence]of result.analysis.sentences.entries())for(const[wordIndex,word]of sentence.words.entries()){const source=raw.sentences[sentenceIndex].words[wordIndex];assert.equal(word.text,source.text);assert.ok(Math.abs(word.start-source.start-pacing.leadSeconds)<1e-9);assert.ok(Math.abs(word.end-source.end-pacing.leadSeconds)<1e-9);}
  assert.equal(JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8')).ok,true);assert.equal(result.analysis.sourceHash,hashBytes(await readFile(result.file)));
  await runFFmpeg(['-v','error','-xerror','-i',result.file,'-map','0:v:0','-map','0:a:0','-f','null','-']);assert.equal((await inspectEvaluationStreamDuration(result.file,result.duration)).passed,true);
  const html=await readFile(path.join(project,'index.html'),'utf8');for(const text of [chapter.title,chapter.visual.takeaway,...chapter.visual.items.flatMap(v=>[v.label,v.detail])])assert.ok(html.includes(text),text);
  const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.native.reason,'static-sweep');assert.ok(state.failed.every((v:any)=>v.evidence.geometry===false));
 }finally{globalThis.fetch=originalFetch;await rm(project,{recursive:true,force:true});}
});
