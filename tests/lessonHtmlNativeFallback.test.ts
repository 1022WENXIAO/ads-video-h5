import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recoverLessonHtml } from '../server/lessonHtmlRecovery';
import { hashBytes, type HtmlDrawing } from '../server/narrativeScenes';
import { runWithJobSignal, throwIfJobCancelled } from '../server/jobExecution';
import { produceLessonScene } from '../server/lessonScenes';
import { runFFmpeg } from '../server/core';
import { newsPublicationScoringFixture } from './fixtures/newsPublicationScoring';
import type { AudioAnalysis } from '../shared/types';

const geometryReport={ok:false,layout:{findings:[{code:'content_overlap',severity:'error',selector:'#one',containerSelector:'#two'}]}};
const drawing=(version:number):HtmlDrawing=>({title:'原布局'+version,nodes:[
  {id:'one',kind:'text',x:80,y:300,w:560,h:80,text:'记录来源',tone:'ink',fontSize:36,highlight:false},
  {id:'two',kind:'text',x:80,y:300,w:560,h:80,text:'核对日期',tone:'ink',fontSize:36,highlight:false},
  {id:'three',kind:'text',x:80,y:520,w:560,h:80,text:'保留证据',tone:'ink',fontSize:36,highlight:false},
]});
async function setup(){
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-native-once-'));let authors=0,produces=0,natives=0;
  const options={project,chapterId:'ch1',contextHash:'verified-script-audio-context',format:'9:16' as const,
    author:async()=>drawing(++authors),
    produce:async(value:HtmlDrawing)=>{produces++;await writeFile(path.join(project,'index.html'),'<html>actual controlled failed layout '+value.title+'</html>');await writeFile(path.join(project,'check-report.json'),JSON.stringify(geometryReport));throw new Error('HTML check 未通过：content_overlap');return {file:'',analysis:{sourceHash:''}};},
    nativeFallback:async()=>{natives++;const file=path.join(project,'native-controlled-scene');await writeFile(file,'Controlled bytes, not movie acceptance');return{file,analysis:{sourceHash:hashBytes(await readFile(file))}};},
  };
  return{project,options,counts:()=>({authors,produces,natives})};
}

test('two saved real-layout reports allow exactly one independent native attempt, immutable evidence and cache reuse',async()=>{
  const f=await setup();
  try{
    const result=await recoverLessonHtml(f.options);assert.deepEqual(f.counts(),{authors:2,produces:2,natives:1});
    const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));
    assert.equal(state.attempts,2);assert.equal(state.failed.length,2);assert.equal(state.native.status,'completed');assert.equal(state.completed.rendererKind,'native');
    for(const failure of state.failed){
      const directory=path.join(f.project,failure.evidence.directory),manifest=await readFile(path.join(directory,'manifest.json'));
      assert.equal(hashBytes(manifest),failure.evidence.manifestHash);assert.equal(failure.evidence.geometry,true);assert.equal((await stat(directory)).mode&0o777,0o700);
      const record=JSON.parse(manifest.toString());for(const[name,hash]of Object.entries(record.files)){assert.equal(hashBytes(await readFile(path.join(directory,name))),hash);assert.equal((await stat(path.join(directory,name))).mode&0o777,0o600);}
      assert.match(await readFile(path.join(directory,'index.html'),'utf8'),new RegExp(failure.drawing.title));
    }
    assert.deepEqual(await recoverLessonHtml(f.options),result);assert.deepEqual(f.counts(),{authors:2,produces:2,natives:1});
    await writeFile(result.file,'changed native bytes');await assert.rejects(recoverLessonHtml(f.options),/已核验分镜文件已改变/);assert.equal(f.counts().natives,1);
  }finally{await rm(f.project,{recursive:true,force:true});}
});

