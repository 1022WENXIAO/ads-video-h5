import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyzeFilm,readFilmReport,validateFilmDescription,reusableShot,filmDirectory} from '../server/filmAnalysis';
import {detectShots,runFFmpeg} from '../server/core';
import {runWithJobSignal,JobCancelledError} from '../server/jobExecution';
import type {ModelConfig} from '../server/modelRegistry';
import type {MediaItem} from '../shared/types';
const config:ModelConfig={id:'fixture',name:'Fixture',kind:'understanding',provider:'ark',modelId:'fixture-vision',baseUrl:'https://example.invalid',apiKey:'fixture-private-key',enabled:true};
const description={summary:'蓝衣人物指向白板上的曲线',scene:'会议室',people:['蓝衣人物'],shotType:'中景',movement:'无法确认',usage:'可用于解释图表分析过程',tags:['图表','讲解']};
async function fixture(t:any){const root=await mkdtemp(path.join(tmpdir(),'film-analysis-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'source');await writeFile(file,'fixture source bytes');const source:MediaItem={id:'source-id',ownerId:'owner',name:'原片.mp4',kind:'video',mimeType:'video/mp4',duration:6,url:'/api/media/source-id',createdAt:new Date().toISOString(),analysis:{status:'ready',modelId:'fixture',sourceHash:'fixture',duration:6,transcript:'先观察图表。',sentences:[{id:'line',start:.2,end:1.6,text:'先观察图表。',words:[],complete:true} as any],pauses:[],timing:'model-estimated',warnings:[],createdAt:''}};const snapshots:any[]=[];return{root,file,source,snapshots,assertCurrent(){},async publish(report:any){snapshots.push(structuredClone(report));source.filmAnalysis={id:report.id,sourceHash:report.sourceHash,status:report.status,shotCount:report.shots.length,completed:report.shots.filter((s:any)=>s.status==='ready').length,updatedAt:report.updatedAt};},detect:async(_file:string,_duration:number,_id:string,options:any)=>{assert.equal(options.full,true);return[0,2,4].map(start=>({start,end:start+2,thumbnailUrl:''}));},render:async(args:string[])=>{await writeFile(args.at(-1)!,'fixture frame');return'';},config};}

test('film analysis binds actual source hash, extracts real timestamps and resumes already reviewed shots without another model call',async t=>{
  const f=await fixture(t);let calls=0;
  const report=await analyzeFilm({...f,describe:async(_c,frames,shot)=>{calls++;assert.equal(frames.length,3);if(shot.index===0)assert.equal(shot.quote,'先观察图表。');return description;}});
  assert.equal(report.shots.length,3);assert.equal(report.status,'ready');assert.match(report.sourceHash,/^[a-f0-9]{64}$/);assert.equal(calls,3);
  const loaded=await readFilmReport(f.root,f.source);assert.equal(loaded!.sourceHash,report.sourceHash);assert.equal(loaded!.shots[0].usage,description.usage);
  await analyzeFilm({...f,describe:async()=>{assert.fail('completed shots must be reused');}});assert.equal(calls,3);
  assert.equal(reusableShot(report,f.source,'shot-1').start,2);assert.throws(()=>reusableShot(report,f.source,'shot-999'),/有效/);
  assert.throws(()=>filmDirectory(f.root,'../../outside',report.id),/无效/);
});

test('a failed scene keeps completed work, records a partial report and retries only unfinished shots',async t=>{
  const f=await fixture(t);let failed=false;
  await assert.rejects(analyzeFilm({...f,describe:async(_c,_frames,shot)=>{if(shot.index===1&&!failed){failed=true;throw Error('HTTP 503 fixture-private-key');}return description;}}),/部分镜头/);
  const partial=(await readFilmReport(f.root,f.source))!;assert.equal(partial.status,'partial');assert.equal(partial.shots.filter(s=>s.status==='ready').length,2);assert.doesNotMatch(JSON.stringify(partial),/fixture-private-key/);
  let calls=0;const result=await analyzeFilm({...f,describe:async()=>{calls++;return description;}});assert.equal(calls,1);assert.equal(result.status,'ready');
});

test('user cancellation retains reviewed scenes and cannot publish an invented complete result',async t=>{
  const f=await fixture(t),stop=new AbortController();let calls=0;
  await assert.rejects(runWithJobSignal(stop.signal,()=>analyzeFilm({...f,describe:async()=>{calls++;return description;},publish:async report=>{await f.publish(report);if(report.shots.some(s=>s.status==='ready'))stop.abort();}})),JobCancelledError);
  const saved=(await readFilmReport(f.root,f.source))!;assert.equal(calls,1);assert.equal(saved.status,'partial');assert.equal(saved.shots.filter(s=>s.status==='ready').length,1);
});

test('changed source bytes invalidate a report instead of silently rebinding its scenes',async t=>{
  const f=await fixture(t);
  await assert.rejects(analyzeFilm({...f,describe:async()=>{await writeFile(f.file,'changed source bytes');return description;}}),/原片在分析期间/);
  assert.equal((await readFilmReport(f.root,f.source))!.status,'partial');
  assert.throws(()=>validateFilmDescription({summary:'只给一句模糊的话'}),/缺少/);
});

test('full film detection retains cuts beyond the upload-preview eight-shot limit',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'film-detection-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'cuts.mp4');
  const args=['-v','error','-y'];for(let i=0;i<10;i++)args.push('-f','lavfi','-i',`color=c=${i%2?'blue':'red'}:s=64x64:r=10:d=0.8`);
  args.push('-filter_complex',Array.from({length:10},(_,i)=>`[${i}:v]`).join('')+'concat=n=10:v=1:a=0,format=yuv420p[v]','-map','[v]','-c:v','libx264',file);await runFFmpeg(args);
  const preview=await detectShots(file,8,'source'),full=await detectShots(file,8,'source',{full:true});
  assert.ok(preview.length<=8);assert.ok(full.length>preview.length);assert.equal(full.at(-1)!.end,8);assert.ok((await readFile(file)).length>0);
});