test('missing HTML, stale reports, mixed runtime errors and damaged archive cannot enable native fallback',async()=>{
  for(const kind of ['missing-html','stale-report','runtime','corrupt-evidence','unknown-first','unknown-last']as const){
    const f=await setup();let attempt=0;
    try{
      const produce=async(value:HtmlDrawing)=>{
        attempt++;
        if(kind!=='missing-html')await writeFile(path.join(f.project,'index.html'),'<html>'+value.title+'</html>');
        if(kind!=='stale-report'||attempt===1)await writeFile(path.join(f.project,'check-report.json'),JSON.stringify(kind==='runtime'?{...geometryReport,runtime:{findings:[{code:'script_error',severity:'error'}]}}:geometryReport));
        if(kind==='unknown-first'||kind==='unknown-last'){
          const unknown={ok:false,layout:{findings:[]}};
          await writeFile(path.join(f.project,'check-report.json'),JSON.stringify(kind==='unknown-first'?unknown:geometryReport));
          await writeFile(path.join(f.project,'lint-report.json'),JSON.stringify(kind==='unknown-first'?geometryReport:unknown));
        }
        if(kind==='corrupt-evidence'&&attempt===2){const directory=path.join(f.project,'html-recovery-evidence',hashBytes(f.options.contextHash),'authored-1');await writeFile(path.join(directory,'index.html'),'corrupt saved HTML');}
        throw new Error('HTML check 未通过：controlled rejection');return{file:'',analysis:{sourceHash:''}};
      };
      await assert.rejects(recoverLessonHtml({...f.options,produce}),/HTML布局|SHA不一致/,kind);assert.equal(f.counts().natives,0,kind);
    }finally{await rm(f.project,{recursive:true,force:true});}
  }
});

test('native failure, wrong source hash and permission errors spend the single claim and never replay after restart',async()=>{
  for(const kind of ['layout','hash','permission']as const){
    const f=await setup();let calls=0;
    const nativeFallback=async()=>{calls++;if(kind==='hash'){const file=path.join(f.project,'bad-native');await writeFile(file,'actual bytes');return{file,analysis:{sourceHash:'wrong'}};}throw kind==='permission'?Object.assign(new Error('native EACCES'),{code:'EACCES'}):new Error('HTML check 未通过：native actual overflow');};
    try{
      await assert.rejects(recoverLessonHtml({...f.options,nativeFallback}),kind==='hash'?/原生分镜文件哈希/:kind==='permission'?{code:'EACCES'}:/native actual overflow/);
      const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.native.status,'failed');assert.equal(state.completed,undefined);
      await assert.rejects(recoverLessonHtml({...f.options,nativeFallback}),/已failed/);assert.equal(calls,1);
    }finally{await rm(f.project,{recursive:true,force:true});}
  }
});

test('cancellation during native execution is immediate and a subsequent request cannot replay it',async()=>{
  const f=await setup(),controller=new AbortController();let calls=0;
  const nativeFallback=async()=>{calls++;controller.abort();throwIfJobCancelled();return{file:'',analysis:{sourceHash:''}};};
  try{
    await assert.rejects(runWithJobSignal(controller.signal,()=>recoverLessonHtml({...f.options,nativeFallback})),{name:'JobCancelledError'});
    const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.native.status,'cancelled');
    await assert.rejects(recoverLessonHtml({...f.options,nativeFallback}),/已cancelled/);assert.equal(calls,1);
  }finally{await rm(f.project,{recursive:true,force:true});}
});

test('unknown running native execution, rolled-back state and corrupt evidence stop without another renderer',async()=>{
  const f=await setup();
  try{
    await recoverLessonHtml(f.options);
    const stateFile=path.join(f.project,'html-recovery.json'),state=JSON.parse(await readFile(stateFile,'utf8')),original=structuredClone(state);
    delete state.completed;state.native.status='running';delete state.native.terminalHash;
    await writeFile(stateFile,JSON.stringify(state));await assert.rejects(recoverLessonHtml(f.options),/已running/);
    delete state.native;await writeFile(stateFile,JSON.stringify(state));await assert.rejects(recoverLessonHtml(f.options),/状态缺失或倒退/);
    await writeFile(stateFile,JSON.stringify(original));await writeFile(path.join(f.project,original.failed[0].evidence.directory,'manifest.json'),'{}');await assert.rejects(recoverLessonHtml(f.options),/manifest SHA不一致/);
    assert.equal(f.counts().natives,1);
  }finally{await rm(f.project,{recursive:true,force:true});}
});

test('changing context and returning restores the original native terminal without granting a second budget',async()=>{
  const f=await setup();
  try{
    const first=await recoverLessonHtml(f.options);await recoverLessonHtml({...f.options,contextHash:'different-verified-context'});
    assert.equal(f.counts().natives,2);assert.deepEqual(await recoverLessonHtml(f.options),first);assert.equal(f.counts().natives,2);
    const state=JSON.parse(await readFile(path.join(f.project,'html-recovery.json'),'utf8'));assert.equal(state.native.status,'completed');assert.equal(state.attempts,2);
  }finally{await rm(f.project,{recursive:true,force:true});}
});

test('evidence storage I/O failures stop before claiming native execution',async()=>{
  const f=await setup();
  try{
    await writeFile(path.join(f.project,'html-recovery-evidence'),'blocked directory');
    await assert.rejects(recoverLessonHtml(f.options),{code:'ENOTDIR'});assert.equal(f.counts().natives,0);
    await assert.rejects(readFile(path.join(f.project,'html-recovery-native',hashBytes(f.options.contextHash),'started.json')),{code:'ENOENT'});
  }finally{await rm(f.project,{recursive:true,force:true});}
});

test('actual Chromium failures fall back once to production native renderer with original audio and checked date',{timeout:120000},async()=>{
  const project=await mkdtemp(path.join(tmpdir(),'qingjian-native-real-render-')),originalFetch=globalThis.fetch;
  try{
    globalThis.fetch=async()=>{throw new Error('No provider is permitted in native layout recovery');};
    const fixture=newsPublicationScoringFixture(),chapter=structuredClone(fixture.artifact.plan!.lesson!.chapters[0]);
    delete chapter.mediaId;delete chapter.htmlHash;delete chapter.audioHash;
    const before=structuredClone(chapter),speech=path.join(project,'original-speech.wav');
    await runFFmpeg(['-v','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1.5','-ar','44100','-ac','1',speech]);
    const speechHash=hashBytes(await readFile(speech)),analysis:AudioAnalysis={sourceHash:speechHash,duration:1.5,status:'ready',modelId:'controlled-waveform-not-tts',timing:'model-estimated',createdAt:'',transcript:chapter.narration,sentences:[],pauses:[],warnings:[]};
    let authors=0,natives=0;
    const produce=(custom?:HtmlDrawing)=>produceLessonScene(chapter,0,1,'9:16',speech,analysis,project,undefined,undefined,true,custom,undefined,fixture.annotation);
    const result=await recoverLessonHtml({project,chapterId:chapter.id,contextHash:'actual-native-date-layout',format:'9:16',author:async()=>drawing(++authors),produce,nativeFallback:async()=>{natives++;return produce();}});
    assert.equal(authors,2);assert.equal(natives,1);assert.equal(result.audioHash,speechHash);assert.equal(hashBytes(await readFile(speech)),speechHash);
    assert.equal(result.analysis.sourceHash,hashBytes(await readFile(result.file)));assert.equal(result.publicationEvidence!.htmlVerified,true);assert.equal(result.publicationEvidence!.sceneHash,result.analysis.sourceHash);assert.equal(result.publicationEvidence!.layout.fontSize,24);
    assert.equal(JSON.parse(await readFile(path.join(project,'check-report.json'),'utf8')).ok,true);
    const html=await readFile(path.join(project,'index.html'),'utf8');assert.ok(html.includes(fixture.annotation.label));for(const item of chapter.visual.items){assert.ok(html.includes(item.label));assert.ok(html.includes(item.detail));}assert.ok(html.includes(chapter.visual.takeaway));assert.deepEqual(chapter,before);
    await runFFmpeg(['-v','error','-i',result.file,'-f','null','-']);
    const state=JSON.parse(await readFile(path.join(project,'html-recovery.json'),'utf8'));assert.equal(state.attempts,2);assert.equal(state.failed.length,2);assert.ok(state.failed.every((failed:any)=>failed.evidence.geometry));assert.equal(state.completed.rendererKind,'native');
    assert.equal((await readdir(path.join(project,'html-recovery-evidence',hashBytes('actual-native-date-layout')))).length,2);
  }finally{globalThis.fetch=originalFetch;await rm(project,{recursive:true,force:true});}
});
